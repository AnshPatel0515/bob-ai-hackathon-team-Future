'use strict';
/**
 * /api/cold-chain  — cold-chain monitoring REST endpoints
 *
 * GET  /                      – list all shipments' current cold state (company-scoped)
 * GET  /:shipmentId            – current state + open excursion for one shipment
 * GET  /:shipmentId/history    – paginated temperature reading history
 * GET  /:shipmentId/excursions – all excursion records for a shipment
 * POST /ingest                 – manual / test reading ingest (→ ColdChainMonitor)
 * GET  /breaches/active        – all shipments currently in breach
 * GET  /dashboard              – cold-chain dashboard summary
 */

const express   = require('express');
const { body, param, query: qv } = require('express-validator');

const db                = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }      = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const coldChainMonitor  = require('../engines/coldChainMonitor');

const router = express.Router();
router.use(authenticate);

// ── GET /api/cold-chain ───────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ccs.*,
              s.reference, s.status AS shipment_status,
              s.cargo_description, s.cargo_value_usd,
              s.origin_city, s.destination_city,
              s.estimated_delivery_at
       FROM cold_chain_state ccs
       JOIN  shipments s ON s.id = ccs.shipment_id
       WHERE s.company_id = $1
       ORDER BY ccs.in_breach DESC, ccs.integrity_score ASC`,
      [req.user.company_id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/cold-chain/breaches/active ───────────────────────────────────────
router.get('/breaches/active', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ccs.*,
              s.reference, s.cargo_description, s.cargo_value_usd,
              s.status AS shipment_status,
              te.id          AS excursion_id,
              te.severity    AS excursion_severity,
              te.started_at  AS excursion_started_at,
              te.temp_recorded_c, te.deviation_c,
              a.id           AS alert_id, a.priority AS alert_priority
       FROM cold_chain_state ccs
       JOIN  shipments s ON s.id = ccs.shipment_id
       LEFT JOIN temperature_excursions te
             ON te.shipment_id = ccs.shipment_id AND te.resolved_at IS NULL
       LEFT JOIN alerts a
             ON a.shipment_id = ccs.shipment_id AND a.alert_type = 'temperature_breach'
             AND a.status IN ('open','acknowledged')
       WHERE s.company_id = $1 AND ccs.in_breach = TRUE
       ORDER BY te.deviation_c DESC NULLS LAST`,
      [req.user.company_id]
    );
    res.json({ data: rows, count: rows.length });
  } catch (err) { next(err); }
});

