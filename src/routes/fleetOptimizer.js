'use strict';
/**
 * /api/fleet-optimizer  — Fleet Utilisation Optimizer REST endpoints
 *
 * POST /run                       – trigger a full optimisation pass
 * GET  /runs                      – list past optimisation runs
 * GET  /runs/:runId               – full run report with all candidates
 * GET  /idle                      – idle fleet assets
 * GET  /underutilised             – assets below utilisation threshold
 * GET  /overloaded                – routes over capacity
 * GET  /available-drivers         – available drivers with hours remaining
 * GET  /unassigned-shipments      – shipments needing assignment
 * GET  /candidates                – pending assignment candidates (all runs)
 * GET  /candidates/:id            – single candidate detail
 * POST /candidates/:id/accept     – accept a recommendation → creates assignment
 * POST /candidates/:id/reject     – reject with optional reason
 * GET  /score                     – score a specific asset+shipment+driver combination
 * GET  /dashboard                 – optimiser summary dashboard
 */

const express = require('express');
const { body, param, query: qv } = require('express-validator');

const db             = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const fleetOptimizer = require('../engines/fleetOptimizer');

const router = express.Router();
router.use(authenticate);

// ── POST /api/fleet-optimizer/run ─────────────────────────────────────────────
router.post(
  '/run',
  authorize('admin','logistics_manager','fleet_operator'),
  [body('notes').optional().trim()],
  validate,
  async (req, res, next) => {
    try {
      const result = await fleetOptimizer.runOptimisation(req.user.company_id, {
        triggeredBy: 'user',
        userId:      req.user.id,
      });
      res.status(202).json(result);
    } catch (err) { next(err); }
  }
);

// ── GET /api/fleet-optimizer/runs ─────────────────────────────────────────────
router.get(
  '/runs',
  [
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 50 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT * FROM optimisation_runs
           WHERE company_id = $1
           ORDER BY run_at DESC LIMIT $2 OFFSET $3`,
          [req.user.company_id, limit, offset]
        ),
        db.query(
          'SELECT COUNT(*) FROM optimisation_runs WHERE company_id = $1',
          [req.user.company_id]
        ),
      ]);
      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── GET /api/fleet-optimizer/runs/:runId ─────────────────────────────────────
router.get(
  '/runs/:runId',
  [param('runId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const report = await fleetOptimizer.getRunReport(req.params.runId);
      if (!report) return res.status(404).json({ error: 'Run not found' });
      // Verify company ownership
      if (report.run.company_id !== req.user.company_id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      res.json(report);
    } catch (err) { next(err); }
  }
);

// ── GET /api/fleet-optimizer/idle ────────────────────────────────────────────
router.get('/idle', async (req, res, next) => {
  try {
    const assets = await fleetOptimizer.getIdleAssets(req.user.company_id);
    const totalIdleCost = assets.reduce((s, a) => {
      return s + Math.max(0, parseFloat(a.idle_days || 0)) * 280;
    }, 0);
    res.json({
      data:             assets,
      count:            assets.length,
      total_idle_cost_usd: parseFloat(totalIdleCost.toFixed(2)),
    });
  } catch (err) { next(err); }
});

// ── GET /api/fleet-optimizer/underutilised ────────────────────────────────────
router.get('/underutilised', async (req, res, next) => {
  try {
    const assets = await fleetOptimizer.getUnderutilisedAssets(req.user.company_id);
    res.json({ data: assets, count: assets.length });
  } catch (err) { next(err); }
});

// ── GET /api/fleet-optimizer/overloaded ───────────────────────────────────────
router.get('/overloaded', async (req, res, next) => {
  try {
    const routes = await fleetOptimizer.getOverloadedRoutes(req.user.company_id);
    res.json({ data: routes, count: routes.length });
  } catch (err) { next(err); }
});

// ── GET /api/fleet-optimizer/available-drivers ────────────────────────────────
router.get('/available-drivers', async (req, res, next) => {
  try {
    const drivers = await fleetOptimizer.getAvailableDrivers(req.user.company_id);
    res.json({ data: drivers, count: drivers.length });
  } catch (err) { next(err); }
});

// ── GET /api/fleet-optimizer/unassigned-shipments ─────────────────────────────
router.get('/unassigned-shipments', async (req, res, next) => {
  try {
    const shipments = await fleetOptimizer.getShipmentsNeedingAssignment(req.user.company_id);
    res.json({ data: shipments, count: shipments.length });
  } catch (err) { next(err); }
});

// ── GET /api/fleet-optimizer/candidates ───────────────────────────────────────
router.get(
  '/candidates',
  [
    qv('status').optional().isIn(['pending','accepted','rejected','superseded']),
    qv('shipment_id').optional().isUUID(),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 100 }),
    qv('min_score').optional().isFloat({ min: 0, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const conditions = ['ac.company_id = $1'];
      const params     = [req.user.company_id];
      let   idx        = 2;

      if (req.query.status)      { conditions.push(`ac.status = $${idx++}`);        params.push(req.query.status); }
      if (req.query.shipment_id) { conditions.push(`ac.shipment_id = $${idx++}`);   params.push(req.query.shipment_id); }
      if (req.query.min_score)   { conditions.push(`ac.total_score >= $${idx++}`);  params.push(parseFloat(req.query.min_score)); }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT ac.*,
                  s.reference AS shipment_reference,
                  s.origin_city, s.destination_city, s.cargo_value_usd,
                  fa.identifier AS asset_identifier, fa.asset_type,
                  fa.status AS asset_status, fa.utilisation_pct,
                  d.full_name AS driver_name, d.status AS driver_status
           FROM assignment_candidates ac
           JOIN shipments   s  ON s.id  = ac.shipment_id
           JOIN fleet_assets fa ON fa.id = ac.asset_id
           LEFT JOIN drivers d  ON d.id  = ac.driver_id
           WHERE ${where}
           ORDER BY ac.total_score DESC, ac.created_at DESC
           LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM assignment_candidates ac WHERE ${where}`, params),
      ]);

      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) { next(err); }
  }
);

