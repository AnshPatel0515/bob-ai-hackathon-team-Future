'use strict';
const express = require('express');
const { body, query: qv, param } = require('express-validator');

const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }  = require('../middleware/validate');
const { parsePagination, paginatedResponse, safeSort, safeDir } = require('../utils/pagination');

const router = express.Router();

// All shipment routes require authentication
router.use(authenticate);

const SORT_COLS = [
  'created_at','updated_at','scheduled_pickup_at','estimated_delivery_at',
  'cargo_value_usd','risk_score','delay_hours','reference',
];

// ── GET /api/shipments ───────────────────────────────────────────────────────
router.get(
  '/',
  [
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 100 }),
    qv('status').optional().isIn(['draft','booked','in_transit','delayed','at_customs','delivered','cancelled']),
    qv('is_cold_chain').optional().isBoolean(),
    qv('sort').optional().isString(),
    qv('dir').optional().isIn(['asc','desc']),
    qv('search').optional().isString().isLength({ max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const col = safeSort(req.query.sort, SORT_COLS, 'created_at');
      const dir = safeDir(req.query.dir);

      const conditions = ['s.company_id = $1'];
      const params     = [req.user.company_id];
      let   idx        = 2;

      if (req.query.status) {
        conditions.push(`s.status = $${idx++}`);
        params.push(req.query.status);
      }
      if (req.query.is_cold_chain !== undefined) {
        conditions.push(`s.is_cold_chain = $${idx++}`);
        params.push(req.query.is_cold_chain === 'true');
      }
      if (req.query.search) {
        conditions.push(`(s.reference ILIKE $${idx} OR s.cargo_description ILIKE $${idx} OR s.origin_city ILIKE $${idx} OR s.destination_city ILIKE $${idx})`);
        params.push(`%${req.query.search}%`);
        idx++;
      }

      const where = conditions.join(' AND ');

      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT s.id, s.reference, s.cargo_description, s.cargo_value_usd,
                  s.is_cold_chain, s.is_hazardous,
                  s.origin_city, s.origin_country,
                  s.destination_city, s.destination_country,
                  s.scheduled_pickup_at, s.actual_pickup_at,
                  s.estimated_delivery_at, s.actual_delivery_at,
                  s.status, s.delay_hours, s.risk_score,
                  u.full_name AS created_by_name
           FROM shipments s
           JOIN users u ON u.id = s.created_by
           WHERE ${where}
           ORDER BY s.${col} ${dir}
           LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(
          `SELECT COUNT(*) FROM shipments s WHERE ${where}`,
          params
        ),
      ]);

      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/shipments/:id ───────────────────────────────────────────────────
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT s.*,
                u.full_name  AS created_by_name,
                c.name       AS company_name
         FROM shipments s
         JOIN users     u ON u.id = s.created_by
         JOIN companies c ON c.id = s.company_id
         WHERE s.id = $1 AND s.company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Shipment not found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/shipments ──────────────────────────────────────────────────────
