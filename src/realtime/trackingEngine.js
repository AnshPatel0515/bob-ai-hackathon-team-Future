'use strict';
/**
 * TrackingEngine
 * ==============
 * Pure business-logic module.  No HTTP, no sockets.
 * All public methods:
 *   processLocationUpdate(payload)  – main entry point from REST + IoT
 *   recalculateETA(assetId)        – forced recalc (e.g. after disruption)
 *   refreshUtilisation(companyId)  – called by periodic job
 *   getFleetAvailability(companyId)
 *
 * ETA algorithm
 * ─────────────
 *  1. Compute remaining straight-line distance to leg destination.
 *  2. Apply a road-factor multiplier (1.35 default) to estimate road distance.
 *  3. Use rolling-average speed from the last N readings (or default 70 km/h).
 *  4. Add a mode-specific buffer (sea = 0, air = 0.05, road = 0.15).
 *  5. Compare to scheduled arrival → derive delay_minutes.
 *  6. If |delta| > DELAY_THRESHOLD_MINUTES → mark delayed, fire alert + broadcast.
 */

const db            = require('../config/db');
const socketManager = require('./socketManager');

// ── Constants ─────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM         = 6371;
const ROAD_FACTOR             = 1.35;   // straight-line → road distance multiplier
const DEFAULT_SPEED_KMH       = { road: 70, sea: 22, air: 820, rail: 90, intermodal: 60 };
const MODE_BUFFER_FACTOR      = { road: 0.15, sea: 0.05, air: 0.03, rail: 0.08, intermodal: 0.12 };
const DELAY_THRESHOLD_MINUTES = 30;     // only flag delay if >30 min off schedule
const ROLLING_WINDOW_READINGS = 5;      // readings to average speed over
const NO_SIGNAL_ALERT_THRESHOLD = 3;    // consecutive missed pings before alert

// ── Haversine distance (km) ───────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Rolling average speed ─────────────────────────────────────────────────────

async function getRollingSpeed(assetId, mode) {
  const { rows } = await db.query(
    `SELECT speed_kmh FROM location_updates
     WHERE asset_id = $1 AND speed_kmh IS NOT NULL AND speed_kmh > 0
     ORDER BY received_at DESC LIMIT $2`,
    [assetId, ROLLING_WINDOW_READINGS]
  );
  if (!rows.length) return DEFAULT_SPEED_KMH[mode] || 70;
  const avg = rows.reduce((s, r) => s + parseFloat(r.speed_kmh), 0) / rows.length;
  return avg > 0 ? avg : DEFAULT_SPEED_KMH[mode] || 70;
}

// ── Active leg for an asset ───────────────────────────────────────────────────

async function getActiveLeg(assetId) {
  const { rows } = await db.query(
    `SELECT l.*, fa.shipment_id AS assignment_shipment_id
     FROM fleet_assignments fa
     JOIN shipment_legs l ON l.id = fa.leg_id
     WHERE fa.asset_id = $1
       AND fa.is_active = TRUE
       AND l.status     = 'active'
     LIMIT 1`,
    [assetId]
  );
  return rows[0] || null;
}

// ── Fetch snapshot + asset context ───────────────────────────────────────────