// ── GET /api/fleet-optimizer/candidates/:id ───────────────────────────────────
router.get(
  '/candidates/:id',
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT ac.*,
                s.reference, s.cargo_description, s.cargo_value_usd,
                s.origin_city, s.origin_country, s.destination_city, s.destination_country,
                s.scheduled_pickup_at, s.is_cold_chain,
                fa.identifier, fa.asset_type, fa.make_model,
                fa.capacity_kg, fa.capacity_m3, fa.is_refrigerated,
                fa.current_lat, fa.current_lon, fa.status AS asset_status,
                fa.utilisation_pct AS current_utilisation,
                d.full_name AS driver_name, d.license_class,
                d.hours_driven_7d, d.max_hours_7d, d.status AS driver_status,
                or2.run_at, or2.triggered_by
         FROM assignment_candidates ac
         JOIN shipments    s   ON s.id   = ac.shipment_id
         JOIN fleet_assets fa  ON fa.id  = ac.asset_id
         LEFT JOIN drivers d   ON d.id   = ac.driver_id
         LEFT JOIN optimisation_runs or2 ON or2.id = ac.run_id
         WHERE ac.id = $1 AND ac.company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

// ── POST /api/fleet-optimizer/candidates/:id/accept ──────────────────────────
router.post(
  '/candidates/:id/accept',
  authorize('admin','logistics_manager','fleet_operator'),
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const result = await fleetOptimizer.acceptCandidate(req.params.id, req.user.id);
      res.json(result);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      next(err);
    }
  }
);

// ── POST /api/fleet-optimizer/candidates/:id/reject ──────────────────────────
router.post(
  '/candidates/:id/reject',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    param('id').isUUID(),
    body('reason').optional().trim().isLength({ max: 500 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await fleetOptimizer.rejectCandidate(req.params.id, req.body.reason);
      res.json(result);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      next(err);
    }
  }
);

// ── GET /api/fleet-optimizer/score ────────────────────────────────────────────
// Score a specific asset + shipment + optional driver combination on demand.
router.get(
  '/score',
  [
    qv('asset_id').isUUID().withMessage('asset_id required'),
    qv('shipment_id').isUUID().withMessage('shipment_id required'),
    qv('driver_id').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const cid = req.user.company_id;

      const [assetRes, shipRes, driverRes] = await Promise.all([
        db.query(
          `SELECT fa.*,
                  COALESCE(fa.utilisation_pct, 0) AS utilisation_pct,
                  EXTRACT(DAY FROM NOW() - fa.updated_at) AS idle_days,
                  COUNT(fass.id) FILTER (WHERE fass.assigned_at >= NOW() - INTERVAL '30 days') AS assignments_30d
           FROM fleet_assets fa
           LEFT JOIN fleet_assignments fass ON fass.asset_id = fa.id
           WHERE fa.id = $1 AND fa.company_id = $2
           GROUP BY fa.id`,
          [req.query.asset_id, cid]
        ),
        db.query(
          'SELECT * FROM shipments WHERE id = $1 AND company_id = $2',
          [req.query.shipment_id, cid]
        ),
        req.query.driver_id
          ? db.query('SELECT * FROM drivers WHERE id = $1 AND company_id = $2', [req.query.driver_id, cid])
          : Promise.resolve({ rows: [null] }),
      ]);

      if (!assetRes.rows.length)  return res.status(404).json({ error: 'Asset not found' });
      if (!shipRes.rows.length)   return res.status(404).json({ error: 'Shipment not found' });

      const result = fleetOptimizer.scoreCandidate(
        shipRes.rows[0],
        assetRes.rows[0],
        driverRes.rows[0] || null
      );
      res.json({
        asset_id:    req.query.asset_id,
        shipment_id: req.query.shipment_id,
        driver_id:   req.query.driver_id || null,
        ...result,
      });
    } catch (err) { next(err); }
  }
);

