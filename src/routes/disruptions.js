'use strict';
const express = require('express');
const { body, param, query: qv } = require('express-validator');

const db                  = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }        = require('../middleware/validate');
const { parsePagination, paginatedResponse, safeSort, safeDir } = require('../utils/pagination');
const disruptionEngine    = require('../engines/disruptionEngine');

const router = express.Router();
router.use(authenticate);

const SORT_COLS = ['started_at','severity','type','estimated_delay_hours','created_at'];

// ── GET /api/disruptions ──────────────────────────────────────────────────────
router.get(
  '/',
  [
    qv('status').optional().isIn(['active','monitoring','resolved','predicted']),
    qv('severity').optional().isIn(['low','medium','high','critical']),
    qv('type').optional().isIn([
      'weather','port_strike','geopolitical','road_closure','customs_delay',
      'natural_disaster','supplier_failure','cyber_attack','regulatory_change','capacity_shortage',
    ]),
    qv('affected_country').optional().isString().isLength({ max: 80 }),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 100 }),
    qv('sort').optional().isString(),
    qv('dir').optional().isIn(['asc','desc']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const col = safeSort(req.query.sort, SORT_COLS, 'started_at');
      const dir = safeDir(req.query.dir);

      const conditions = ['1=1'];
      const params     = [];
      let idx = 1;

      if (req.query.status)           { conditions.push(`status = $${idx++}`);           params.push(req.query.status); }
      if (req.query.severity)         { conditions.push(`severity = $${idx++}`);         params.push(req.query.severity); }
      if (req.query.type)             { conditions.push(`type = $${idx++}`);             params.push(req.query.type); }
      if (req.query.affected_country) { conditions.push(`affected_country ILIKE $${idx++}`); params.push(`%${req.query.affected_country}%`); }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT * FROM disruptions WHERE ${where}
           ORDER BY ${col} ${dir} LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM disruptions WHERE ${where}`, params),
      ]);

      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── GET /api/disruptions/:id ──────────────────────────────────────────────────
router.get('/:id', [param('id').isUUID()], validate, async (req, res, next) => {
  try {
    const [disruption, affected] = await Promise.all([
      db.query('SELECT * FROM disruptions WHERE id = $1', [req.params.id]),
      db.query(
        `SELECT s.id, s.reference, s.status, s.origin_city, s.destination_city,
                sd.estimated_delay_hours, sd.impact_notes, sd.notified_at
         FROM shipment_disruptions sd
         JOIN shipments s ON s.id = sd.shipment_id
         WHERE sd.disruption_id = $1 AND s.company_id = $2
         ORDER BY sd.estimated_delay_hours DESC`,
        [req.params.id, req.user.company_id]
      ),
    ]);
    if (!disruption.rows.length) return res.status(404).json({ error: 'Disruption not found' });
    res.json({ ...disruption.rows[0], affected_shipments: affected.rows });
  } catch (err) { next(err); }
});

// ── POST /api/disruptions ─────────────────────────────────────────────────────
router.post(
  '/',
  authorize('admin','logistics_manager','analyst'),
  [
    body('type').isIn([
      'weather','port_strike','geopolitical','road_closure','customs_delay',
      'natural_disaster','supplier_failure','cyber_attack','regulatory_change','capacity_shortage',
    ]),
    body('title').trim().notEmpty().isLength({ max: 200 }),
    body('severity').isIn(['low','medium','high','critical']),
    body('started_at').isISO8601().toDate(),
    body('description').optional().trim(),
    body('affected_region').optional().trim(),
    body('affected_country').optional().trim(),
    body('affected_lat').optional().isFloat({ min: -90, max: 90 }),
    body('affected_lon').optional().isFloat({ min: -180, max: 180 }),
    body('radius_km').optional().isFloat({ min: 0 }),
    body('source').optional().trim(),
    body('estimated_end_at').optional().isISO8601().toDate(),
    body('estimated_delay_hours').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const {
        type, title, description, severity, status = 'active',
        affected_region, affected_country, affected_lat, affected_lon, radius_km,
        source, started_at, estimated_end_at, estimated_delay_hours = 0,
      } = req.body;

      const { rows } = await db.query(
        `INSERT INTO disruptions (
           type, title, description, severity, status,
           affected_region, affected_country, affected_lat, affected_lon, radius_km,
           source, started_at, estimated_end_at, estimated_delay_hours
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          type, title, description || null, severity, status,
          affected_region || null, affected_country || null,
          affected_lat ?? null, affected_lon ?? null, radius_km ?? null,
          source || null, started_at, estimated_end_at || null, estimated_delay_hours,
        ]
      );
      const disruption = rows[0];

      // Immediately assess impact in background (don't block HTTP response)
      if (['active', 'monitoring'].includes(disruption.status)) {
        setImmediate(() =>
          disruptionEngine.assessDisruption(disruption).catch((e) =>
            console.error('[DisruptionEngine] assessment error:', e.message)
          )
        );
      }

      res.status(201).json(disruption);
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/disruptions/:id ────────────────────────────────────────────────
router.patch(
  '/:id',
  authorize('admin','logistics_manager','analyst'),
  [
    param('id').isUUID(),
    body('status').optional().isIn(['active','monitoring','resolved','predicted']),
    body('severity').optional().isIn(['low','medium','high','critical']),
    body('resolved_at').optional().isISO8601().toDate(),
    body('estimated_end_at').optional().isISO8601().toDate(),
    body('estimated_delay_hours').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const allowed = ['status','severity','resolved_at','estimated_end_at','estimated_delay_hours','description'];
      const updates = []; const values = []; let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { updates.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (!updates.length) return res.status(422).json({ error: 'No updatable fields provided' });

      values.push(req.params.id);
      const { rows } = await db.query(
        `UPDATE disruptions SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} RETURNING *`,
        values
      );
      if (!rows.length) return res.status(404).json({ error: 'Disruption not found' });
      const updated = rows[0];

      // Re-assess if still active/monitoring
      if (['active', 'monitoring'].includes(updated.status)) {
        setImmediate(() =>
          disruptionEngine.assessDisruption(updated).catch((e) =>
            console.error('[DisruptionEngine] reassessment error:', e.message)
          )
        );
      }

      res.json(updated);
    } catch (err) { next(err); }
  }
);

