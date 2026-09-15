'use strict';
/**
 * DisruptionEngine
 * ================
 * Analyses a disruption event and automatically identifies every in-flight
 * shipment that may be affected, then calculates delay, cost, and risk for each.
 *
 * Matching strategy (applied in OR — a shipment is affected if any match):
 *  1. GEO RADIUS   – shipment origin or destination within radius_km of event centre
 *  2. COUNTRY MATCH – shipment.origin_country or destination_country matches
 *  3. LEG ROUTE    – any active leg passes through the affected region
 *  4. TYPE RULES   – port strikes → shipments with sea legs via affected port
 *                    road closures → road legs in affected country
 *                    geopolitical  → all shipments transiting affected country
 *
 * Delay model (hours)
 * ───────────────────
 *  base_delay = disruption.estimated_delay_hours
 *  multiplier per severity: low 0.5 · medium 1.0 · high 1.5 · critical 2.0
 *  leg-proximity factor: direct hit 1.0, adjacent 0.5, country-only 0.3
 *
 * Cost model (USD)
 * ────────────────
 *  estimated_cost = delay_hours × daily_carrying_cost_rate
 *  daily_carrying_cost_rate = cargo_value × 0.002  (0.2% per day ÷ 24)
 *  + fixed reroute overhead per disruption type
 *
 * Risk model
 * ──────────
 *  risk_delta = severity_score × proximity_factor × cold_chain_multiplier
 */

const db            = require('../config/db');
const socketManager = require('../realtime/socketManager');

// ── Constants ─────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

const SEVERITY_MULTIPLIER = { low: 0.5, medium: 1.0, high: 1.5, critical: 2.0 };
const SEVERITY_RISK_SCORE = { low: 5,   medium: 15,  high: 30,  critical: 50  };

// Base delay overrides per disruption type (hours) when base is 0
const TYPE_BASE_DELAY = {
  weather:           12,
  port_strike:       48,
  geopolitical:      72,
  road_closure:       4,
  customs_delay:     18,
  natural_disaster:  36,
  supplier_failure:   0,
  cyber_attack:       8,
  regulatory_change: 24,
  capacity_shortage: 72,
};

// Fixed reroute overhead cost per disruption type (USD)
const TYPE_REROUTE_COST = {
  weather:           3500,
  port_strike:       8000,
  geopolitical:     25000,
  road_closure:       800,
  customs_delay:     2000,
  natural_disaster:  5000,
  supplier_failure:     0,
  cyber_attack:      1500,
  regulatory_change: 3000,
  capacity_shortage:12000,
};

// Leg modes affected by each disruption type
const TYPE_AFFECTED_MODES = {
  port_strike:       ['sea', 'intermodal'],
  weather:           ['road', 'sea', 'air', 'rail', 'intermodal'],
  road_closure:      ['road', 'intermodal'],
  natural_disaster:  ['road', 'sea', 'rail', 'intermodal'],
  geopolitical:      ['road', 'sea', 'air', 'rail', 'intermodal'],
  customs_delay:     ['sea', 'air', 'intermodal'],
  cyber_attack:      ['sea', 'air', 'intermodal'],
  regulatory_change: ['sea', 'air'],
  capacity_shortage: ['sea', 'intermodal'],
  supplier_failure:  [],
};

const COLD_CHAIN_RISK_MULTIPLIER = 1.8;

// ── Haversine ─────────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function withinRadius(lat1, lon1, lat2, lon2, radiusKm) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return false;
  return haversine(lat1, lon1, lat2, lon2) <= radiusKm;
}

// ── Impact level derivation ───────────────────────────────────────────────────

function deriveImpactLevel(delayHours, riskDelta, isColdChain) {
  const score = delayHours + riskDelta * 2 + (isColdChain ? 20 : 0);
  if (score >= 120) return 'critical';
  if (score >= 60)  return 'high';
  if (score >= 24)  return 'medium';
  if (score >  0)   return 'low';
  return 'none';
}

// ── Match reason builder ──────────────────────────────────────────────────────

