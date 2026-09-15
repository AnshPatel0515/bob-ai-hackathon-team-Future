'use strict';
/**
 * FleetOptimizer
 * ==============
 * Full fleet-utilisation optimisation engine.
 *
 * Public API
 * ──────────
 *   runOptimisation(companyId, opts)      – full optimisation pass, returns run report
 *   getIdleAssets(companyId)              – idle + underutilised assets
 *   getAvailableDrivers(companyId)        – drivers available now
 *   getUnderutilisedAssets(companyId)     – assets below utilisation threshold
 *   getOverloadedRoutes(companyId)        – legs/routes over capacity
 *   getShipmentsNeedingAssignment(cid)    – shipments without an active assignment
 *   scoreCandidate(shipment, asset, driver) – scoring for one match
 *   acceptCandidate(candidateId, userId)  – accept a recommendation
 *   rejectCandidate(candidateId, reason)  – reject a recommendation
 *
 * Scoring model (weighted sum → 0-100)
 * ─────────────────────────────────────
 *  distance_score     (25%) – how close the asset is to the shipment's origin
 *  capacity_score     (25%) – weight + volume fit against shipment requirements
 *  availability_score (20%) – driver hours remaining in 7-day window
 *  cold_chain_score   (15%) – refrigeration compatibility
 *  eta_score          (10%) – can the asset reach origin before scheduled pickup?
 *  route_score        ( 5%) – same-direction route bonus (reduces dead-miles)
 *
 * Cost model
 * ──────────
 *  baseline_cost   = current idle/empty-run cost (idle_days × IDLE_COST_PER_DAY)
 *  assignment_cost = distance_to_origin × ROAD_COST_PER_KM + driver_daily × eta_days
 *  saving          = max(0, baseline_cost - assignment_cost)
 *
 * Utilisation improvement
 * ───────────────────────
 *  If an idle asset is assigned, its projected utilisation rises from current
 *  to ceil((active_days + leg_days) / 30 * 100).
 */

const db            = require('../config/db');
const socketManager = require('../realtime/socketManager');

// ── Constants ─────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM       = 6371;
const ROAD_FACTOR           = 1.35;
const ROAD_COST_PER_KM      = 1.85;      // USD per km (fuel + wear)
const IDLE_COST_PER_DAY     = 280;       // USD per idle day (depreciation + insurance)
const DRIVER_COST_PER_DAY   = 220;       // USD per driver day
const REEFER_COST_PER_DAY   = 95;        // additional cost for refrigerated units
const MAX_DRIVER_HOURS_7D   = 56;
const IDLE_THRESHOLD_PCT    = 20;        // utilisation below this = underutilised
const OVERLOAD_THRESHOLD_PCT = 90;       // utilisation above this = overloaded
const MAX_CANDIDATES_PER_SHIPMENT = 5;

// Score weights (must sum to 1.0)
const WEIGHTS = {
  distance:     0.25,
  capacity:     0.25,
  availability: 0.20,
  cold_chain:   0.15,
  eta:          0.10,
  route:        0.05,
};

// ── Geo helpers ───────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a     =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function roadDistance(lat1, lon1, lat2, lon2) {
  return haversine(lat1, lon1, lat2, lon2) * ROAD_FACTOR;
}

// ── Individual scorers (each returns 0–100) ───────────────────────────────────

function scoreDistance(assetLat, assetLon, originLat, originLon) {
  if (!assetLat || !assetLon || !originLat || !originLon) return 50;
  const km = roadDistance(assetLat, assetLon, originLat, originLon);
  // Perfect = 0 km → 100; 2000 km → 0; linear decay
  return Math.max(0, Math.round(100 - (km / 2000) * 100));
}

function scoreCapacity(asset, shipment) {
  const weightFit  = shipment.cargo_weight_kg
    ? (asset.capacity_kg >= shipment.cargo_weight_kg ? 100 : 0)
    : 100;
  const volumeFit  = shipment.cargo_volume_m3
    ? (asset.capacity_m3 >= shipment.cargo_volume_m3 ? 100 : 0)
    : 100;
  return Math.round((weightFit + volumeFit) / 2);
}

