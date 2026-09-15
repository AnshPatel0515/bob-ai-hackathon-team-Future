// ============================================================
// api-client.js  –  Frontend ↔ Backend integration layer.
// Connects to the Node.js backend via Server-Sent Events (SSE)
// and REST API calls.  Falls back gracefully to the existing
// pure-frontend simulation when the backend is not running.
// ============================================================
'use strict';

/* ── Configuration ─────────────────────────────────────────── */
const API_BASE   = window.location.port === '3000'
  ? `http://${window.location.hostname}:3000/api`   // backend running
  : null;                                             // static-only mode

const BACKEND_AVAILABLE = API_BASE !== null;

// ── SSE connection ────────────────────────────────────────────
let _sse        = null;
let _sseRetries = 0;
const MAX_RETRIES = 8;

/**
 * Connect to the backend SSE stream.
 * On each 'state' event the full app state is synced to the frontend.
 */
function connectSSE() {
  if (!BACKEND_AVAILABLE) {
    console.info('[API] Backend not detected. Running in standalone simulation mode.');
    updateBackendBadge(false);
    return;
  }

  _sse = new EventSource(`${API_BASE}/events`);

  _sse.addEventListener('connected', (e) => {
    const d = JSON.parse(e.data);
    console.info('[SSE] Connected –', d.message);
    _sseRetries = 0;
    updateBackendBadge(true);
    showToast('Backend connected. Live simulation stream active.', 'success');
  });

  _sse.addEventListener('state', (e) => {
    const snapshot = JSON.parse(e.data);
    applyBackendSnapshot(snapshot);
  });

  _sse.addEventListener('disruption', (e) => {
    const d = JSON.parse(e.data);
    if (d.event === 'activated') {
      showToast(`🔄 Backend: ${d.type} scenario activated.`, 'warning');
    } else if (d.event === 'resolved') {
      showToast(`✅ Backend: ${d.type} resolved. Routes normalising.`, 'success');
    }
  });

  _sse.addEventListener('coldchain_alert', (e) => {
    const sensors = JSON.parse(e.data);
    const critCount = sensors.filter(s => s.status === 'Critical').length;
    if (critCount > 0) {
      showToast(`⚠️ Cold-chain: ${critCount} critical sensor(s) detected!`, 'error');
    }
  });

  _sse.addEventListener('sim_control', (e) => {
    const d = JSON.parse(e.data);
    console.info('[SSE] Sim control:', d.action);
    if (d.action === 'reset') showToast('Simulation reset by backend.', 'success');
  });

  _sse.onerror = () => {
    _sseRetries++;
    updateBackendBadge(false);
    if (_sseRetries <= MAX_RETRIES) {
      console.warn(`[SSE] Connection lost. Retry ${_sseRetries}/${MAX_RETRIES} in 5s…`);
      setTimeout(connectSSE, 5000);
    } else {
      console.warn('[SSE] Max retries reached. Running in standalone mode.');
    }
    _sse.close();
    _sse = null;
  };
}

/**
 * Apply a full state snapshot from the backend to the frontend state.
 */
function applyBackendSnapshot(snapshot) {
  if (!snapshot) return;

  // Merge backend state into frontend `state` object
  if (snapshot.shipments)   state.shipments  = snapshot.shipments;
  if (snapshot.fleet)       state.fleet      = snapshot.fleet;
  if (snapshot.sensors)     state.coldChain  = normaliseSensors(snapshot.sensors);
  if (snapshot.disruptions) syncDisruptions(snapshot.disruptions);
  if (snapshot.actions)     state.actions    = snapshot.actions;
  if (snapshot.auditLog)    state.auditLog   = snapshot.auditLog.slice(0, 50).reverse();
  if (snapshot.simTimeISO)  updateSimTimeBadge(snapshot.simTimeISO);

  // Refresh all currently visible sections
  updateDashboardKPIs();
  updateNavBadges();
  updateLastUpdated();

  const active = document.querySelector('.section.active');
  if (active) {
    const id = active.id.replace('sec-', '');
    simRefreshCurrentSection && simRefreshCurrentSection();
    if (id === 'dashboard') setTimeout(renderDashboardCharts, 0);
  }

  // Store backend brief for AI section
  if (snapshot.brief) _backendBrief = snapshot.brief;
}

