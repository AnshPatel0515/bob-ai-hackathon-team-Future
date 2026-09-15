'use strict';
const express = require('express');
const { body, param, query: qv } = require('express-validator');

const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }  = require('../middleware/validate');
const { parsePagination, paginatedResponse, safeSort, safeDir } = require('../utils/pagination');

const router = express.Router();
router.use(authenticate);

const SORT_COLS = ['generated_at','confidence_score','net_benefit_usd','expires_at'];

// ── GET /api/recommendations ──────────────────────────────────────────────────
router.get(
  '/',
  [
    qv('status').optional().isIn(['pending','accepted','rejected','implemented','expired']),
    qv('recommendation_type').optional().isIn([
      'reroute','reassign_asset','reassign_driver','expedite_customs',
      'delay_shipment','split_shipment','carrier_switch','cost_optimisation',
    ]),
    qv('shipment_id').optional().isUUID(),
    qv('min_confidence').optional().isFloat({ min: 0, max: 100 }),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 100 }),
    qv('sort').optional().isString(),
    qv('dir').optional().isIn(['asc','desc']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const col = safeSort(req.query.sort, SORT_COLS, 'generated_at');
      const dir = safeDir(req.query.dir);

      const conditions = [
        `(r.shipment_id IN (SELECT id FROM shipments WHERE company_id = $1) OR r.shipment_id IS NULL)`
      ];
      const params = [req.user.company_id];
      let idx = 2;

      if (req.query.status)               { conditions.push(`r.status = $${idx++}`);               params.push(req.query.status); }
      if (req.query.recommendation_type)  { conditions.push(`r.recommendation_type = $${idx++}`);  params.push(req.query.recommendation_type); }
      if (req.query.shipment_id)          { conditions.push(`r.shipment_id = $${idx++}`);           params.push(req.query.shipment_id); }
      if (req.query.min_confidence)       { conditions.push(`r.confidence_score >= $${idx++}`);     params.push(parseFloat(req.query.min_confidence)); }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT r.*,
                  s.reference     AS shipment_reference,
                  d.title         AS disruption_title,
                  u.full_name     AS reviewed_by_name
           FROM optimization_recommendations r
           LEFT JOIN shipments    s ON s.id = r.shipment_id
           LEFT JOIN disruptions  d ON d.id = r.disruption_id
           LEFT JOIN users        u ON u.id = r.reviewed_by
           WHERE ${where}
           ORDER BY r.${col} ${dir} LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(
          `SELECT COUNT(*) FROM optimization_recommendations r WHERE ${where}`,
          params
        ),
      ]);

      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── GET /api/recommendations/:id ──────────────────────────────────────────────
router.get('/:id', [param('id').isUUID()], validate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*,
              s.reference    AS shipment_reference,
              s.status       AS shipment_status,
              d.title        AS disruption_title,
              d.severity     AS disruption_severity,
              u.full_name    AS reviewed_by_name
       FROM optimization_recommendations r
       LEFT JOIN shipments    s ON s.id = r.shipment_id
       LEFT JOIN disruptions  d ON d.id = r.disruption_id
       LEFT JOIN users        u ON u.id = r.reviewed_by
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recommendation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/recommendations ─────────────────────────────────────────────────
router.post(
  '/',
  authorize('admin','logistics_manager','analyst'),
  [
    body('recommendation_type').isIn([
      'reroute','reassign_asset','reassign_driver','expedite_customs',
      'delay_shipment','split_shipment','carrier_switch','cost_optimisation',
    ]),
    body('title').trim().notEmpty().isLength({ max: 255 }),
    body('description').trim().notEmpty(),
    body('shipment_id').optional().isUUID(),
    body('disruption_id').optional().isUUID(),
    body('rationale').optional().trim(),
    body('estimated_saving_usd').optional().isFloat({ min: 0 }),
    body('estimated_cost_usd').optional().isFloat({ min: 0 }),
    body('time_saving_hours').optional().isFloat({ min: 0 }),
    body('confidence_score').optional().isFloat({ min: 0, max: 100 }),
    body('action_payload').optional().isObject(),
    body('expires_at').optional().isISO8601().toDate(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        recommendation_type, title, description, shipment_id, disruption_id,
        rationale, estimated_saving_usd, estimated_cost_usd,
        time_saving_hours, confidence_score, action_payload, expires_at,
      } = req.body;

      const { rows } = await db.query(
        `INSERT INTO optimization_recommendations (
           recommendation_type, title, description, shipment_id, disruption_id,
           rationale, estimated_saving_usd, estimated_cost_usd,
           time_saving_hours, confidence_score,
           action_payload, expires_at, generated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'user')
         RETURNING *`,
        [
          recommendation_type, title, description,
          shipment_id || null, disruption_id || null,
          rationale || null, estimated_saving_usd ?? null, estimated_cost_usd ?? null,
          time_saving_hours ?? null, confidence_score ?? null,
          action_payload ? JSON.stringify(action_payload) : null,
          expires_at || null,
        ]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/recommendations/:id/status ────────────────────────────────────
router.patch(
  '/:id/status',
  authorize('admin','logistics_manager'),
  [
    param('id').isUUID(),
    body('status').isIn(['accepted','rejected','implemented','expired']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE optimization_recommendations
         SET status      = $1,
             reviewed_by = $2,
             reviewed_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [req.body.status, req.user.id, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Recommendation not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/recommendations/pending/digest ───────────────────────────────────
// High-confidence pending recommendations summary for dashboard
router.get('/pending/digest', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.id, r.recommendation_type, r.title,
              r.confidence_score, r.net_benefit_usd, r.time_saving_hours,
              r.generated_at, r.expires_at,
              s.reference AS shipment_reference
       FROM optimization_recommendations r
       LEFT JOIN shipments s ON s.id = r.shipment_id
       WHERE r.status = 'pending'
         AND (r.shipment_id IN (SELECT id FROM shipments WHERE company_id = $1) OR r.shipment_id IS NULL)
         AND (r.expires_at IS NULL OR r.expires_at > NOW())
         AND r.confidence_score >= 70
       ORDER BY r.confidence_score DESC, r.net_benefit_usd DESC NULLS LAST
       LIMIT 10`,
      [req.user.company_id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

module.exports = router;
