'use strict';
/**
 * ColdChainMonitor
 * ================
 * Processes every incoming temperature reading for cold-chain shipments.
 * Detects breaches immediately (not at delivery).
 *
 * Pipeline per reading
 * ────────────────────
 *  1. Look up shipment temperature limits from cold_chain_state (or bootstrap it).
 *  2. Determine IN_BREACH or CLEAR.
 *  3. Update cold_chain_state in-place (last reading, breach window, integrity score).
 *  4. On breach ONSET  → open temperature_excursions row, create alert, broadcast.
 *  5. On breach UPDATE → update excursion peak/duration, re-evaluate severity.
 *  6. On breach CLOSE  → finalise excursion, recalculate risk score, broadcast recovery.
 *  7. Update shipment.risk_score.
 *
 * Severity model
 * ──────────────
 *  deviation_c ≤ 2°   AND duration < 30 min  → minor
 *  deviation_c ≤ 5°   OR  duration < 120 min → moderate
 *  deviation_c ≤ 10°  OR  duration < 360 min → severe
 *  else                                       → critical
 *
 * Cargo risk model
 * ────────────────
 *  Weighted formula using severity, cargo_value, cumulative_breach_minutes,
 *  and cold-chain type (e.g. cryogenic is weighted 3×).
 */

const db            = require('../config/db');
const socketManager = require('../realtime/socketManager');

// ── Configuration ─────────────────────────────────────────────────────────────

const CLEAR_CONSECUTIVE_READINGS = parseInt(process.env.COLD_CLEAR_READINGS || '3', 10);

const SEVERITY_THRESHOLDS = {
  minor:    { maxDeviation: 2,  maxMinutes: 30 },
  moderate: { maxDeviation: 5,  maxMinutes: 120 },
  severe:   { maxDeviation: 10, maxMinutes: 360 },
  // critical: anything above severe
};