/**
 * Normalise backend sensor format to match frontend cold-chain data format.
 */
function normaliseSensors(sensors) {
  return (sensors || []).map(s => ({
    id:          s.id,
    shipmentId:  s.shipmentId,
    sensorId:    s.sensorId,
    temp:        s.temp,
    minTemp:     s.minTemp,
    maxTemp:     s.maxTemp,
    humidity:    s.humidity,
    battery:     s.battery,
    timestamp:   s.timestamp,
    gps:         s.gps,
    doorStatus:  s.doorStatus,
    status:      s.status,
    acknowledged:s.acknowledged,
  }));
}

/**
 * Sync active disruptions into frontend state.
 */
function syncDisruptions(disruptions) {
  if (!disruptions || disruptions.length === 0) {
    state.activeDisruption = 'none';
    return;
  }
  // Use first active disruption to drive the frontend disruption selector
  const first = disruptions[0];
  state.activeDisruption = first.templateKey || 'none';
  // Sync disruption buttons
  document.querySelectorAll('.disruption-btn').forEach(b => {
    b.classList.remove('active', 'critical-d');
    if (b.dataset.id === state.activeDisruption) {
      const meta = DISRUPTION_META[state.activeDisruption] || {};
      b.classList.add('active');
      if (meta.cls) b.classList.add(meta.cls);
    }
  });
}

// ── Cached backend brief ──────────────────────────────────────
let _backendBrief = null;
function getBackendBrief() { return _backendBrief; }

