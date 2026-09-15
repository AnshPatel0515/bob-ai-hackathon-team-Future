'use strict';
const express = require('express');
const { body, param, query: qv } = require('express-validator');

const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }  = require('../middleware/validate');
const { parsePagination, paginatedResponse, safeSort, safeDir } = require('../utils/pagination');

const router = express.Router();
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════
//  FLEET ASSETS
// ═══════════════════════════════════════════════════════════════

// ── GET /api/fleet ────────────────────────────────────────────────────────────
router.get(
  '/',
  [
    qv('status').optional().isIn(['available','in_use','idle','maintenance','decommissioned']),
    qv('asset_type').optional().isIn(['truck','van','container','vessel','aircraft','rail_wagon']),
    qv('is_refrigerated').optional().isBoolean(),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 100 }),
    qv('sort').optional().isString(),
    qv('dir').optional().isIn(['asc','desc']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const SORT_COLS = ['identifier','asset_type','status','utilisation_pct','created_at'];
      const col = safeSort(req.query.sort, SORT_COLS, 'created_at');
      const dir = safeDir(req.query.dir);

      const conditions = ['company_id = $1'];
      const params     = [req.user.company_id];
      let idx = 2;

      if (req.query.status)         { conditions.push(`status = $${idx++}`);         params.push(req.query.status); }
      if (req.query.asset_type)     { conditions.push(`asset_type = $${idx++}`);     params.push(req.query.asset_type); }
      if (req.query.is_refrigerated !== undefined) {
        conditions.push(`is_refrigerated = $${idx++}`);
        params.push(req.query.is_refrigerated === 'true');
      }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT * FROM fleet_assets WHERE ${where}
           ORDER BY ${col} ${dir} LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM fleet_assets WHERE ${where}`, params),
      ]);

      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── GET /api/fleet/:id ────────────────────────────────────────────────────────
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT fa.*,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'shipment_id',   fa2.shipment_id,
                      'reference',     s.reference,
                      'status',        s.status,
                      'assigned_at',   fa2.assigned_at,
                      'is_active',     fa2.is_active
                    ) ORDER BY fa2.assigned_at DESC
                  ) FILTER (WHERE fa2.id IS NOT NULL),
                  '[]'
                ) AS recent_assignments
         FROM fleet_assets fa
         LEFT JOIN fleet_assignments fa2 ON fa2.asset_id = fa.id
         LEFT JOIN shipments s ON s.id = fa2.shipment_id
         WHERE fa.id = $1 AND fa.company_id = $2
         GROUP BY fa.id`,
        [req.params.id, req.user.company_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Asset not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── POST /api/fleet ───────────────────────────────────────────────────────────
router.post(
  '/',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    body('asset_type').isIn(['truck','van','container','vessel','aircraft','rail_wagon']),
    body('identifier').trim().notEmpty(),
    body('make_model').optional().trim(),
    body('year_manufactured').optional().isInt({ min: 1900, max: 2100 }),
    body('capacity_kg').optional().isFloat({ min: 0 }),
    body('capacity_m3').optional().isFloat({ min: 0 }),
    body('is_refrigerated').optional().isBoolean(),
    body('temp_min_celsius').optional().isFloat(),
    body('temp_max_celsius').optional().isFloat(),
    body('current_location_desc').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        asset_type, identifier, make_model, year_manufactured,
        capacity_kg, capacity_m3, is_refrigerated = false,
        temp_min_celsius, temp_max_celsius,
        current_lat, current_lon, current_location_desc,
        last_maintenance_at, next_maintenance_at,
      } = req.body;

      const { rows } = await db.query(
        `INSERT INTO fleet_assets (
           company_id, asset_type, identifier, make_model, year_manufactured,
           capacity_kg, capacity_m3, is_refrigerated, temp_min_celsius, temp_max_celsius,
           current_lat, current_lon, current_location_desc,
           last_maintenance_at, next_maintenance_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          req.user.company_id, asset_type, identifier, make_model || null, year_manufactured || null,
          capacity_kg || null, capacity_m3 || null, is_refrigerated,
          temp_min_celsius || null, temp_max_celsius || null,
          current_lat || null, current_lon || null, current_location_desc || null,
          last_maintenance_at || null, next_maintenance_at || null,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/fleet/:id ──────────────────────────────────────────────────────
router.patch(
  '/:id',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    param('id').isUUID(),
    body('status').optional().isIn(['available','in_use','idle','maintenance','decommissioned']),
    body('utilisation_pct').optional().isFloat({ min: 0, max: 100 }),
    body('current_lat').optional().isFloat(),
    body('current_lon').optional().isFloat(),
    body('current_location_desc').optional().trim(),
    body('last_maintenance_at').optional().isISO8601(),
    body('next_maintenance_at').optional().isISO8601(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const check = await db.query(
        'SELECT id FROM fleet_assets WHERE id = $1 AND company_id = $2',
        [req.params.id, req.user.company_id]
      );
      if (!check.rows.length) return res.status(404).json({ error: 'Asset not found' });

      const allowed = [
        'status','utilisation_pct','current_lat','current_lon','current_location_desc',
        'last_maintenance_at','next_maintenance_at','make_model',
      ];
      const updates = []; const values = []; let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { updates.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (!updates.length) return res.status(422).json({ error: 'No updatable fields provided' });

      values.push(req.params.id);
      const { rows } = await db.query(
        `UPDATE fleet_assets SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} RETURNING *`,
        values
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── POST /api/fleet/assignments ───────────────────────────────────────────────
router.post(
  '/assignments',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    body('shipment_id').isUUID(),
    body('asset_id').isUUID(),
    body('driver_id').optional().isUUID(),
    body('leg_id').optional().isUUID(),
    body('notes').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { shipment_id, asset_id, driver_id, leg_id, notes } = req.body;

      // Verify asset belongs to company
      const assetCheck = await db.query(
        'SELECT id, status FROM fleet_assets WHERE id = $1 AND company_id = $2',
        [asset_id, req.user.company_id]
      );
      if (!assetCheck.rows.length) return res.status(404).json({ error: 'Asset not found' });

      const { rows } = await db.query(
        `INSERT INTO fleet_assignments (shipment_id, leg_id, asset_id, driver_id, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [shipment_id, leg_id || null, asset_id, driver_id || null, notes || null]
      );

      // Mark asset as in_use
      await db.query(
        `UPDATE fleet_assets SET status = 'in_use', updated_at = NOW() WHERE id = $1`,
        [asset_id]
      );

      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/fleet/assignments/:id/release ─────────────────────────────────
router.patch(
  '/assignments/:id/release',
  authorize('admin','logistics_manager','fleet_operator'),
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE fleet_assignments
         SET is_active = FALSE, released_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Assignment not found' });

      // Free the asset back to available
      await db.query(
        `UPDATE fleet_assets SET status = 'available', updated_at = NOW() WHERE id = $1`,
        [rows[0].asset_id]
      );

      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/fleet/utilisation/summary ───────────────────────────────────────
router.get('/utilisation/summary', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         asset_type,
         status,
         COUNT(*)                          AS count,
         ROUND(AVG(utilisation_pct), 1)   AS avg_utilisation,
         ROUND(MIN(utilisation_pct), 1)   AS min_utilisation,
         ROUND(MAX(utilisation_pct), 1)   AS max_utilisation
       FROM fleet_assets
       WHERE company_id = $1
       GROUP BY asset_type, status
       ORDER BY asset_type, status`,
      [req.user.company_id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
//  DRIVERS
// ═══════════════════════════════════════════════════════════════

// ── GET /api/fleet/drivers ────────────────────────────────────────────────────
router.get(
  '/drivers',
  [
    qv('status').optional().isIn(['available','on_duty','off_duty','on_leave','suspended']),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const conditions = ['company_id = $1'];
      const params     = [req.user.company_id];
      let idx = 2;

      if (req.query.status) { conditions.push(`status = $${idx++}`); params.push(req.query.status); }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT id, full_name, license_number, license_class, license_expiry,
                  phone, home_base_city, home_base_country, status,
                  hours_driven_7d, max_hours_7d, created_at
           FROM drivers WHERE ${where}
           ORDER BY full_name ASC LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM drivers WHERE ${where}`, params),
      ]);
      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── GET /api/fleet/drivers/:id ────────────────────────────────────────────────
router.get(
  '/drivers/:id',
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const [driverRes, assignRes] = await Promise.all([
        db.query(
          `SELECT * FROM drivers WHERE id = $1 AND company_id = $2`,
          [req.params.id, req.user.company_id]
        ),
        db.query(
          `SELECT fa.shipment_id, s.reference, s.status AS shipment_status,
                  fa.assigned_at, fa.released_at, fa.is_active,
                  ast.identifier AS asset_identifier
           FROM fleet_assignments fa
           JOIN shipments s   ON s.id   = fa.shipment_id
           JOIN fleet_assets ast ON ast.id = fa.asset_id
           WHERE fa.driver_id = $1
           ORDER BY fa.assigned_at DESC
           LIMIT 10`,
          [req.params.id]
        ),
      ]);
      if (!driverRes.rows.length) return res.status(404).json({ error: 'Driver not found' });
      res.json({ ...driverRes.rows[0], recent_assignments: assignRes.rows });
    } catch (err) { next(err); }
  }
);

