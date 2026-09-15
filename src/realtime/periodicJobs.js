'use strict';
/**
 * Periodic jobs that run on a timer inside the process.
 *
 * Timers (all configurable via .env):
 *   UTILISATION_INTERVAL_MS     default 5 min   – refresh fleet utilisation
 *   NOSIGNAL_INTERVAL_MS        default 3 min   – stale GPS watchdog
 *   FLEET_STATUS_INTERVAL_MS    default 30 sec  – broadcast live fleet snapshot
 *   COLD_CHAIN_SCAN_INTERVAL_MS default 60 sec  – cold-chain reading scan
 *   DISRUPTION_SWEEP_INTERVAL_MS default 10 min – re-assess active disruptions
 */

const db                 = require('../config/db');
const trackingEngine     = require('./trackingEngine');
const socketManager      = require('./socketManager');
const coldChainMonitor   = require('../engines/coldChainMonitor');
const disruptionEngine   = require('../engines/disruptionEngine');

let utilisationTimer     = null;
let noSignalTimer        = null;
let fleetStatusTimer     = null;
let coldChainTimer       = null;
let disruptionSweepTimer = null;

async function getAllCompanyIds() {
  const { rows } = await db.query('SELECT DISTINCT id FROM companies');
  return rows.map((r) => r.id);
}

// ── Utilisation refresh ───────────────────────────────────────────────────────
async function runUtilisationRefresh() {
  try {
    const companyIds = await getAllCompanyIds();
    for (const cid of companyIds) {
      await trackingEngine.refreshUtilisation(cid);
    }
  } catch (err) {
    console.error('[JOB] utilisationRefresh error:', err.message);
  }
}

// ── No-signal watchdog ────────────────────────────────────────────────────────
async function runNoSignalCheck() {
  try {
    const companyIds = await getAllCompanyIds();
    for (const cid of companyIds) {
      await trackingEngine.checkNoSignal(cid);
    }
  } catch (err) {
    console.error('[JOB] noSignalCheck error:', err.message);
  }
}

// ── Fleet status broadcast ────────────────────────────────────────────────────
// Push a compact fleet availability snapshot to every company room
// so dashboard widgets stay fresh even without active GPS pings.
async function runFleetStatusBroadcast() {
  try {
    const companyIds = await getAllCompanyIds();
    for (const cid of companyIds) {
      const availability = await trackingEngine.getFleetAvailability(cid);
      socketManager.broadcastFleetStatus(cid, {
        company_id: cid,
        updated_at: new Date().toISOString(),
        summary:    availability.summary,
        // Only send slim position data to avoid large payloads
        assets: availability.assets.map((a) => ({
          asset_id:         a.id,
          identifier:       a.identifier,
          asset_type:       a.asset_type,
          status:           a.status,
          utilisation_pct:  a.utilisation_pct,
          latitude:         a.tracked_lat  || a.current_lat,
          longitude:        a.tracked_lon  || a.current_lon,
          speed_kmh:        a.speed_kmh,
          is_delayed:       a.is_delayed,
          shipment_id:      a.shipment_id,
          shipment_ref:     a.shipment_reference,
          last_update_at:   a.last_update_at,
        })),
      });
    }
  } catch (err) {
    console.error('[JOB] fleetStatusBroadcast error:', err.message);
  }
}

// ── Cold-chain scan ───────────────────────────────────────────────────────────
async function runColdChainScan() {
  try {
    const processed = await coldChainMonitor.scanActiveColdChain();
    if (processed > 0) {
      console.log(`[JOB] coldChainScan — processed ${processed} readings`);
    }
  } catch (err) {
    console.error('[JOB] coldChainScan error:', err.message);
  }
}

// ── Disruption sweep ──────────────────────────────────────────────────────────
async function runDisruptionSweep() {
  try {
    const { swept, totalAffected } = await disruptionEngine.sweepActiveDisruptions();
    if (swept > 0) {
      console.log(`[JOB] disruptionSweep — swept ${swept} disruptions, ${totalAffected} shipments impacted`);
    }
  } catch (err) {
    console.error('[JOB] disruptionSweep error:', err.message);
  }
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

function start() {
  const UTILISATION_INTERVAL   = parseInt(process.env.UTILISATION_INTERVAL_MS     || String(5 * 60 * 1000),   10);
  const NOSIGNAL_INTERVAL      = parseInt(process.env.NOSIGNAL_INTERVAL_MS        || String(3 * 60 * 1000),   10);
  const FLEET_STATUS_INTERVAL  = parseInt(process.env.FLEET_STATUS_INTERVAL_MS    || String(30 * 1000),       10);
  const COLD_CHAIN_INTERVAL    = parseInt(process.env.COLD_CHAIN_SCAN_INTERVAL_MS || String(60 * 1000),       10);
  const DISRUPTION_INTERVAL    = parseInt(process.env.DISRUPTION_SWEEP_INTERVAL_MS|| String(10 * 60 * 1000),  10);

  utilisationTimer     = setInterval(runUtilisationRefresh,  UTILISATION_INTERVAL);
  noSignalTimer        = setInterval(runNoSignalCheck,        NOSIGNAL_INTERVAL);
  fleetStatusTimer     = setInterval(runFleetStatusBroadcast, FLEET_STATUS_INTERVAL);
  coldChainTimer       = setInterval(runColdChainScan,        COLD_CHAIN_INTERVAL);
  disruptionSweepTimer = setInterval(runDisruptionSweep,      DISRUPTION_INTERVAL);

  // Run immediately on startup
  setImmediate(runFleetStatusBroadcast);
  setImmediate(runUtilisationRefresh);
  setImmediate(runColdChainScan);
  setImmediate(runDisruptionSweep);

  console.log(
    `[JOBS] Started — ` +
    `utilisation ${UTILISATION_INTERVAL/1000}s | ` +
    `no-signal ${NOSIGNAL_INTERVAL/1000}s | ` +
    `fleet-status ${FLEET_STATUS_INTERVAL/1000}s | ` +
    `cold-chain ${COLD_CHAIN_INTERVAL/1000}s | ` +
    `disruption-sweep ${DISRUPTION_INTERVAL/1000}s`
  );
}

function stop() {
  clearInterval(utilisationTimer);
  clearInterval(noSignalTimer);
  clearInterval(fleetStatusTimer);
  clearInterval(coldChainTimer);
  clearInterval(disruptionSweepTimer);
  console.log('[JOBS] Stopped');
}

module.exports = { start, stop };