// Risk score penalty per severity per $100K cargo value
const SEVERITY_RISK_PENALTY = {
  minor:    2,
  moderate: 8,
  severe:   20,
  critical: 40,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcDeviation(tempC, minC, maxC) {
  if (tempC > maxC) return tempC - maxC;
  if (tempC < minC) return minC - tempC;
  return 0;
}

function assignSeverity(deviationC, durationMinutes) {
  if (deviationC <= SEVERITY_THRESHOLDS.minor.maxDeviation &&
      durationMinutes <= SEVERITY_THRESHOLDS.minor.maxMinutes)  return 'minor';
  if (deviationC <= SEVERITY_THRESHOLDS.moderate.maxDeviation ||
      durationMinutes <= SEVERITY_THRESHOLDS.moderate.maxMinutes) return 'moderate';
  if (deviationC <= SEVERITY_THRESHOLDS.severe.maxDeviation ||
      durationMinutes <= SEVERITY_THRESHOLDS.severe.maxMinutes)   return 'severe';
  return 'critical';
}

function calcIntegrityScore(cumulativeMinutes, totalExcursions, cargoValueUsd) {
  // Starts at 100, penalised by breach duration and cargo value
  const durationPenalty  = Math.min(50, cumulativeMinutes / 10);
  const excursionPenalty = Math.min(30, totalExcursions * 5);
  const valuePenalty     = cargoValueUsd > 500000 ? 10 : cargoValueUsd > 100000 ? 5 : 2;
  return Math.max(0, 100 - durationPenalty - excursionPenalty - valuePenalty);
}

function calcCargoRisk(severity, cargoValueUsd, cumulativeMinutes, isCryogenic) {
  const baseScore    = SEVERITY_RISK_PENALTY[severity] || 40;
  const valueFactor  = Math.min(3, cargoValueUsd / 200000);    // 1× at $200K, caps at 3×
  const timeFactor   = Math.min(2, 1 + cumulativeMinutes / 120); // grows with cumulative minutes
  const cryoFactor   = isCryogenic ? 1.5 : 1;
  const raw          = baseScore * valueFactor * timeFactor * cryoFactor;
  return Math.min(100, Math.round(raw));
}

function buildCargoImpactNote(severity, deviationC, durationMinutes, cargoValueUsd) {
  const valueStr = `$${(cargoValueUsd / 1000).toFixed(0)}K`;
  if (severity === 'critical') {
    return `CRITICAL: ${deviationC.toFixed(1)}°C deviation for ${Math.round(durationMinutes)} min. ${valueStr} cargo at immediate spoilage risk. Batch hold recommended.`;
  }
  if (severity === 'severe') {
    return `SEVERE: ${deviationC.toFixed(1)}°C deviation for ${Math.round(durationMinutes)} min. ${valueStr} cargo degradation likely. QA review required.`;
  }
  if (severity === 'moderate') {
    return `MODERATE: ${deviationC.toFixed(1)}°C deviation for ${Math.round(durationMinutes)} min. ${valueStr} cargo may be affected. Investigate on delivery.`;
  }
  return `MINOR: ${deviationC.toFixed(1)}°C deviation for ${Math.round(durationMinutes)} min. Within acceptable tolerance window.`;
}

// ── Bootstrap cold_chain_state for a new shipment ─────────────────────────────

async function ensureState(shipmentId) {
  const { rows } = await db.query(
    `INSERT INTO cold_chain_state (
       shipment_id, temp_min_celsius, temp_max_celsius
     )
     SELECT id, temp_min_celsius, temp_max_celsius
     FROM   shipments
     WHERE  id = $1 AND is_cold_chain = TRUE
     ON CONFLICT (shipment_id) DO NOTHING
     RETURNING *`,
    [shipmentId]
  );

  if (rows.length) return rows[0];

  const { rows: existing } = await db.query(
    'SELECT * FROM cold_chain_state WHERE shipment_id = $1',
    [shipmentId]
  );
  return existing[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN ENTRY: processReading
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} opts.sensorId
 * @param {string} opts.shipmentId
 * @param {number} opts.temperatureC
 * @param {Date|string} opts.recordedAt
 * @param {number} [opts.humidityPct]
 */
async function processReading({ sensorId, shipmentId, temperatureC, recordedAt, humidityPct }) {
  // 1. Get or bootstrap state
  const state = await ensureState(shipmentId);
  if (!state) return null; // not a cold-chain shipment

  const { rows: [shipment] } = await db.query(
    `SELECT id, cargo_value_usd, cargo_description, company_id, status,
            risk_score, temp_min_celsius, temp_max_celsius
     FROM shipments WHERE id = $1`,
    [shipmentId]
  );
  if (!shipment || ['delivered', 'cancelled'].includes(shipment.status)) return null;

  const minC       = parseFloat(state.temp_min_celsius);
  const maxC       = parseFloat(state.temp_max_celsius);
  const readingAt  = new Date(recordedAt || Date.now());
  const deviationC = calcDeviation(temperatureC, minC, maxC);
  const isInBreach = deviationC > 0;
  const isCryogenic = minC < -50; // e.g. vaccines, plasma

  // 2. Determine duration if currently breaching
  let durationMinutes = 0;
  if (isInBreach && state.in_breach && state.breach_started_at) {
    durationMinutes = (readingAt - new Date(state.breach_started_at)) / 60000;
  }

  const severity = isInBreach ? assignSeverity(deviationC, durationMinutes) : null;

  // ── BREACH ONSET ──────────────────────────────────────────────────────────
  if (isInBreach && !state.in_breach) {
    await handleBreachOnset({
      state, shipment, sensorId, shipmentId,
      temperatureC, deviationC, severity, readingAt,
      minC, maxC, isCryogenic,
    });
  }

  // ── BREACH CONTINUING ─────────────────────────────────────────────────────
  else if (isInBreach && state.in_breach) {
    await handleBreachContinuing({
      state, shipment, sensorId, shipmentId,
      temperatureC, deviationC, durationMinutes, severity,
      readingAt, minC, maxC, isCryogenic,
    });
  }

  // ── READING CLEAR ─────────────────────────────────────────────────────────
  else if (!isInBreach && state.in_breach) {
    const newConsecutiveOk = (state.consecutive_ok_readings || 0) + 1;
    if (newConsecutiveOk >= CLEAR_CONSECUTIVE_READINGS) {
      await handleBreachClose({
        state, shipment, shipmentId,
        readingAt, temperatureC, isCryogenic,
      });
    } else {
      // Not enough clean readings yet — still treating as in breach, just update counter
      await db.query(
        `UPDATE cold_chain_state
         SET latest_temp_c = $1, latest_reading_at = $2,
             latest_sensor_id = $3, consecutive_ok_readings = $4,
             updated_at = NOW()
         WHERE shipment_id = $5`,
        [temperatureC, readingAt, sensorId, newConsecutiveOk, shipmentId]
      );
    }
  }

  // ── NORMAL READING ────────────────────────────────────────────────────────
  else {
    await db.query(
      `UPDATE cold_chain_state
       SET latest_temp_c = $1, latest_reading_at = $2,
           latest_sensor_id = $3, consecutive_ok_readings = LEAST(consecutive_ok_readings + 1, 99),
           updated_at = NOW()
       WHERE shipment_id = $4`,
      [temperatureC, readingAt, sensorId, shipmentId]
    );
  }

  return { isInBreach, deviationC, severity, durationMinutes };
}

// ── Breach onset handler ──────────────────────────────────────────────────────

async function handleBreachOnset({
  state, shipment, sensorId, shipmentId,
  temperatureC, deviationC, severity, readingAt,
  minC, maxC, isCryogenic,
}) {
  const newExcursionCount = (state.total_excursions || 0) + 1;
  const cargoRisk = calcCargoRisk(severity, parseFloat(shipment.cargo_value_usd), 0, isCryogenic);
  const cargoImpact = buildCargoImpactNote(severity, deviationC, 0, parseFloat(shipment.cargo_value_usd));

  // Open an excursion record
  const { rows: [excursion] } = await db.query(
    `INSERT INTO temperature_excursions (
       shipment_id, sensor_id, severity,
       temp_recorded_c, temp_min_limit_c, temp_max_limit_c,
       started_at, cargo_impact
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [shipmentId, sensorId, severity, temperatureC, minC, maxC, readingAt, cargoImpact]
  );

  // Update cold_chain_state
  await db.query(
    `UPDATE cold_chain_state SET
       latest_temp_c        = $1,
       latest_reading_at    = $2,
       latest_sensor_id     = $3,
       in_breach            = TRUE,
       breach_started_at    = $2,
       breach_peak_temp_c   = $1,
       breach_peak_deviation_c = $4,
       total_excursions     = $5,
       consecutive_ok_readings = 0,
       cold_chain_ok        = FALSE,
       updated_at           = NOW()
     WHERE shipment_id = $6`,
    [temperatureC, readingAt, sensorId, deviationC, newExcursionCount, shipmentId]
  );

  // Update shipment risk_score
  const newRisk = Math.min(100, (parseFloat(shipment.risk_score) || 0) + cargoRisk);
  await db.query(
    `UPDATE shipments SET risk_score = $1, updated_at = NOW() WHERE id = $2`,
    [newRisk, shipmentId]
  );

  // Create alert
  const alertPriority = severity === 'critical' ? 'critical'
                      : severity === 'severe'   ? 'critical'
                      : severity === 'moderate' ? 'high' : 'medium';

  const { rows: [alert] } = await db.query(
    `INSERT INTO alerts (alert_type, priority, title, message, shipment_id, excursion_id)
     VALUES ('temperature_breach', $1, $2, $3, $4, $5)
     RETURNING id`,
    [
      alertPriority,
      `🌡 ${severity.toUpperCase()} Temperature Breach — ${shipment.cargo_description?.slice(0, 60)}`,
      `Sensor reading ${temperatureC}°C — deviation ${deviationC.toFixed(2)}°C from limit. ${cargoImpact}`,
      shipmentId,
      excursion.id,
    ]
  );

  // Socket broadcast
  socketManager.broadcastAlert(shipment.company_id, shipmentId, {
    type:          'temperature_breach',
    severity,
    alert_id:      alert.id,
    excursion_id:  excursion.id,
    shipment_id:   shipmentId,
    temperature_c: temperatureC,
    deviation_c:   deviationC,
    cargo_impact:  cargoImpact,
    risk_score:    newRisk,
  });

  socketManager.toShipment(shipmentId, 'cold_chain:breach', {
    shipment_id:   shipmentId,
    sensor_id:     sensorId,
    excursion_id:  excursion.id,
    severity,
    temperature_c: temperatureC,
    deviation_c:   deviationC,
    started_at:    readingAt,
    limits:        { min: minC, max: maxC },
    cargo_impact:  cargoImpact,
    risk_score:    newRisk,
  });

  console.log(`[COLD] BREACH ONSET — shipment ${shipmentId} | ${temperatureC}°C | dev ${deviationC.toFixed(2)}°C | ${severity}`);
  return excursion.id;
}

// ── Breach continuing handler ─────────────────────────────────────────────────

async function handleBreachContinuing({
  state, shipment, sensorId, shipmentId,
  temperatureC, deviationC, durationMinutes, severity,
  readingAt, minC, maxC, isCryogenic,
}) {
  const isPeakWorse = deviationC > parseFloat(state.breach_peak_deviation_c || 0);
  const cargoImpact = buildCargoImpactNote(
    severity, deviationC, durationMinutes, parseFloat(shipment.cargo_value_usd)
  );
  const cargoRisk = calcCargoRisk(
    severity, parseFloat(shipment.cargo_value_usd), durationMinutes, isCryogenic
  );

  // Update the open excursion
  await db.query(
    `UPDATE temperature_excursions
     SET severity         = $1,
         temp_recorded_c  = CASE WHEN $2 > ABS(temp_recorded_c - temp_max_limit_c) + temp_max_limit_c
                                 THEN $3 ELSE temp_recorded_c END,
         duration_minutes = $4,
         cargo_impact     = $5
     WHERE shipment_id = $6 AND resolved_at IS NULL`,
    [severity, deviationC, temperatureC, durationMinutes, cargoImpact, shipmentId]
  );

  // Update cold_chain_state
  await db.query(
    `UPDATE cold_chain_state SET
       latest_temp_c           = $1,
       latest_reading_at       = $2,
       latest_sensor_id        = $3,
       breach_peak_temp_c      = CASE WHEN $4 THEN $1 ELSE breach_peak_temp_c END,
       breach_peak_deviation_c = CASE WHEN $4 THEN $5 ELSE breach_peak_deviation_c END,
       breach_duration_minutes = $6,
       consecutive_ok_readings = 0,
       updated_at              = NOW()
     WHERE shipment_id = $7`,
    [temperatureC, readingAt, sensorId, isPeakWorse, deviationC, durationMinutes, shipmentId]
  );

  // Escalate alert priority if severity worsened
  if (severity === 'critical' || severity === 'severe') {
    await db.query(
      `UPDATE alerts
       SET priority = 'critical', title = $1, message = $2
       WHERE shipment_id = $3 AND alert_type = 'temperature_breach'
         AND status IN ('open','acknowledged')`,
      [
        `🌡 CRITICAL Ongoing Breach — ${shipment.cargo_description?.slice(0, 60)}`,
        `${Math.round(durationMinutes)} min at deviation ${deviationC.toFixed(2)}°C. ${cargoImpact}`,
        shipmentId,
      ]
    );
  }

  // Update shipment risk
  const newRisk = Math.min(100, Math.max(parseFloat(shipment.risk_score) || 0, cargoRisk));
  await db.query(
    'UPDATE shipments SET risk_score = $1, updated_at = NOW() WHERE id = $2',
    [newRisk, shipmentId]
  );

  socketManager.toShipment(shipmentId, 'cold_chain:update', {
    shipment_id:      shipmentId,
    sensor_id:        sensorId,
    severity,
    temperature_c:    temperatureC,
    deviation_c:      deviationC,
    duration_minutes: durationMinutes,
    risk_score:       newRisk,
    cargo_impact:     cargoImpact,
  });
}

// ── Breach close handler ──────────────────────────────────────────────────────

async function handleBreachClose({ state, shipment, shipmentId, readingAt, temperatureC, isCryogenic }) {
  const breachStart    = new Date(state.breach_started_at);
  const durationMins   = (readingAt - breachStart) / 60000;
  const cumulative     = parseFloat(state.cumulative_breach_minutes || 0) + durationMins;
  const totalExcursions = state.total_excursions || 1;
  const integrityScore = calcIntegrityScore(cumulative, totalExcursions, parseFloat(shipment.cargo_value_usd));

  // Finalise the excursion row
  await db.query(
    `UPDATE temperature_excursions
     SET resolved_at      = $1,
         duration_minutes = $2,
         cargo_impact     = cargo_impact || $3
     WHERE shipment_id = $4 AND resolved_at IS NULL`,
    [
      readingAt,
      durationMins.toFixed(2),
      ` | Breach closed after ${Math.round(durationMins)} min.`,
      shipmentId,
    ]
  );

  // Update cold_chain_state
  await db.query(
    `UPDATE cold_chain_state SET
       latest_temp_c               = $1,
       latest_reading_at           = $2,
       in_breach                   = FALSE,
       breach_started_at           = NULL,
       breach_peak_temp_c          = NULL,
       breach_peak_deviation_c     = NULL,
       breach_duration_minutes     = 0,
       consecutive_ok_readings     = $3,
       cumulative_breach_minutes   = $4,
       cold_chain_ok               = ($5 >= 60),
       integrity_score             = $5,
       updated_at                  = NOW()
     WHERE shipment_id = $6`,
    [
      temperatureC, readingAt,
      CLEAR_CONSECUTIVE_READINGS,
      cumulative.toFixed(2),
      integrityScore,
      shipmentId,
    ]
  );

  socketManager.toShipment(shipmentId, 'cold_chain:resolved', {
    shipment_id:      shipmentId,
    resolved_at:      readingAt,
    duration_minutes: durationMins,
    integrity_score:  integrityScore,
    cumulative_breach_minutes: cumulative,
  });

  // Resolve the open temperature_breach alert
  await db.query(
    `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
     WHERE shipment_id = $1 AND alert_type = 'temperature_breach'
       AND status IN ('open','acknowledged')`,
    [shipmentId]
  );

  console.log(`[COLD] BREACH CLOSED — shipment ${shipmentId} | ${Math.round(durationMins)} min | integrity ${integrityScore}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PERIODIC SCAN — called by periodicJobs every N seconds
//  Catches late readings (from buffered IoT uplinks) by rescanning
//  all active cold-chain shipments for un-processed readings.
// ═══════════════════════════════════════════════════════════════════════════════

async function scanActiveColdChain() {
  // Find readings newer than the last processed reading for each cold-chain shipment
  const { rows } = await db.query(
    `SELECT sr.id AS reading_id, sr.sensor_id, sr.temperature_c,
            sr.recorded_at, sr.humidity_pct,
            sen.shipment_id
     FROM sensor_readings sr
     JOIN sensors          sen ON sen.id = sr.sensor_id
     JOIN shipments        sh  ON sh.id  = sen.shipment_id
     LEFT JOIN cold_chain_state ccs ON ccs.shipment_id = sen.shipment_id
     WHERE sh.is_cold_chain = TRUE
       AND sh.status NOT IN ('delivered','cancelled','draft')
       AND sr.temperature_c IS NOT NULL
       AND (ccs.latest_reading_at IS NULL OR sr.recorded_at > ccs.latest_reading_at)
     ORDER BY sen.shipment_id, sr.recorded_at ASC
     LIMIT 500`
  );

  for (const row of rows) {
    try {
      await processReading({
        sensorId:     row.sensor_id,
        shipmentId:   row.shipment_id,
        temperatureC: parseFloat(row.temperature_c),
        recordedAt:   row.recorded_at,
        humidityPct:  row.humidity_pct ? parseFloat(row.humidity_pct) : undefined,
      });
    } catch (err) {
      console.error(`[COLD] scan error for shipment ${row.shipment_id}:`, err.message);
    }
  }

  return rows.length;
}

// ── Get current state for a shipment ─────────────────────────────────────────

async function getShipmentColdState(shipmentId) {
  const { rows } = await db.query(
    `SELECT ccs.*,
            s.cargo_description, s.cargo_value_usd, s.reference,
            sen.serial_number AS sensor_serial,
            te.id   AS open_excursion_id,
            te.severity AS open_severity
     FROM cold_chain_state ccs
     JOIN  shipments s   ON s.id   = ccs.shipment_id
     LEFT JOIN sensors   sen ON sen.id = ccs.latest_sensor_id
     LEFT JOIN temperature_excursions te
           ON te.shipment_id = ccs.shipment_id AND te.resolved_at IS NULL
     WHERE ccs.shipment_id = $1`,
    [shipmentId]
  );
  return rows[0] || null;
}

module.exports = {
  processReading,
  scanActiveColdChain,
  ensureState,
  getShipmentColdState,
};