// ── POST /api/fleet/drivers ───────────────────────────────────────────────────
router.post(
  '/drivers',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    body('full_name').trim().notEmpty(),
    body('license_number').trim().notEmpty(),
    body('license_class').trim().notEmpty(),
    body('license_expiry').isISO8601(),
    body('phone').optional().trim(),
    body('home_base_city').optional().trim(),
    body('home_base_country').optional().trim(),
    body('max_hours_7d').optional().isFloat({ min: 1, max: 90 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        full_name, license_number, license_class, license_expiry,
        phone, home_base_city, home_base_country, max_hours_7d = 56,
      } = req.body;

      const { rows } = await db.query(
        `INSERT INTO drivers (
           company_id, full_name, license_number, license_class, license_expiry,
           phone, home_base_city, home_base_country, max_hours_7d
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          req.user.company_id, full_name, license_number, license_class, license_expiry,
          phone || null, home_base_city || null, home_base_country || null, max_hours_7d,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/fleet/drivers/:id ─────────────────────────────────────────────
router.patch(
  '/drivers/:id',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    param('id').isUUID(),
    body('status').optional().isIn(['available','on_duty','off_duty','on_leave','suspended']),
    body('hours_driven_7d').optional().isFloat({ min: 0 }),
    body('phone').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const check = await db.query(
        'SELECT id FROM drivers WHERE id = $1 AND company_id = $2',
        [req.params.id, req.user.company_id]
      );
      if (!check.rows.length) return res.status(404).json({ error: 'Driver not found' });

      const allowed = ['status','hours_driven_7d','phone','home_base_city','home_base_country'];
      const updates = []; const values = []; let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { updates.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (!updates.length) return res.status(422).json({ error: 'No updatable fields provided' });

      values.push(req.params.id);
      const { rows } = await db.query(
        `UPDATE drivers SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} RETURNING *`,
        values
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

module.exports = router;
