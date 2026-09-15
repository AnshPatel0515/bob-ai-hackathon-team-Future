'use strict';
const express = require('express');
const { body, param, query: qv } = require('express-validator');

const db                 = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }       = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const coldChainMonitor   = require('../engines/coldChainMonitor');

const router = express.Router();
router.use(authenticate);

// ── GET /api/sensors ──────────────────────────────────────────────────────────
router.get(
  '/',
  [
    qv('shipment_id').optional().isUUID(),
    qv('asset_id').optional().isUUID(),
    qv('sensor_type').optional().isIn(['temperature','gps','humidity','shock','combined']),
    qv('is_active').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const conditions = ['(s.asset_id IN (SELECT id FROM fleet_assets WHERE company_id = $1) OR s.shipment_id IN (SELECT id FROM shipments WHERE company_id = $1))'];
      const params     = [req.user.company_id];
      let idx = 2;

      if (req.query.shipment_id) { conditions.push(`s.shipment_id = $${idx++}`); params.push(req.query.shipment_id); }
      if (req.query.asset_id)    { conditions.push(`s.asset_id = $${idx++}`);    params.push(req.query.asset_id); }
      if (req.query.sensor_type) { conditions.push(`s.sensor_type = $${idx++}`); params.push(req.query.sensor_type); }
      if (req.query.is_active !== undefined) {
        conditions.push(`s.is_active = $${idx++}`);
        params.push(req.query.is_active === 'true');
      }

      const { rows } = await db.query(
        `SELECT s.*,
                fa.identifier AS asset_identifier,
                sh.reference  AS shipment_reference
         FROM sensors s
         LEFT JOIN fleet_assets fa ON fa.id = s.asset_id
         LEFT JOIN shipments    sh ON sh.id = s.shipment_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY s.created_at DESC`,
        params
      );
      res.json({ data: rows });
    } catch (err) { next(err); }
  }
);

// ── GET /api/sensors/:id ──────────────────────────────────────────────────────
router.get('/:id', [param('id').isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*,
              fa.identifier AS asset_identifier,
              sh.reference  AS shipment_reference
       FROM sensors s
       LEFT JOIN fleet_assets fa ON fa.id = s.asset_id
       LEFT JOIN shipments    sh ON sh.id = s.shipment_id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sensor not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/sensors ─────────────────────────────────────────────────────────
router.post(
  '/',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    body('serial_number').trim().notEmpty(),
    body('sensor_type').isIn(['temperature','gps','humidity','shock','combined']),
    body('asset_id').optional().isUUID(),
    body('shipment_id').optional().isUUID(),
    body('manufacturer').optional().trim(),
    body('model').optional().trim(),
    body('installed_at').optional().isISO8601().toDate(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        serial_number, sensor_type, asset_id, shipment_id,
        manufacturer, model, installed_at,
      } = req.body;

      const { rows } = await db.query(
        `INSERT INTO sensors (serial_number, sensor_type, asset_id, shipment_id, manufacturer, model, installed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [serial_number, sensor_type, asset_id || null, shipment_id || null,
         manufacturer || null, model || null, installed_at || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/sensors/:id/readings ─────────────────────────────────────────────
router.get(
  '/:id/readings',
  [
    param('id').isUUID(),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 200 }),
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const conditions = ['sensor_id = $1'];
      const params     = [req.params.id];
      let idx = 2;

      if (req.query.from) { conditions.push(`recorded_at >= $${idx++}`); params.push(req.query.from); }
      if (req.query.to)   { conditions.push(`recorded_at <= $${idx++}`); params.push(req.query.to); }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT id, sensor_id, recorded_at, temperature_c, humidity_pct,
                  latitude, longitude, battery_pct, signal_strength
           FROM sensor_readings WHERE ${where}
           ORDER BY recorded_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM sensor_readings WHERE ${where}`, params),
      ]);
      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── POST /api/sensors/:id/readings (ingest from IoT device) ──────────────────
router.post(
  '/:id/readings',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    param('id').isUUID(),
    body('recorded_at').optional().isISO8601().toDate(),
    body('temperature_c').optional().isFloat(),
    body('humidity_pct').optional().isFloat({ min: 0, max: 100 }),
    body('latitude').optional().isFloat({ min: -90, max: 90 }),
    body('longitude').optional().isFloat({ min: -180, max: 180 }),
    body('battery_pct').optional().isFloat({ min: 0, max: 100 }),
    body('signal_strength').optional().isInt({ min: -120, max: 0 }),
    body('raw_payload').optional().isObject(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        recorded_at, temperature_c, humidity_pct,
        latitude, longitude, battery_pct, signal_strength, raw_payload,
      } = req.body;

      const ts = recorded_at || new Date();
      const { rows } = await db.query(
        `INSERT INTO sensor_readings (
           sensor_id, recorded_at, temperature_c, humidity_pct,
           latitude, longitude, battery_pct, signal_strength, raw_payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, sensor_id, recorded_at, temperature_c, humidity_pct,
                   latitude, longitude, battery_pct`,
        [
          req.params.id,
          ts,
          temperature_c ?? null,
          humidity_pct ?? null,
          latitude ?? null,
          longitude ?? null,
          battery_pct ?? null,
          signal_strength ?? null,
          raw_payload ? JSON.stringify(raw_payload) : null,
        ]
      );

      // If this sensor is bound to a cold-chain shipment, process immediately
      if (temperature_c != null) {
        const { rows: [sen] } = await db.query(
          'SELECT shipment_id FROM sensors WHERE id = $1',
          [req.params.id]
        );
        if (sen?.shipment_id) {
          setImmediate(() =>
            coldChainMonitor.processReading({
              sensorId:     req.params.id,
              shipmentId:   sen.shipment_id,
              temperatureC: temperature_c,
              recordedAt:   ts,
              humidityPct:  humidity_pct,
            }).catch((e) => console.error('[ColdChain] reading error:', e.message))
          );
        }
      }

      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/sensors/readings/latest ─────────────────────────────────────────
// Latest reading per active sensor for a company's shipments
router.get('/readings/latest', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (sr.sensor_id)
              sr.sensor_id, sr.recorded_at, sr.temperature_c,
              sr.latitude, sr.longitude, sr.battery_pct,
              sen.serial_number, sen.sensor_type,
              sh.reference AS shipment_reference, sh.id AS shipment_id
       FROM sensor_readings sr
       JOIN sensors  sen ON sen.id = sr.sensor_id
       LEFT JOIN shipments sh  ON sh.id  = sen.shipment_id
       WHERE sen.shipment_id IN (SELECT id FROM shipments WHERE company_id = $1)
          OR sen.asset_id    IN (SELECT id FROM fleet_assets WHERE company_id = $1)
       ORDER BY sr.sensor_id, sr.recorded_at DESC`,
      [req.user.company_id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

module.exports = router;