router.post(
  '/',
  authorize('admin','logistics_manager'),
  [
    body('reference').trim().notEmpty().withMessage('reference is required'),
    body('cargo_description').trim().notEmpty(),
    body('cargo_value_usd').isFloat({ min: 0 }),
    body('origin_city').trim().notEmpty(),
    body('origin_country').trim().notEmpty(),
    body('destination_city').trim().notEmpty(),
    body('destination_country').trim().notEmpty(),
    body('scheduled_pickup_at').isISO8601().toDate(),
    body('is_cold_chain').optional().isBoolean(),
    body('temp_min_celsius').optional().isFloat(),
    body('temp_max_celsius').optional().isFloat(),
    body('is_hazardous').optional().isBoolean(),
    body('hazmat_class').optional().trim(),
    body('cargo_weight_kg').optional().isFloat({ min: 0 }),
    body('cargo_volume_m3').optional().isFloat({ min: 0 }),
    body('estimated_delivery_at').optional().isISO8601().toDate(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        reference, cargo_description, cargo_value_usd,
        cargo_weight_kg, cargo_volume_m3,
        is_cold_chain = false, temp_min_celsius, temp_max_celsius,
        is_hazardous = false, hazmat_class,
        origin_city, origin_country, origin_lat, origin_lon,
        destination_city, destination_country, dest_lat, dest_lon,
        scheduled_pickup_at, estimated_delivery_at,
      } = req.body;

      if (is_cold_chain && (temp_min_celsius == null || temp_max_celsius == null)) {
        return res.status(422).json({ error: 'temp_min_celsius and temp_max_celsius are required for cold-chain shipments' });
      }

      const { rows } = await db.query(
        `INSERT INTO shipments (
           reference, company_id, created_by,
           cargo_description, cargo_value_usd, cargo_weight_kg, cargo_volume_m3,
           is_cold_chain, temp_min_celsius, temp_max_celsius,
           is_hazardous, hazmat_class,
           origin_city, origin_country, origin_lat, origin_lon,
           destination_city, destination_country, dest_lat, dest_lon,
           scheduled_pickup_at, estimated_delivery_at, status
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'draft'
         ) RETURNING *`,
        [
          reference, req.user.company_id, req.user.id,
          cargo_description, cargo_value_usd, cargo_weight_kg || null, cargo_volume_m3 || null,
          is_cold_chain, temp_min_celsius || null, temp_max_celsius || null,
          is_hazardous, hazmat_class || null,
          origin_city, origin_country, origin_lat || null, origin_lon || null,
          destination_city, destination_country, dest_lat || null, dest_lon || null,
          scheduled_pickup_at, estimated_delivery_at || null,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/shipments/:id ─────────────────────────────────────────────────
router.patch(
  '/:id',
  authorize('admin','logistics_manager'),
  [
    param('id').isUUID(),
    body('status').optional().isIn(['draft','booked','in_transit','delayed','at_customs','delivered','cancelled']),
    body('estimated_delivery_at').optional().isISO8601().toDate(),
    body('actual_pickup_at').optional().isISO8601().toDate(),
    body('actual_delivery_at').optional().isISO8601().toDate(),
    body('delay_hours').optional().isFloat({ min: 0 }),
    body('risk_score').optional().isFloat({ min: 0, max: 100 }),
    body('cargo_value_usd').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Verify ownership
      const existing = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [req.params.id, req.user.company_id]
      );
      if (!existing.rows.length) return res.status(404).json({ error: 'Shipment not found' });

      const allowed = [
        'status','estimated_delivery_at','actual_pickup_at','actual_delivery_at',
        'delay_hours','risk_score','cargo_value_usd','cargo_description',
        'temp_min_celsius','temp_max_celsius',
      ];

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

      values.push(req.params.id);
      const { rows } = await db.query(
        `UPDATE shipments SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} RETURNING *`,
        values
      );
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/shipments/:id ────────────────────────────────────────────────
router.delete(
  '/:id',
  authorize('admin'),
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rowCount } = await db.query(
        `DELETE FROM shipments WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
        [req.params.id, req.user.company_id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Shipment not found or not in draft status' });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/shipments/:id/summary ───────────────────────────────────────────
// Full shipment detail with legs, active assignments, excursions, and disruptions
router.get(
  '/:id/summary',
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const id   = req.params.id;
      const coid = req.user.company_id;

      const [shipRes, legsRes, assignRes, excRes, disRes] = await Promise.all([
        db.query(
          `SELECT s.*, u.full_name AS created_by_name
           FROM shipments s JOIN users u ON u.id = s.created_by
           WHERE s.id = $1 AND s.company_id = $2`, [id, coid]),
        db.query(
          `SELECT * FROM shipment_legs WHERE shipment_id = $1 ORDER BY leg_sequence`, [id]),
        db.query(
          `SELECT fa.id AS asset_id, fa.identifier, fa.asset_type, fa.status AS asset_status,
                  d.full_name AS driver_name, fa2.assigned_at, fa2.is_active
           FROM fleet_assignments fa2
           JOIN fleet_assets fa ON fa.id = fa2.asset_id
           LEFT JOIN drivers d  ON d.id  = fa2.driver_id
           WHERE fa2.shipment_id = $1`, [id]),
        db.query(
          `SELECT * FROM temperature_excursions WHERE shipment_id = $1 ORDER BY started_at DESC`, [id]),
        db.query(
          `SELECT d.*, sd.estimated_delay_hours, sd.impact_notes, sd.notified_at
           FROM shipment_disruptions sd
           JOIN disruptions d ON d.id = sd.disruption_id
           WHERE sd.shipment_id = $1`, [id]),
      ]);

      if (!shipRes.rows.length) return res.status(404).json({ error: 'Shipment not found' });

      res.json({
        ...shipRes.rows[0],
        legs:          legsRes.rows,
        assignments:   assignRes.rows,
        excursions:    excRes.rows,
        disruptions:   disRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