function scoreColdChain(asset, shipment) {
  if (!shipment.is_cold_chain) return 100;          // non-cold → any asset ok
  if (!asset.is_refrigerated)  return 0;            // cold needed, no reefer → disqualified
  const minOk = asset.temp_min_celsius <= shipment.temp_min_celsius;
  const maxOk = asset.temp_max_celsius >= shipment.temp_max_celsius;
  return (minOk && maxOk) ? 100 : (minOk || maxOk) ? 50 : 0;
}

function scoreAvailability(driver) {
  if (!driver) return 60;                           // no driver needed (sea/air freight)
  const hoursLeft = (driver.max_hours_7d - driver.hours_driven_7d) || 0;
  if (driver.status !== 'available') return 0;
  if (hoursLeft <= 0)                return 0;
  return Math.min(100, Math.round((hoursLeft / MAX_DRIVER_HOURS_7D) * 100));
}

function scoreETA(assetLat, assetLon, originLat, originLon, scheduledPickup) {
  if (!assetLat || !assetLon || !originLat || !originLon || !scheduledPickup) return 60;
  const km     = roadDistance(assetLat, assetLon, originLat, originLon);
  const hoursToOrigin = km / 70;                    // 70 km/h average
  const etaAtOrigin   = new Date(Date.now() + hoursToOrigin * 3600000);
  const pickup        = new Date(scheduledPickup);
  const bufferHours   = (pickup - etaAtOrigin) / 3600000;
  if (bufferHours >= 12) return 100;
  if (bufferHours >= 4)  return 80;
  if (bufferHours >= 0)  return 50;
  return 0;                                         // already late to pickup
}

function scoreRoute(assetLon, destLon) {
  if (!assetLon || !destLon) return 50;
  // Reward assets already heading in the right longitude direction (rough dead-mile proxy)
  const delta = Math.abs(parseFloat(assetLon) - parseFloat(destLon));
  return Math.max(0, Math.round(100 - (delta / 180) * 100));
}

// ── Composite score ───────────────────────────────────────────────────────────

function computeTotalScore(scores) {
  return parseFloat(
    (
      scores.distance     * WEIGHTS.distance     +
      scores.capacity     * WEIGHTS.capacity     +
      scores.availability * WEIGHTS.availability +
      scores.cold_chain   * WEIGHTS.cold_chain   +
      scores.eta          * WEIGHTS.eta          +
      scores.route        * WEIGHTS.route
    ).toFixed(2)
  );
}

// ── Cost calculations ─────────────────────────────────────────────────────────

function estimateAssignmentCost(distanceToOriginKm, legDistanceKm, isRefrigerated, driverNeeded) {
  const positioningCost = distanceToOriginKm * ROAD_COST_PER_KM;
  const legDays         = Math.ceil((legDistanceKm || 0) / (70 * 24));
  const driverCost      = driverNeeded ? legDays * DRIVER_COST_PER_DAY : 0;
  const reeferCost      = isRefrigerated ? legDays * REEFER_COST_PER_DAY : 0;
  return parseFloat((positioningCost + driverCost + reeferCost).toFixed(2));
}

function estimateIdleBaselineCost(idleDays) {
  return parseFloat((idleDays * IDLE_COST_PER_DAY).toFixed(2));
}