// ── GET /api/fleet-optimizer/dashboard ────────────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const cid = req.user.company_id;

    const [
      fleetOverview,
      idleAssets,
      availDrivers,
      unassigned,
      recentRuns,
      topCandidates,
      savingsPotential,
    ] = await Promise.all([
      // Fleet overview: count by status + avg utilisation
      db.query(
        `SELECT status,
                COUNT(*)                         AS count,
                ROUND(AVG(utilisation_pct), 1)  AS avg_utilisation
         FROM fleet_assets
         WHERE company_id = $1 AND status != 'decommissioned'
         GROUP BY status ORDER BY status`,
        [cid]
      ),
      // Idle assets with estimated daily cost
      db.query(
        `SELECT fa.id, fa.identifier, fa.asset_type, fa.utilisation_pct,
                fa.is_refrigerated, fa.current_location_desc,
                ROUND(EXTRACT(DAY FROM NOW() - COALESCE(ts.last_update_at, fa.updated_at)),0) AS idle_days,
                ROUND(EXTRACT(DAY FROM NOW() - COALESCE(ts.last_update_at, fa.updated_at)),0) * 280 AS idle_cost_usd
         FROM fleet_assets fa
         LEFT JOIN tracking_snapshots ts ON ts.asset_id = fa.id
         WHERE fa.company_id = $1 AND fa.status IN ('idle','available')
         ORDER BY idle_days DESC NULLS LAST
         LIMIT 10`,
        [cid]
      ),
      // Available drivers
      db.query(
        `SELECT id, full_name, license_class, home_base_city,
                hours_driven_7d, max_hours_7d,
                (max_hours_7d - hours_driven_7d) AS hours_remaining
         FROM drivers
         WHERE company_id = $1 AND status = 'available'
           AND license_expiry > CURRENT_DATE
         ORDER BY (max_hours_7d - hours_driven_7d) DESC
         LIMIT 10`,
        [cid]
      ),
      // Unassigned shipments
      db.query(
        `SELECT s.id, s.reference, s.status, s.scheduled_pickup_at,
                s.cargo_value_usd, s.is_cold_chain,
                s.origin_city, s.destination_city
         FROM shipments s
         WHERE s.company_id = $1
           AND s.status IN ('booked','in_transit','delayed')
           AND NOT EXISTS (
             SELECT 1 FROM fleet_assignments fa
             WHERE fa.shipment_id = s.id AND fa.is_active = TRUE
           )
         ORDER BY s.scheduled_pickup_at ASC
         LIMIT 10`,
        [cid]
      ),
      // Recent optimisation runs
      db.query(
        `SELECT id, run_at, triggered_by, total_assets, idle_assets,
                avg_utilisation_before, avg_utilisation_after, utilisation_delta,
                total_cost_saving_usd, total_recommendations, accepted_recommendations
         FROM optimisation_runs
         WHERE company_id = $1
         ORDER BY run_at DESC LIMIT 5`,
        [cid]
      ),
      // Top pending candidates
      db.query(
        `SELECT ac.id, ac.shipment_id, ac.asset_id, ac.total_score,
                ac.cost_saving_vs_current, ac.expected_utilisation_pct,
                ac.estimated_pickup_eta, ac.distance_to_origin_km,
                s.reference AS shipment_reference,
                fa.identifier AS asset_identifier, fa.asset_type,
                d.full_name AS driver_name
         FROM assignment_candidates ac
         JOIN shipments s    ON s.id  = ac.shipment_id
         JOIN fleet_assets fa ON fa.id = ac.asset_id
         LEFT JOIN drivers d  ON d.id = ac.driver_id
         WHERE ac.company_id = $1 AND ac.status = 'pending'
         ORDER BY ac.total_score DESC LIMIT 10`,
        [cid]
      ),
      // Total potential savings from pending candidates
      db.query(
        `SELECT
           COALESCE(SUM(cost_saving_vs_current), 0) AS total_potential_saving,
           COUNT(*)                                  AS pending_candidates,
           ROUND(AVG(total_score), 1)               AS avg_score
         FROM assignment_candidates
         WHERE company_id = $1 AND status = 'pending'`,
        [cid]
      ),
    ]);

    res.json({
      generated_at:       new Date().toISOString(),
      fleet_overview:     fleetOverview.rows,
      idle_assets:        idleAssets.rows,
      available_drivers:  availDrivers.rows,
      unassigned_shipments: unassigned.rows,
      recent_runs:        recentRuns.rows,
      top_candidates:     topCandidates.rows,
      savings_potential:  savingsPotential.rows[0],
    });
  } catch (err) { next(err); }
});

module.exports = router;