async function getAssetContext(assetId) {
  const { rows } = await db.query(
    `SELECT fa.id AS asset_id, fa.company_id, fa.status AS asset_status,
            fa.utilisation_pct,
            ts.shipment_id, ts.latitude, ts.longitude,
            ts.current_leg_id, ts.estimated_arrival_at,
            ts.scheduled_arrival_at, ts.delay_minutes, ts.is_delayed,
            ts.consecutive_no_signal, ts.last_update_at
     FROM fleet_assets fa
     LEFT JOIN tracking_snapshots ts ON ts.asset_id = fa.id
     WHERE fa.id = $1`,
    [assetId]
  );
  return rows[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY: processLocationUpdate
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Called when a GPS update arrives (from REST POST or IoT socket event).
 * Orchestrates: persist → ETA calc → delay detect → snapshot upsert → broadcast.
 *
 * @param {object} payload
 * @param {string} payload.asset_id
 * @param {number} payload.latitude
 * @param {number} payload.longitude
 * @param {number} [payload.speed_kmh]
 * @param {number} [payload.heading_deg]
 * @param {number} [payload.altitude_m]
 * @param {number} [payload.accuracy_m]
 * @param {string} [payload.shipment_id]   – override; auto-resolved if omitted
 * @param {string} [payload.source]        – 'gps'|'manual'|'simulated'
 * @param {object} [payload.raw_payload]
 */
async function processLocationUpdate(payload) {
  const {
    asset_id,
    latitude,
    longitude,
    speed_kmh       = null,
    heading_deg     = null,
    altitude_m      = null,
    accuracy_m      = null,
    source          = 'gps',
    raw_payload     = null,
  } = payload;

  // 1. Fetch context (company, current shipment, existing snapshot)
  const ctx = await getAssetContext(asset_id);
  if (!ctx) throw new Error(`Asset ${asset_id} not found`);

  const shipment_id = payload.shipment_id || ctx.shipment_id || null;

  // 2. Compute distance from last known position
  let distanceLegKm  = null;
  let distanceTotalKm = null;
  if (ctx.latitude && ctx.longitude) {
    distanceLegKm = haversine(
      parseFloat(ctx.latitude), parseFloat(ctx.longitude),
      latitude, longitude
    );
    distanceTotalKm = distanceLegKm; // will be accumulated via snapshot
  }

  // 3. Persist raw location update
  const { rows: [locRow] } = await db.query(
    `INSERT INTO location_updates
       (asset_id, shipment_id, received_at, latitude, longitude,
        altitude_m, heading_deg, speed_kmh, accuracy_m,
        distance_leg_km, source, raw_payload)
     VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, received_at`,
    [
      asset_id, shipment_id, latitude, longitude,
      altitude_m, heading_deg, speed_kmh, accuracy_m,
      distanceLegKm,
      source,
      raw_payload ? JSON.stringify(raw_payload) : null,
    ]
  );

  // 4. Update fleet_assets current position
  await db.query(
    `UPDATE fleet_assets
     SET current_lat = $1, current_lon = $2,
         current_location_desc = NULL,
         updated_at = NOW()
     WHERE id = $3`,
    [latitude, longitude, asset_id]
  );

  // 5. ETA calculation
  const etaResult = await calculateETA(asset_id, latitude, longitude, speed_kmh, shipment_id);

  // 6. Detect delay
  const delayResult = detectDelay(etaResult);

  // 7. Upsert tracking snapshot
  await db.query(
    `INSERT INTO tracking_snapshots (
       asset_id, shipment_id,
       latitude, longitude, heading_deg, speed_kmh,
       current_leg_id,
       leg_origin_lat, leg_origin_lon, leg_dest_lat, leg_dest_lon,
       leg_distance_km, leg_progress_pct,
       estimated_arrival_at, scheduled_arrival_at, eta_confidence_pct,
       delay_minutes, is_delayed, delay_reason,
       utilisation_pct, last_update_at, consecutive_no_signal
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),0)
     ON CONFLICT (asset_id) DO UPDATE SET
       shipment_id          = EXCLUDED.shipment_id,
       latitude             = EXCLUDED.latitude,
       longitude            = EXCLUDED.longitude,
       heading_deg          = EXCLUDED.heading_deg,
       speed_kmh            = EXCLUDED.speed_kmh,
       current_leg_id       = EXCLUDED.current_leg_id,
       leg_origin_lat       = EXCLUDED.leg_origin_lat,
       leg_origin_lon       = EXCLUDED.leg_origin_lon,
       leg_dest_lat         = EXCLUDED.leg_dest_lat,
       leg_dest_lon         = EXCLUDED.leg_dest_lon,
       leg_distance_km      = EXCLUDED.leg_distance_km,
       leg_progress_pct     = EXCLUDED.leg_progress_pct,
       estimated_arrival_at = EXCLUDED.estimated_arrival_at,
       scheduled_arrival_at = EXCLUDED.scheduled_arrival_at,
       eta_confidence_pct   = EXCLUDED.eta_confidence_pct,
       delay_minutes        = EXCLUDED.delay_minutes,
       is_delayed           = EXCLUDED.is_delayed,
       delay_reason         = EXCLUDED.delay_reason,
       utilisation_pct      = EXCLUDED.utilisation_pct,
       last_update_at       = NOW(),
       consecutive_no_signal = 0`,
    [
      asset_id, shipment_id,
      latitude, longitude, heading_deg, speed_kmh,
      etaResult.legId,
      etaResult.legOriginLat, etaResult.legOriginLon,
      etaResult.legDestLat,   etaResult.legDestLon,
      etaResult.legDistanceKm, etaResult.progressPct,
      etaResult.estimatedArrival, etaResult.scheduledArrival,
      etaResult.confidencePct,
      delayResult.delayMinutes, delayResult.isDelayed, delayResult.reason,
      ctx.utilisation_pct || 0,
    ]
  );

  // 8. Log ETA history if ETA changed significantly (>5 min)
  if (etaResult.estimatedArrival) {
    const prevEta = ctx.estimated_arrival_at
      ? new Date(ctx.estimated_arrival_at)
      : null;
    const newEta  = new Date(etaResult.estimatedArrival);
    const deltaMins = prevEta
      ? (newEta - prevEta) / 60000
      : null;

    if (!prevEta || Math.abs(deltaMins) > 5) {
      await db.query(
        `INSERT INTO eta_history
           (shipment_id, asset_id, previous_eta, new_eta, delta_minutes, trigger_reason, confidence_pct)
         VALUES ($1,$2,$3,$4,$5,'gps_update',$6)`,
        [
          shipment_id, asset_id,
          prevEta ? prevEta.toISOString() : null,
          newEta.toISOString(),
          deltaMins !== null ? deltaMins.toFixed(2) : null,
          etaResult.confidencePct,
        ]
      );
    }
  }

  // 9. Handle delay state changes
  const wasDelayed = ctx.is_delayed;
  if (delayResult.isDelayed && !wasDelayed && shipment_id) {
    await handleDelayOnset(asset_id, shipment_id, ctx.company_id, delayResult);
  } else if (!delayResult.isDelayed && wasDelayed && shipment_id) {
    // Delay resolved
    await db.query(
      `UPDATE shipments SET status = 'in_transit', updated_at = NOW()
       WHERE id = $1 AND status = 'delayed'`,
      [shipment_id]
    );
  }

  // 10. Broadcast
  const broadcastPayload = buildBroadcastPayload(
    asset_id, shipment_id, ctx.company_id, locRow,
    { latitude, longitude, heading_deg, speed_kmh },
    etaResult, delayResult
  );
  socketManager.broadcastTrackingUpdate(ctx.company_id, shipment_id, asset_id, broadcastPayload);

  if (etaResult.estimatedArrival) {
    socketManager.broadcastETAUpdate(ctx.company_id, shipment_id, {
      shipment_id,
      asset_id,
      estimated_arrival_at: etaResult.estimatedArrival,
      delay_minutes:        delayResult.delayMinutes,
      is_delayed:           delayResult.isDelayed,
      confidence_pct:       etaResult.confidencePct,
    });
  }

  return broadcastPayload;
}

// ── ETA calculation ───────────────────────────────────────────────────────────

async function calculateETA(assetId, currentLat, currentLon, currentSpeedKmh, shipmentId) {
  const result = {
    legId: null,
    legOriginLat: null, legOriginLon: null,
    legDestLat: null,   legDestLon: null,
    legDistanceKm: null,
    progressPct: null,
    estimatedArrival: null,
    scheduledArrival: null,
    confidencePct: null,
    remainingKm: null,
  };

  // Find the active leg
  const leg = await getActiveLeg(assetId);
  if (!leg) return result;

  result.legId          = leg.id;
  result.legOriginLat   = parseFloat(leg.origin_lat)  || null;
  result.legOriginLon   = parseFloat(leg.origin_lon)  || null;
  result.legDestLat     = parseFloat(leg.dest_lat)    || null;
  result.legDestLon     = parseFloat(leg.dest_lon)    || null;
  result.scheduledArrival = leg.estimated_arr_at || null;

  if (!result.legDestLat || !result.legDestLon) return result;

  // Straight-line remaining + road factor
  const straightLineKm = haversine(currentLat, currentLon, result.legDestLat, result.legDestLon);
  const mode           = leg.mode || 'road';
  const roadFactor     = (mode === 'sea' || mode === 'air') ? 1.0 : ROAD_FACTOR;
  const remainingKm    = straightLineKm * roadFactor;
  result.remainingKm   = remainingKm;

  // Total leg distance (for progress %)
  if (result.legOriginLat && result.legOriginLon) {
    const totalStraight = haversine(
      result.legOriginLat, result.legOriginLon,
      result.legDestLat,   result.legDestLon
    );
    const totalKm = totalStraight * roadFactor;
    result.legDistanceKm = totalKm;
    const travelledKm    = Math.max(0, totalKm - remainingKm);
    result.progressPct   = Math.min(100, Math.round((travelledKm / totalKm) * 100));
  }

  // Speed: prefer live reading, fall back to rolling avg, then mode default
  const effectiveSpeed = (currentSpeedKmh && currentSpeedKmh > 2)
    ? currentSpeedKmh
    : await getRollingSpeed(assetId, mode);

  // ETA = now + (remaining / speed) * (1 + buffer)
  const buffer      = MODE_BUFFER_FACTOR[mode] || 0.15;
  const hoursLeft   = (remainingKm / effectiveSpeed) * (1 + buffer);
  const etaMs       = Date.now() + hoursLeft * 3600000;
  result.estimatedArrival = new Date(etaMs).toISOString();

  // Confidence: higher with more readings, penalised for slow/no speed data
  const speedConfidence = (currentSpeedKmh && currentSpeedKmh > 2) ? 85 : 65;
  result.confidencePct  = Math.max(40, Math.min(95, speedConfidence - straightLineKm / 100));

  return result;
}

// ── Delay detection ───────────────────────────────────────────────────────────

function detectDelay(etaResult) {
  if (!etaResult.estimatedArrival || !etaResult.scheduledArrival) {
    return { isDelayed: false, delayMinutes: 0, reason: null };
  }

  const eta       = new Date(etaResult.estimatedArrival);
  const scheduled = new Date(etaResult.scheduledArrival);
  const deltaMs   = eta - scheduled;
  const deltaMins = deltaMs / 60000;

  if (deltaMins > DELAY_THRESHOLD_MINUTES) {
    return {
      isDelayed:     true,
      delayMinutes:  Math.round(deltaMins),
      reason:        `ETA ${Math.round(deltaMins)} min later than scheduled`,
    };
  }

  return { isDelayed: false, delayMinutes: Math.max(0, Math.round(deltaMins)), reason: null };
}

// ── Delay onset handler ───────────────────────────────────────────────────────

async function handleDelayOnset(assetId, shipmentId, companyId, delayResult) {
  // Mark shipment as delayed
  await db.query(
    `UPDATE shipments SET status = 'delayed', delay_hours = $1, updated_at = NOW()
     WHERE id = $2 AND status NOT IN ('delivered','cancelled')`,
    [(delayResult.delayMinutes / 60).toFixed(2), shipmentId]
  );

  // Create alert
  const { rows: [alert] } = await db.query(
    `INSERT INTO alerts (alert_type, priority, title, message, shipment_id, asset_id)
     VALUES ('eta_delay','high',
             $1, $2, $3, $4)
     RETURNING id`,
    [
      `Shipment Delay Detected — ${Math.round(delayResult.delayMinutes)} min behind schedule`,
      `Asset ${assetId} is running ${Math.round(delayResult.delayMinutes)} minutes late. ${delayResult.reason || ''}`,
      shipmentId, assetId,
    ]
  );

  // Broadcast
  socketManager.broadcastDelayDetected(companyId, shipmentId, assetId, {
    shipment_id:    shipmentId,
    asset_id:       assetId,
    delay_minutes:  delayResult.delayMinutes,
    reason:         delayResult.reason,
    alert_id:       alert.id,
  });

  socketManager.broadcastAlert(companyId, shipmentId, {
    alert_id:    alert.id,
    alert_type:  'eta_delay',
    priority:    'high',
    shipment_id: shipmentId,
    message:     `Delay detected: ${Math.round(delayResult.delayMinutes)} min`,
  });
}

// ── Build broadcast payload ───────────────────────────────────────────────────

function buildBroadcastPayload(assetId, shipmentId, companyId, locRow, position, etaResult, delayResult) {
  return {
    type:            'tracking:update',
    asset_id:        assetId,
    shipment_id:     shipmentId,
    company_id:      companyId,
    location_id:     locRow.id,
    received_at:     locRow.received_at,
    position: {
      latitude:    position.latitude,
      longitude:   position.longitude,
      heading_deg: position.heading_deg,
      speed_kmh:   position.speed_kmh,
    },
    leg: {
      leg_id:        etaResult.legId,
      progress_pct:  etaResult.progressPct,
      remaining_km:  etaResult.remainingKm,
    },
    eta: {
      estimated_arrival_at: etaResult.estimatedArrival,
      scheduled_arrival_at: etaResult.scheduledArrival,
      confidence_pct:       etaResult.confidencePct,
    },
    delay: {
      is_delayed:    delayResult.isDelayed,
      delay_minutes: delayResult.delayMinutes,
      reason:        delayResult.reason,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORCED ETA RECALCULATION (called after disruption link, manual override, etc.)
// ═══════════════════════════════════════════════════════════════════════════════

async function recalculateETA(assetId, triggerReason = 'manual') {
  const ctx = await getAssetContext(assetId);
  if (!ctx || !ctx.latitude) return null;

  const etaResult   = await calculateETA(
    assetId, parseFloat(ctx.latitude), parseFloat(ctx.longitude),
    null, ctx.shipment_id
  );
  const delayResult = detectDelay(etaResult);

  if (etaResult.estimatedArrival) {
    const prevEta = ctx.estimated_arrival_at ? new Date(ctx.estimated_arrival_at) : null;
    const newEta  = new Date(etaResult.estimatedArrival);
    const deltaMins = prevEta ? (newEta - prevEta) / 60000 : null;

    await db.query(
      `UPDATE tracking_snapshots
       SET estimated_arrival_at = $1,
           delay_minutes        = $2,
           is_delayed           = $3,
           delay_reason         = $4,
           last_update_at       = NOW()
       WHERE asset_id = $5`,
      [
        etaResult.estimatedArrival,
        delayResult.delayMinutes,
        delayResult.isDelayed,
        delayResult.reason,
        assetId,
      ]
    );

    await db.query(
      `INSERT INTO eta_history
         (shipment_id, asset_id, previous_eta, new_eta, delta_minutes, trigger_reason, confidence_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        ctx.shipment_id, assetId,
        prevEta ? prevEta.toISOString() : null,
        etaResult.estimatedArrival,
        deltaMins !== null ? deltaMins.toFixed(2) : null,
        triggerReason,
        etaResult.confidencePct,
      ]
    );

    socketManager.broadcastETAUpdate(ctx.company_id, ctx.shipment_id, {
      shipment_id:          ctx.shipment_id,
      asset_id:             assetId,
      estimated_arrival_at: etaResult.estimatedArrival,
      delay_minutes:        delayResult.delayMinutes,
      is_delayed:           delayResult.isDelayed,
      confidence_pct:       etaResult.confidencePct,
      trigger_reason:       triggerReason,
    });
  }

  return { etaResult, delayResult };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILISATION CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recalculate utilisation_pct for all assets in a company.
 * Utilisation = (active_assignments_last_30d / 30) * 100
 * Stored back to fleet_assets and broadcast to company room.
 */
async function refreshUtilisation(companyId) {
  const { rows: assets } = await db.query(
    `SELECT id FROM fleet_assets WHERE company_id = $1 AND status != 'decommissioned'`,
    [companyId]
  );

  const updates = [];

  for (const asset of assets) {
    // Days with at least one active assignment in last 30 days
    const { rows: [utilRow] } = await db.query(
      `SELECT
         COUNT(DISTINCT DATE(assigned_at)) AS active_days
       FROM fleet_assignments
       WHERE asset_id = $1
         AND assigned_at >= NOW() - INTERVAL '30 days'`,
      [asset.id]
    );

    const activeDays    = parseInt(utilRow.active_days || 0, 10);
    const utilisationPct = Math.min(100, Math.round((activeDays / 30) * 100));

    await db.query(
      `UPDATE fleet_assets
       SET utilisation_pct = $1, updated_at = NOW()
       WHERE id = $2`,
      [utilisationPct, asset.id]
    );

    await db.query(
      `UPDATE tracking_snapshots
       SET utilisation_pct = $1
       WHERE asset_id = $2`,
      [utilisationPct, asset.id]
    );

    updates.push({ asset_id: asset.id, utilisation_pct: utilisationPct });
  }

  socketManager.broadcastUtilisation(companyId, {
    company_id: companyId,
    updated_at: new Date().toISOString(),
    assets:     updates,
  });

  return updates;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLEET AVAILABILITY
// ═══════════════════════════════════════════════════════════════════════════════

async function getFleetAvailability(companyId) {
  const { rows } = await db.query(
    `SELECT
       fa.id, fa.identifier, fa.asset_type,
       fa.status, fa.utilisation_pct,
       fa.is_refrigerated, fa.capacity_kg, fa.capacity_m3,
       fa.current_lat, fa.current_lon, fa.current_location_desc,
       ts.shipment_id,
       ts.latitude    AS tracked_lat,
       ts.longitude   AS tracked_lon,
       ts.speed_kmh,
       ts.is_delayed,
       ts.delay_minutes,
       ts.estimated_arrival_at,
       ts.leg_progress_pct,
       ts.last_update_at,
       s.reference    AS shipment_reference,
       s.destination_city, s.destination_country
     FROM fleet_assets fa
     LEFT JOIN tracking_snapshots ts ON ts.asset_id = fa.id
     LEFT JOIN shipments s           ON s.id = ts.shipment_id
     WHERE fa.company_id = $1
       AND fa.status != 'decommissioned'
     ORDER BY fa.status ASC, fa.identifier ASC`,
    [companyId]
  );

  const summary = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  return { assets: rows, summary };
}

// ── No-signal watchdog ────────────────────────────────────────────────────────
// Called by the periodic job to detect assets that have gone silent.

async function checkNoSignal(companyId) {
  const STALE_MINUTES = parseInt(process.env.GPS_STALE_MINUTES || '15', 10);

  const { rows } = await db.query(
    `UPDATE tracking_snapshots
     SET consecutive_no_signal = consecutive_no_signal + 1
     WHERE asset_id IN (
       SELECT id FROM fleet_assets
       WHERE company_id = $1 AND status = 'in_use'
     )
     AND last_update_at < NOW() - ($2 || ' minutes')::INTERVAL
     RETURNING asset_id, consecutive_no_signal, shipment_id`,
    [companyId, STALE_MINUTES]
  );

  for (const row of rows) {
    if (row.consecutive_no_signal >= NO_SIGNAL_ALERT_THRESHOLD) {
      // Only fire alert once (on exactly hitting the threshold)
      if (row.consecutive_no_signal === NO_SIGNAL_ALERT_THRESHOLD) {
        await db.query(
          `INSERT INTO alerts (alert_type, priority, title, message, asset_id, shipment_id)
           VALUES ('geofence_violation','medium',
                   'GPS Signal Lost', $1, $2, $3)`,
          [
            `No GPS signal from asset for over ${STALE_MINUTES * NO_SIGNAL_ALERT_THRESHOLD} minutes`,
            row.asset_id,
            row.shipment_id,
          ]
        );
        socketManager.broadcastAlert(companyId, row.shipment_id, {
          alert_type: 'geofence_violation',
          priority:   'medium',
          asset_id:   row.asset_id,
          message:    `GPS signal lost for asset`,
        });
      }
    }
  }

  return rows;
}

module.exports = {
  processLocationUpdate,
  recalculateETA,
  refreshUtilisation,
  getFleetAvailability,
  checkNoSignal,
  // Exported for testing / direct use
  haversine,
  calculateETA,
  detectDelay,
};