function estimateProjectedUtilisation(currentActiveDays, legDistanceKm) {
  const legDays = Math.ceil((legDistanceKm || 500) / (70 * 24));
  return Math.min(100, Math.round(((currentActiveDays + legDays) / 30) * 100));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATA FETCHERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getIdleAssets(companyId) {
  const { rows } = await db.query(
    `SELECT fa.*,
            ts.last_update_at,
            ts.shipment_id    AS active_shipment_id,
            EXTRACT(DAY FROM NOW() - COALESCE(ts.last_update_at, fa.updated_at)) AS idle_days
     FROM fleet_assets fa
     LEFT JOIN tracking_snapshots ts ON ts.asset_id = fa.id
     WHERE fa.company_id = $1
       AND fa.status IN ('idle','available')
       AND fa.status != 'decommissioned'
     ORDER BY fa.utilisation_pct ASC NULLS FIRST, idle_days DESC`,
    [companyId]
  );
  return rows;
}

async function getAvailableDrivers(companyId) {
  const { rows } = await db.query(
    `SELECT d.*,
            (d.max_hours_7d - d.hours_driven_7d) AS hours_remaining,
            -- Check whether driver is not currently on an active assignment
            NOT EXISTS (
              SELECT 1 FROM fleet_assignments fa
              WHERE fa.driver_id = d.id AND fa.is_active = TRUE
            ) AS is_free
     FROM drivers d
     WHERE d.company_id = $1
       AND d.status = 'available'
       AND d.license_expiry > CURRENT_DATE
       AND (d.max_hours_7d - d.hours_driven_7d) > 4
     ORDER BY (d.max_hours_7d - d.hours_driven_7d) DESC`,
    [companyId]
  );
  return rows.filter((d) => d.is_free);
}

async function getUnderutilisedAssets(companyId) {
  const { rows } = await db.query(
    `SELECT fa.*,
            COALESCE(fa.utilisation_pct, 0) AS utilisation_pct,
            COUNT(fa2.id) FILTER (WHERE fa2.assigned_at >= NOW() - INTERVAL '30 days') AS assignments_30d
     FROM fleet_assets fa
     LEFT JOIN fleet_assignments fa2 ON fa2.asset_id = fa.id
     WHERE fa.company_id = $1
       AND fa.status != 'decommissioned'
       AND COALESCE(fa.utilisation_pct, 0) < $2
     GROUP BY fa.id
     ORDER BY fa.utilisation_pct ASC NULLS FIRST`,
    [companyId, IDLE_THRESHOLD_PCT]
  );
  return rows;
}

async function getOverloadedRoutes(companyId) {
  const { rows } = await db.query(
    `SELECT
       l.id, l.shipment_id, l.leg_sequence, l.mode,
       l.origin_city, l.dest_city, l.distance_km,
       l.scheduled_dep_at, l.estimated_arr_at,
       s.reference AS shipment_reference,
       fa.identifier AS asset_identifier,
       fa.capacity_kg, s.cargo_weight_kg,
       CASE WHEN fa.capacity_kg > 0
            THEN ROUND((s.cargo_weight_kg / fa.capacity_kg) * 100, 1)
            ELSE NULL
       END AS load_factor_pct
     FROM shipment_legs l
     JOIN shipments s ON s.id = l.shipment_id
     JOIN fleet_assignments fass ON fass.shipment_id = s.id AND fass.is_active = TRUE
     JOIN fleet_assets fa ON fa.id = fass.asset_id
     WHERE s.company_id = $1
       AND l.status IN ('pending','active')
       AND fa.capacity_kg > 0
       AND s.cargo_weight_kg / fa.capacity_kg > $2
     ORDER BY (s.cargo_weight_kg / fa.capacity_kg) DESC`,
    [companyId, OVERLOAD_THRESHOLD_PCT / 100]
  );
  return rows;
}

async function getShipmentsNeedingAssignment(companyId) {
  const { rows } = await db.query(
    `SELECT s.*,
            -- Check no active assignment exists
            NOT EXISTS (
              SELECT 1 FROM fleet_assignments fa
              WHERE fa.shipment_id = s.id AND fa.is_active = TRUE
            ) AS needs_assignment,
            -- First pending leg
            (SELECT l.id FROM shipment_legs l
             WHERE l.shipment_id = s.id AND l.status = 'pending'
             ORDER BY l.leg_sequence LIMIT 1) AS first_pending_leg_id,
            (SELECT l.mode FROM shipment_legs l
             WHERE l.shipment_id = s.id AND l.status = 'pending'
             ORDER BY l.leg_sequence LIMIT 1) AS first_leg_mode
     FROM shipments s
     WHERE s.company_id = $1
       AND s.status IN ('booked','in_transit','delayed')
       AND NOT EXISTS (
         SELECT 1 FROM fleet_assignments fa
         WHERE fa.shipment_id = s.id AND fa.is_active = TRUE
       )
     ORDER BY s.scheduled_pickup_at ASC`,
    [companyId]
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCORE A SINGLE CANDIDATE
// ═══════════════════════════════════════════════════════════════════════════════

function scoreCandidate(shipment, asset, driver) {
  const assetLat  = parseFloat(asset.current_lat)  || null;
  const assetLon  = parseFloat(asset.current_lon)  || null;
  const origLat   = parseFloat(shipment.origin_lat) || null;
  const origLon   = parseFloat(shipment.origin_lon) || null;
  const destLon   = parseFloat(shipment.dest_lon)   || null;

  const scores = {
    distance:     scoreDistance(assetLat, assetLon, origLat, origLon),
    capacity:     scoreCapacity(asset, shipment),
    availability: scoreAvailability(driver),
    cold_chain:   scoreColdChain(asset, shipment),
    eta:          scoreETA(assetLat, assetLon, origLat, origLon, shipment.scheduled_pickup_at),
    route:        scoreRoute(assetLon, destLon),
  };

  const total = computeTotalScore(scores);

  const distKm = (assetLat && origLat)
    ? roadDistance(assetLat, assetLon, origLat, origLon)
    : null;

  const legDistKm = parseFloat(shipment.leg_distance_km) || 500;
  const idleDays  = parseFloat(asset.idle_days) || 0;
  const assignCost = estimateAssignmentCost(
    distKm || 0, legDistKm, asset.is_refrigerated, !!driver
  );
  const baselineCost  = estimateIdleBaselineCost(Math.max(idleDays, 1));
  const costSaving    = Math.max(0, baselineCost - assignCost);
  const activeDays30  = parseInt(asset.assignments_30d || 0, 10);
  const projUtil      = estimateProjectedUtilisation(activeDays30, legDistKm);

  const hoursToOrigin = distKm ? distKm / 70 : 0;
  const pickupEta     = new Date(Date.now() + hoursToOrigin * 3600000);
  const legDays       = Math.ceil(legDistKm / (70 * 24));
  const deliveryEta   = new Date(pickupEta.getTime() + legDays * 86400000);

  return {
    scores,
    total_score:              total,
    distance_to_origin_km:    distKm ? parseFloat(distKm.toFixed(2)) : null,
    estimated_pickup_eta:     pickupEta.toISOString(),
    estimated_delivery_eta:   deliveryEta.toISOString(),
    estimated_cost_usd:       assignCost,
    cost_saving_vs_current:   parseFloat(costSaving.toFixed(2)),
    expected_utilisation_pct: projUtil,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RUN FULL OPTIMISATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} companyId
 * @param {object} [opts]
 * @param {string} [opts.triggeredBy]  'system'|'user'|'disruption'
 * @param {string} [opts.userId]       who triggered (for rec attribution)
 */
async function runOptimisation(companyId, opts = {}) {
  const triggeredBy = opts.triggeredBy || 'system';

  // ── Snapshot current fleet state ─────────────────────────────────────────
  const [idleAssets, availableDrivers, undeutil, shipments, allAssets] = await Promise.all([
    getIdleAssets(companyId),
    getAvailableDrivers(companyId),
    getUnderutilisedAssets(companyId),
    getShipmentsNeedingAssignment(companyId),
    db.query(
      `SELECT id, status, utilisation_pct FROM fleet_assets
       WHERE company_id = $1 AND status != 'decommissioned'`,
      [companyId]
    ),
  ]);

  const fleetRows         = allAssets.rows;
  const totalAssets       = fleetRows.length;
  const idleCount         = fleetRows.filter((a) => ['idle','available'].includes(a.status)).length;
  const inUseCount        = fleetRows.filter((a) => a.status === 'in_use').length;
  const avgUtilBefore     = fleetRows.length
    ? parseFloat(
        (fleetRows.reduce((s, a) => s + (parseFloat(a.utilisation_pct) || 0), 0) / fleetRows.length).toFixed(2)
      )
    : 0;

  // ── Create run record ─────────────────────────────────────────────────────
  const { rows: [run] } = await db.query(
    `INSERT INTO optimisation_runs
       (company_id, triggered_by, total_assets, idle_assets, in_use_assets,
        available_drivers, avg_utilisation_before, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running')
     RETURNING *`,
    [companyId, triggeredBy, totalAssets, idleCount, inUseCount,
     availableDrivers.length, avgUtilBefore]
  );

  const allCandidates = [];
  let   totalSaving   = 0;

  // ── Match each unassigned shipment against available assets ───────────────
  for (const shipment of shipments) {
    // Determine which asset types are appropriate for this shipment's first leg
    const legMode = shipment.first_leg_mode || 'road';
    const needsReefer = shipment.is_cold_chain;

    // Get best-fit assets: prefer idle/available, same type as leg, reefer-compatible
    const { rows: candidateAssets } = await db.query(
      `SELECT fa.*,
              COALESCE(fa.utilisation_pct, 0) AS utilisation_pct,
              EXTRACT(DAY FROM NOW() - COALESCE(ts.last_update_at, fa.updated_at)) AS idle_days,
              COUNT(fass.id) FILTER (WHERE fass.assigned_at >= NOW() - INTERVAL '30 days') AS assignments_30d
       FROM fleet_assets fa
       LEFT JOIN tracking_snapshots ts ON ts.asset_id = fa.id
       LEFT JOIN fleet_assignments  fass ON fass.asset_id = fa.id
       WHERE fa.company_id = $1
         AND fa.status IN ('available','idle')
         AND ($2 = FALSE OR fa.is_refrigerated = TRUE)
         AND fa.capacity_kg >= COALESCE($3, 0)
       GROUP BY fa.id, ts.last_update_at
       ORDER BY fa.utilisation_pct ASC NULLS FIRST, idle_days DESC
       LIMIT 10`,
      [companyId, needsReefer, shipment.cargo_weight_kg || 0]
    );

    // Score every (asset × driver) combination
    const scored = [];
    for (const asset of candidateAssets) {
      // Try pairing with each available driver, plus the no-driver option
      const driverCandidates = legMode !== 'road' ? [null] : [...availableDrivers, null];

      for (const driver of driverCandidates) {
        const result = scoreCandidate(shipment, asset, driver);
        if (result.scores.capacity === 0)    continue; // hard disqualify
        if (result.scores.cold_chain === 0)  continue; // hard disqualify
        if (driver && result.scores.availability === 0) continue;

        scored.push({ asset, driver, ...result });
      }
    }

    // Take top N by total_score
    scored.sort((a, b) => b.total_score - a.total_score);
    const top = scored.slice(0, MAX_CANDIDATES_PER_SHIPMENT);

    for (const cand of top) {
      allCandidates.push({ shipment, ...cand });
      totalSaving += cand.cost_saving_vs_current || 0;
    }
  }

  // ── Persist candidates ────────────────────────────────────────────────────
  const insertedIds = [];
  for (const c of allCandidates) {
    const { rows: [row] } = await db.query(
      `INSERT INTO assignment_candidates
         (run_id, company_id, shipment_id, asset_id, driver_id,
          score_distance, score_capacity, score_availability,
          score_cold_chain, score_route, score_eta, total_score,
          distance_to_origin_km, estimated_pickup_eta, estimated_delivery_eta,
          expected_utilisation_pct, estimated_cost_usd, cost_saving_vs_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        run.id, companyId, c.shipment.id, c.asset.id, c.driver?.id || null,
        c.scores.distance, c.scores.capacity, c.scores.availability,
        c.scores.cold_chain, c.scores.route, c.scores.eta, c.total_score,
        c.distance_to_origin_km, c.estimated_pickup_eta, c.estimated_delivery_eta,
        c.expected_utilisation_pct, c.estimated_cost_usd, c.cost_saving_vs_current,
      ]
    );
    insertedIds.push(row.id);
  }

  // ── Also create optimization_recommendations for high-score matches ───────
  let recCount = 0;
  for (const c of allCandidates) {
    if (c.total_score < 60) continue;
    await db.query(
      `INSERT INTO optimization_recommendations
         (shipment_id, recommendation_type, status, title, description, rationale,
          estimated_saving_usd, estimated_cost_usd,
          time_saving_hours, confidence_score, generated_by,
          action_payload, expires_at)
       VALUES ($1,'reassign_asset','pending',$2,$3,$4,$5,$6,$7,$8,'system',$9,NOW() + INTERVAL '48 hours')
       ON CONFLICT DO NOTHING`,
      [
        c.shipment.id,
        `Assign ${c.asset.identifier} to ${c.shipment.reference}`,
        `Asset ${c.asset.identifier} (${c.asset.asset_type}) scored ${c.total_score}/100 for shipment ${c.shipment.reference}. ` +
        `Distance to origin: ${c.distance_to_origin_km ? c.distance_to_origin_km.toFixed(0) + ' km' : 'unknown'}.`,
        `Asset idle ${Math.round(parseFloat(c.asset.idle_days || 0))} days. Utilisation will rise from ${c.asset.utilisation_pct}% to ~${c.expected_utilisation_pct}%.`,
        c.cost_saving_vs_current,
        c.estimated_cost_usd,
        null,
        c.total_score,
        JSON.stringify({
          candidate_id: insertedIds[allCandidates.indexOf(c)],
          asset_id:     c.asset.id,
          driver_id:    c.driver?.id || null,
          run_id:       run.id,
        }),
      ]
    );
    recCount++;
  }

  // ── Estimate after-state utilisation ─────────────────────────────────────
  // Best candidate per shipment improves one asset's utilisation
  const bestPerShipment = new Map();
  for (const c of allCandidates) {
    const existing = bestPerShipment.get(c.shipment.id);
    if (!existing || c.total_score > existing.total_score) {
      bestPerShipment.set(c.shipment.id, c);
    }
  }

  let projectedUtilSum = fleetRows.reduce((s, a) => s + (parseFloat(a.utilisation_pct) || 0), 0);
  for (const [, c] of bestPerShipment) {
    const current = parseFloat(c.asset.utilisation_pct) || 0;
    projectedUtilSum += (c.expected_utilisation_pct - current);
  }
  const avgUtilAfter = fleetRows.length
    ? parseFloat((projectedUtilSum / fleetRows.length).toFixed(2))
    : 0;

  // ── Finalise run record ───────────────────────────────────────────────────
  await db.query(
    `UPDATE optimisation_runs
     SET avg_utilisation_after  = $1,
         total_cost_saving_usd  = $2,
         total_recommendations  = $3,
         status                 = 'completed'
     WHERE id = $4`,
    [avgUtilAfter, parseFloat(totalSaving.toFixed(2)), recCount, run.id]
  );

  // ── Broadcast ─────────────────────────────────────────────────────────────
  socketManager.toCompany(companyId, 'fleet:optimisation_complete', {
    run_id:                run.id,
    triggered_by:          triggeredBy,
    shipments_analysed:    shipments.length,
    candidates_generated:  allCandidates.length,
    recommendations:       recCount,
    avg_utilisation_before: avgUtilBefore,
    avg_utilisation_after:  avgUtilAfter,
    utilisation_delta:     parseFloat((avgUtilAfter - avgUtilBefore).toFixed(2)),
    total_cost_saving_usd: parseFloat(totalSaving.toFixed(2)),
    idle_assets:           idleCount,
    available_drivers:     availableDrivers.length,
  });

  return {
    run_id:                 run.id,
    run_at:                 run.run_at,
    triggered_by:           triggeredBy,
    fleet_snapshot: {
      total_assets:        totalAssets,
      idle_assets:         idleCount,
      in_use_assets:       inUseCount,
      underutilised_assets: undeutil.length,
      available_drivers:   availableDrivers.length,
    },
    utilisation: {
      before:  avgUtilBefore,
      after:   avgUtilAfter,
      delta:   parseFloat((avgUtilAfter - avgUtilBefore).toFixed(2)),
    },
    cost_saving_usd:       parseFloat(totalSaving.toFixed(2)),
    shipments_analysed:    shipments.length,
    candidates_generated:  allCandidates.length,
    recommendations:       recCount,
    // Top recommendation per shipment for quick display
    top_matches: [...bestPerShipment.values()].map((c) => ({
      shipment_id:          c.shipment.id,
      shipment_reference:   c.shipment.reference,
      asset_id:             c.asset.id,
      asset_identifier:     c.asset.identifier,
      driver_id:            c.driver?.id || null,
      driver_name:          c.driver?.full_name || null,
      total_score:          c.total_score,
      distance_to_origin_km: c.distance_to_origin_km,
      cost_saving_usd:      c.cost_saving_vs_current,
      utilisation_before:   parseFloat(c.asset.utilisation_pct || 0),
      utilisation_after:    c.expected_utilisation_pct,
      estimated_pickup_eta: c.estimated_pickup_eta,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACCEPT / REJECT CANDIDATE
// ═══════════════════════════════════════════════════════════════════════════════

async function acceptCandidate(candidateId, userId) {
  const { rows: [cand] } = await db.query(
    `SELECT ac.*, s.company_id, s.reference, s.first_pending_leg_id
     FROM assignment_candidates ac
     JOIN shipments s ON s.id = ac.shipment_id
     WHERE ac.id = $1 AND ac.status = 'pending'`,
    [candidateId]
  );
  if (!cand) throw Object.assign(new Error('Candidate not found or already actioned'), { status: 404 });

  await db.withTransaction(async (client) => {
    // Mark this candidate accepted
    await client.query(
      `UPDATE assignment_candidates SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
      [candidateId]
    );
    // Supersede other candidates for same shipment
    await client.query(
      `UPDATE assignment_candidates SET status = 'superseded'
       WHERE shipment_id = $1 AND id != $2 AND status = 'pending'`,
      [cand.shipment_id, candidateId]
    );
    // Create the fleet assignment
    await client.query(
      `INSERT INTO fleet_assignments
         (shipment_id, leg_id, asset_id, driver_id, notes)
       VALUES ($1, $2, $3, $4, 'Created by fleet optimiser')`,
      [cand.shipment_id, cand.first_pending_leg_id || null, cand.asset_id, cand.driver_id || null]
    );
    // Set asset to in_use
    await client.query(
      `UPDATE fleet_assets SET status = 'in_use', updated_at = NOW() WHERE id = $1`,
      [cand.asset_id]
    );
    // Set driver to on_duty
    if (cand.driver_id) {
      await client.query(
        `UPDATE drivers SET status = 'on_duty', updated_at = NOW() WHERE id = $1`,
        [cand.driver_id]
      );
    }
    // Accept linked recommendation
    await client.query(
      `UPDATE optimization_recommendations
       SET status = 'accepted', reviewed_by = $1, reviewed_at = NOW()
       WHERE action_payload->>'candidate_id' = $2`,
      [userId || null, candidateId]
    );
    // Update run accepted count
    await client.query(
      `UPDATE optimisation_runs
       SET accepted_recommendations = accepted_recommendations + 1
       WHERE id = $1`,
      [cand.run_id]
    );
  });

  socketManager.toCompany(cand.company_id, 'fleet:assignment_accepted', {
    candidate_id:  candidateId,
    shipment_id:   cand.shipment_id,
    asset_id:      cand.asset_id,
    driver_id:     cand.driver_id,
    cost_saving:   cand.cost_saving_vs_current,
  });

  return { ok: true, candidateId };
}

async function rejectCandidate(candidateId, reason) {
  const { rows: [cand] } = await db.query(
    `UPDATE assignment_candidates
     SET status = 'rejected', rejected_at = NOW(), rejection_reason = $2
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [candidateId, reason || null]
  );
  if (!cand) throw Object.assign(new Error('Candidate not found or already actioned'), { status: 404 });

  // Reject linked recommendation
  await db.query(
    `UPDATE optimization_recommendations
     SET status = 'rejected', reviewed_at = NOW()
     WHERE action_payload->>'candidate_id' = $1`,
    [candidateId]
  );

  return { ok: true, candidate: cand };
}

// ── Get run report ────────────────────────────────────────────────────────────

async function getRunReport(runId) {
  const { rows: [run] } = await db.query(
    'SELECT * FROM optimisation_runs WHERE id = $1',
    [runId]
  );
  if (!run) return null;

  const { rows: candidates } = await db.query(
    `SELECT ac.*,
            s.reference AS shipment_reference, s.cargo_description,
            s.origin_city, s.destination_city, s.cargo_value_usd,
            fa.identifier AS asset_identifier, fa.asset_type, fa.status AS asset_status,
            d.full_name AS driver_name
     FROM assignment_candidates ac
     JOIN shipments s    ON s.id   = ac.shipment_id
     JOIN fleet_assets fa ON fa.id = ac.asset_id
     LEFT JOIN drivers d  ON d.id  = ac.driver_id
     WHERE ac.run_id = $1
     ORDER BY ac.total_score DESC`,
    [runId]
  );

  return { run, candidates };
}

module.exports = {
  runOptimisation,
  getIdleAssets,
  getAvailableDrivers,
  getUnderutilisedAssets,
  getOverloadedRoutes,
  getShipmentsNeedingAssignment,
  scoreCandidate,
  acceptCandidate,
  rejectCandidate,
  getRunReport,
};