// ── REST API helpers ──────────────────────────────────────────
async function apiGet(path) {
  if (!BACKEND_AVAILABLE) return null;
  try {
    const r = await fetch(`${API_BASE}${path}`);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function apiPost(path, body = {}) {
  if (!BACKEND_AVAILABLE) return null;
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function apiDelete(path) {
  if (!BACKEND_AVAILABLE) return null;
  try {
    const r = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function apiPatch(path, body = {}) {
  if (!BACKEND_AVAILABLE) return null;
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// ── Simulation controls ───────────────────────────────────────
async function backendSimStart()  { return apiPost('/sim/start'); }
async function backendSimPause()  { return apiPost('/sim/pause'); }
async function backendSimResume() { return apiPost('/sim/resume'); }
async function backendSimStop()   { return apiPost('/sim/stop'); }
async function backendSimReset()  { return apiPost('/sim/reset'); }

// ── Disruption controls ───────────────────────────────────────
async function backendTriggerDisruption(templateKey) {
  return apiPost('/disruptions/trigger', { templateKey });
}

async function backendResolveDisruption(id) {
  return apiDelete(`/disruptions/${id}`);
}

async function backendClearDisruptions() {
  return apiDelete('/disruptions');
}

// ── Shipment reroute ──────────────────────────────────────────
async function backendRerouteShipment(shipmentId) {
  return apiPost(`/shipments/${shipmentId}/reroute`);
}

// ── Fleet redeployment ────────────────────────────────────────
async function backendRedeployFleet(vehicleId, targetShipmentId) {
  return apiPost(`/fleet/${vehicleId}/redeploy`, { targetShipmentId });
}

// ── Sensor actions ────────────────────────────────────────────
async function backendAcknowledgeSensor(sensorId) {
  return apiPost(`/sensors/${sensorId}/acknowledge`);
}

async function backendEscalateSensor(sensorId) {
  return apiPost(`/sensors/${sensorId}/escalate`);
}

// ── Action updates ────────────────────────────────────────────
async function backendCompleteAction(actionId) {
  return apiPatch(`/actions/${actionId}/complete`);
}

async function backendSnoozeAction(actionId) {
  return apiPatch(`/actions/${actionId}/snooze`);
}

// ── UI helpers ────────────────────────────────────────────────
function updateBackendBadge(connected) {
  const dot = document.getElementById('sim-dot');
  const lbl = document.getElementById('sim-label');
  if (!dot || !lbl) return;

  if (connected && BACKEND_AVAILABLE) {
    dot.className  = 'sim-dot sim-live';
    lbl.textContent = 'Live Backend · Simulated Logistics Environment';
  } else if (BACKEND_AVAILABLE) {
    dot.className  = 'sim-dot sim-paused';
    lbl.textContent = 'Reconnecting to backend…';
  }
  // If not backend available, the SIM object manages the badge
}

function updateSimTimeBadge(isoString) {
  const el = document.getElementById('sim-time-display');
  if (!el) return;
  const d = new Date(isoString);
  el.textContent = d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short',
  });
}

// ── Fleet Optimizer API Methods ───────────────────────────────
async function backendRunFleetOptimizer() {
  return apiPost('/fleet-optimizer/run');
}
async function backendGetIdleAssets() {
  return apiGet('/fleet-optimizer/idle');
}
async function backendGetOverloadedRoutes() {
  return apiGet('/fleet-optimizer/overloaded');
}
async function backendGetAvailableDrivers() {
  return apiGet('/fleet-optimizer/available-drivers');
}
async function backendGetUnderutilisedAssets() {
  return apiGet('/fleet-optimizer/underutilised');
}
async function backendGetUnassignedShipments() {
  return apiGet('/fleet-optimizer/unassigned-shipments');
}
async function backendAcceptFleetCandidate(candidateId) {
  return apiPost(`/fleet-optimizer/candidates/${candidateId}/accept`);
}
async function backendRejectFleetCandidate(candidateId, reason) {
  return apiPost(`/fleet-optimizer/candidates/${candidateId}/reject`, { reason });
}
async function backendFetchBrief() {
  return apiGet('/brief');
}

// ── Alert API Methods ──────────────────────────────────────────
async function backendGetAlerts(query = {}) {
  const params = new URLSearchParams(query).toString();
  return apiGet(`/alerts${params ? '?' + params : ''}`);
}
async function backendGetAlertSummary() {
  return apiGet('/alerts/summary');
}
async function backendAcknowledgeAlert(alertId) {
  return apiPost(`/alerts/${alertId}/acknowledge`, {});
}
async function backendResolveAlert(alertId) {
  return apiPost(`/alerts/${alertId}/resolve`, {});
}
async function backendCreateAlert(alertData) {
  return apiPost('/alerts', alertData);
}

// ── Initialise ────────────────────────────────────────────────
function initAPIClient() {
  connectSSE();
  // Update sim time display if backend responds
  if (BACKEND_AVAILABLE) {
    apiGet('/sim/status').then(s => {
      if (s?.simTimeISO) updateSimTimeBadge(s.simTimeISO);
    });
  }
}

// ── Exports (global scope for use in script.js) ───────────────
window.API = {
  available:               BACKEND_AVAILABLE,
  init:                    initAPIClient,
  getBackendBrief,
  fetchBrief:              backendFetchBrief,
  simStart:                backendSimStart,
  simPause:                backendSimPause,
  simResume:               backendSimResume,
  simStop:                 backendSimStop,
  simReset:                backendSimReset,
  triggerDisruption:       backendTriggerDisruption,
  resolveDisruption:       backendResolveDisruption,
  clearDisruptions:        backendClearDisruptions,
  rerouteShipment:         backendRerouteShipment,
  redeployFleet:           backendRedeployFleet,
  acknowledgeSensor:       backendAcknowledgeSensor,
  escalateSensor:          backendEscalateSensor,
  completeAction:          backendCompleteAction,
  snoozeAction:            backendSnoozeAction,
  runFleetOptimizer:       backendRunFleetOptimizer,
  getIdleAssets:           backendGetIdleAssets,
  getOverloadedRoutes:     backendGetOverloadedRoutes,
  getAvailableDrivers:     backendGetAvailableDrivers,
  getUnderutilisedAssets:  backendGetUnderutilisedAssets,
  getUnassignedShipments:  backendGetUnassignedShipments,
  acceptFleetCandidate:    backendAcceptFleetCandidate,
  rejectFleetCandidate:    backendRejectFleetCandidate,
  getAlerts:               backendGetAlerts,
  getAlertSummary:         backendGetAlertSummary,
  acknowledgeAlert:        backendAcknowledgeAlert,
  resolveAlert:            backendResolveAlert,
  createAlert:             backendCreateAlert,
};


