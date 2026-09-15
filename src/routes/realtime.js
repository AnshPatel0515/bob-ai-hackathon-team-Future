'use strict';
/**
 * /api/realtime  — REST endpoints that complement the WebSocket feed.
 *
 * These routes are the HTTP interface for:
 *   POST /gps              – ingest a GPS update (IoT device → server)
 *   GET  /snapshot/:assetId – current tracking snapshot for one asset
 *   GET  /fleet             – full fleet availability + utilisation
 *   GET  /shipment/:id/eta  – current ETA + history for a shipment
 *   POST /shipment/:id/eta/recalculate – force ETA recalc (e.g. after disruption)
 *   GET  /dashboard         – aggregated real-time dashboard data
 *   GET  /location-history/:assetId – paginated GPS trail
 */

const express        = require('express');
const { body, param, query: qv } = require('express-validator');

const db             = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate }   = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const trackingEngine = require('../realtime/trackingEngine');

const router = express.Router();
router.use(authenticate);

// ── POST /api/realtime/gps ────────────────────────────────────────────────────
// Primary IoT ingest endpoint. Accepts a GPS ping from a vehicle/device.
router.post(
  '/gps',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    body('asset_id').isUUID().withMessage('asset_id (UUID) required'),
    body('latitude').isFloat({ min: -90, max: 90 }).withMessage('latitude required'),
    body('longitude').isFloat({ min: -180, max: 180 }).withMessage('longitude required'),
    body('speed_kmh').optional().isFloat({ min: 0, max: 1200 }),
    body('heading_deg').optional().isFloat({ min: 0, max: 360 }),
    body('altitude_m').optional().isFloat(),
    body('accuracy_m').optional().isFloat({ min: 0 }),
    body('shipment_id').optional().isUUID(),
    body('source').optional().isIn(['gps','manual','simulated']),
    body('raw_payload').optional().isObject(),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Verify asset belongs to user's company
      const { rows: assetRows } = await db.query(
        'SELECT id FROM fleet_assets WHERE id = $1 AND company_id = $2',
        [req.body.asset_id, req.user.company_id]
      );
      if (!assetRows.length) return res.status(404).json({ error: 'Asset not found' });

      const result = await trackingEngine.processLocationUpdate({
        ...req.body,
        source: req.body.source || 'gps',
      });

      res.status(202).json({ ok: true, tracking: result });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/realtime/gps/batch ─────────────────────────────────────────────
// Ingest multiple GPS pings in one call (e.g. buffered IoT uplink).
router.post(
  '/gps/batch',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    body('updates').isArray({ min: 1, max: 100 }).withMessage('updates must be an array (max 100)'),
    body('updates.*.asset_id').isUUID(),
    body('updates.*.latitude').isFloat({ min: -90, max: 90 }),
    body('updates.*.longitude').isFloat({ min: -180, max: 180 }),
    body('updates.*.speed_kmh').optional().isFloat({ min: 0, max: 1200 }),
    body('updates.*.heading_deg').optional().isFloat({ min: 0, max: 360 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Verify all assets belong to user's company in one query
      const assetIds = [...new Set(req.body.updates.map((u) => u.asset_id))];
      const { rows: assetRows } = await db.query(
        `SELECT id FROM fleet_assets
         WHERE id = ANY($1::uuid[]) AND company_id = $2`,
        [assetIds, req.user.company_id]
      );
      const validIds = new Set(assetRows.map((r) => r.id));
      const invalid  = assetIds.filter((id) => !validIds.has(id));
      if (invalid.length) {
        return res.status(404).json({ error: 'Unknown asset_ids', invalid });
      }

      // Process in sequence to avoid racing on same asset
      const results = [];
      for (const upd of req.body.updates) {
        try {
          const r = await trackingEngine.processLocationUpdate({ ...upd, source: upd.source || 'gps' });
          results.push({ asset_id: upd.asset_id, ok: true, position: r.position });
        } catch (e) {
          results.push({ asset_id: upd.asset_id, ok: false, error: e.message });
        }
      }

      res.status(202).json({ processed: results.length, results });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/realtime/snapshot/:assetId ───────────────────────────────────────
router.get(
  '/snapshot/:assetId',
  [param('assetId').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT ts.*,
                fa.identifier, fa.asset_type, fa.status AS asset_status,
                fa.company_id,
                s.reference  AS shipment_reference,
                s.status     AS shipment_status,
                s.destination_city, s.destination_country,
                l.mode       AS leg_mode,
                l.dest_city  AS leg_dest_city,
                d.full_name  AS driver_name
         FROM tracking_snapshots ts
         JOIN fleet_assets fa        ON fa.id = ts.asset_id
         LEFT JOIN shipments s       ON s.id  = ts.shipment_id
         LEFT JOIN shipment_legs l   ON l.id  = ts.current_leg_id
         LEFT JOIN fleet_assignments fa2 ON fa2.asset_id = ts.asset_id AND fa2.is_active = TRUE
         LEFT JOIN drivers d         ON d.id  = fa2.driver_id
         WHERE ts.asset_id = $1 AND fa.company_id = $2`,
        [req.params.assetId, req.user.company_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Snapshot not found — no GPS data yet for this asset' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/realtime/fleet ───────────────────────────────────────────────────
router.get('/fleet', async (req, res, next) => {
  try {
    const availability = await trackingEngine.getFleetAvailability(req.user.company_id);
    res.json(availability);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/realtime/fleet/utilisation/refresh ─────────────────────────────
router.post(
  '/fleet/utilisation/refresh',
  authorize('admin','logistics_manager'),
  async (req, res, next) => {
    try {
      const updates = await trackingEngine.refreshUtilisation(req.user.company_id);
      res.json({ updated: updates.length, assets: updates });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/realtime/shipment/:id/eta ────────────────────────────────────────
router.get(
  '/shipment/:id/eta',
  [param('id').isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const shipId = req.params.id;

      // Verify shipment belongs to company
      const { rows: shipRows } = await db.query(
        `SELECT id, reference, estimated_delivery_at, status, delay_hours
         FROM shipments WHERE id = $1 AND company_id = $2`,
        [shipId, req.user.company_id]
      );
      if (!shipRows.length) return res.status(404).json({ error: 'Shipment not found' });

      // Current snapshot for any active asset on this shipment
      const { rows: snapRows } = await db.query(
        `SELECT ts.*, fa.identifier, fa.asset_type
         FROM tracking_snapshots ts
         JOIN fleet_assets fa ON fa.id = ts.asset_id
         WHERE ts.shipment_id = $1`,
        [shipId]
      );

      // ETA history (last 20)
      const { rows: histRows } = await db.query(
        `SELECT * FROM eta_history
         WHERE shipment_id = $1
         ORDER BY calculated_at DESC
         LIMIT 20`,
        [shipId]
      );

      res.json({
        shipment:     shipRows[0],
        live_assets:  snapRows,
        eta_history:  histRows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/realtime/shipment/:id/eta/recalculate ───────────────────────────
router.post(
  '/shipment/:id/eta/recalculate',
  authorize('admin','logistics_manager','fleet_operator'),
  [
    param('id').isUUID(),
    body('trigger_reason').optional().trim().isLength({ max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const shipId = req.params.id;

      const { rows: shipRows } = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [shipId, req.user.company_id]
      );
      if (!shipRows.length) return res.status(404).json({ error: 'Shipment not found' });

      // Find all active assets on this shipment
      const { rows: assetRows } = await db.query(
        `SELECT DISTINCT asset_id FROM fleet_assignments
         WHERE shipment_id = $1 AND is_active = TRUE`,
        [shipId]
      );

      if (!assetRows.length) {
        return res.status(422).json({ error: 'No active assets assigned to this shipment' });
      }

      const results = [];
      for (const { asset_id } of assetRows) {
        const r = await trackingEngine.recalculateETA(
          asset_id,
          req.body.trigger_reason || 'manual'
        );
        if (r) results.push({ asset_id, ...r.etaResult, delay: r.delayResult });
      }

      res.json({ recalculated: results.length, results });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/realtime/dashboard ───────────────────────────────────────────────
// Single endpoint powering the main real-time dashboard.
router.get('/dashboard', async (req, res, next) => {
  try {
    const cid = req.user.company_id;

    const [
      fleetSummary,
      activeShipments,
      openAlerts,
      liveDelays,
      topRecs,
      recentEtaChanges,
    ] = await Promise.all([
      // Fleet summary
      db.query(
        `SELECT status, COUNT(*) AS count,
                ROUND(AVG(utilisation_pct),1) AS avg_utilisation
         FROM fleet_assets WHERE company_id = $1 AND status != 'decommissioned'
         GROUP BY status ORDER BY status`,
        [cid]
      ),

      // Active shipments with live snapshot
      db.query(
        `SELECT s.id, s.reference, s.status, s.risk_score,
                s.origin_city, s.destination_city,
                s.estimated_delivery_at, s.delay_hours,
                s.is_cold_chain,
                ts.latitude, ts.longitude,
                ts.speed_kmh, ts.leg_progress_pct,
                ts.estimated_arrival_at, ts.is_delayed, ts.delay_minutes,
                ts.last_update_at
         FROM shipments s
         LEFT JOIN tracking_snapshots ts ON ts.shipment_id = s.id
         WHERE s.company_id = $1
           AND s.status IN ('in_transit','delayed','at_customs','booked')
         ORDER BY s.risk_score DESC NULLS LAST, s.estimated_delivery_at ASC
         LIMIT 20`,
        [cid]
      ),

      // Open/acknowledged alerts (critical + high first)
      db.query(
        `SELECT a.id, a.alert_type, a.priority, a.title,
                a.triggered_at, a.shipment_id, a.asset_id,
                s.reference AS shipment_reference
         FROM alerts a
         LEFT JOIN shipments s ON s.id = a.shipment_id
         WHERE (a.shipment_id IN (SELECT id FROM shipments WHERE company_id = $1)
                OR a.asset_id IN (SELECT id FROM fleet_assets WHERE company_id = $1)
                OR (a.shipment_id IS NULL AND a.asset_id IS NULL))
           AND a.status IN ('open','acknowledged')
         ORDER BY
           CASE a.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                           WHEN 'medium'   THEN 3 ELSE 4 END,
           a.triggered_at DESC
         LIMIT 10`,
        [cid]
      ),

      // Currently delayed assets
      db.query(
        `SELECT ts.asset_id, ts.shipment_id, ts.delay_minutes,
                ts.delay_reason, ts.estimated_arrival_at,
                fa.identifier, s.reference AS shipment_reference
         FROM tracking_snapshots ts
         JOIN fleet_assets fa ON fa.id = ts.asset_id
         LEFT JOIN shipments s ON s.id = ts.shipment_id
         WHERE fa.company_id = $1 AND ts.is_delayed = TRUE
         ORDER BY ts.delay_minutes DESC`,
        [cid]
      ),

      // Top pending recommendations
      db.query(
        `SELECT id, recommendation_type, title,
                confidence_score, net_benefit_usd, time_saving_hours
         FROM optimization_recommendations
         WHERE status = 'pending'
           AND (shipment_id IN (SELECT id FROM shipments WHERE company_id = $1)
                OR shipment_id IS NULL)
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY confidence_score DESC NULLS LAST
         LIMIT 5`,
        [cid]
      ),

      // Recent ETA changes (last hour)
      db.query(
        `SELECT eh.shipment_id, s.reference, eh.new_eta,
                eh.delta_minutes, eh.trigger_reason, eh.calculated_at
         FROM eta_history eh
         JOIN shipments s ON s.id = eh.shipment_id
         WHERE s.company_id = $1
           AND eh.calculated_at >= NOW() - INTERVAL '1 hour'
           AND ABS(eh.delta_minutes) > 10
         ORDER BY ABS(eh.delta_minutes) DESC
         LIMIT 10`,
        [cid]
      ),
    ]);

    res.json({
      generated_at:      new Date().toISOString(),
      fleet_summary:     fleetSummary.rows,
      active_shipments:  activeShipments.rows,
      open_alerts:       openAlerts.rows,
      live_delays:       liveDelays.rows,
      top_recommendations: topRecs.rows,
      recent_eta_changes:  recentEtaChanges.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/realtime/location-history/:assetId ───────────────────────────────
router.get(
  '/location-history/:assetId',
  [
    param('assetId').isUUID(),
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 500 }),
    qv('from').optional().isISO8601(),
    qv('to').optional().isISO8601(),
    qv('shipment_id').optional().isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Verify asset belongs to company
      const { rows: assetRows } = await db.query(
        'SELECT id FROM fleet_assets WHERE id = $1 AND company_id = $2',
        [req.params.assetId, req.user.company_id]
      );
      if (!assetRows.length) return res.status(404).json({ error: 'Asset not found' });

      const { page, limit, offset } = parsePagination(req.query);
      const conditions = ['asset_id = $1'];
      const params     = [req.params.assetId];
      let idx = 2;

      if (req.query.from)        { conditions.push(`received_at >= $${idx++}`); params.push(req.query.from); }
      if (req.query.to)          { conditions.push(`received_at <= $${idx++}`); params.push(req.query.to); }
      if (req.query.shipment_id) { conditions.push(`shipment_id = $${idx++}`);  params.push(req.query.shipment_id); }

      const where = conditions.join(' AND ');
      const [dataRes, countRes] = await Promise.all([
        db.query(
          `SELECT id, asset_id, shipment_id, received_at,
                  latitude, longitude, heading_deg, speed_kmh, altitude_m,
                  distance_leg_km, source
           FROM location_updates
           WHERE ${where}
           ORDER BY received_at DESC
           LIMIT $${idx} OFFSET $${idx + 1}`,
          [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM location_updates WHERE ${where}`, params),
      ]);

      res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/realtime/eta-history/:shipmentId ─────────────────────────────────
router.get(
  '/eta-history/:shipmentId',
  [
    param('shipmentId').isUUID(),
    qv('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { rows: shipRows } = await db.query(
        'SELECT id FROM shipments WHERE id = $1 AND company_id = $2',
        [req.params.shipmentId, req.user.company_id]
      );
      if (!shipRows.length) return res.status(404).json({ error: 'Shipment not found' });

      const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
      const { rows } = await db.query(
        `SELECT * FROM eta_history
         WHERE shipment_id = $1
         ORDER BY calculated_at DESC LIMIT $2`,
        [req.params.shipmentId, limit]
      );
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
