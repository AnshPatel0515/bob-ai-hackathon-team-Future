'use strict';
const express = require('express');
const { body, param, query: qv } = require('express-validator');

const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }  = require('../middleware/validate');
const { parsePagination, paginatedResponse, safeSort, safeDir } = require('../utils/pagination');

const router = express.Router();
router.use(authenticate);

const SORT_COLS = ['triggered_at','priority','alert_type','status'];

// ── GET /api/alerts ───────────────────────────────────────────────────────────
router.get(
  '/',
  [
    qv('status').optional().isIn(['open','acknowledged','resolved','dismissed']),
    qv('priority').optional().isIn(['low','medium','high','critical']),
    qv('alert_type').optional().isIn([
      'temperature_breach','geofence_violation','eta_delay','asset_idle',
      'shipment_at_risk','disruption_detected','driver_hours_exceeded',
      'customs_hold','cargo_damage',
    ]),
    qv('shipment_id').optional().isUUID(),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 100 }),
    qv('sort').optional().isString(),
    qv('dir').optional().isIn(['asc','desc']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const col = safeSort(req.query.sort, SORT_COLS, 'triggered_at');
      const dir = safeDir(req.query.dir);

      // Scope alerts to user's company shipments/assets
      const conditions = [
        `(a.shipment_id IN (SELECT id FROM shipments WHERE company_id = $1)
          OR a.asset_id IN (SELECT id FROM fleet_assets WHERE company_id = $1)
          OR (a.shipment_id IS NULL AND a.asset_id IS NULL))`
      ];
      const params = [req.user.company_id];
      let idx = 2;

      if (req.query.status)     { conditions.push(`a.status = $${idx++}`);     params.push(req.query.status); }
      if (req.query.priority)   { conditions.push(`a.priority = $${idx++}`);   params.push(req.query.priority); }
      if (req.query.alert_type) { conditions.push(`a.alert_type = $${idx++}`); params.push(req.query.alert_type); }
      if (req.query.shipment_id){ conditions.push(`a.shipment_id = $${idx++}`);params.push(req.query.shipment_id); }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT a.*,
                  s.reference   AS shipment_reference,
                  fa.identifier AS asset_identifier,
                  u.full_name   AS assigned_to_name
           FROM alerts a
           LEFT JOIN shipments    s  ON s.id  = a.shipment_id
           LEFT JOIN fleet_assets fa ON fa.id = a.asset_id
           LEFT JOIN users        u  ON u.id  = a.assigned_to
           WHERE ${where}
           ORDER BY a.${col} ${dir} LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(
          `SELECT COUNT(*) FROM alerts a WHERE ${where}`,
          params
        ),
      ]);

      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── GET /api/alerts/summary ───────────────────────────────────────────────────
router.get('/summary', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         priority,
         status,
         COUNT(*) AS count
       FROM alerts a
       WHERE (a.shipment_id IN (SELECT id FROM shipments WHERE company_id = $1)
              OR a.asset_id IN (SELECT id FROM fleet_assets WHERE company_id = $1)
              OR (a.shipment_id IS NULL AND a.asset_id IS NULL))
       GROUP BY priority, status
       ORDER BY priority DESC, status`,
      [req.user.company_id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/alerts/:id ───────────────────────────────────────────────────────
router.get('/:id', [param('id').isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*,
              s.reference   AS shipment_reference,
              fa.identifier AS asset_identifier,
              u.full_name   AS assigned_to_name,
              d.title       AS disruption_title,
              te.temp_recorded_c, te.deviation_c
       FROM alerts a
       LEFT JOIN shipments           s  ON s.id  = a.shipment_id
       LEFT JOIN fleet_assets        fa ON fa.id = a.asset_id
       LEFT JOIN users               u  ON u.id  = a.assigned_to
       LEFT JOIN disruptions         d  ON d.id  = a.disruption_id
       LEFT JOIN temperature_excursions te ON te.id = a.excursion_id
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/alerts ──────────────────────────────────────────────────────────
router.post(
  '/',
  authorize('admin','logistics_manager','fleet_operator','analyst'),
  [
    body('alert_type').isIn([
      'temperature_breach','geofence_violation','eta_delay','asset_idle',
      'shipment_at_risk','disruption_detected','driver_hours_exceeded',
      'customs_hold','cargo_damage',
    ]),
    body('priority').isIn(['low','medium','high','critical']),
    body('title').trim().notEmpty().isLength({ max: 255 }),
    body('message').trim().notEmpty(),
    body('shipment_id').optional().isUUID(),
    body('asset_id').optional().isUUID(),
    body('disruption_id').optional().isUUID(),
    body('excursion_id').optional().isUUID(),
    body('assigned_to').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        alert_type, priority, title, message,
        shipment_id, asset_id, disruption_id, excursion_id, assigned_to,
      } = req.body;

      const { rows } = await db.query(
        `INSERT INTO alerts (
           alert_type, priority, title, message,
           shipment_id, asset_id, disruption_id, excursion_id, assigned_to
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          alert_type, priority, title, message,
          shipment_id || null, asset_id || null,
          disruption_id || null, excursion_id || null, assigned_to || null,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/alerts/:id ─────────────────────────────────────────────────────
router.patch(
  '/:id',
  [
    param('id').isUUID(),
    body('status').optional().isIn(['open','acknowledged','resolved','dismissed']),
    body('assigned_to').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const updates = []; const values = []; let idx = 1;

      if (req.body.status !== undefined) {
        updates.push(`status = $${idx++}`);
        values.push(req.body.status);

        if (req.body.status === 'acknowledged') {
          updates.push(`acknowledged_at = NOW()`);
        } else if (req.body.status === 'resolved') {
          updates.push(`resolved_at = NOW()`);
        }
      }
      if (req.body.assigned_to !== undefined) {
        updates.push(`assigned_to = $${idx++}`);
        values.push(req.body.assigned_to);
      }

      if (!updates.length) return res.status(422).json({ error: 'No updatable fields provided' });

      values.push(req.params.id);
      const { rows } = await db.query(
        `UPDATE alerts SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );
      if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── POST /api/alerts/:id/acknowledge ─────────────────────────────────────────
router.post('/:id/acknowledge', [param('id').isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_at = NOW()
       WHERE id = $1 AND status = 'open' RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alert not found or already actioned' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/alerts/:id/resolve ──────────────────────────────────────────────
router.post('/:id/resolve', [param('id').isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
       WHERE id = $1 AND status != 'dismissed' RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alert not found or dismissed' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
