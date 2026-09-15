'use strict';
const express = require('express');
const { body, param, query: qv } = require('express-validator');

const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

const router = express.Router();
router.use(authenticate);

// ── GET /api/tracking/:shipmentId/legs ───────────────────────────────────────
router.get(
  '/:shipmentId/legs',
  [param('shipmentId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      // Verify shipment belongs to company
      const shipCheck = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [req.params.shipmentId, req.user.company_id]
      );
      if (!shipCheck.rows.length) return res.status(404).json({ error: 'Shipment not found' });

      const { rows } = await db.query(
        `SELECT l.*,
                fa.identifier  AS asset_identifier,
                fa.asset_type,
                d.full_name    AS driver_name
         FROM shipment_legs l
         LEFT JOIN fleet_assignments fa2 ON fa2.leg_id = l.id AND fa2.is_active = TRUE
         LEFT JOIN fleet_assets fa       ON fa.id = fa2.asset_id
         LEFT JOIN drivers d             ON d.id  = fa2.driver_id
         WHERE l.shipment_id = $1
         ORDER BY l.leg_sequence`,
        [req.params.shipmentId]
      );
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/tracking/:shipmentId/legs ──────────────────────────────────────
router.post(
  '/:shipmentId/legs',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    param('shipmentId').isUUID(),
    body('leg_sequence').isInt({ min: 1 }),
    body('mode').isIn(['road','rail','sea','air','intermodal']),
    body('origin_city').trim().notEmpty(),
    body('origin_country').trim().notEmpty(),
    body('dest_city').trim().notEmpty(),
    body('dest_country').trim().notEmpty(),
    body('scheduled_dep_at').isISO8601().toDate(),
    body('carrier_name').optional().trim(),
    body('carrier_ref').optional().trim(),
    body('distance_km').optional().isFloat({ min: 0 }),
    body('estimated_arr_at').optional().isISO8601().toDate(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const sid = req.params.shipmentId;
      const shipCheck = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [sid, req.user.company_id]
      );
      if (!shipCheck.rows.length) return res.status(404).json({ error: 'Shipment not found' });

      const {
        leg_sequence, mode, carrier_name, carrier_ref,
        origin_city, origin_country, origin_lat, origin_lon,
        dest_city, dest_country, dest_lat, dest_lon,
        distance_km, scheduled_dep_at, estimated_arr_at, notes,
      } = req.body;

      const { rows } = await db.query(
        `INSERT INTO shipment_legs (
           shipment_id, leg_sequence, mode, carrier_name, carrier_ref,
           origin_city, origin_country, origin_lat, origin_lon,
           dest_city, dest_country, dest_lat, dest_lon,
           distance_km, scheduled_dep_at, estimated_arr_at, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          sid, leg_sequence, mode, carrier_name || null, carrier_ref || null,
          origin_city, origin_country, origin_lat || null, origin_lon || null,
          dest_city, dest_country, dest_lat || null, dest_lon || null,
          distance_km || null, scheduled_dep_at, estimated_arr_at || null, notes || null,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/tracking/:shipmentId/legs/:legId ───────────────────────────────
router.patch(
  '/:shipmentId/legs/:legId',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    param('shipmentId').isUUID(),
    param('legId').isUUID(),
    body('status').optional().isIn(['pending','active','completed','skipped']),
    body('actual_dep_at').optional().isISO8601().toDate(),
    body('actual_arr_at').optional().isISO8601().toDate(),
    body('estimated_arr_at').optional().isISO8601().toDate(),
    body('notes').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Verify ownership through shipment
      const check = await db.query(
        `SELECT l.id FROM shipment_legs l
         JOIN shipments s ON s.id = l.shipment_id
         WHERE l.id = $1 AND l.shipment_id = $2 AND s.company_id = $3`,
        [req.params.legId, req.params.shipmentId, req.user.company_id]
      );
      if (!check.rows.length) return res.status(404).json({ error: 'Leg not found' });

      const allowed = ['status','actual_dep_at','actual_arr_at','estimated_arr_at','notes','carrier_name','carrier_ref'];
      const updates = [];
      const values  = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates.push(`${key} = $${idx++}`);
          values.push(req.body[key]);
        }
      }
      if (!updates.length) return res.status(422).json({ error: 'No updatable fields provided' });

      values.push(req.params.legId);
      const { rows } = await db.query(
        `UPDATE shipment_legs SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} RETURNING *`,
        values
      );
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/tracking/:shipmentId/sensor-readings ────────────────────────────
router.get(
  '/:shipmentId/sensor-readings',
  [
    param('shipmentId').isUUID(),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 200 }),
    qv('sensor_id').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const sid = req.params.shipmentId;

      const shipCheck = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [sid, req.user.company_id]
      );
      if (!shipCheck.rows.length) return res.status(404).json({ error: 'Shipment not found' });

      const conditions = ['sen.shipment_id = $1'];
      const params     = [sid];
      let idx = 2;

      if (req.query.sensor_id) {
        conditions.push(`sr.sensor_id = $${idx++}`);
        params.push(req.query.sensor_id);
      }

      const where = conditions.join(' AND ');

      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT sr.id, sr.sensor_id, sr.recorded_at,
                  sr.temperature_c, sr.humidity_pct,
                  sr.latitude, sr.longitude, sr.battery_pct,
                  sen.serial_number, sen.sensor_type
           FROM sensor_readings sr
           JOIN sensors sen ON sen.id = sr.sensor_id
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
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/tracking/:shipmentId/excursions ─────────────────────────────────
router.get(
  '/:shipmentId/excursions',
  [param('shipmentId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const shipCheck = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [req.params.shipmentId, req.user.company_id]
      );
      if (!shipCheck.rows.length) return res.status(404).json({ error: 'Shipment not found' });

      const { rows } = await db.query(
        `SELECT te.*, s.serial_number AS sensor_serial, s.sensor_type
         FROM temperature_excursions te
         JOIN sensors s ON s.id = te.sensor_id
         WHERE te.shipment_id = $1
         ORDER BY te.started_at DESC`,
        [req.params.shipmentId]
      );
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/tracking/:shipmentId/excursions ─────────────────────────────────
router.post(
  '/:shipmentId/excursions',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    param('shipmentId').isUUID(),
    body('sensor_id').isUUID(),
    body('severity').isIn(['minor','moderate','severe','critical']),
    body('temp_recorded_c').isFloat(),
    body('temp_min_limit_c').isFloat(),
    body('temp_max_limit_c').isFloat(),
    body('started_at').isISO8601().toDate(),
    body('resolved_at').optional().isISO8601().toDate(),
    body('duration_minutes').optional().isFloat({ min: 0 }),
    body('cargo_impact').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const sid = req.params.shipmentId;
      const shipCheck = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [sid, req.user.company_id]
      );
      if (!shipCheck.rows.length) return res.status(404).json({ error: 'Shipment not found' });

      const {
        sensor_id, severity, temp_recorded_c,
        temp_min_limit_c, temp_max_limit_c,
        started_at, resolved_at, duration_minutes, cargo_impact,
      } = req.body;

      const { rows } = await db.query(
        `INSERT INTO temperature_excursions (
           shipment_id, sensor_id, severity,
           temp_recorded_c, temp_min_limit_c, temp_max_limit_c,
           started_at, resolved_at, duration_minutes, cargo_impact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          sid, sensor_id, severity,
          temp_recorded_c, temp_min_limit_c, temp_max_limit_c,
          started_at, resolved_at || null, duration_minutes || null, cargo_impact || null,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