function buildMatchReason(matches) {
  return matches.filter(Boolean).join('; ');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN ENTRY: assessDisruption
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assess a disruption and propagate its impact to affected shipments.
 * @param {string|object} disruptionOrId  UUID or full disruption row
 * @returns {{ affected: number, impacts: Array }}
 */
async function assessDisruption(disruptionOrId) {
  // Fetch disruption if passed as ID
  let disruption;
  if (typeof disruptionOrId === 'string') {
    const { rows } = await db.query('SELECT * FROM disruptions WHERE id = $1', [disruptionOrId]);
    if (!rows.length) throw new Error(`Disruption ${disruptionOrId} not found`);
    disruption = rows[0];
  } else {
    disruption = disruptionOrId;
  }

  if (disruption.status === 'resolved') return { affected: 0, impacts: [] };

  // Fetch all in-flight shipments (across all companies)
  const { rows: shipments } = await db.query(
    `SELECT s.id, s.reference, s.company_id, s.status,
            s.cargo_value_usd, s.is_cold_chain, s.risk_score,
            s.origin_lat, s.origin_lon, s.origin_country, s.origin_city,
            s.dest_lat, s.dest_lon, s.destination_country, s.destination_city,
            s.estimated_delivery_at, s.scheduled_pickup_at
     FROM shipments s
     WHERE s.status IN ('booked','in_transit','delayed','at_customs')`
  );

  // Fetch all active legs for these shipments
  const shipmentIds = shipments.map((s) => s.id);
  let legsByShipment = {};
  if (shipmentIds.length) {
    const { rows: legs } = await db.query(
      `SELECT * FROM shipment_legs
       WHERE shipment_id = ANY($1::uuid[])
         AND status IN ('pending','active')`,
      [shipmentIds]
    );
    legs.forEach((l) => {
      if (!legsByShipment[l.shipment_id]) legsByShipment[l.shipment_id] = [];
      legsByShipment[l.shipment_id].push(l);
    });
  }

  const baseDelay = parseFloat(disruption.estimated_delay_hours) ||
                    TYPE_BASE_DELAY[disruption.type] || 0;
  const sevMultiplier = SEVERITY_MULTIPLIER[disruption.severity] || 1;
  const affectedModes = TYPE_AFFECTED_MODES[disruption.type] || [];
  const rerouting     = TYPE_REROUTE_COST[disruption.type] || 0;
  const radiusKm      = parseFloat(disruption.radius_km) || 50;

  const impacts = [];

  for (const shipment of shipments) {
    const legs = legsByShipment[shipment.id] || [];
    const matchReasons = [];
    let proximityFactor = 0;
    let affectedLegId   = null;

    // ── 1. GEO RADIUS CHECK ────────────────────────────────────────────────
    if (disruption.affected_lat && disruption.affected_lon) {
      const dLat = parseFloat(disruption.affected_lat);
      const dLon = parseFloat(disruption.affected_lon);

      if (withinRadius(dLat, dLon, parseFloat(shipment.origin_lat), parseFloat(shipment.origin_lon), radiusKm)) {
        matchReasons.push(`Origin ${shipment.origin_city} within ${radiusKm} km radius`);
        proximityFactor = Math.max(proximityFactor, 1.0);
      }
      if (withinRadius(dLat, dLon, parseFloat(shipment.dest_lat), parseFloat(shipment.dest_lon), radiusKm)) {
        matchReasons.push(`Destination ${shipment.destination_city} within ${radiusKm} km radius`);
        proximityFactor = Math.max(proximityFactor, 1.0);
      }
    }

    // ── 2. COUNTRY MATCH ──────────────────────────────────────────────────
    if (disruption.affected_country) {
      const affCountry = disruption.affected_country.toLowerCase();
      if (shipment.origin_country?.toLowerCase() === affCountry) {
        matchReasons.push(`Origin country matches (${shipment.origin_country})`);
        proximityFactor = Math.max(proximityFactor, 0.8);
      }
      if (shipment.destination_country?.toLowerCase() === affCountry) {
        matchReasons.push(`Destination country matches (${shipment.destination_country})`);
        proximityFactor = Math.max(proximityFactor, 0.8);
      }
    }

    // ── 3. LEG ROUTE CHECK ────────────────────────────────────────────────
    for (const leg of legs) {
      // Mode compatibility
      if (affectedModes.length && !affectedModes.includes(leg.mode)) continue;

      const legHit =
        // leg origin in radius
        (disruption.affected_lat && withinRadius(
          parseFloat(disruption.affected_lat), parseFloat(disruption.affected_lon),
          parseFloat(leg.origin_lat), parseFloat(leg.origin_lon), radiusKm
        )) ||
        // leg destination in radius
        (disruption.affected_lat && withinRadius(
          parseFloat(disruption.affected_lat), parseFloat(disruption.affected_lon),
          parseFloat(leg.dest_lat), parseFloat(leg.dest_lon), radiusKm
        )) ||
        // country match on leg
        (disruption.affected_country &&
          (leg.origin_country?.toLowerCase() === disruption.affected_country.toLowerCase() ||
           leg.dest_country?.toLowerCase()   === disruption.affected_country.toLowerCase()));

      if (legHit) {
        matchReasons.push(`Leg ${leg.leg_sequence} (${leg.mode}) route passes through affected area`);
        proximityFactor = Math.max(proximityFactor, leg.status === 'active' ? 1.0 : 0.6);
        affectedLegId   = leg.id;
        break;
      }
    }

    // ── 4. TYPE-SPECIFIC RULES ─────────────────────────────────────────────
    // Port strike: match sea-leg shipments in the affected country even if no geo
    if (disruption.type === 'port_strike' && disruption.affected_country) {
      const hasSeaLeg = legs.some((l) =>
        ['sea','intermodal'].includes(l.mode) &&
        (l.origin_country?.toLowerCase() === disruption.affected_country.toLowerCase() ||
         l.dest_country?.toLowerCase()   === disruption.affected_country.toLowerCase())
      );
      if (hasSeaLeg && !matchReasons.length) {
        matchReasons.push(`Sea leg transits ${disruption.affected_country} (port strike)`);
        proximityFactor = Math.max(proximityFactor, 0.7);
      }
    }

    // Geopolitical: any shipment transiting the country
    if (disruption.type === 'geopolitical' && disruption.affected_country) {
      const transits = legs.some((l) =>
        l.origin_country?.toLowerCase() === disruption.affected_country.toLowerCase() ||
        l.dest_country?.toLowerCase()   === disruption.affected_country.toLowerCase()
      );
      if (transits && !matchReasons.length) {
        matchReasons.push(`Shipment transits affected country (${disruption.affected_country})`);
        proximityFactor = Math.max(proximityFactor, 0.5);
      }
    }

    if (!matchReasons.length) continue; // not affected

    // ── Calculate impact ──────────────────────────────────────────────────
    const delayHours = parseFloat((baseDelay * sevMultiplier * proximityFactor).toFixed(2));

    const cargoValue    = parseFloat(shipment.cargo_value_usd) || 0;
    const dailyRate     = cargoValue * 0.002; // 0.2% of cargo value per day
    const carryCost     = (delayHours / 24) * dailyRate;
    const estimatedCost = parseFloat((carryCost + rerouting * proximityFactor).toFixed(2));

    const severityRisk  = SEVERITY_RISK_SCORE[disruption.severity] || 15;
    const coldFactor    = shipment.is_cold_chain ? COLD_CHAIN_RISK_MULTIPLIER : 1;
    const riskDelta     = parseFloat(
      (severityRisk * proximityFactor * coldFactor).toFixed(2)
    );
    const impactLevel = deriveImpactLevel(delayHours, riskDelta, shipment.is_cold_chain);

    impacts.push({
      shipment,
      affectedLegId,
      delayHours,
      estimatedCost,
      riskDelta,
      impactLevel,
      matchReason: buildMatchReason(matchReasons),
    });
  }

  // ── Persist impacts & update shipments ────────────────────────────────────
  const companyAlerts = {}; // keyed by company_id to avoid duplicate broadcasts

  for (const impact of impacts) {
    const { shipment, affectedLegId, delayHours, estimatedCost, riskDelta, impactLevel, matchReason } = impact;

    // Upsert shipment_disruptions
    await db.query(
      `INSERT INTO shipment_disruptions
         (shipment_id, disruption_id, estimated_delay_hours, risk_score_delta, impact_notes, notified_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (shipment_id, disruption_id) DO UPDATE SET
         estimated_delay_hours = EXCLUDED.estimated_delay_hours,
         risk_score_delta      = EXCLUDED.risk_score_delta,
         impact_notes          = EXCLUDED.impact_notes`,
      [shipment.id, disruption.id, delayHours, riskDelta, matchReason]
    );

    // Append to impact log
    const { rows: [logRow] } = await db.query(
      `INSERT INTO disruption_impact_log
         (disruption_id, shipment_id, estimated_delay_hours, estimated_cost_usd,
          risk_score_delta, impact_level, shipment_status_at_time,
          disruption_severity, affected_leg_id, match_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        disruption.id, shipment.id, delayHours, estimatedCost,
        riskDelta, impactLevel,
        shipment.status, disruption.severity,
        affectedLegId || null, matchReason,
      ]
    );

    // Update shipment delay_hours and risk_score
    const newRisk = Math.min(100, parseFloat(shipment.risk_score || 0) + riskDelta);
    await db.query(
      `UPDATE shipments
       SET delay_hours = GREATEST(delay_hours, $1),
           risk_score  = $2,
           status      = CASE
             WHEN status = 'in_transit' AND $1 > 4 THEN 'delayed'
             ELSE status
           END,
           updated_at  = NOW()
       WHERE id = $3`,
      [delayHours, newRisk, shipment.id]
    );

    // Create alert for high / critical impact shipments
    if (['high', 'critical'].includes(impactLevel)) {
      const alertPriority = impactLevel === 'critical' ? 'critical' : 'high';
      const { rows: [alert] } = await db.query(
        `INSERT INTO alerts
           (alert_type, priority, title, message, shipment_id, disruption_id)
         VALUES ('shipment_at_risk', $1, $2, $3, $4, $5)
         RETURNING id`,
        [
          alertPriority,
          `${impactLevel.toUpperCase()} Disruption Risk — ${shipment.reference}`,
          `${disruption.title} (${disruption.type}) affects ${shipment.reference}. ` +
          `Est. delay: ${delayHours}h | Cost: $${estimatedCost.toLocaleString()} | ${matchReason}`,
          shipment.id,
          disruption.id,
        ]
      );

      if (!companyAlerts[shipment.company_id]) companyAlerts[shipment.company_id] = [];
      companyAlerts[shipment.company_id].push({
        alert_id:      alert.id,
        shipment_id:   shipment.id,
        reference:     shipment.reference,
        impact_level:  impactLevel,
        delay_hours:   delayHours,
        estimated_cost: estimatedCost,
        risk_score:    newRisk,
      });
    }

    // Auto-generate reroute recommendation for high/critical
    if (['high', 'critical'].includes(impactLevel)) {
      const recType = ['port_strike', 'geopolitical', 'natural_disaster'].includes(disruption.type)
        ? 'reroute' : 'carrier_switch';
      await db.query(
        `INSERT INTO optimization_recommendations
           (shipment_id, disruption_id, recommendation_type, title, description,
            rationale, estimated_cost_usd, time_saving_hours, confidence_score, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'system')
         ON CONFLICT DO NOTHING`,
        [
          shipment.id, disruption.id, recType,
          `Auto-recommendation: ${recType.replace('_', ' ')} for ${shipment.reference}`,
          `${disruption.title} creates a ${impactLevel} risk. Review routing alternatives to avoid ${disruption.affected_country || disruption.affected_region || 'affected area'}.`,
          matchReason,
          estimatedCost,
          delayHours,
          Math.min(90, 50 + SEVERITY_RISK_SCORE[disruption.severity]),
        ]
      );
    }
  }

  // ── Broadcast per company ────────────────────────────────────────────────
  for (const [companyId, alerts] of Object.entries(companyAlerts)) {
    socketManager.toCompany(companyId, 'disruption:impact', {
      disruption_id:   disruption.id,
      disruption_type: disruption.type,
      severity:        disruption.severity,
      title:           disruption.title,
      affected_count:  impacts.filter((i) => i.shipment.company_id === companyId).length,
      high_risk_alerts: alerts,
    });
  }

  console.log(`[DISRUPTION] Assessed ${disruption.id} (${disruption.type}/${disruption.severity}) — ${impacts.length} shipments affected`);

  return {
    disruption_id: disruption.id,
    affected:      impacts.length,
    impacts: impacts.map((i) => ({
      shipment_id:    i.shipment.id,
      reference:      i.shipment.reference,
      impact_level:   i.impactLevel,
      delay_hours:    i.delayHours,
      estimated_cost: i.estimatedCost,
      risk_delta:     i.riskDelta,
      match_reason:   i.matchReason,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PERIODIC SWEEP — re-assess all active disruptions
// ═══════════════════════════════════════════════════════════════════════════════

async function sweepActiveDisruptions() {
  const { rows } = await db.query(
    `SELECT * FROM disruptions WHERE status IN ('active','monitoring') ORDER BY severity DESC`
  );

  let totalAffected = 0;
  for (const d of rows) {
    try {
      const result = await assessDisruption(d);
      totalAffected += result.affected;
    } catch (err) {
      console.error(`[DISRUPTION] sweep error for ${d.id}:`, err.message);
    }
  }
  return { swept: rows.length, totalAffected };
}

// ── Get full impact report for a disruption ───────────────────────────────────

async function getDisruptionImpactReport(disruptionId) {
  const { rows: [disruption] } = await db.query(
    'SELECT * FROM disruptions WHERE id = $1',
    [disruptionId]
  );
  if (!disruption) return null;

  const { rows: impacts } = await db.query(
    `SELECT dil.*,
            s.reference, s.status AS current_status,
            s.cargo_value_usd, s.is_cold_chain,
            s.origin_city, s.destination_city
     FROM disruption_impact_log dil
     JOIN shipments s ON s.id = dil.shipment_id
     WHERE dil.disruption_id = $1
     ORDER BY dil.assessed_at DESC`,
    [disruptionId]
  );

  // Aggregate stats
  const stats = impacts.reduce((acc, r) => {
    acc.total_delay_hours    = (acc.total_delay_hours    || 0) + parseFloat(r.estimated_delay_hours || 0);
    acc.total_estimated_cost = (acc.total_estimated_cost || 0) + parseFloat(r.estimated_cost_usd   || 0);
    acc[`level_${r.impact_level}`] = (acc[`level_${r.impact_level}`] || 0) + 1;
    return acc;
  }, {});

  return { disruption, impacts, stats };
}

module.exports = {
  assessDisruption,
  sweepActiveDisruptions,
  getDisruptionImpactReport,
};