// ── GET /api/cold-chain/dashboard ─────────────────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const cid = req.user.company_id;
    const [summaryRes, atRiskRes, recentExcursionsRes] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)                                                  AS total_cold_shipments,
           COUNT(*) FILTER (WHERE ccs.in_breach = TRUE)             AS currently_breaching,
           COUNT(*) FILTER (WHERE ccs.cold_chain_ok = FALSE)        AS integrity_compromised,
           ROUND(AVG(ccs.integrity_score), 1)                       AS avg_integrity_score,
           SUM(ccs.total_excursions)                                AS total_excursions_all_time,
           COUNT(*) FILTER (WHERE ccs.integrity_score < 60)         AS critical_integrity
         FROM cold_chain_state ccs
         JOIN shipments s ON s.id = ccs.shipment_id
         WHERE s.company_id = $1
           AND s.status NOT IN ('delivered','cancelled')`,
        [cid]
      ),
      db.query(
        `SELECT s.id, s.reference, s.cargo_value_usd, s.cargo_description,
                ccs.integrity_score, ccs.in_breach, ccs.total_excursions,
                ccs.latest_temp_c, ccs.temp_min_celsius, ccs.temp_max_celsius,
                ccs.breach_peak_deviation_c
         FROM cold_chain_state ccs
         JOIN shipments s ON s.id = ccs.shipment_id
         WHERE s.company_id = $1
           AND s.status NOT IN ('delivered','cancelled')
           AND (ccs.in_breach = TRUE OR ccs.integrity_score < 70)
         ORDER BY ccs.in_breach DESC, ccs.integrity_score ASC
         LIMIT 10`,
        [cid]
      ),
      db.query(
        `SELECT te.*, s.reference, s.cargo_value_usd
         FROM temperature_excursions te
         JOIN shipments s ON s.id = te.shipment_id
         WHERE s.company_id = $1
         ORDER BY te.started_at DESC
         LIMIT 10`,
        [cid]
      ),
    ]);

    res.json({
      summary:           summaryRes.rows[0],
      at_risk_shipments: atRiskRes.rows,
      recent_excursions: recentExcursionsRes.rows,
      generated_at:      new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── GET /api/cold-chain/:shipmentId ───────────────────────────────────────────
router.get(
  '/:shipmentId',
  [param('shipmentId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: [shipCheck] } = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [req.params.shipmentId, req.user.company_id]
      );
      if (!shipCheck) return res.status(404).json({ error: 'Shipment not found' });

      const state = await coldChainMonitor.getShipmentColdState(req.params.shipmentId);
      if (!state) return res.status(404).json({ error: 'No cold-chain state — not a cold-chain shipment or no readings yet' });

      res.json(state);
    } catch (err) { next(err); }
  }
);

// ── GET /api/cold-chain/:shipmentId/history ───────────────────────────────────
router.get(
  '/:shipmentId/history',
  [
    param('shipmentId').isUUID(),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 500 }),
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
    qv('sensor_id').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows: [shipCheck] } = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [req.params.shipmentId, req.user.company_id]
      );
      if (!shipCheck) return res.status(404).json({ error: 'Shipment not found' });

      const { page, limit, offset } = parsePagination(req.query);
      const conditions = ['sen.shipment_id = $1'];
      const params     = [req.params.shipmentId];
      let idx = 2;

      if (req.query.sensor_id) { conditions.push(`sr.sensor_id = $${idx++}`); params.push(req.query.sensor_id); }
      if (req.query.from)      { conditions.push(`sr.recorded_at >= $${idx++}`); params.push(req.query.from); }
      if (req.query.to)        { conditions.push(`sr.recorded_at <= $${idx++}`); params.push(req.query.to); }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT sr.id, sr.sensor_id, sr.recorded_at,
                  sr.temperature_c, sr.humidity_pct, sr.battery_pct,
                  sen.serial_number, sen.sensor_type,
                  -- Annotate each reading with its breach status
                  CASE
                    WHEN sr.temperature_c > sh.temp_max_celsius THEN sr.temperature_c - sh.temp_max_celsius
                    WHEN sr.temperature_c < sh.temp_min_celsius THEN sh.temp_min_celsius - sr.temperature_c
                    ELSE 0
                  END AS deviation_c,
                  sr.temperature_c > sh.temp_max_celsius OR sr.temperature_c < sh.temp_min_celsius AS is_breach
           FROM sensor_readings sr
           JOIN sensors  sen ON sen.id = sr.sensor_id
           JOIN shipments sh  ON sh.id = sen.shipment_id
           WHERE ${where}
           ORDER BY sr.recorded_at DESC
           LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(
          `SELECT COUNT(*) FROM sensor_readings sr
           JOIN sensors sen ON sen.id = sr.sensor_id
           WHERE ${where}`,
          params
        ),
      ]);

      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── GET /api/cold-chain/:shipmentId/excursions ────────────────────────────────
router.get(
  '/:shipmentId/excursions',
  [param('shipmentId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows: [shipCheck] } = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [req.params.shipmentId, req.user.company_id]
      );
      if (!shipCheck) return res.status(404).json({ error: 'Shipment not found' });

      const { rows } = await db.query(
        `SELECT te.*,
                sen.serial_number, sen.sensor_type,
                a.id AS alert_id, a.priority AS alert_priority, a.status AS alert_status
         FROM temperature_excursions te
         JOIN  sensors sen ON sen.id = te.sensor_id
         LEFT JOIN alerts a ON a.excursion_id = te.id
         WHERE te.shipment_id = $1
         ORDER BY te.started_at DESC`,
        [req.params.shipmentId]
      );
      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

// ── POST /api/cold-chain/ingest ───────────────────────────────────────────────
// Manual / test reading ingest — also the path for direct sensor HTTP push.
router.post(
  '/ingest',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    body('sensor_id').isUUID(),
    body('shipment_id').isUUID(),
    body('temperature_c').isFloat(),
    body('recorded_at').optional().isISO8601().toDate(),
    body('humidity_pct').optional().isFloat({ min: 0, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { sensor_id, shipment_id, temperature_c, recorded_at, humidity_pct } = req.body;

      // Verify shipment belongs to company
      const { rows: [ship] } = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2 AND is_cold_chain = TRUE',
        [shipment_id, req.user.company_id]
      );
      if (!ship) return res.status(404).json({ error: 'Cold-chain shipment not found' });

      // Persist to sensor_readings
      await db.query(
        `INSERT INTO sensor_readings (sensor_id, recorded_at, temperature_c, humidity_pct)
         VALUES ($1, $2, $3, $4)`,
        [sensor_id, recorded_at || new Date(), temperature_c, humidity_pct || null]
      );

      // Process through monitor
      const result = await coldChainMonitor.processReading({
        sensorId:     sensor_id,
        shipmentId:   shipment_id,
        temperatureC: temperature_c,
        recordedAt:   recorded_at || new Date(),
        humidityPct:  humidity_pct,
      });

      res.status(202).json({ ok: true, result });
    } catch (err) { next(err); }
  }
);

module.exports = router;