// ── POST /api/disruptions/:id/link-shipment ───────────────────────────────────
router.post(
  '/:id/link-shipment',
  authorize('admin','logistics_manager','analyst'),
  [
    param('id').isUUID(),
    body('shipment_id').isUUID(),
    body('estimated_delay_hours').optional().isFloat({ min: 0 }),
    body('risk_score_delta').optional().isFloat({ min: -100, max: 100 }),
    body('impact_notes').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { shipment_id, estimated_delay_hours = 0, risk_score_delta, impact_notes } = req.body;

      const { rows } = await db.query(
        `INSERT INTO shipment_disruptions (shipment_id, disruption_id, estimated_delay_hours, risk_score_delta, impact_notes, notified_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (shipment_id, disruption_id) DO UPDATE
           SET estimated_delay_hours = EXCLUDED.estimated_delay_hours,
               risk_score_delta      = EXCLUDED.risk_score_delta,
               impact_notes          = EXCLUDED.impact_notes
         RETURNING *`,
        [shipment_id, req.params.id, estimated_delay_hours, risk_score_delta ?? null, impact_notes || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── GET /api/disruptions/active/map ──────────────────────────────────────────
// GeoJSON-ready active disruptions for map overlay
router.get('/active/map', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, type, title, severity, affected_country, affected_region,
              affected_lat, affected_lon, radius_km,
              started_at, estimated_end_at, estimated_delay_hours
       FROM disruptions
       WHERE status IN ('active','monitoring')
         AND affected_lat IS NOT NULL
         AND affected_lon IS NOT NULL
       ORDER BY severity DESC, started_at DESC`
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/disruptions/:id/impact ──────────────────────────────────────────
router.get('/:id/impact', [param('id').isUUID()], validate, async (req, res, next) => {
  try {
    const report = await disruptionEngine.getDisruptionImpactReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'Disruption not found' });
    res.json(report);
  } catch (err) { next(err); }
});

// ── POST /api/disruptions/:id/reassess ───────────────────────────────────────
router.post(
  '/:id/reassess',
  authorize('admin','logistics_manager','analyst'),
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const result = await disruptionEngine.assessDisruption(req.params.id);
      res.json(result);
    } catch (err) { next(err); }
  }
);

module.exports = router;
