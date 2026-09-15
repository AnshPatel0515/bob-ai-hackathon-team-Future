// ============================================================
// script.js – Supply Chain Disruption Assistant
// All application logic, UI rendering, and state management
// ============================================================

/* ── APPLICATION STATE ─────────────────────────────────────── */
const state = {
  activeDisruption: "none",
  selectedShipmentId: null,
  shipments: [],          // live copy mutated by actions
  fleet: [],              // live copy mutated by actions
  coldChain: [],          // live copy mutated by acknowledgements
  actions: [],            // live copy mutated by user
  alerts: [],             // live alerts mutated by user & real-time engine
  auditLog: [],           // appended to on every action
  shipmentFilter: { search: "", priority: "all", risk: "all", status: "all", cargo: "all" },
  alertFilter:    { priority: "all", status: "all", type: "all", search: "" },
  shipmentSort:   { field: "id", dir: "asc" },
  actionFilter:   "all",
  showCompleted:  false,
  lastUpdated:    new Date(),
};

// ============================================================
// SIMULATION ENGINE
// Runs continuously, updating data every 10 s automatically.
// Guards against duplicate timers; fully stoppable/resumable.
// ============================================================

const SIM = {
  enabled:   true,   // master ON/OFF toggle
  paused:    false,  // pause/resume (keeps timer alive, skips tick work)
  tickMs:    10000,  // 10 seconds between ticks
  _timerId:  null,   // single timer reference — prevents duplicates
  _tickCount: 0,     // total ticks fired since page load

  /* ── Disruption pool the engine may auto-activate ── */
  _disruptionPool: ["severe_storm","port_strike","highway_closure","geopolitical","extreme_heat","none"],
  _disruptionCursor: 0,   // cycles through pool

  /* ── Start the engine (idempotent) ── */
  start() {
    if (this._timerId !== null) return;  // already running — do nothing
    this._timerId = setInterval(() => this._tick(), this.tickMs);
    this._updateIndicator();
  },

  /* ── Stop the engine cleanly ── */
  stop() {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
    this._updateIndicator();
  },

  /* ── Toggle ON / OFF ── */
  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.paused = false;
      this.start();
      showToast("Auto-simulation resumed.", "success");
    } else {
      this.stop();
      showToast("Auto-simulation stopped.", "warning");
    }
    this._updateIndicator();
  },

  /* ── Pause (timer keeps running, tick is a no-op) ── */
  pause() {
    if (!this.enabled) return;
    this.paused = true;
    this._updateIndicator();
    showToast("Simulation paused.", "warning");
  },

  /* ── Resume from pause ── */
  resume() {
    if (!this.enabled) return;
    this.paused = false;
    this._updateIndicator();
    showToast("Simulation resumed.", "success");
  },

  /* ── Called every tickMs by setInterval ── */
  _tick() {
    if (!this.enabled || this.paused) return;
    this._tickCount++;
    simUpdateShipments();
    simUpdateFleet();
    simUpdateColdChain();
    simMaybeAutoDisruption();
    evaluateRealtimeAlerts();
    // refresh visible section
    simRefreshCurrentSection();
    updateDashboardKPIs();
    updateNavBadges();
    updateNotifBadge();
    updateLastUpdated();
    // charts always refresh if on dashboard
    const active = document.querySelector(".section.active");
    if (active && active.id === "sec-dashboard") {
      setTimeout(renderDashboardCharts, 0);
    }
    this._updateIndicator();
  },

  /* ── Update the live indicator badge in the header ── */
  _updateIndicator() {
    const dot  = document.getElementById("sim-dot");
    const lbl  = document.getElementById("sim-label");
    const btnToggle = document.getElementById("sim-toggle-btn");
    const btnPause  = document.getElementById("sim-pause-btn");
    const btnResume = document.getElementById("sim-resume-btn");
    if (!dot || !lbl) return;

    if (!this.enabled) {
      dot.className  = "sim-dot sim-off";
      lbl.textContent = "Simulation OFF";
    } else if (this.paused) {
      dot.className  = "sim-dot sim-paused";
      lbl.textContent = "Paused";
    } else {
      dot.className  = "sim-dot sim-live";
      lbl.textContent = "Simulated Live Data";
    }

    if (btnToggle) btnToggle.textContent = this.enabled ? "■ Stop" : "▶ Start";
    if (btnPause)  btnPause.disabled  = !this.enabled || this.paused;
    if (btnResume) btnResume.disabled = !this.enabled || !this.paused;
  },
};

/* ── Helper: randomly mutate shipment statuses ───────────────── */
function simUpdateShipments() {
  const disruptionIds = state.activeDisruption !== "none"
    ? (DISRUPTION_SCENARIOS[state.activeDisruption]?.affectedShipmentIds || [])
    : [];

  state.shipments.forEach(s => {
    if (s.status === "Delivered") return; // never regress delivered

    const isAffected = disruptionIds.includes(s.id);
    const roll = Math.random();

    if (isAffected) {
      // Affected shipments drift toward worse states
      if (s.status === "On Time" && roll < 0.40)    { s.status = "Delayed"; s.delayHours = Math.max(s.delayHours, 2 + Math.floor(Math.random() * 6)); }
      else if (s.status === "Delayed" && roll < 0.25) { s.status = "At Risk"; s.delayHours += Math.floor(Math.random() * 4); }
      else if (s.status === "At Risk" && roll < 0.15)  { s.delayHours += Math.floor(Math.random() * 3); }
      else if (s.status === "Rerouting" && roll < 0.20){ s.status = "Delayed"; s.delayHours = Math.max(1, s.delayHours - 2); }
    } else {
      // Unaffected shipments self-heal or stay on time
      if ((s.status === "Delayed" || s.status === "At Risk") && roll < 0.30) {
        s.delayHours = Math.max(0, s.delayHours - Math.ceil(Math.random() * 3));
        if (s.delayHours === 0) s.status = "On Time";
      } else if (s.status === "On Time" && roll < 0.08) {
        s.status = "Delayed";
        s.delayHours = 1 + Math.floor(Math.random() * 3);
      }
    }

    // Small random jitter to delay even for stable shipments
    if (s.delayHours > 0 && Math.random() < 0.12) {
      s.delayHours = Math.max(0, s.delayHours + (Math.random() < 0.5 ? 1 : -1));
    }

    // Risk level tracks delay
    if (s.delayHours === 0)       s.riskLevel = "Low";
    else if (s.delayHours <= 6)   s.riskLevel = "Medium";
    else                          s.riskLevel = "High";
  });
}

/* ── Helper: nudge fleet utilisation values ─────────────────── */
function simUpdateFleet() {
  state.fleet.forEach(f => {
    if (f.status === "Maintenance") return;
    if (f.status === "Idle") {
      // Idle trucks slowly lose fuel (parked engine idling)
      f.fuel = Math.max(20, f.fuel - (Math.random() < 0.3 ? 1 : 0));
      return;
    }
    // Active trucks: utilisation fluctuates ±5 pp, fuel ticks down
    const delta = Math.floor(Math.random() * 11) - 5;
    f.utilisation = Math.min(100, Math.max(0, f.utilisation + delta));
    f.fuel = Math.max(10, f.fuel - (Math.random() < 0.4 ? 1 : 0));

    // Very low fuel → trigger a warning action
    if (f.fuel <= 15 && !state.actions.find(a => a.related === f.id && a.type === "Fuel Alert" && a.status === "Pending")) {
      state.actions.unshift({
        id:       "ACT-SIM-" + f.id,
        priority: "High",
        type:     "Fuel Alert",
        related:  f.id,
        reason:   f.id + " fuel at " + f.fuel + "%. Immediate refuel required.",
        team:     "Fleet Ops",
        deadline: "ASAP",
        status:   "Pending",
        snoozed:  false,
      });
      addAuditEntry("Fuel Alert Generated", f.id, "Normal", "Fuel " + f.fuel + "%", "System");
      if (!SIM.paused) showToast(f.id + " fuel critical (" + f.fuel + "%). Action created.", "warning");
    }
  });
}

/* ── Helper: drift cold-chain temperatures slightly ──────────── */
function simUpdateColdChain() {
  state.coldChain.forEach(c => {
    if (c.acknowledged) return; // acknowledged sensors are resolved

    // Temperature drift ±0.3°C per tick
    const drift = (Math.random() * 0.6) - 0.3;
    c.temp = Math.round((c.temp + drift) * 10) / 10;

    // Reclassify status
    const margin = 0.5; // ±0.5°C warning zone
    if (c.temp < c.minTemp - margin || c.temp > c.maxTemp + margin) {
      c.status = "Critical";
    } else if (c.temp < c.minTemp || c.temp > c.maxTemp) {
      c.status = "Warning";
    } else {
      c.status = "Normal";
    }

    // Update timestamp
    c.timestamp = new Date().toISOString().replace("T"," ").substring(0,16);

    // Battery slow drain
    if (Math.random() < 0.15) c.battery = Math.max(5, c.battery - 1);

    // Auto-generate critical alert action if newly critical
    if (c.status === "Critical" && !state.actions.find(a => a.related === c.sensorId && a.type === "Temp Alert" && a.status === "Pending")) {
      state.actions.unshift({
        id:       "ACT-CC-" + c.sensorId,
        priority: "Critical",
        type:     "Temp Alert",
        related:  c.sensorId,
        reason:   "Temperature breach on " + c.sensorId + ": " + c.temp + "°C (allowed: " + c.minTemp + "–" + c.maxTemp + "°C)",
        team:     "Quality Team",
        deadline: "Immediate",
        status:   "Pending",
        snoozed:  false,
      });
      addAuditEntry("Temp Alert Generated", c.sensorId, "Within range", c.temp + "°C – CRITICAL", "System");
      if (!SIM.paused) showToast("⚠️ Cold-chain alert: " + c.sensorId + " at " + c.temp + "°C!", "error");
    }
  });
}

/* ── Helper: every ~60 s cycle through auto disruption events ── */
function simMaybeAutoDisruption() {
  // advance disruption roughly every 6 ticks (60 s)
  if (SIM._tickCount % 6 !== 0) return;
  SIM._disruptionCursor = (SIM._disruptionCursor + 1) % SIM._disruptionPool.length;
  const nextId = SIM._disruptionPool[SIM._disruptionCursor];
  if (nextId === state.activeDisruption) return; // already active

  // Apply silently (no manual click sound)
  state.activeDisruption = nextId;
  const d = DISRUPTION_SCENARIOS[nextId];

  // Reset all shipments then apply disruption
  state.shipments.forEach(s => {
    const base = SHIPMENTS_DATA.find(b => b.id === s.id);
    if (base) { s.delayHours = base.delayHours; s.riskLevel = base.riskLevel; s.status = base.status; s.recommendedAction = base.recommendedAction; }
  });

  if (nextId !== "none" && d) {
    d.affectedShipmentIds.forEach(sid => {
      const s = state.shipments.find(x => x.id === sid);
      if (!s) return;
      const delay = Math.round(d.delayMultiplier * (4 + Math.random() * 8));
      s.delayHours = delay;
      s.riskLevel  = d.severityLevel >= 3 ? "High" : "Medium";
      s.status     = delay > 10 ? "At Risk" : "Delayed";
      s.recommendedAction = "Auto-sim: reroute – " + d.type;
    });
    addAuditEntry("Auto Disruption", "System", state.activeDisruption || "None", d.label, "Simulation");
    showToast("🔄 Simulation: " + d.label + " scenario activated.", "warning");
  } else {
    addAuditEntry("Auto Disruption Cleared", "System", "Previous disruption", "None", "Simulation");
    showToast("✅ Simulation: Disruption cleared. Routes normalising.", "success");
  }

  // sync disruption button highlights
  document.querySelectorAll(".disruption-btn").forEach(b => {
    b.classList.remove("active","critical-d");
    if (b.dataset.id === nextId) {
      const meta = DISRUPTION_META[nextId] || {};
      b.classList.add("active");
      if (meta.cls) b.classList.add(meta.cls);
    }
  });

  updateDisruptionDetail();
  renderAIBrief();
}

/* ── Helper: refresh whatever section is currently visible ───── */
function simRefreshCurrentSection() {
  const active = document.querySelector(".section.active");
  if (!active) return;
  const id = active.id.replace("sec-","");
  // these re-renders are lightweight DOM updates, not full rebuilds
  switch (id) {
    case "dashboard":   updateDashboardKPIs(); renderDashboardRecentLog(); break;
    case "alerts":      renderAlertsList(); break;
    case "disruptions": updateDisruptionDetail(); break;
    case "shipments":   renderShipmentTable(); break;
    case "routes":      renderRouteCards(); break;
    case "fleet":       renderFleetCards(); break;
    case "coldchain":   renderColdChainCards(); break;
    case "ai-brief":    renderAIBrief(); break;
    case "actions":     renderActionList(); break;
    case "audit":       renderAuditList(); break;
  }
}

/* ── INIT ──────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  deepCopyData();
  buildNav();
  renderDashboard();
  renderAlertSection();
  renderDisruptionSection();
  renderShipmentSection();
  renderRouteSection();
  renderCarrierSection();
  renderFleetSection();
  renderColdChainSection();
  renderAIBriefSection();
  renderActionCentreSection();
  renderAuditLogSection();
  bindHeader();
  updateLastUpdated();
  updateNotifBadge();
  showSection("dashboard");

  // Initialise backend API client (connects SSE, falls back gracefully)
  if (window.API) window.API.init();

  // Start the built-in simulation engine.
  // If the backend is running, its SSE stream drives updates;
  // the built-in engine still runs for standalone mode.
  setTimeout(() => {
    SIM.start();
    SIM._updateIndicator();
  }, 800);

  showToast("Control tower loaded. Simulation engine starting…", "success");
});

function deepCopyData() {
  state.shipments  = JSON.parse(JSON.stringify(SHIPMENTS_DATA));
  state.fleet      = JSON.parse(JSON.stringify(FLEET_DATA));
  state.coldChain  = JSON.parse(JSON.stringify(COLD_CHAIN_DATA));
  state.actions    = JSON.parse(JSON.stringify(ACTIONS_DATA));
  state.alerts     = typeof ALERTS_DATA !== "undefined" ? JSON.parse(JSON.stringify(ALERTS_DATA)) : [];
  state.auditLog   = JSON.parse(JSON.stringify(AUDIT_LOG_DATA));
}

/* ── NAVIGATION ────────────────────────────────────────────── */
const NAV_ITEMS = [
  { id: "dashboard",    icon: "📊", label: "Dashboard",            badge: null },
  { id: "alerts",       icon: "🔔", label: "Alerts & Notifications",badge: null },
  { id: "disruptions",  icon: "⚡", label: "Disruption Mgmt",      badge: null },
  { id: "shipments",    icon: "📦", label: "Shipment Manager",     badge: null },
  { id: "routes",       icon: "🗺️",  label: "Route Optimisation",  badge: null },
  { id: "carriers",     icon: "🚢", label: "Carrier Selection",    badge: null },
  { id: "fleet",        icon: "🚛", label: "Fleet Utilisation",    badge: null },
  { id: "coldchain",    icon: "❄️",  label: "Cold-Chain Monitor",  badge: null },
  { id: "ai-brief",     icon: "🤖", label: "AI Investigation",     badge: null },
  { id: "actions",      icon: "✅", label: "Action Centre",        badge: null },
  { id: "audit",        icon: "📋", label: "Activity Log",         badge: null },
];

function buildNav() {
  const nav = document.getElementById("nav-list");
  nav.innerHTML = NAV_ITEMS.map(n => `
    <div class="nav-item" id="nav-${n.id}" data-section="${n.id}" onclick="showSection('${n.id}')" tabindex="0" role="button" aria-label="${n.label}">
      <span class="nav-icon">${n.icon}</span>
      <span>${n.label}</span>
      ${n.badge ? `<span class="nav-badge" id="badge-${n.id}">${n.badge}</span>` : ""}
    </div>
  `).join("");

  // keyboard nav
  nav.querySelectorAll(".nav-item").forEach(el => {
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") el.click(); });
  });
}

function showSection(id) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  const sec = document.getElementById("sec-" + id);
  const nav = document.getElementById("nav-" + id);
  if (sec) sec.classList.add("active");
  if (nav) nav.classList.add("active");
  // close mobile sidebar
  document.getElementById("sidebar").classList.remove("open");
  // refresh section content on view
  if (id === "dashboard")   { updateDashboardKPIs(); setTimeout(renderDashboardCharts, 0); }
  if (id === "alerts")      renderAlertsList();
  if (id === "disruptions") updateDisruptionDetail();
  if (id === "shipments")   renderShipmentTable();
  if (id === "routes")      renderRouteCards();
  if (id === "fleet")       renderFleetCards();
  if (id === "coldchain")   renderColdChainCards();
  if (id === "ai-brief")    renderAIBrief();
  if (id === "actions")     renderActionList();
  if (id === "audit")       renderAuditList();
}

/* ── HEADER BINDINGS ───────────────────────────────────────── */
function bindHeader() {
  document.getElementById("btn-reset").addEventListener("click", resetDemo);
  document.getElementById("menu-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
  // Start live clock
  function tickClock() {
    const el = document.getElementById("header-clock");
    if (el) el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  tickClock();
  setInterval(tickClock, 1000);
}

/* ── BACKEND-AWARE SIMULATION CONTROL HANDLERS ─────────────── */
// These replace direct SIM.toggle/pause/resume calls on the buttons
// so that when the backend is running, it also receives the command.
async function handleSimToggle() {
  if (window.API && window.API.available) {
    const running = SIM.enabled;
    if (running) { await window.API.simStop();  SIM.enabled = false; SIM.stop(); }
    else         { await window.API.simStart(); SIM.enabled = true;  SIM.start(); }
  } else {
    SIM.toggle();
  }
  SIM._updateIndicator();
}

async function handleSimPause() {
  if (window.API && window.API.available) await window.API.simPause();
  SIM.pause();
}

async function handleSimResume() {
  if (window.API && window.API.available) await window.API.simResume();
  SIM.resume();
}

/* ── RESET DEMO ─────────────────────────────────────────────── */
function resetDemo() {
  // Stop the engine while we reset to avoid a mid-reset tick
  SIM.stop();
  SIM._disruptionCursor = 0;
  SIM._tickCount = 0;

  state.activeDisruption = "none";
  state.selectedShipmentId = null;
  deepCopyData();
  updateDashboardKPIs();
  updateDisruptionDetail();
  renderShipmentTable();
  renderFleetCards();
  renderColdChainCards();
  renderAIBrief();
  renderActionList();
  renderAuditList();
  renderRouteCards();
  updateNavBadges();
  updateLastUpdated();
  // reset disruption buttons
  document.querySelectorAll(".disruption-btn").forEach(b => {
    b.classList.remove("active", "critical-d");
    if (b.dataset.id === "none") b.classList.add("active");
  });
  // Restart the simulation if it was enabled
  if (SIM.enabled) { SIM.paused = false; SIM.start(); }
  SIM._updateIndicator();
  showToast("Demo reset. All data restored. Simulation restarted.", "success");
}

/* ── LAST UPDATED ───────────────────────────────────────────── */
function updateLastUpdated() {
  state.lastUpdated = new Date();
  const el = document.getElementById("last-updated");
  if (el) el.textContent = "Updated " + state.lastUpdated.toLocaleTimeString();
}

/* ── DISRUPTION LOGIC ──────────────────────────────────────── */
function applyDisruption(disruptionId) {
  const prev = state.activeDisruption;
  state.activeDisruption = disruptionId;

  // reset all shipment delays first
  state.shipments.forEach(s => {
    const base = SHIPMENTS_DATA.find(b => b.id === s.id);
    s.delayHours = base ? base.delayHours : 0;
    s.riskLevel  = base ? base.riskLevel  : "Low";
    s.status     = base ? base.status     : "On Time";
    s.recommendedAction = base ? base.recommendedAction : "Monitor";
  });

  const d = DISRUPTION_SCENARIOS[disruptionId];
  if (disruptionId !== "none" && d) {
    d.affectedShipmentIds.forEach(sid => {
      const s = state.shipments.find(x => x.id === sid);
      if (!s) return;
      const delay = Math.round(d.delayMultiplier * (6 + Math.random() * 8));
      s.delayHours  = delay;
      s.riskLevel   = d.severityLevel >= 3 ? "High" : "Medium";
      s.status      = delay > 10 ? "At Risk" : "Delayed";
      s.recommendedAction = "Reroute immediately – " + d.type + " disruption";
    });

    addAuditEntry(
      "Disruption Applied",
      "System",
      prev !== "none" ? DISRUPTION_SCENARIOS[prev]?.label || "None" : "No disruption",
      d.label,
      "System Auto"
    );
  }

  updateDisruptionDetail();
  updateDashboardKPIs();
  renderShipmentTable();
  renderRouteCards();
  renderAIBrief();
  updateNavBadges();
  updateLastUpdated();
  // refresh charts if dashboard is visible
  const activeSec = document.querySelector(".section.active");
  if (activeSec && activeSec.id === "sec-dashboard") setTimeout(renderDashboardCharts, 0);
}

/* ── DASHBOARD KPIs ─────────────────────────────────────────── */
function computeMetrics() {
  const d = DISRUPTION_SCENARIOS[state.activeDisruption];
  const totalShipments    = state.shipments.length;
  const activeDisruptions = state.activeDisruption !== "none" ? 1 : 0;
  const affectedShips     = state.shipments.filter(s => s.delayHours > 0).length;
  const highPriority      = state.shipments.filter(s => s.priority === "Critical" || s.priority === "High").length;
  const idleFleet         = state.fleet.filter(f => f.status === "Idle").length;
  const totalUtil         = state.fleet.reduce((a, f) => a + f.utilisation, 0);
  const avgUtil           = Math.round(totalUtil / state.fleet.length);
  const coldAlerts        = state.coldChain.filter(c => c.status !== "Normal" && !c.acknowledged).length;
  const totalDelay        = state.shipments.reduce((a, s) => a + (s.delayHours || 0), 0);
  const riskShips         = state.shipments.filter(s => s.riskLevel === "High");
  const financialRisk     = riskShips.reduce((a, s) => {
    const src = SHIPMENTS_DATA.find(b => b.id === s.id);
    if (!src) return a;
    const val = parseFloat(src.value.replace(/[$,]/g, "")) || 0;
    return a + val * 0.12; // 12% at risk
  }, 0);

  const pendingActions = state.actions.filter(a => a.status === "Pending" && !a.snoozed);
  const criticalActions = pendingActions.filter(a => a.priority === "Critical").length;

  return { totalShipments, activeDisruptions, affectedShips, highPriority, idleFleet, avgUtil, coldAlerts, totalDelay, financialRisk, criticalActions };
}

function updateDashboardKPIs() {
  const m = computeMetrics();
  setKPI("kpi-total",       m.totalShipments);
  setKPI("kpi-disruptions", m.activeDisruptions);
  setKPI("kpi-affected",    m.affectedShips);
  setKPI("kpi-priority",    m.highPriority);
  setKPI("kpi-util",        m.avgUtil + "%");
  setKPI("kpi-idle",        m.idleFleet);
  setKPI("kpi-cold",        m.coldAlerts);
  setKPI("kpi-delay",       m.totalDelay + "h");
  setKPI("kpi-risk",        "$" + Math.round(m.financialRisk / 1000) + "K");
  setKPI("kpi-actions",     m.criticalActions);
}

function setKPI(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── DASHBOARD RENDER ───────────────────────────────────────── */
function renderDashboard() {
  const sec = document.getElementById("sec-dashboard");
  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-top">
        <div>
          <div class="section-title">Control Tower Dashboard</div>
          <div class="section-sub">Monitor shipments, disruptions, fleet, and cold-chain in real time</div>
        </div>
      </div>
    </div>

    <div class="kpi-grid">
      ${kpiCard("kpi-total",       "Total Shipments",    "📦", "",        "Active consignments",     "stable")}
      ${kpiCard("kpi-disruptions", "Active Disruptions", "⚡", "danger",  "Select to simulate",      "up")}
      ${kpiCard("kpi-affected",    "Affected Shipments", "⚠️", "warning", "Disruption impact",       "up")}
      ${kpiCard("kpi-priority",    "High Priority",      "🔴", "danger",  "Critical &amp; High",     "")}
      ${kpiCard("kpi-util",        "Fleet Utilisation",  "🚛", "success", "Avg across all assets",   "")}
      ${kpiCard("kpi-idle",        "Idle Assets",        "🔵", "purple",  "Ready for redeployment",  "")}
      ${kpiCard("kpi-cold",        "Cold-Chain Alerts",  "❄️", "danger",  "Unacknowledged sensors",  "up")}
      ${kpiCard("kpi-delay",       "Total Delay Hours",  "⏱️", "warning", "Cumulative impact",       "up")}
      ${kpiCard("kpi-risk",        "Financial Risk",     "💰", "danger",  "12% of cargo value",      "up")}
      ${kpiCard("kpi-actions",     "Pending Actions",    "✅", "danger",  "Require attention",       "")}
    </div>

    <!-- Charts row -->
    <div class="charts-grid" id="dashboard-charts-grid">
      <div class="chart-card">
        <div class="chart-card-header">
          <div>
            <div class="chart-card-title">Shipment Status Distribution</div>
            <div class="chart-card-sub">Current status across all 12 shipments</div>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="chart-status"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header">
          <div>
            <div class="chart-card-title">Fleet Utilisation</div>
            <div class="chart-card-sub">Load percentage per vehicle</div>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="chart-fleet"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header">
          <div>
            <div class="chart-card-title">Priority Distribution</div>
            <div class="chart-card-sub">Shipments by priority level</div>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="chart-priority"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header">
          <div>
            <div class="chart-card-title">Cold-Chain Temperature Readings</div>
            <div class="chart-card-sub">Sensor readings vs. allowed range</div>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="chart-temp"></canvas></div>
      </div>
    </div>

    <div class="two-col">
      <div>
        <div class="section-title" style="font-size:15px;font-weight:600;margin-bottom:12px;">Quick Disruption Selector</div>
        <div id="dashboard-disruption-btns" class="disruption-grid" style="margin-bottom:0;"></div>
      </div>
      <div>
        <div class="section-title" style="font-size:15px;font-weight:600;margin-bottom:12px;">Recent Activity</div>
        <div id="dashboard-recent-log"></div>
      </div>
    </div>
  `;
  renderDashboardDisruptionBtns();
  renderDashboardRecentLog();
  updateDashboardKPIs();
  // charts are drawn after a tick so canvases are in the DOM
  setTimeout(renderDashboardCharts, 0);
}

function kpiCard(id, label, icon, cls, sub, trendCls) {
  const trendIcon = trendCls === "up" ? "↑" : trendCls === "down" ? "↓" : "→";
  const barPct = cls === "success" ? "72" : cls === "warning" ? "55" : cls === "danger" ? "38" : "60";
  return `
    <div class="kpi-card ${cls}" onclick="handleKpiClick('${id}')">
      <div class="kpi-icon-wrap">${icon}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value" id="${id}">—</div>
      <div class="kpi-footer">
        <div class="kpi-trend ${trendCls}">${trendIcon} ${sub}</div>
      </div>
      <div class="kpi-bar"><div class="kpi-bar-fill" style="width:${barPct}%"></div></div>
    </div>
  `;
}

/* KPI click — navigate to relevant section */
function handleKpiClick(kpiId) {
  const map = {
    "kpi-total": "shipments", "kpi-disruptions": "disruptions",
    "kpi-affected": "shipments", "kpi-priority": "shipments",
    "kpi-util": "fleet", "kpi-idle": "fleet",
    "kpi-cold": "coldchain", "kpi-delay": "routes",
    "kpi-risk": "shipments", "kpi-actions": "actions",
  };
  const dest = map[kpiId];
  if (dest) showSection(dest);
}

/* ── CHART.JS CHARTS ─────────────────────────────────────────── */
// Store chart instances so they can be destroyed on re-render
const _charts = {};

function destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

// Shared Chart.js defaults
const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: { color: "#94a3b8", font: { size: 11, family: "Inter" }, boxWidth: 12, padding: 10 }
    },
    tooltip: {
      backgroundColor: "#0f1e35",
      borderColor: "#1e3255",
      borderWidth: 1,
      titleColor: "#f1f5f9",
      bodyColor: "#94a3b8",
      padding: 10,
    }
  }
};

function renderDashboardCharts() {
  renderStatusChart();
  renderFleetChart();
  renderPriorityChart();
  renderTempChart();
}

function renderStatusChart() {
  destroyChart("chart-status");
  const ctx = document.getElementById("chart-status");
  if (!ctx) return;
  // Count shipments per status from live state
  const counts = { "On Time": 0, "Delayed": 0, "At Risk": 0, "Rerouting": 0, "Delivered": 0 };
  state.shipments.forEach(s => { if (counts[s.status] !== undefined) counts[s.status]++; });
  _charts["chart-status"] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: Object.keys(counts),
      datasets: [{
        data: Object.values(counts),
        backgroundColor: ["#10b981","#f59e0b","#ef4444","#3b82f6","#8b5cf6"],
        borderColor: "#0b1628", borderWidth: 2,
      }]
    },
    options: { ...CHART_DEFAULTS, cutout: "68%",
      plugins: { ...CHART_DEFAULTS.plugins, legend: { ...CHART_DEFAULTS.plugins.legend, position: "right" } }
    }
  });
}

function renderFleetChart() {
  destroyChart("chart-fleet");
  const ctx = document.getElementById("chart-fleet");
  if (!ctx) return;
  const labels = state.fleet.map(f => f.id);
  const data   = state.fleet.map(f => f.utilisation);
  const colors = data.map(v => v >= 80 ? "#ef4444" : v >= 50 ? "#f59e0b" : v > 0 ? "#10b981" : "#3b82f6");
  _charts["chart-fleet"] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Utilisation %",
        data, backgroundColor: colors, borderRadius: 4, borderSkipped: false,
      }]
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ticks: { color: "#4b6080", font: { size: 10 } }, grid: { color: "rgba(30,50,85,.5)" } },
        y: { min: 0, max: 100, ticks: { color: "#4b6080", font: { size: 10 }, callback: v => v + "%" }, grid: { color: "rgba(30,50,85,.5)" } }
      },
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } }
    }
  });
}

function renderPriorityChart() {
  destroyChart("chart-priority");
  const ctx = document.getElementById("chart-priority");
  if (!ctx) return;
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  state.shipments.forEach(s => { if (counts[s.priority] !== undefined) counts[s.priority]++; });
  _charts["chart-priority"] = new Chart(ctx, {
    type: "pie",
    data: {
      labels: Object.keys(counts),
      datasets: [{
        data: Object.values(counts),
        backgroundColor: ["#ef4444","#f59e0b","#10b981","#3b82f6"],
        borderColor: "#0b1628", borderWidth: 2,
      }]
    },
    options: { ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins, legend: { ...CHART_DEFAULTS.plugins.legend, position: "right" } }
    }
  });
}

function renderTempChart() {
  destroyChart("chart-temp");
  const ctx = document.getElementById("chart-temp");
  if (!ctx) return;
  const labels = state.coldChain.map(c => c.sensorId);
  const temps  = state.coldChain.map(c => c.temp);
  const maxT   = state.coldChain.map(c => c.maxTemp);
  const minT   = state.coldChain.map(c => c.minTemp);
  const pointColors = state.coldChain.map(c =>
    c.status === "Critical" ? "#ef4444" : c.status === "Warning" ? "#f59e0b" : "#10b981"
  );
  _charts["chart-temp"] = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Actual Temp (°C)", data: temps, borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,.12)", tension: .3, pointBackgroundColor: pointColors, pointRadius: 5, fill: false },
        { label: "Max Allowed",      data: maxT,  borderColor: "#ef4444", borderDash: [4,3], borderWidth: 1, pointRadius: 0, fill: false },
        { label: "Min Allowed",      data: minT,  borderColor: "#10b981", borderDash: [4,3], borderWidth: 1, pointRadius: 0, fill: false },
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ticks: { color: "#4b6080", font: { size: 9 }, maxRotation: 45 }, grid: { color: "rgba(30,50,85,.5)" } },
        y: { ticks: { color: "#4b6080", font: { size: 10 }, callback: v => v + "°C" }, grid: { color: "rgba(30,50,85,.5)" } }
      }
    }
  });
}

function renderDashboardDisruptionBtns() {
  const container = document.getElementById("dashboard-disruption-btns");
  if (!container) return;
  container.innerHTML = buildDisruptionButtons();
}

function renderDashboardRecentLog() {
  const el = document.getElementById("dashboard-recent-log");
  if (!el) return;
  const recent = state.auditLog.slice(-5).reverse();
  el.innerHTML = `<div class="audit-list">` +
    recent.map(buildAuditItemHTML).join("") +
  `</div>`;
}

/* ── DISRUPTION SECTION ─────────────────────────────────────── */
function renderDisruptionSection() {
  const sec = document.getElementById("sec-disruptions");
  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-top">
        <div>
          <div class="section-title">Disruption Management</div>
          <div class="section-sub">Select an active disruption to assess impact and recommended responses</div>
        </div>
        <div class="page-header-actions">
          <span class="badge badge-info">6 Scenarios</span>
        </div>
      </div>
    </div>
    <div id="disruption-btns" class="disruption-grid"></div>
    <div id="disruption-detail"></div>
  `;
  document.getElementById("disruption-btns").innerHTML = buildDisruptionButtons();
  updateDisruptionDetail();
}

const DISRUPTION_META = {
  none:          { icon: "✅", cls: "" },
  severe_storm:  { icon: "🌩️", cls: "critical-d" },
  port_strike:   { icon: "⚓", cls: "critical-d" },
  highway_closure:{ icon:"🚧", cls: "" },
  geopolitical:  { icon: "🛂", cls: "" },
  extreme_heat:  { icon: "🌡️", cls: "" },
};

function buildDisruptionButtons() {
  return Object.entries(DISRUPTION_SCENARIOS).map(([id, d]) => {
    const meta = DISRUPTION_META[id] || { icon: "⚡", cls: "" };
    const active = state.activeDisruption === id ? "active " + meta.cls : "";
    return `
      <button class="disruption-btn ${active}" data-id="${id}"
        onclick="selectDisruption('${id}')" aria-label="Select ${d.label}">
        <span class="d-icon">${meta.icon}</span>
        ${d.label}
        <div class="d-sev">${d.severity}</div>
      </button>
    `;
  }).join("");
}

function selectDisruption(id) {
  // update all disruption button groups
  document.querySelectorAll(".disruption-btn").forEach(b => {
    b.classList.remove("active", "critical-d");
    if (b.dataset.id === id) {
      const meta = DISRUPTION_META[id] || {};
      b.classList.add("active");
      if (meta.cls) b.classList.add(meta.cls);
    }
  });
  applyDisruption(id);
}

function updateDisruptionDetail() {
  const id = state.activeDisruption;
  const d  = DISRUPTION_SCENARIOS[id];
  const el = document.getElementById("disruption-detail");
  if (!el) return;
  if (id === "none" || !d) {
    el.innerHTML = `
      <div class="disruption-detail-card visible">
        <div class="dc-header">
          <span class="dc-icon">✅</span>
          <div><div class="dc-title">No Active Disruption</div><div class="dc-loc">All routes operating normally</div></div>
        </div>
        <p style="color:var(--text-muted); font-size:13px;">Select a disruption scenario above to simulate its impact across the supply chain.</p>
      </div>`;
    return;
  }
  const meta = DISRUPTION_META[id] || { icon: "⚡" };
  el.innerHTML = `
    <div class="disruption-detail-card visible">
      <div class="dc-header">
        <span class="dc-icon">${meta.icon}</span>
        <div>
          <div class="dc-title">${d.label}</div>
          <div class="dc-loc">📍 ${d.location}</div>
        </div>
        <span class="badge ${severityBadge(d.severity)}" style="margin-left:auto;">${d.severity}</span>
      </div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px;">${d.description}</p>
      <div class="disruption-detail-grid">
        ${dcField("Type", d.type)}
        ${dcField("Severity", d.severity)}
        ${dcField("Start Time", d.startTime)}
        ${dcField("Expected Duration", d.expectedDuration)}
        ${dcField("Affected Routes", d.affectedRoutes.join(", ") || "None")}
        ${dcField("Affected Carriers", d.affectedCarriers.join(", ") || "None")}
        ${dcField("Affected Shipments", d.affectedShipmentIds.join(", ") || "None")}
        ${dcField("Cold-Chain Risk", d.coldChainRisk ? "⚠️ Yes" : "✅ No")}
      </div>
      <hr class="divider">
      <div>
        <div class="card-body-item">
          <span class="cbi-label">💼 Business Impact</span>
          <span class="cbi-val" style="max-width:60%;text-align:right;color:var(--amber);">${d.businessImpact}</span>
        </div>
      </div>
    </div>`;
}

function dcField(label, val) {
  return `<div class="dc-field"><label>${label}</label><span>${val}</span></div>`;
}

function severityBadge(sev) {
  const map = { "Critical": "badge-critical", "High": "badge-danger", "Medium": "badge-warning", "None": "badge-success", "Low": "badge-low" };
  return map[sev] || "badge-low";
}

/* ── SHIPMENT SECTION ───────────────────────────────────────── */
function renderShipmentSection() {
  const sec = document.getElementById("sec-shipments");
  sec.innerHTML = `
    <div class="section-title">📦 Shipment Manager</div>
    <div class="section-sub">Monitor and manage all active shipments with live disruption impact data</div>
    <div class="table-wrapper">
      <div class="table-toolbar">
        <input type="text" id="ship-search" placeholder="🔍 Search ID, origin, destination, cargo…" oninput="filterShipments()" aria-label="Search shipments">
        <select id="ship-filter-priority" onchange="filterShipments()" aria-label="Filter by priority">
          <option value="all">All Priorities</option>
          <option value="Critical">Critical</option>
          <option value="High">High</option>
          <option value="Medium">Medium</option>
        </select>
        <select id="ship-filter-risk" onchange="filterShipments()" aria-label="Filter by risk">
          <option value="all">All Risk Levels</option>
          <option value="High">High Risk</option>
          <option value="Medium">Medium Risk</option>
          <option value="Low">Low Risk</option>
        </select>
        <select id="ship-filter-status" onchange="filterShipments()" aria-label="Filter by status">
          <option value="all">All Statuses</option>
          <option value="On Time">On Time</option>
          <option value="Delayed">Delayed</option>
          <option value="At Risk">At Risk</option>
          <option value="Rerouting">Rerouting</option>
          <option value="Delivered">Delivered</option>
        </select>
        <select id="ship-filter-cargo" onchange="filterShipments()" aria-label="Filter by cargo type">
          <option value="all">All Cargo Types</option>
          <option value="Pharmaceuticals">Pharmaceuticals</option>
          <option value="Electronics">Electronics</option>
          <option value="Fresh Produce">Fresh Produce</option>
          <option value="Chemicals">Chemicals</option>
          <option value="Medical Supplies">Medical Supplies</option>
          <option value="Food & Beverage">Food &amp; Beverage</option>
          <option value="Automotive Parts">Automotive Parts</option>
          <option value="Retail Goods">Retail Goods</option>
          <option value="Perishable Goods">Perishable Goods</option>
          <option value="Consumer Electronics">Consumer Electronics</option>
          <option value="Auto Parts">Auto Parts</option>
          <option value="Industrial Equipment">Industrial Equipment</option>
        </select>
        <select id="ship-sort" onchange="sortShipments()" aria-label="Sort shipments">
          <option value="id">Sort: ID</option>
          <option value="delay">Sort: Delay (High→Low)</option>
          <option value="risk">Sort: Risk (High→Low)</option>
          <option value="priority">Sort: Priority</option>
        </select>
      </div>
      <div class="tbl-scroll">
        <table id="shipment-table" aria-label="Shipments">
          <thead>
            <tr>
              <th>ID</th>
              <th>Origin → Destination</th>
              <th>Cargo</th>
              <th>Carrier</th>
              <th>ETA</th>
              <th>Delay</th>
              <th>Priority</th>
              <th>Risk</th>
              <th>Temp</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="shipment-tbody"></tbody>
        </table>
      </div>
    </div>
    <div id="shipment-modal-placeholder"></div>
  `;
  renderShipmentTable();
}

function getFilteredShipments() {
  const f  = state.shipmentFilter;
  const q  = f.search.toLowerCase();
  return state.shipments.filter(s => {
    if (q && ![s.id, s.origin, s.destination, s.cargoType, s.carrier].join(" ").toLowerCase().includes(q)) return false;
    if (f.priority !== "all" && s.priority !== f.priority)  return false;
    if (f.risk     !== "all" && s.riskLevel !== f.risk)     return false;
    if (f.status   !== "all" && s.status !== f.status)      return false;
    if (f.cargo    !== "all" && s.cargoType !== f.cargo)    return false;
    return true;
  });
}

function filterShipments() {
  state.shipmentFilter.search   = document.getElementById("ship-search")?.value || "";
  state.shipmentFilter.priority = document.getElementById("ship-filter-priority")?.value || "all";
  state.shipmentFilter.risk     = document.getElementById("ship-filter-risk")?.value || "all";
  state.shipmentFilter.status   = document.getElementById("ship-filter-status")?.value || "all";
  state.shipmentFilter.cargo    = document.getElementById("ship-filter-cargo")?.value || "all";
  renderShipmentTable();
}

function sortShipments() {
  const val = document.getElementById("ship-sort")?.value || "id";
  state.shipmentSort.field = val;
  renderShipmentTable();
}

function renderShipmentTable() {
  const tbody = document.getElementById("shipment-tbody");
  if (!tbody) return;
  let ships = getFilteredShipments();

  // sort
  const sf = state.shipmentSort.field;
  const prioOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const riskOrder = { High: 0, Medium: 1, Low: 2 };
  ships.sort((a, b) => {
    if (sf === "delay")    return (b.delayHours || 0) - (a.delayHours || 0);
    if (sf === "risk")     return (riskOrder[a.riskLevel] || 0) - (riskOrder[b.riskLevel] || 0);
    if (sf === "priority") return (prioOrder[a.priority] || 0) - (prioOrder[b.priority] || 0);
    return a.id.localeCompare(b.id);
  });

  if (ships.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><div class="es-icon">📭</div>No shipments match your filters</div></td></tr>`;
    return;
  }

  tbody.innerHTML = ships.map(s => {
    const sel = state.selectedShipmentId === s.id ? "selected-row" : "";
    return `
      <tr class="${sel}" onclick="selectShipment('${s.id}')" tabindex="0" onkeydown="if(event.key==='Enter')selectShipment('${s.id}')" aria-label="Shipment ${s.id}">
        <td class="mono">${s.id}</td>
        <td>${s.origin}<br><span class="text-muted text-xs">→ ${s.destination}</span></td>
        <td>${s.cargoType}${s.coldChain ? ' ❄️' : ''}</td>
        <td>${s.carrier}</td>
        <td class="mono text-sm">${formatETA(s.eta)}</td>
        <td>${s.delayHours > 0 ? `<span style="color:var(--red);font-weight:700;">+${s.delayHours}h</span>` : `<span style="color:var(--green)">—</span>`}</td>
        <td>${priorityBadge(s.priority)}</td>
        <td>${riskBadge(s.riskLevel)}</td>
        <td class="text-xs">${s.tempRequired}</td>
        <td>${statusBadge(s.status)}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openShipmentDetail('${s.id}')">Details</button></td>
      </tr>
    `;
  }).join("");
}

function formatETA(eta) {
  if (!eta) return "—";
  return eta.replace("T", " ").replace(/:\d\d$/, "");
}

function selectShipment(id) {
  state.selectedShipmentId = id;
  renderShipmentTable();
  renderRouteCards();
}

function openShipmentDetail(id) {
  const s = state.shipments.find(x => x.id === id);
  if (!s) return;
  const src = SHIPMENTS_DATA.find(x => x.id === id) || s;
  showModal(`📦 Shipment ${s.id} Details`, `
    <div class="two-col">
      ${dcField("Origin", s.origin)}
      ${dcField("Destination", s.destination)}
      ${dcField("Cargo Type", s.cargoType + (s.coldChain ? " ❄️" : ""))}
      ${dcField("Carrier", s.carrier)}
      ${dcField("Current Route", s.currentRoute)}
      ${dcField("ETA", s.eta)}
      ${dcField("Delay", s.delayHours > 0 ? "+" + s.delayHours + "h" : "None")}
      ${dcField("Priority", s.priority)}
      ${dcField("Risk Level", s.riskLevel)}
      ${dcField("Status", s.status)}
      ${dcField("Temp Required", s.tempRequired)}
      ${dcField("Weight", src.weight || "—")}
      ${dcField("Cargo Value", src.value || "—")}
    </div>
    <hr class="divider">
    <div class="brief-section">
      <h4>Recommended Action</h4>
      <p>${s.recommendedAction}</p>
    </div>
    <div class="flex gap-2 mt-4 flex-wrap">
      <button class="btn btn-primary" onclick="applyRecommendedRoute('${id}'); closeModal();">Apply Recommended Route</button>
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
    </div>
  `);
}

/* ── ROUTE SECTION ──────────────────────────────────────────── */
/* ── ROUTE OPTIMISATION ENGINE ───────────────────────────────── */
const ROUTE_ENGINE = {
  getRouteEvaluation(shipmentId) {
    const s = state.shipments.find(x => x.id === shipmentId) || state.shipments[0];
    const baseRoutes = ROUTE_OPTIONS[shipmentId] || ROUTE_OPTIONS["default"];
    
    return baseRoutes.map((r) => {
      const isCurrent = r.type === "current";
      const isRec     = r.type === "recommended";
      
      const distance = r.distance !== "—" ? r.distance : (isCurrent ? "850 mi" : isRec ? "820 mi" : "890 mi");
      const travelTime = r.time !== "—" ? r.time : (isCurrent ? "24h (+18h delay)" : isRec ? "14h" : "15h");
      const disruptionRisk = r.risk !== undefined ? `${r.risk}/5 (${r.weather || 'Weather risk'})` : "Low (1/5)";
      const cost = r.addCost !== undefined ? r.addCost : (isCurrent ? "$0 baseline" : "+$180 fuel/toll");
      const vehicleAvailability = r.vehicleAvailability || (isRec ? "VH-101 Available (Reefer)" : "Current Asset (In Transit)");
      const deliveryDeadline = r.deliveryDeadline || (isRec ? "On-Time (4h buffer)" : "Delayed by 18h");
      
      let rationale = r.rationale;
      if (!rationale) {
        if (isCurrent) {
          rationale = `Subject to severe disruption delay along primary highway corridor. High delay exposure.`;
        } else if (isRec) {
          rationale = `BEST ROUTE SELECTED: Bypasses active storm/strike zone via inland corridor. Ensures delivery deadline compliance with a 4-hour safety buffer, preserves cold-chain integrity, and leverages available fleet asset with minimal cost overhead (+$180).`;
        } else {
          rationale = `Expedited contingency route. Guarantees tightest delivery window but incurs high air/heavy freight surcharges.`;
        }
      }

      return {
        ...r,
        distance,
        travelTime,
        disruptionRisk,
        cost,
        vehicleAvailability,
        deliveryDeadline,
        rationale,
      };
    });
  }
};

function renderRouteSection() {
  const sec = document.getElementById("sec-routes");
  sec.innerHTML = `
    <div class="section-title">🗺️ Route Optimisation Engine</div>
    <div class="section-sub">Multi-criteria alternative route comparison engine for disrupted shipments</div>
    <div class="filter-bar" id="route-shipment-filter"></div>
    <div id="route-cards-container"></div>
  `;
  buildRouteFilter();
  renderRouteCards();
}

function buildRouteFilter() {
  const el = document.getElementById("route-shipment-filter");
  if (!el) return;
  const affected = state.shipments.filter(s => s.delayHours > 0 || state.activeDisruption === "none");
  const chips = state.activeDisruption === "none"
    ? state.shipments.slice(0, 5)
    : state.shipments.filter(s => s.delayHours > 0);
  el.innerHTML = chips.map(s =>
    `<span class="filter-chip ${state.selectedShipmentId === s.id ? "active" : ""}" onclick="selectRouteShipment('${s.id}')">${s.id}</span>`
  ).join("");
  if (!state.selectedShipmentId && chips.length > 0) {
    state.selectedShipmentId = chips[0].id;
  }
}

function selectRouteShipment(id) {
  state.selectedShipmentId = id;
  buildRouteFilter();
  renderRouteCards();
}

function renderRouteCards() {
  const container = document.getElementById("route-cards-container");
  if (!container) return;
  const id = state.selectedShipmentId;
  if (!id) {
    container.innerHTML = `<div class="empty-state"><div class="es-icon">🗺️</div>Select a shipment above to see route options</div>`;
    return;
  }
  const evaluatedRoutes = ROUTE_ENGINE.getRouteEvaluation(id);
  const ship            = state.shipments.find(s => s.id === id);
  const recRoute        = evaluatedRoutes.find(r => r.type === "recommended") || evaluatedRoutes[0];

  container.innerHTML = `
    <div class="card mb-4" style="margin-bottom:16px;">
      <div class="card-header">
        <div>
          <div class="card-title">Shipment: <span class="mono" style="color:var(--blue);font-weight:700;">${id}</span></div>
          <div class="text-muted text-sm">${ship ? ship.origin + " → " + ship.destination + " | Cargo: " + ship.cargoType : ""}</div>
        </div>
        ${ship ? statusBadge(ship.status) : ""}
      </div>
    </div>

    <!-- 6-Metric Comparison Table -->
    <div class="card" style="margin-bottom:20px;overflow-x:auto;">
      <div class="card-title" style="font-size:15px;margin-bottom:8px;">📊 Route Comparison Matrix</div>
      <table class="route-matrix-table">
        <thead>
          <tr>
            <th>Route Option</th>
            <th>📏 Distance</th>
            <th>⏱️ Travel Time</th>
            <th>⚠️ Disruption Risk</th>
            <th>💵 Cost</th>
            <th>🚛 Vehicle Avail.</th>
            <th>📅 Deadline Buffer</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          ${evaluatedRoutes.map(r => `
            <tr class="${r.type === 'recommended' ? 'highlight-rec' : ''}">
              <td>
                <strong>${r.name}</strong>
                ${r.type === 'recommended' ? ' <span class="rec-tag" style="margin-left:4px;">★ BEST</span>' : ''}
              </td>
              <td>${r.distance}</td>
              <td>${r.travelTime}</td>
              <td>${r.disruptionRisk}</td>
              <td>${r.cost}</td>
              <td>${r.vehicleAvailability}</td>
              <td>${r.deliveryDeadline}</td>
              <td><strong style="color:${r.score >= 7 ? 'var(--green)' : 'var(--amber)'}">${r.score}/10</strong></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Recommended Rationale Card -->
    ${recRoute ? `
      <div class="rationale-box">
        <div class="rationale-title">★ Best Route Rationale — Why ${recRoute.name} Was Selected:</div>
        <div>${recRoute.rationale}</div>
      </div>
    ` : ''}

    <div class="section-title" style="font-size:15px;margin-top:24px;margin-bottom:12px;">Detailed Route Alternatives</div>
    <div class="route-grid">
      ${evaluatedRoutes.map(r => buildRouteCard(r, id)).join("")}
    </div>
  `;
}

function buildRouteCard(r, shipId) {
  const isRec  = r.type === "recommended";
  const isEmg  = r.type === "emergency";
  const pct    = Math.round((r.score / 10) * 100);
  const fillCl = r.score >= 7 ? "fill-green" : r.score >= 4 ? "fill-amber" : "fill-red";
  return `
    <div class="route-card ${isRec ? "recommended" : ""} ${isEmg ? "emergency" : ""}">
      ${isRec ? `<div class="rec-tag">★ RECOMMENDED</div>` : ""}
      <div class="font-bold" style="margin-bottom:6px; padding-top:${isRec ? "8px" : "0"}">${r.name}</div>
      <div class="route-score">
        <div class="score-bar"><div class="score-fill ${fillCl}" style="width:${pct}%"></div></div>
        <span class="score-val">${r.score}/10</span>
      </div>
      <div class="cards-grid" style="grid-template-columns:1fr 1fr; gap:8px; margin:0;">
        ${miniField("📏 Distance", r.distance)}
        ${miniField("⏱️ Travel Time", r.travelTime || r.time)}
        ${miniField("💵 Cost", r.cost || r.addCost)}
        ${miniField("⬇️ Delay Saved", r.delayReduction)}
        ${miniField("⚠️ Risk", r.disruptionRisk || r.risk + "/5")}
        ${miniField("📅 Deadline", r.deliveryDeadline || "On-Time")}
        ${miniField("🚛 Vehicle", r.vehicleAvailability || "Available")}
        ${miniField("🛣️ Road", r.road || "Good")}
        ${miniField("⛽ Fuel", r.fuel || "Normal")}
      </div>
      ${isRec ? `
        <div style="margin-top:12px">
          <button class="btn btn-success full-width" onclick="applyRecommendedRoute('${shipId}')">
            ✅ Apply Recommended Route
          </button>
        </div>
      ` : ""}
    </div>
  `;
}

function miniField(label, val) {
  return `<div style="background:var(--surface2);border-radius:6px;padding:6px 8px;">
    <div style="font-size:10px;color:var(--text-dim)">${label}</div>
    <div style="font-size:12px;font-weight:600;margin-top:2px">${val}</div>
  </div>`;
}

async function applyRecommendedRoute(shipId) {
  if (window.API && window.API.available) {
    const result = await window.API.rerouteShipment(shipId);
    if (result && result.success) {
      showToast(`Route applied for ${shipId} via backend.`, "success");
      return;
    }
  }
  const s = state.shipments.find(x => x.id === shipId);
  if (!s) return;
  const routes = ROUTE_ENGINE.getRouteEvaluation(shipId);
  const rec    = routes.find(r => r.type === "recommended") || routes[0];
  if (!rec) return;

  const prevStatus = s.status;
  const prevRoute  = s.currentRoute;

  s.status      = "Rerouting";
  s.currentRoute = rec.name;
  s.delayHours  = Math.max(0, s.delayHours - parseInt(rec.delayReduction) || 0);
  s.recommendedAction = "Reroute applied – monitor progress";

  addAuditEntry("Route Changed", s.id, prevRoute, rec.name, "Operator");
  addAuditEntry("Status Changed", s.id, prevStatus, "Rerouting", "Operator");

  const act = state.actions.find(a => a.related === shipId && a.type === "Reroute" && a.status === "Pending");
  if (act) act.status = "Completed";

  updateDashboardKPIs();
  renderShipmentTable();
  renderRouteCards();
  renderActionList();
  renderAuditList();
  updateNavBadges();
  updateLastUpdated();
  showToast(`Route applied for ${shipId}. Status updated to Rerouting.`, "success");
}

/* ── CARRIER SECTION ─────────────────────────────────────────── */
function renderCarrierSection() {
  const sec = document.getElementById("sec-carriers");
  sec.innerHTML = `
    <div class="section-title">🚢 Carrier Selection</div>
    <div class="section-sub">Available alternative carriers with performance and cost analysis</div>
    <div class="cards-grid">
      ${CARRIERS_DATA.map(buildCarrierCard).join("")}
    </div>
  `;
}

function buildCarrierCard(c) {
  const riskCl = c.risk === "Low" ? "badge-success" : c.risk === "Medium" ? "badge-warning" : "badge-danger";
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${c.name}</div>
          <div class="text-xs text-muted">${c.id} · ${c.region}</div>
        </div>
        <span class="badge ${riskCl}">${c.risk} Risk</span>
      </div>
      ${[
        ["Available Capacity", c.capacity],
        ["Reliability Score", `<span style="color:var(--green);font-weight:800">${c.reliability}%</span>`],
        ["Estimated Cost",    `<span style="color:var(--amber)">${c.cost}</span>`],
        ["Transit Time",      c.transitTime],
        ["Cold-Chain",        c.coldChain ? `<span style="color:var(--cyan)">✅ Yes</span>` : "❌ No"],
      ].map(([k,v]) => `<div class="card-body-item"><span class="cbi-label">${k}</span><span class="cbi-val">${v}</span></div>`).join("")}
      <div class="mt-2" style="background:var(--blue-dim);border-radius:var(--radius);padding:8px 10px;font-size:12px;color:var(--blue);margin-top:10px;">
        💡 ${c.reason}
      </div>
      <div style="margin-top:10px;">
        <button class="btn btn-primary full-width btn-sm" onclick="selectCarrier('${c.id}', '${c.name}')">Select This Carrier</button>
      </div>
    </div>
  `;
}

function selectCarrier(carrierId, carrierName) {
  const shipId = state.selectedShipmentId;
  const label  = shipId || "unassigned shipment";
  addAuditEntry("Carrier Selected", label, "Previous carrier", carrierName, "Procurement");
  updateLastUpdated();
  renderAuditList();
  showToast(`${carrierName} selected for ${label}.`, "success");
}

/* ── FLEET UTILISATION OPTIMIZER ENGINE ─────────────────────── */
const FLEET_OPTIMIZER = {
  getIdleVehicles() {
    return state.fleet.filter(f => ["Idle", "Available"].includes(f.status) && (parseFloat(String(f.currentLoad || "0").replace(/,/g,"").replace(" kg","")) === 0 || f.status === "Idle"))
      .map(f => ({
        ...f,
        idleDays: f.idleDays !== undefined ? f.idleDays : (f.status === "Idle" ? 4 : 1),
        idleCostUsd: (f.idleDays !== undefined ? f.idleDays : (f.status === "Idle" ? 4 : 1)) * 280,
      }));
  },

  getOverloadedRoutes() {
    return state.fleet.filter(f => {
      const cap = parseFloat(String(f.capacity).replace(/,/g,"").replace(" kg","")) || 1;
      const load = parseFloat(String(f.currentLoad).replace(/,/g,"").replace(" kg","")) || 0;
      return (load / cap) >= 0.85;
    }).map(f => {
      const cap = parseFloat(String(f.capacity).replace(/,/g,"").replace(" kg","")) || 1;
      const load = parseFloat(String(f.currentLoad).replace(/,/g,"").replace(" kg","")) || 0;
      const ship = state.shipments.find(s => s.id === f.nearestAffected) || state.shipments[0];
      return {
        assetId: f.id,
        assetType: f.type,
        location: f.location,
        capacityKg: cap,
        cargoWeightKg: load,
        loadFactorPct: Math.round((load / cap) * 100),
        shipmentReference: ship ? ship.id : "N/A",
        route: ship ? `${ship.origin} → ${ship.destination}` : "Active Transit",
      };
    });
  },

  getAvailableDrivers() {
    const drivers = typeof DRIVERS_DATA !== "undefined" ? DRIVERS_DATA : [];
    return drivers.filter(d => d.status === "Available" && (d.maxHours7d - d.hoursDriven7d) > 4)
      .map(d => ({
        ...d,
        hoursRemaining: d.maxHours7d - d.hoursDriven7d,
      }));
  },

  getUnderutilisedAssets() {
    return state.fleet.filter(f => f.utilisation < 50)
      .map(f => ({
        ...f,
        idleDays: f.idleDays || (f.utilisation === 0 ? 5 : 2),
        idleCostUsd: (f.idleDays || (f.utilisation === 0 ? 5 : 2)) * 280,
      }));
  },

  getShipmentsNeedingAssignment() {
    return state.shipments.filter(s => s.status !== "Delivered" && (s.delayHours > 0 || s.riskLevel === "High" || s.status === "Booked"));
  },

  runOptimizationPass() {
    const idleVehicles = this.getIdleVehicles();
    const availableDrivers = this.getAvailableDrivers();
    const underutilised = this.getUnderutilisedAssets();
    const overloaded = this.getOverloadedRoutes();
    const unassigned = this.getShipmentsNeedingAssignment();

    const avgUtilBefore = Math.round(
      state.fleet.reduce((acc, f) => acc + (f.utilisation || 0), 0) / state.fleet.length
    );

    const candidates = [];
    let totalSavings = 0;

    unassigned.forEach(shipment => {
      idleVehicles.forEach(asset => {
        const driver = availableDrivers.find(d => d.location === asset.location) || availableDrivers[0] || null;
        
        const distanceScore = asset.location.includes(shipment.origin.split(",")[0]) ? 95 : 65;
        const assetCap = parseFloat(String(asset.capacity).replace(/,/g,"").replace(" kg","")) || 5000;
        const shipWeight = parseFloat(String(shipment.weight || "5000").replace(/,/g,"").replace(" kg","")) || 5000;
        const capacityScore = assetCap >= shipWeight ? 100 : 0;
        
        if (capacityScore === 0) return;
        
        const isColdNeeded = shipment.coldChain || shipment.cargoType.includes("Pharma") || shipment.cargoType.includes("Produce");
        const coldScore = !isColdNeeded ? 100 : (asset.tempCapable ? 100 : 0);
        if (coldScore === 0) return;

        const availScore = driver ? Math.min(100, Math.round((driver.hoursRemaining / 56) * 100)) : 70;
        const etaScore = shipment.priority === "Critical" ? 90 : 80;
        const routeScore = 85;

        const totalScore = Math.round(
          distanceScore * 0.25 +
          capacityScore * 0.25 +
          availScore * 0.20 +
          coldScore * 0.15 +
          etaScore * 0.10 +
          routeScore * 0.05
        );

        const idleDays = asset.idleDays || 3;
        const baselineIdleCost = idleDays * 280;
        const positioningCost = distanceScore > 80 ? 120 : 380;
        const driverCost = driver ? 220 : 0;
        const assignCost = positioningCost + driverCost;
        const costSaving = Math.max(0, baselineIdleCost - assignCost);

        const projectedAssetUtil = Math.min(100, Math.max(65, asset.utilisation + 60));

        candidates.push({
          id: `REC-${shipment.id}-${asset.id}`,
          shipmentId: shipment.id,
          shipmentReference: shipment.id,
          cargoType: shipment.cargoType,
          origin: shipment.origin,
          destination: shipment.destination,
          assetId: asset.id,
          assetType: asset.type,
          assetLocation: asset.location,
          driverId: driver ? driver.id : "N/A",
          driverName: driver ? driver.name : "Available Driver",
          totalScore,
          scores: {
            distance: distanceScore,
            capacity: capacityScore,
            availability: availScore,
            coldChain: coldScore,
            eta: etaScore,
            route: routeScore,
          },
          estimatedPickupEta: "In 2.5 hours",
          estimatedDeliveryEta: "Tomorrow 14:00 UTC",
          costSaving,
          currentAssetUtil: asset.utilisation,
          projectedAssetUtil,
        });
      });
    });

    candidates.sort((a, b) => b.totalScore - a.totalScore);
    const topMatches = [];
    const seenShipments = new Set();

    candidates.forEach(c => {
      if (!seenShipments.has(c.shipmentId)) {
        seenShipments.add(c.shipmentId);
        topMatches.push(c);
        totalSavings += c.costSaving;
      }
    });

    const projectedFleetUtilSum = state.fleet.reduce((acc, f) => {
      const match = topMatches.find(m => m.assetId === f.id);
      return acc + (match ? match.projectedAssetUtil : f.utilisation);
    }, 0);

    const avgUtilAfter = Math.round(projectedFleetUtilSum / state.fleet.length);

    return {
      runAt: new Date().toISOString(),
      idleCount: idleVehicles.length,
      idleCostTotalUsd: idleVehicles.reduce((acc, v) => acc + v.idleCostUsd, 0),
      overloadedCount: overloaded.length,
      availableDriverCount: availableDrivers.length,
      underutilisedCount: underutilised.length,
      unassignedCount: unassigned.length,
      avgUtilBefore,
      avgUtilAfter,
      utilisationDelta: avgUtilAfter - avgUtilBefore,
      totalSavingsUsd: totalSavings,
      recommendations: topMatches,
      findings: {
        idleVehicles,
        overloaded,
        availableDrivers,
        underutilised,
        unassigned,
      }
    };
  }
};

let activeOptimizerTab = "recommendations";

function renderFleetSection() {
  const sec = document.getElementById("sec-fleet");
  const optResult = FLEET_OPTIMIZER.runOptimizationPass();

  sec.innerHTML = `
    <div class="optimizer-panel">
      <div class="opt-header-bar">
        <div class="opt-title-group">
          <h2>⚡ Fleet Utilisation Optimizer</h2>
          <p>AI-driven asset redeployment, driver matching, and fleet efficiency analytics</p>
        </div>
        <button class="btn-optimizer-run" onclick="triggerFleetOptimizationRun()">
          ⚡ Run Optimization Engine
        </button>
      </div>

      <!-- KPI Summary Row -->
      <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit, minmax(160px,1fr));margin-bottom:20px;">
        <div class="kpi-card">
          <div class="kpi-label">🔵 Idle Vehicles</div>
          <div class="kpi-val" style="color:var(--amber)">${optResult.idleCount}</div>
          <div class="kpi-sub">Penalty: $${optResult.idleCostTotalUsd.toLocaleString()}/day</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">⚠️ Overloaded Routes</div>
          <div class="kpi-val" style="color:var(--red)">${optResult.overloadedCount}</div>
          <div class="kpi-sub">>85% capacity threshold</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">👤 Available Drivers</div>
          <div class="kpi-val" style="color:var(--green)">${optResult.availableDriverCount}</div>
          <div class="kpi-sub">Ready for dispatch</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">📉 Underutilised Assets</div>
          <div class="kpi-val" style="color:var(--purple)">${optResult.underutilisedCount}</div>
          <div class="kpi-sub"><50% utilization rate</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">📈 Utilisation Boost</div>
          <div class="kpi-val" style="color:var(--blue)">${optResult.avgUtilBefore}% → ${optResult.avgUtilAfter}%</div>
          <div class="kpi-sub">+${optResult.utilisationDelta}% fleet-wide improvement</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">💰 Projected Savings</div>
          <div class="kpi-val" style="color:var(--green)">+$${optResult.totalSavingsUsd.toLocaleString()}</div>
          <div class="kpi-sub">Baseline cost elimination</div>
        </div>
      </div>

      <!-- 5 Findings Navigation Tabs -->
      <div class="findings-tabs">
        <span class="finding-tab ${activeOptimizerTab === 'recommendations' ? 'active' : ''}" onclick="switchOptimizerTab('recommendations')">
          🎯 Reassignment Matches <span class="finding-badge-count">${optResult.recommendations.length}</span>
        </span>
        <span class="finding-tab ${activeOptimizerTab === 'idle' ? 'active' : ''}" onclick="switchOptimizerTab('idle')">
          🔵 Idle Vehicles <span class="finding-badge-count">${optResult.idleCount}</span>
        </span>
        <span class="finding-tab ${activeOptimizerTab === 'overloaded' ? 'active' : ''}" onclick="switchOptimizerTab('overloaded')">
          ⚠️ Overloaded Routes <span class="finding-badge-count">${optResult.overloadedCount}</span>
        </span>
        <span class="finding-tab ${activeOptimizerTab === 'drivers' ? 'active' : ''}" onclick="switchOptimizerTab('drivers')">
          👤 Available Drivers <span class="finding-badge-count">${optResult.availableDriverCount}</span>
        </span>
        <span class="finding-tab ${activeOptimizerTab === 'underutilised' ? 'active' : ''}" onclick="switchOptimizerTab('underutilised')">
          📉 Underutilised Assets <span class="finding-badge-count">${optResult.underutilisedCount}</span>
        </span>
      </div>

      <div id="optimizer-tab-content"></div>
    </div>

    <div class="section-title" style="font-size:15px;margin-bottom:12px;">All Fleet Assets</div>
    <div id="fleet-cards" class="cards-grid"></div>
  `;

  renderOptimizerTabContent(optResult);
  renderFleetCards();
}

function switchOptimizerTab(tabName) {
  activeOptimizerTab = tabName;
  renderFleetSection();
}

function triggerFleetOptimizationRun() {
  if (window.API && window.API.available) {
    window.API.runFleetOptimizer().then(() => {
      showToast("Fleet Utilisation Optimization pass executed via backend.", "success");
    });
  }
  addAuditEntry("Fleet Optimizer Executed", "System", "Previous Run", "Full Fleet Pass Completed", "Fleet Engine");
  renderFleetSection();
  showToast("⚡ Fleet Utilisation Optimization complete! Recommendations updated.", "success");
}

function renderOptimizerTabContent(optResult) {
  const container = document.getElementById("optimizer-tab-content");
  if (!container) return;

  if (activeOptimizerTab === "recommendations") {
    if (optResult.recommendations.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="es-icon">✅</div>No shipments currently require reassignment</div>`;
      return;
    }
    container.innerHTML = optResult.recommendations.map(r => `
      <div class="recommendation-card" id="rec-card-${r.id}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="font-size:15px;font-weight:700;">Reassign <span class="mono" style="color:var(--blue);">${r.shipmentId}</span> to Asset <span class="mono">${r.assetId}</span> (${r.assetType})</div>
            <div class="text-xs text-muted" style="margin-top:2px;">📍 ${r.origin} → ${r.destination} · Driver: <strong>${r.driverName}</strong></div>
          </div>
          <span class="rec-score-pill">Match Score: ${r.totalScore}/100</span>
        </div>

        <div class="score-breakdown-grid">
          <div class="score-factor-item"><div class="score-factor-label">Distance (25%)</div><div class="score-factor-val">${r.scores.distance}/100</div></div>
          <div class="score-factor-item"><div class="score-factor-label">Capacity (25%)</div><div class="score-factor-val">${r.scores.capacity}/100</div></div>
          <div class="score-factor-item"><div class="score-factor-label">Driver HOS (20%)</div><div class="score-factor-val">${r.scores.availability}/100</div></div>
          <div class="score-factor-item"><div class="score-factor-label">Cold Chain (15%)</div><div class="score-factor-val">${r.scores.coldChain}/100</div></div>
          <div class="score-factor-item"><div class="score-factor-label">Pickup ETA (10%)</div><div class="score-factor-val">${r.scores.eta}/100</div></div>
          <div class="score-factor-item"><div class="score-factor-label">Route Bonus (5%)</div><div class="score-factor-val">${r.scores.route}/100</div></div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-top:12px;padding-top:10px;border-top:1px dashed var(--border);font-size:12px;">
          <div>
            <span style="color:var(--green);font-weight:700;">Utilisation Boost: ${r.currentAssetUtil}% → ~${r.projectedAssetUtil}%</span>
            <span style="margin:0 6px;">·</span>
            <span style="color:var(--amber);font-weight:700;">Est. Savings: +$${r.costSaving}</span>
          </div>
          <button class="btn btn-success btn-sm" onclick="acceptFleetRecommendation('${r.id}', '${r.shipmentId}', '${r.assetId}', '${r.driverName}')">
            ✅ Accept Assignment
          </button>
        </div>
      </div>
    `).join("");
  } else if (activeOptimizerTab === "idle") {
    const list = optResult.findings.idleVehicles;
    container.innerHTML = `
      <table class="route-matrix-table">
        <thead>
          <tr><th>Asset ID</th><th>Type</th><th>Location</th><th>Capacity</th><th>Idle Days</th><th>Idle Penalty Cost</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${list.map(v => `
            <tr>
              <td><strong>${v.id}</strong></td>
              <td>${v.type}</td>
              <td>${v.location}</td>
              <td>${v.capacity}</td>
              <td><span style="color:var(--amber);font-weight:700">${v.idleDays} days</span></td>
              <td><span style="color:var(--red);font-weight:700">$${v.idleCostUsd}</span></td>
              <td><span class="badge badge-warning">Idle</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else if (activeOptimizerTab === "overloaded") {
    const list = optResult.findings.overloaded;
    container.innerHTML = `
      <table class="route-matrix-table">
        <thead>
          <tr><th>Asset ID</th><th>Asset Type</th><th>Location</th><th>Route / Leg</th><th>Capacity</th><th>Current Cargo Load</th><th>Load Factor</th></tr>
        </thead>
        <tbody>
          ${list.map(o => `
            <tr>
              <td><strong>${o.assetId}</strong></td>
              <td>${o.assetType}</td>
              <td>${o.location}</td>
              <td>${o.route}</td>
              <td>${o.capacityKg.toLocaleString()} kg</td>
              <td>${o.cargoWeightKg.toLocaleString()} kg</td>
              <td><span class="badge badge-critical">${o.loadFactorPct}% Load</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else if (activeOptimizerTab === "drivers") {
    const list = optResult.findings.availableDrivers;
    container.innerHTML = `
      <table class="route-matrix-table">
        <thead>
          <tr><th>Driver Name</th><th>License Class</th><th>Base Location</th><th>7D Driven Hours</th><th>Hours Remaining</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${list.map(d => `
            <tr>
              <td><strong>${d.name}</strong></td>
              <td>${d.license}</td>
              <td>${d.location}</td>
              <td>${d.hoursDriven7d}h / 56h</td>
              <td><span style="color:var(--green);font-weight:700;">${d.hoursRemaining}h remaining</span></td>
              <td><span class="badge badge-success">Available</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else if (activeOptimizerTab === "underutilised") {
    const list = optResult.findings.underutilised;
    container.innerHTML = `
      <table class="route-matrix-table">
        <thead>
          <tr><th>Asset ID</th><th>Type</th><th>Location</th><th>Current Utilisation %</th><th>30-Day Assignments</th><th>Idle Penalty Cost</th></tr>
        </thead>
        <tbody>
          ${list.map(u => `
            <tr>
              <td><strong>${u.id}</strong></td>
              <td>${u.type}</td>
              <td>${u.location}</td>
              <td><span style="color:var(--purple);font-weight:700;">${u.utilisation}%</span></td>
              <td>${u.assignments30d} assignments</td>
              <td>$${u.idleCostUsd}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}

async function acceptFleetRecommendation(recId, shipmentId, assetId, driverName) {
  if (window.API && window.API.available) {
    await window.API.acceptFleetCandidate(recId);
  }
  const f = state.fleet.find(v => v.id === assetId);
  if (f) {
    f.status = "Reserved";
    f.utilisation = Math.min(100, f.utilisation + 50);
  }
  const s = state.shipments.find(x => x.id === shipmentId);
  if (s) {
    s.status = "In Transit";
    s.recommendedAction = `Assigned to asset ${assetId} with driver ${driverName}`;
  }
  addAuditEntry("Asset Reassigned", assetId, "Idle", `Assigned to ${shipmentId} (Driver: ${driverName})`, "Fleet Ops");
  
  showToast(`✅ Recommendation accepted! Asset ${assetId} assigned to ${shipmentId}.`, "success");
  renderFleetSection();
  updateDashboardKPIs();
  renderAuditList();
}

function renderFleetCards() {
  const cards = document.getElementById("fleet-cards");
  if (!cards) return;
  cards.innerHTML = state.fleet.map(f => buildFleetCard(f)).join("");
}

function buildFleetCard(f) {
  const utilPct = f.utilisation;
  const fillCl  = utilPct >= 80 ? "fill-red" : utilPct >= 50 ? "fill-amber" : utilPct >= 1 ? "fill-green" : "fill-blue";
  const statusBg = {
    "In Transit": "badge-info",
    "Idle": "badge-warning",
    "Maintenance": "badge-danger",
    "Available": "badge-success",
    "Reserved": "badge-purple",
  }[f.status] || "badge-low";

  return `
    <div class="fleet-card">
      <div class="fc-header">
        <div>
          <div class="fc-id">${f.id}</div>
          <div class="fc-type">${f.type}</div>
        </div>
        <span class="badge ${statusBg}">${f.status}</span>
      </div>
      ${[
        ["📍 Location",   f.location],
        ["📦 Capacity",   f.capacity],
        ["🏋️ Load",       f.currentLoad],
        ["👤 Driver",     f.driverName || f.driver],
        ["⛽ Fuel",       f.fuel + "%"],
        ["❄️ Temp Cap",   f.tempCapable ? "Yes" : "No"],
      ].map(([k,v]) => `<div class="card-body-item"><span class="cbi-label">${k}</span><span class="cbi-val">${v}</span></div>`).join("")}
      <div style="margin-top:10px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-bottom:4px;">
          <span>Utilisation</span><span>${utilPct}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill ${fillCl}" style="width:${utilPct}%"></div></div>
      </div>
    </div>
  `;
}


/* ── COLD CHAIN SECTION ─────────────────────────────────────── */
function renderColdChainSection() {
  const sec = document.getElementById("sec-coldchain");
  sec.innerHTML = `
    <div class="section-title">❄️ Cold-Chain Monitor</div>
    <div class="section-sub">IoT sensor readings for temperature-sensitive shipments</div>
    <div class="filter-bar" id="cc-filter-bar">
      <span class="filter-chip active" id="ccf-all" onclick="filterCC('all')">All Sensors</span>
      <span class="filter-chip" id="ccf-Critical" onclick="filterCC('Critical')">🔴 Critical</span>
      <span class="filter-chip" id="ccf-Warning"  onclick="filterCC('Warning')">🟡 Warning</span>
      <span class="filter-chip" id="ccf-Normal"   onclick="filterCC('Normal')">🟢 Normal</span>
    </div>
    <div id="cc-cards" class="cards-grid"></div>
  `;
  renderColdChainCards();
}

let ccFilter = "all";
function filterCC(f) {
  ccFilter = f;
  document.querySelectorAll("#cc-filter-bar .filter-chip").forEach(c => c.classList.remove("active"));
  const target = document.getElementById("ccf-" + f);
  if (target) target.classList.add("active");
  renderColdChainCards();
}

function renderColdChainCards() {
  const el = document.getElementById("cc-cards");
  if (!el) return;
  let data = state.coldChain;
  if (ccFilter !== "all") data = data.filter(c => c.status === ccFilter);
  if (data.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="es-icon">✅</div>No sensors matching this filter</div>`;
    return;
  }
  el.innerHTML = data.map(buildColdChainCard).join("");
}

function buildColdChainCard(c) {
  const ship    = state.shipments.find(s => s.id === c.shipmentId);
  const tempCls = c.status === "Critical" ? "t-critical" : c.status === "Warning" ? "t-warning" : "t-normal";
  const cardCls = c.status === "Critical" ? "critical-temp" : c.status === "Warning" ? "warning-temp" : "";
  const ackTxt  = c.acknowledged ? "Acknowledged ✓" : "";

  return `
    <div class="temp-card ${cardCls}" id="cc-card-${c.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="font-bold">${c.shipmentId} – ${c.sensorId}</div>
          <div class="text-xs text-muted">${ship ? ship.cargoType : ""} · ${ship ? ship.origin + " → " + ship.destination : ""}</div>
        </div>
        <span class="badge badge-${c.status.toLowerCase() === "normal" ? "normal" : c.status.toLowerCase() === "warning" ? "warning" : "critical"}">${c.status}</span>
      </div>
      <div class="temp-display ${tempCls}">${c.temp}°C</div>
      <div class="temp-range">Allowed: ${c.minTemp}°C to ${c.maxTemp}°C</div>
      <div style="margin-top:12px;">
        ${[
          ["💧 Humidity",    c.humidity + "%"],
          ["🔋 Battery",     c.battery + "%"],
          ["🚪 Door",        c.doorStatus],
          ["📍 GPS",         c.gps],
          ["🕐 Timestamp",   c.timestamp],
        ].map(([k,v]) => `<div class="card-body-item"><span class="cbi-label">${k}</span><span class="cbi-val">${v}</span></div>`).join("")}
      </div>
      ${c.status !== "Normal" && !c.acknowledged ? `
      <div class="flex gap-2 mt-4 flex-wrap">
        <button class="btn btn-ghost btn-sm" onclick="acknowledgeAlert('${c.id}')">✓ Acknowledge</button>
        <button class="btn btn-danger btn-sm" onclick="escalateAlert('${c.id}')">⬆ Escalate</button>
        <button class="btn btn-warning btn-sm" onclick="requestInspection('${c.id}')">🔍 Inspect</button>
      </div>` : ""}
      ${c.acknowledged ? `<div class="mt-2" style="font-size:11px;color:var(--green)">✅ Acknowledged</div>` : ""}
    </div>
  `;
}

async function acknowledgeAlert(sensorId) {
  if (window.API && window.API.available) {
    const result = await window.API.acknowledgeSensor(sensorId);
    if (result && result.success) {
      showToast(`Sensor ${result.sensor?.sensorId || sensorId} acknowledged via backend.`, "success");
      return;
    }
  }
  const c = state.coldChain.find(x => x.id === sensorId);
  if (!c) return;
  c.acknowledged = true;
  addAuditEntry("Alert Acknowledged", c.sensorId, c.status + " alert", "Acknowledged", "Quality Team");
  renderColdChainCards();
  updateDashboardKPIs();
  updateNavBadges();
  updateLastUpdated();
  showToast(`Alert on sensor ${c.sensorId} acknowledged.`, "success");
}

async function escalateAlert(sensorId) {
  if (window.API && window.API.available) {
    await window.API.escalateSensor(sensorId);
  }
  const c = state.coldChain.find(x => x.id === sensorId);
  if (!c) return;
  addAuditEntry("Alert Escalated", c.sensorId, c.status, "Escalated to management", "Quality Manager");
  showToast(`Sensor ${c.sensorId} alert escalated to management.`, "warning");
}

function requestInspection(sensorId) {
  const c = state.coldChain.find(x => x.id === sensorId);
  if (!c) return;
  addAuditEntry("Inspection Requested", c.shipmentId, "No inspection", "Inspection requested", "Operations");
  showToast(`Inspection requested for shipment ${c.shipmentId}.`, "warning");
}

/* ── AI BRIEF SECTION ────────────────────────────────────────── */
function renderAIBriefSection() {
  const sec = document.getElementById("sec-ai-brief");
  sec.innerHTML = `
    <div class="section-title">🤖 AI Investigation Brief</div>
    <div class="section-sub">Rule-based intelligent summary of the current supply chain situation</div>
    <div id="ai-brief-container"></div>
  `;
  renderAIBrief();
}

function renderAIBrief() {
  const el = document.getElementById("ai-brief-container");
  if (!el) return;
  const d       = DISRUPTION_SCENARIOS[state.activeDisruption];
  const affected = state.shipments.filter(s => s.delayHours > 0);
  const critical  = state.coldChain.filter(c => c.status === "Critical" && !c.acknowledged);
  const idleCount = state.fleet.filter(f => f.status === "Idle").length;
  const totalDelay= affected.reduce((a, s) => a + s.delayHours, 0);
  const m         = computeMetrics();

  const priority  = m.criticalActions > 0 ? "CRITICAL" : affected.length > 3 ? "HIGH" : affected.length > 0 ? "MEDIUM" : "LOW";
  const priorCl   = priority === "CRITICAL" ? "badge-critical" : priority === "HIGH" ? "badge-danger" : priority === "MEDIUM" ? "badge-warning" : "badge-success";

  // Situation summary
  const situationText = state.activeDisruption === "none"
    ? "No active disruptions detected. All shipments are operating within normal parameters. Continue standard monitoring protocols."
    : `A <strong>${d.severity} ${d.type}</strong> disruption is currently active at <strong>${d.location}</strong>. 
       ${affected.length} of ${state.shipments.length} tracked shipments are affected, generating an estimated 
       ${totalDelay} hours of cumulative delay. ${d.businessImpact}`;

  // Most affected
  const topAffected = affected.sort((a,b) => b.delayHours - a.delayHours).slice(0,3);

  // Cold chain risk
  const ccRisk = critical.length > 0
    ? `⚠️ CRITICAL: ${critical.length} cold-chain sensor(s) report temperatures outside safe ranges. Immediate inspection required for shipments ${[...new Set(critical.map(c => c.shipmentId))].join(", ")}.`
    : state.coldChain.filter(c => c.status === "Warning").length > 0
    ? "⚠️ WARNING: Some sensors showing early out-of-range temperature readings. Monitor closely."
    : "✅ All monitored cold-chain shipments are within acceptable temperature ranges.";

  // Fleet
  const fleetText = idleCount > 0
    ? `${idleCount} vehicle(s) are currently idle and available for redeployment: ${state.fleet.filter(f => f.status === "Idle").map(f => f.id).join(", ")}.`
    : "All fleet assets are actively deployed. No spare capacity currently available.";

  // Next steps
  const steps = [];
  if (affected.length > 0) steps.push("Apply recommended alternative routes for all affected shipments, prioritising Critical cargo.");
  if (critical.length > 0) steps.push("Immediately investigate and resolve critical temperature alerts on cold-chain shipments.");
  if (idleCount > 0)       steps.push("Redeploy idle fleet assets to support affected delivery corridors.");
  if (d && d.affectedCarriers?.length > 0) steps.push("Contact alternative carriers to replace " + d.affectedCarriers.join(", ") + ".");
  steps.push("Update customers on affected shipments with revised ETA estimates.");
  steps.push("Generate executive disruption impact report for management review.");

  el.innerHTML = `
    <div class="ai-brief-card">
      <div class="ai-brief-banner">
        <div class="ai-brief-banner-icon" aria-hidden="true">🤖</div>
        <div class="ai-brief-banner-text">
          <h3>AI Investigation Brief</h3>
          <p>Intelligent situation summary · IBM BOB AI Agent Demo</p>
        </div>
        <span class="ai-badge">AI Agent Demo</span>
        <span class="badge ${priorCl}" style="margin-left:8px;">Priority: ${priority}</span>
      </div>
      <div class="ai-brief-body">
      <div class="ai-disclaimer">
        ℹ️ This is a simulated AI-generated recommendation using rule-based logic and synthetic data. Not a real AI model output.
      </div>

      <div class="brief-section">
        <h4>1. Situation Summary</h4>
        <p>${situationText}</p>
      </div>

      <div class="brief-section">
        <h4>2. Most Affected Shipments</h4>
        ${topAffected.length > 0 ? `<ul>${topAffected.map(s =>
          `<li><strong>${s.id}</strong> – ${s.origin} → ${s.destination} | ${s.cargoType} | <span style="color:var(--red)">+${s.delayHours}h delay</span> | ${s.priority} priority</li>`
        ).join("")}</ul>` : "<p>No shipments are currently delayed.</p>"}
      </div>

      <div class="brief-section">
        <h4>3. Root Cause Analysis</h4>
        <p>${state.activeDisruption === "none"
          ? "No disruption source identified. System operating normally."
          : `Primary cause: <strong>${d.label}</strong> (${d.type}) at ${d.location}. This is a ${d.severity}-severity event expected to last ${d.expectedDuration}. ${d.description}`
        }</p>
      </div>

      <div class="brief-section">
        <h4>4. Delay Prediction</h4>
        <p>${totalDelay > 0
          ? `Total cumulative delay across affected shipments: <strong>${totalDelay} hours</strong>. Average delay per affected shipment: <strong>${Math.round(totalDelay / Math.max(1, affected.length))} hours</strong>. Delay reduction possible by applying recommended routes.`
          : "No delays currently predicted. All shipments on schedule."
        }</p>
      </div>

      <div class="brief-section">
        <h4>5. Cold-Chain Risk Assessment</h4>
        <p>${ccRisk}</p>
      </div>

      <div class="brief-section">
        <h4>6. Fleet Availability</h4>
        <p>${fleetText}</p>
      </div>

      <div class="brief-section">
        <h4>7. Recommended Next Steps</h4>
        <ul>${steps.map(s => `<li>${s}</li>`).join("")}</ul>
      </div>

      <div class="brief-section">
        <h4>8. Business Impact Summary</h4>
        <p>${state.activeDisruption === "none"
          ? "No financial impact detected at this time."
          : `Estimated financial risk: <strong>$${Math.round(m.financialRisk / 1000)}K</strong>. ${d.businessImpact}`
        }</p>
      </div>

      <div class="brief-section">
        <h4>9. Priority Classification</h4>
        <p>Current operational priority: <span class="badge ${priorCl}">${priority}</span>.
        ${m.criticalActions > 0 ? `<strong>${m.criticalActions} critical action(s)</strong> require immediate attention in the Action Centre.` : "All pending actions are within manageable thresholds."}</p>
      </div>
      </div><!-- /.ai-brief-body -->
    </div>
  `;
}

/* ── ACTION CENTRE SECTION ──────────────────────────────────── */
function renderActionCentreSection() {
  const sec = document.getElementById("sec-actions");
  sec.innerHTML = `
    <div class="section-title">✅ Action Centre</div>
    <div class="section-sub">Prioritised tasks requiring immediate attention</div>
    <div class="table-toolbar" style="border-radius:var(--radius-lg);margin-bottom:14px;background:var(--surface);">
      <select id="action-filter-priority" onchange="setActionFilter()" aria-label="Filter actions by priority">
        <option value="all">All Priorities</option>
        <option value="Critical">Critical</option>
        <option value="High">High</option>
        <option value="Medium">Medium</option>
        <option value="Low">Low</option>
      </select>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);cursor:pointer;">
        <input type="checkbox" id="show-completed" onchange="toggleCompleted()" style="width:auto;border-radius:3px;" aria-label="Show completed actions">
        Show Completed
      </label>
    </div>
    <div id="action-list-container"></div>
  `;
  renderActionList();
}

function setActionFilter() {
  state.actionFilter = document.getElementById("action-filter-priority")?.value || "all";
  renderActionList();
}

function toggleCompleted() {
  state.showCompleted = document.getElementById("show-completed")?.checked || false;
  renderActionList();
}

function renderActionList() {
  const el = document.getElementById("action-list-container");
  if (!el) return;

  let actions = state.actions;
  if (state.actionFilter !== "all") actions = actions.filter(a => a.priority === state.actionFilter);
  if (!state.showCompleted)         actions = actions.filter(a => a.status !== "Completed");

  const prioOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  actions = [...actions].sort((a, b) => (prioOrder[a.priority] || 0) - (prioOrder[b.priority] || 0));

  if (actions.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="es-icon">✅</div>No actions in this view</div>`;
    return;
  }

  el.innerHTML = `<div class="action-list">${actions.map(buildActionItem).join("")}</div>`;
}

function buildActionItem(a) {
  const prioCls = { Critical: "p-critical", High: "p-high", Medium: "p-medium", Low: "p-low" }[a.priority] || "";
  const pBadge  = { Critical: "badge-critical", High: "badge-danger", Medium: "badge-warning", Low: "badge-low" }[a.priority] || "badge-low";
  const done    = a.status === "Completed";
  const snoozed = a.snoozed;

  return `
    <div class="action-item ${done ? "completed" : ""} ${snoozed ? "snoozed" : ""}">
      <div class="ai-priority ${prioCls}"></div>
      <div class="ai-body">
        <div class="ai-meta">
          <span class="ai-id">${a.id}</span>
          <span class="badge ${pBadge}">${a.priority}</span>
          <span class="badge badge-info">${a.type}</span>
          <span class="badge badge-low">${a.related}</span>
          ${done    ? `<span class="badge badge-success">Completed ✓</span>` : ""}
          ${snoozed ? `<span class="badge badge-low">Snoozed 💤</span>` : ""}
        </div>
        <div class="ai-reason">${a.reason}</div>
        <div class="flex gap-2 text-xs text-muted mt-2 flex-wrap">
          <span>👥 ${a.team}</span>
          <span>⏰ Due: ${a.deadline}</span>
        </div>
        ${!done ? `
        <div class="ai-footer">
          <button class="btn btn-success btn-sm" onclick="completeAction('${a.id}')">✓ Complete</button>
          ${!snoozed ? `<button class="btn btn-ghost btn-sm" onclick="snoozeAction('${a.id}')">💤 Snooze</button>` : ""}
        </div>` : ""}
      </div>
    </div>
  `;
}

async function completeAction(id) {
  if (window.API && window.API.available) {
    await window.API.completeAction(id);
    showToast(`Action ${id} completed via backend.`, "success");
    return;
  }
  const a = state.actions.find(x => x.id === id);
  if (!a) return;
  a.status = "Completed";
  addAuditEntry("Action Completed", a.id, "Pending", "Completed", a.team);
  renderActionList();
  updateDashboardKPIs();
  updateNavBadges();
  updateLastUpdated();
  showToast(`Action ${a.id} marked as completed.`, "success");
}

async function snoozeAction(id) {
  if (window.API && window.API.available) {
    await window.API.snoozeAction(id);
    showToast(`Action ${id} snoozed via backend.`, "warning");
    return;
  }
  const a = state.actions.find(x => x.id === id);
  if (!a) return;
  a.snoozed = true;
  addAuditEntry("Action Snoozed", a.id, "Active", "Snoozed", a.team);
  renderActionList();
  updateNavBadges();
  showToast(`Action ${a.id} snoozed.`, "warning");
}

/* ── AUDIT LOG SECTION ──────────────────────────────────────── */
function renderAuditLogSection() {
  const sec = document.getElementById("sec-audit");
  sec.innerHTML = `
    <div class="section-title">📋 Audit Log</div>
    <div class="section-sub">Full activity trail of all system and operator actions</div>
    <div id="audit-list-container"></div>
  `;
  renderAuditList();
}

function renderAuditList() {
  const el = document.getElementById("audit-list-container");
  if (!el) return;
  const logs = [...state.auditLog].reverse();
  el.innerHTML = `<div class="audit-list">${logs.map(buildAuditItemHTML).join("")}</div>`;
}

function buildAuditItemHTML(l) {
  // Pick an icon by action keyword
  const actionIcons = {
    "Disruption": "⚡", "Route": "🗺️", "Asset": "🚛", "Alert": "❄️",
    "Carrier": "🚢", "Action": "✅", "Fleet": "🚛", "Dashboard": "📊",
    "Sensor": "🌡️", "Inspection": "🔍", "Completed": "✓", "Snoozed": "💤"
  };
  const icon = Object.entries(actionIcons).find(([k]) => l.action.includes(k))?.[1] || "📋";
  return `
    <div class="audit-item">
      <div class="al-icon" aria-hidden="true">${icon}</div>
      <div class="al-content">
        <div class="al-ts">${l.timestamp}</div>
        <div><span class="al-act">${l.action}</span><span class="al-entity">${l.entity}</span></div>
        <span class="al-change">${l.prev} → ${l.next}</span>
      </div>
      <span class="al-user">${l.user}</span>
    </div>
  `;
}

function addAuditEntry(action, entity, prev, next, user) {
  const ts = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "medium" });
  state.auditLog.push({
    id:        "LOG-" + String(state.auditLog.length + 1).padStart(3, "0"),
    timestamp: ts,
    action, entity, prev, next,
    user: user || "Operator"
  });
  renderAuditList();
  renderDashboardRecentLog();
}

/* ── BADGE HELPERS ───────────────────────────────────────────── */
function priorityBadge(p) {
  const map = { Critical: "badge-critical", High: "badge-danger", Medium: "badge-warning", Low: "badge-low" };
  return `<span class="badge ${map[p] || "badge-low"}">${p}</span>`;
}

function riskBadge(r) {
  const map = { High: "badge-critical", Medium: "badge-warning", Low: "badge-success" };
  return `<span class="badge ${map[r] || "badge-low"}">${r}</span>`;
}

function statusBadge(s) {
  const map = {
    "On Time":  "badge-success",
    "Delayed":  "badge-warning",
    "At Risk":  "badge-danger",
    "Rerouting":"badge-info",
    "Delivered":"badge-normal",
  };
  return `<span class="badge ${map[s] || "badge-low"}">${s}</span>`;
}

/* ── NAV BADGES ──────────────────────────────────────────────── */
function updateNavBadges() {
  // Rerender nav with badge counts
  const coldAlerts    = state.coldChain.filter(c => c.status !== "Normal" && !c.acknowledged).length;
  const pendingActions = state.actions.filter(a => a.status === "Pending" && !a.snoozed && a.priority === "Critical").length;

  const navColdchain = document.getElementById("nav-coldchain");
  const navActions   = document.getElementById("nav-actions");
  const navDisrupt   = document.getElementById("nav-disruptions");

  if (navColdchain) {
    let badge = navColdchain.querySelector(".nav-badge");
    if (!badge) { badge = document.createElement("span"); badge.className = "nav-badge"; navColdchain.appendChild(badge); }
    badge.textContent = coldAlerts;
    badge.style.display = coldAlerts > 0 ? "" : "none";
  }
  if (navActions) {
    let badge = navActions.querySelector(".nav-badge");
    if (!badge) { badge = document.createElement("span"); badge.className = "nav-badge"; navActions.appendChild(badge); }
    badge.textContent = pendingActions;
    badge.style.display = pendingActions > 0 ? "" : "none";
  }
  if (navDisrupt) {
    let badge = navDisrupt.querySelector(".nav-badge");
    if (!badge) { badge = document.createElement("span"); badge.className = "nav-badge"; navDisrupt.appendChild(badge); }
    const hasDisrupt = state.activeDisruption !== "none" ? "1" : "";
    badge.textContent = hasDisrupt;
    badge.style.display = hasDisrupt ? "" : "none";
  }
}

/* ── MODAL ────────────────────────────────────────────────────── */
function showModal(title, bodyHTML) {
  const overlay = document.getElementById("modal-overlay");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHTML;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  document.getElementById("modal-close-btn").focus();
}

function closeModal() {
  const overlay = document.getElementById("modal-overlay");
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}

/* ── TOAST ────────────────────────────────────────────────────── */
function showToast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = "toast " + type;
  const icon = type === "success" ? "✅" : type === "warning" ? "⚠️" : type === "error" ? "❌" : "ℹ️";
  toast.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; toast.style.transition = "opacity .3s"; setTimeout(() => toast.remove(), 320); }, 3500);
}

/* ── KEYBOARD: close modal on Escape ─────────────────────────── */
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeModal();
});

// ============================================================
// AI CHAT WIDGET
// Rule-based conversational assistant with live state awareness
// ============================================================

/* ── Chat state ─────────────────────────────────────────────── */
const chatState = {
  open: false,
  history: [],          // { role: "bot"|"user", text, html, time }
  unread: 0,
  typing: false,
};

/* ── Bootstrap on DOMContentLoaded ─────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("chat-bubble").addEventListener("click", toggleChat);
  document.getElementById("chat-close").addEventListener("click", closeChat);
  document.getElementById("chat-clear").addEventListener("click", clearChat);

  // Show welcome message after a short delay
  setTimeout(() => {
    chatBotSay(
      `👋 Hi! I'm your <strong>Supply Chain AI assistant</strong>.<br>` +
      `I can answer questions about shipments, disruptions, fleet, cold-chain, ` +
      `actions, and financial risk — all using live data from this dashboard.<br><br>` +
      `<em style="color:var(--text-dim);font-size:11px;">⚠️ This is a simulated AI using rule-based logic and synthetic data.</em>`,
      true
    );
    // show unread badge if chat is closed
    if (!chatState.open) showChatUnread(1);
  }, 1200);
});

/* ── Open / close ───────────────────────────────────────────── */
function toggleChat() {
  chatState.open ? closeChat() : openChat();
}

function openChat() {
  chatState.open = true;
  document.getElementById("chat-panel").classList.add("open");
  document.getElementById("chat-panel").setAttribute("aria-hidden", "false");
  document.getElementById("chat-bubble").setAttribute("aria-expanded", "true");
  document.getElementById("chat-bubble-icon").textContent = "✕";
  showChatUnread(0);
  chatScrollBottom();
  setTimeout(() => document.getElementById("chat-input").focus(), 120);
}

function closeChat() {
  chatState.open = false;
  document.getElementById("chat-panel").classList.remove("open");
  document.getElementById("chat-panel").setAttribute("aria-hidden", "true");
  document.getElementById("chat-bubble").setAttribute("aria-expanded", "false");
  document.getElementById("chat-bubble-icon").textContent = "🤖";
}

function clearChat() {
  chatState.history = [];
  document.getElementById("chat-messages").innerHTML = "";
}

function showChatUnread(n) {
  chatState.unread = n;
  const el = document.getElementById("chat-unread");
  if (!el) return;
  el.textContent = n > 0 ? n : "";
  el.style.display = n > 0 ? "flex" : "none";
}

/* ── Send a message ─────────────────────────────────────────── */
function chatSend(presetText) {
  const inputEl = document.getElementById("chat-input");
  const raw = (presetText || inputEl.value || "").trim();
  if (!raw) return;

  // Add user message
  chatAddMessage("user", raw);
  if (inputEl) inputEl.value = "";

  // Show typing indicator then reply
  chatShowTyping();
  const delay = 420 + Math.random() * 480;   // feels natural
  setTimeout(() => {
    chatHideTyping();
    const { html, plain } = chatEngine(raw);
    chatBotSay(html);
  }, delay);
}

/* ── Render a bot message ───────────────────────────────────── */
function chatBotSay(html, isWelcome = false) {
  chatAddMessage("bot", null, html);
  if (!chatState.open && !isWelcome) showChatUnread(chatState.unread + 1);
}

/* ── Add message to DOM + state ─────────────────────────────── */
function chatAddMessage(role, text, html) {
  const now  = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const entry = { role, text: text || "", html: html || escapeHtml(text || ""), time: now };
  chatState.history.push(entry);

  const msgEl = document.createElement("div");
  msgEl.className = "chat-msg " + role;

  const avatar = role === "bot" ? "🤖" : "👤";
  msgEl.innerHTML = `
    <div class="msg-avatar" aria-hidden="true">${avatar}</div>
    <div>
      <div class="msg-bubble">${entry.html}</div>
      <div class="msg-time">${now}</div>
    </div>
  `;

  document.getElementById("chat-messages").appendChild(msgEl);
  chatScrollBottom();
}

/* ── Typing indicator ───────────────────────────────────────── */
function chatShowTyping() {
  if (chatState.typing) return;
  chatState.typing = true;
  const el = document.createElement("div");
  el.className = "chat-msg bot typing-indicator";
  el.id = "chat-typing";
  el.innerHTML = `
    <div class="msg-avatar" aria-hidden="true">🤖</div>
    <div class="msg-bubble">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>
  `;
  document.getElementById("chat-messages").appendChild(el);
  chatScrollBottom();
}

function chatHideTyping() {
  chatState.typing = false;
  const el = document.getElementById("chat-typing");
  if (el) el.remove();
}

function chatScrollBottom() {
  const box = document.getElementById("chat-messages");
  if (box) box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ============================================================
// RULE-BASED CHAT ENGINE
// Matches user intent → pulls from live state → builds response
// ============================================================

function chatEngine(input) {
  const q = input.toLowerCase();

  // ── Greeting ────────────────────────────────────────────────
  if (/^(hi|hello|hey|good\s*(morning|afternoon|evening)|sup|yo)/.test(q)) {
    return reply(`👋 Hello! I am your <strong>AI Supply Chain Assistant</strong> connected to live fleet and shipment data.<br><br>
      Ask me questions like:<br>
      • <em>"Which shipments are at risk?"</em><br>
      • <em>"Which shipments are delayed?"</em><br>
      • <em>"Which trucks are idle?"</em><br>
      • <em>"What shipments are affected by the port strike?"</em><br>
      • <em>"Which cold-chain shipment has a temperature breach?"</em><br>
      • <em>"How can we reduce today's delays?"</em><br>
      • <em>"What is the best rerouting option?"</em>`);
  }

  // ── Help ─────────────────────────────────────────────────────
  if (/help|what can you|commands|capabilities/.test(q)) {
    return reply(`🤖 <strong>Live Data Operational Queries I Can Answer:</strong><br><br>
      • ⚠️ <em>Which shipments are at risk?</em><br>
      • ⏱️ <em>Which shipments are delayed?</em><br>
      • 🚛 <em>Which trucks are idle / underutilised?</em><br>
      • ⚓ <em>What shipments are affected by the port strike?</em><br>
      • ❄️ <em>Which cold-chain shipment has a temperature breach?</em><br>
      • 📉 <em>How can we reduce today's delays?</em><br>
      • 🗺️ <em>What is the best rerouting option?</em><br>
      • ⚡ <em>Run fleet utilisation optimizer</em>`);
  }

  // ── Port Strike Specific ──────────────────────────────────────
  if (/port strike|dockworker|los angeles|long beach|strike/.test(q)) {
    return chatAnswerPortStrike();
  }

  // ── At Risk Shipments ─────────────────────────────────────────
  if (/at.?risk|high risk|critical risk|jeopardy/.test(q)) {
    return chatAnswerAtRisk();
  }

  // ── Delayed Shipments ─────────────────────────────────────────
  if (/delayed|delay|behind schedule|late/.test(q)) {
    return chatAnswerDelayedShipments();
  }

  // ── Idle Trucks / Fleet ──────────────────────────────────────
  if (/idle|idle truck|unused truck|underutilised|redeploy/.test(q)) {
    return chatAnswerIdleTrucks();
  }

  // ── Cold Chain / Temp Breach ──────────────────────────────────
  if (/cold.?chain|temperature|temp breach|breach|sensor|critical temp/.test(q)) {
    return chatAnswerColdChainBreach();
  }

  // ── Reduce Delays / Delay Reduction Strategy ─────────────────
  if (/reduce.*delay|cut delay|speed up|fix delay|mitigate/.test(q)) {
    return chatAnswerReduceDelays();
  }

  // ── Best Rerouting Option ─────────────────────────────────────
  if (/best rerout|best route|recommended route|detour option/.test(q)) {
    return chatAnswerBestRerouting();
  }

  // ── Fleet general ────────────────────────────────────────────
  if (/fleet|truck|vehicle|asset|utilis/.test(q)) {
    return chatAnswerFleet();
  }

  // ── Disruption general ───────────────────────────────────────
  if (/disruption|storm|closure|geopolit|heat/.test(q)) {
    return chatAnswerDisruption();
  }

  // ── Specific shipment lookup ─────────────────────────────────
  const shipMatch = q.match(/shp-?(\d{3})/);
  if (shipMatch) {
    return chatAnswerShipment("SHP-" + shipMatch[1]);
  }

  // ── Actions ──────────────────────────────────────────────────
  if (/action|task|todo|next step|recommend|pending/.test(q)) {
    return chatAnswerActions();
  }

  // ── Routes general ───────────────────────────────────────────
  if (/route|reroute|path|way/.test(q)) {
    return chatAnswerRoutes();
  }

  // ── Financial ────────────────────────────────────────────────
  if (/financ|cost|money|value|revenue|loss|exposure/.test(q)) {
    return chatAnswerFinancial();
  }

  // ── Summary ──────────────────────────────────────────────────
  if (/summary|overview|dashboard|status report/.test(q)) {
    return chatAnswerSummary();
  }

  // ── Fallback ─────────────────────────────────────────────────
  return reply(
    `🤔 Ask me any operational query using live database data:<br><br>
     • <em>"Which shipments are at risk?"</em><br>
     • <em>"Which trucks are idle?"</em><br>
     • <em>"Which cold-chain shipment has a temperature breach?"</em><br>
     • <em>"How can we reduce today's delays?"</em>`
  );
}

/* ── STRUCTURED AI RESPONSE HELPER ───────────────────────────── */

function formatStructuredAIResponse(title, reasoningHTML, actionHTML, impactHTML) {
  return reply(`
    <div style="font-weight:700;font-size:14px;margin-bottom:8px;">${title}</div>
    <div class="ai-reasoning-card">
      <div class="ai-section-block">
        <div class="ai-section-title reasoning">🧠 Reasoning & Data Analysis</div>
        <div class="ai-section-text">${reasoningHTML}</div>
      </div>
      <div class="ai-section-block" style="margin-top:10px;">
        <div class="ai-section-title action">🎯 Recommended Action</div>
        <div class="ai-section-text">${actionHTML}</div>
      </div>
      <div class="ai-section-block" style="margin-top:10px;">
        <div class="ai-section-title impact">📈 Expected Impact</div>
        <div class="ai-section-text">${impactHTML}</div>
      </div>
    </div>
  `);
}

/* ── OPERATIONAL INTENT HANDLERS WITH EMPIRICAL DATA ─────────── */

function chatAnswerAtRisk() {
  const atRisk = state.shipments.filter(s => s.status === "At Risk" || s.riskLevel === "High");
  const activeD = DISRUPTION_SCENARIOS[state.activeDisruption] || DISRUPTION_SCENARIOS["none"];

  if (atRisk.length === 0) {
    return formatStructuredAIResponse(
      "✅ At-Risk Shipments Analysis",
      `No shipments are currently classified as 'At Risk' or 'High Risk'. All <strong>${state.shipments.length}</strong> active shipments are progressing within acceptable variance thresholds.`,
      "Maintain standard control tower monitoring. Ensure IoT temperature sensors remain active for cold-chain consignments.",
      "Zero high-risk exposure. Operational risk score remains low (0/100)."
    );
  }

  const listHTML = atRisk.map(s => `• <strong>${s.id}</strong> (${s.cargoType}): ${s.origin} → ${s.destination} [Delay: +${s.delayHours}h, Status: ${s.status}]`).join("<br>");

  return formatStructuredAIResponse(
    `⚠️ ${atRisk.length} Shipment(s) Currently At Risk`,
    `Database analysis indicates <strong>${atRisk.length}</strong> shipment(s) are severely impacted by the active disruption (<strong>${activeD.label}</strong>):<br><br>${listHTML}<br><br>Cargo carrying values for these consignments total <strong>$${(atRisk.length * 420).toLocaleString()},000</strong>.`,
    `Immediately execute alternative route assignments for <strong>${atRisk.map(s=>s.id).join(", ")}</strong> via the Route Optimisation Engine to bypass the affected disruption corridor.`,
    `Reduces delay exposure by up to <strong>18–24 hours</strong> per shipment and protects <strong>$${(atRisk.length * 420).toLocaleString()},000</strong> in revenue at risk.`
  );
}

function chatAnswerDelayedShipments() {
  const delayed = state.shipments.filter(s => s.delayHours > 0).sort((a,b) => b.delayHours - a.delayHours);
  const totalDelayHours = delayed.reduce((acc, s) => acc + s.delayHours, 0);

  if (delayed.length === 0) {
    return formatStructuredAIResponse(
      "✅ Delayed Shipments Analysis",
      "Live database query returns <strong>0 delayed shipments</strong>. All active shipments are operating on schedule.",
      "No corrective action needed.",
      "100% on-time delivery metric maintained."
    );
  }

  const listHTML = delayed.map(s => `• <strong>${s.id}</strong> (${s.cargoType}): +${s.delayHours}h delay [Carrier: ${s.carrier}]`).join("<br>");

  return formatStructuredAIResponse(
    `⏱️ ${delayed.length} Shipment(s) Delayed (${totalDelayHours}h Total Delay)`,
    `Live database scan identifies <strong>${delayed.length}</strong> delayed shipments with a cumulative delay of <strong>${totalDelayHours} hours</strong>:<br><br>${listHTML}`,
    `1. Apply recommended highway bypass routes in the Route Optimisation section.<br>2. Reassign idle refrigerated/dry assets to expedite delayed legs.<br>3. Send proactive delay notifications to end customers for consignments with >6h delay.`,
    `Eliminates <strong>${Math.round(totalDelayHours * 0.7)} hours</strong> of delay today and restores on-time delivery status for ${Math.ceil(delayed.length * 0.8)} shipments.`
  );
}

function chatAnswerIdleTrucks() {
  const idle = FLEET_OPTIMIZER.getIdleVehicles();
  const totalPenalty = idle.reduce((a, v) => a + v.idleCostUsd, 0);

  if (idle.length === 0) {
    return formatStructuredAIResponse(
      "✅ Fleet Utilization Status",
      "All fleet assets are currently deployed or in active transit. Zero idle vehicles detected.",
      "Continue monitoring active transit legs.",
      "100% fleet deployment efficiency."
    );
  }

  const listHTML = idle.map(v => `• <strong>${v.id}</strong> (${v.type}): Located at <strong>${v.location}</strong> [Idle: ${v.idleDays} days, Daily Penalty: $${v.idleCostUsd}]`).join("<br>");

  return formatStructuredAIResponse(
    `🔵 ${idle.length} Idle Vehicles Detected ($${totalPenalty.toLocaleString()}/day Penalty)`,
    `Live fleet database query finds <strong>${idle.length}</strong> idle assets currently incurring depreciation and insurance penalties:<br><br>${listHTML}`,
    `Run the <strong>Fleet Utilisation Optimizer</strong> to match idle assets (e.g. <strong>${idle[0].id}</strong>) with unassigned/delayed shipments requiring local capacity support.`,
    `Increases fleet utilisation from <strong>39% to 76%</strong> (+37% boost) and saves <strong>$${totalPenalty.toLocaleString()}/day</strong> in idle holding costs.`
  );
}

function chatAnswerPortStrike() {
  const affected = state.shipments.filter(s => 
    s.origin.includes("Los Angeles") || s.destination.includes("Los Angeles") || 
    s.origin.includes("Long Beach") || s.destination.includes("Long Beach") ||
    s.carrier.includes("Pacific")
  );

  return formatStructuredAIResponse(
    "⚓ Port Strike Disruption Impact Analysis",
    `Dockworker labor strike at Port of Los Angeles / Long Beach impacts <strong>${affected.length}</strong> active shipments (${affected.map(s=>s.id).join(", ") || "SHP-002, SHP-005, SHP-008"}). Primary ocean carrier <em>PacificShip Lines</em> is halted at berth.`,
    `1. Divert incoming container vessels to Port of Oakland or Port of San Diego.<br>2. Switch affected dry cargo to overland rail carrier <strong>RapidRoute USA</strong>.<br>3. Issue port strike delay advisory to retail customers.`,
    `Prevents <strong>5–10 days</strong> of container unloading backlog and reduces financial risk exposure by <strong>$1.8M</strong>.`
  );
}

function chatAnswerColdChainBreach() {
  const critical = state.coldChain.filter(c => c.status === "Critical");
  const warning = state.coldChain.filter(c => c.status === "Warning");

  if (critical.length === 0 && warning.length === 0) {
    return formatStructuredAIResponse(
      "✅ Cold-Chain Sensor Status",
      "All 10 IoT temperature sensors report values within normal operational thresholds.",
      "Maintain continuous IoT telemetry monitoring.",
      "Zero spoilage risk for temperature-controlled cargo."
    );
  }

  const listHTML = critical.map(c => `• <strong>${c.sensorId}</strong> on <strong>${c.shipmentId}</strong>: Current Temp <strong>${c.temp}°C</strong> (Allowed: ${c.minTemp}°C to ${c.maxTemp}°C) [Door: ${c.doorStatus}]`).join("<br>");

  return formatStructuredAIResponse(
    `❄️ ${critical.length} Critical Cold-Chain Temperature Breach(es) Detected`,
    `Real-time IoT telemetry query detected <strong>${critical.length}</strong> critical temperature breach(es):<br><br>${listHTML}`,
    `1. Inspect truck door closure immediately for <strong>${critical.map(c=>c.shipmentId).join(", ")}</strong>.<br>2. Dispatch emergency reefer van <strong>VH-104</strong> (Phoenix) or <strong>VH-101</strong> (Dallas) to transfer cargo.<br>3. Acknowledge and escalate alert in Cold-Chain Monitor.`,
    `Prevents total product spoilage valued at <strong>$705,000</strong> (Pharmaceutical & Perishable shipments).`
  );
}

function chatAnswerReduceDelays() {
  const delayed = state.shipments.filter(s => s.delayHours > 0);
  const totalDelayHours = delayed.reduce((acc, s) => acc + s.delayHours, 0);

  return formatStructuredAIResponse(
    "📉 Operational Action Plan to Reduce Today's Delays",
    `Cumulative delay across all shipments stands at <strong>${totalDelayHours} hours</strong>, primarily driven by Gulf storm blockades and I-80 highway bridge closures.`,
    `Execute the following 3-step action plan:<br>` +
    `1. <strong>Apply Recommended Reroutes</strong>: Shift ${delayed.slice(0,2).map(s=>s.id).join(", ")} to bypass routes (saves ~18h delay).<br>` +
    `2. <strong>Redeploy Idle Assets</strong>: Assign idle truck <strong>VH-104</strong> and <strong>VH-102</strong> to congested legs (saves ~8h delay).<br>` +
    `3. <strong>Clear Action Items</strong>: Complete the top critical items in the Action Centre.`,
    `Reduces total fleet delay by <strong>65%</strong> (saving ~${Math.round(totalDelayHours * 0.65)} hours today) and recovers on-time SLA compliance.`
  );
}

function chatAnswerBestRerouting() {
  const targetId = state.selectedShipmentId || "SHP-001";
  const routes = ROUTE_ENGINE.getRouteEvaluation(targetId);
  const rec = routes.find(r => r.type === "recommended") || routes[0];

  return formatStructuredAIResponse(
    `🗺️ Best Rerouting Option for Shipment ${targetId}`,
    `Multi-criteria evaluation comparing 3 route alternatives for <strong>${targetId}</strong> across Distance, Travel Time, Disruption Risk, Cost, Vehicle Availability, and Delivery Deadline.<br><br>` +
    `Selected Route: <strong>${rec.name}</strong> (Composite Score: <strong>${rec.score}/10</strong> vs Baseline: 2/10).`,
    `Click <strong>"✅ Apply Recommended Route"</strong> in the Route Optimisation section to apply <strong>${rec.name}</strong>.`,
    `Saves <strong>${rec.delayReduction || "18h"}</strong> of delay, arrives <strong>4 hours before deadline</strong>, with only <strong>${rec.cost || "+$180"}</strong> in cost overhead.`
  );
}

function chatAnswerSummary() {
  const m = computeMetrics();
  const d = DISRUPTION_SCENARIOS[state.activeDisruption];
  return reply(`
    📊 <strong>Current Dashboard Overview</strong><br><br>
    ${infoRow("Total Shipments",    m.totalShipments)}
    ${infoRow("Active Disruptions", m.activeDisruptions > 0 ? `⚡ ${d.label}` : "✅ None")}
    ${infoRow("Affected Shipments", m.affectedShips > 0 ? `⚠️ ${m.affectedShips}` : "✅ 0")}
    ${infoRow("High Priority",      m.highPriority)}
    ${infoRow("Fleet Utilisation",  m.avgUtil + "%")}
    ${infoRow("Idle Assets",        m.idleFleet > 0 ? `🔵 ${m.idleFleet}` : "0")}
    ${infoRow("Cold-Chain Alerts",  m.coldAlerts > 0 ? `❄️ ${m.coldAlerts} unacknowledged` : "✅ 0")}
    ${infoRow("Total Delay",        m.totalDelay > 0 ? `⏱️ ${m.totalDelay}h` : "0h")}
    ${infoRow("Financial Risk",     "$" + Math.round(m.financialRisk / 1000) + "K")}
    ${infoRow("Critical Actions",   m.criticalActions > 0 ? `🔴 ${m.criticalActions}` : "✅ 0")}
  `);
}

function chatAnswerDisruption() {
  const id = state.activeDisruption;
  const d  = DISRUPTION_SCENARIOS[id];
  if (id === "none" || !d) {
    return reply(`✅ <strong>No active disruption.</strong> All routes and carriers are operating normally. Continue standard monitoring.`);
  }
  const affected = state.shipments.filter(s => s.delayHours > 0);
  return reply(`
    ⚡ <strong>Active Disruption: ${d.label}</strong><br><br>
    ${infoRow("Type",             d.type)}
    ${infoRow("Location",         d.location)}
    ${infoRow("Severity",         d.severity)}
    ${infoRow("Started",          d.startTime)}
    ${infoRow("Expected Duration",d.expectedDuration)}
    ${infoRow("Affected Routes",  d.affectedRoutes.join(", ") || "None")}
    ${infoRow("Affected Carriers",d.affectedCarriers.join(", ") || "None")}
    ${infoRow("Shipments at Risk",affected.length + " of " + state.shipments.length)}
    ${infoRow("Cold-Chain Risk",  d.coldChainRisk ? "⚠️ Yes" : "✅ No")}<br>
    <em style="font-size:11px;color:var(--amber)">💼 ${d.businessImpact}</em>
  `);
}

function chatAnswerShipment(id) {
  const s = state.shipments.find(x => x.id === id);
  if (!s) {
    return reply(`❌ Shipment <strong>${id}</strong> not found. Valid IDs are SHP-001 through SHP-012.`);
  }
  const src = SHIPMENTS_DATA.find(x => x.id === id) || s;
  return reply(`
    📦 <strong>Shipment ${s.id}</strong><br><br>
    ${infoRow("Route",       s.origin + " → " + s.destination)}
    ${infoRow("Cargo",       s.cargoType + (s.coldChain ? " ❄️" : ""))}
    ${infoRow("Carrier",     s.carrier)}
    ${infoRow("Status",      s.status)}
    ${infoRow("ETA",         s.eta)}
    ${infoRow("Delay",       s.delayHours > 0 ? "⚠️ +" + s.delayHours + "h" : "✅ None")}
    ${infoRow("Priority",    s.priority)}
    ${infoRow("Risk Level",  s.riskLevel)}
    ${infoRow("Temp Req.",   s.tempRequired)}
    ${infoRow("Cargo Value", src.value || "—")}<br>
    <em style="font-size:11px;color:var(--blue)">💡 ${s.recommendedAction}</em>
  `);
}

function chatAnswerFleet() {
  const total   = state.fleet.length;
  const idle    = state.fleet.filter(f => f.status === "Idle");
  const transit = state.fleet.filter(f => f.status === "In Transit");
  const avail   = state.fleet.filter(f => f.status === "Available");
  const reserved= state.fleet.filter(f => f.status === "Reserved");
  const avgUtil = Math.round(state.fleet.reduce((a, f) => a + (f.utilisation || 0), 0) / total);

  return reply(`
    🚛 <strong>Fleet Status Summary</strong><br><br>
    ${infoRow("Total Assets",  total)}
    ${infoRow("In Transit",    transit.length)}
    ${infoRow("Idle Assets",   idle.length > 0 ? `🔵 ${idle.length}` : "0")}
    ${infoRow("Available",     avail.length)}
    ${infoRow("Reserved",      reserved.length)}
    ${infoRow("Avg Utilisation", avgUtil + "%")}<br>
    <em style="font-size:11px;color:var(--blue)">Ask "Which trucks are idle?" or go to Fleet Utilisation to run optimization.</em>
  `);
}

function chatAnswerFinancial() {
  const m = computeMetrics();
  const highRisk = state.shipments.filter(s => s.riskLevel === "High");

  return reply(`
    💰 <strong>Financial Risk Assessment</strong><br><br>
    ${infoRow("Shipments at High Risk", highRisk.length)}
    ${infoRow("Total Estimated Exposure", "<strong style='color:#ef4444'>$" + Math.round(m.financialRisk / 1000) + "K</strong>")}
    ${infoRow("Risk Basis", "12% of cargo value per affected shipment")}<br>
    <em style="font-size:11px;color:var(--text-dim)">Applying recommended routes reduces financial exposure by reducing delay likelihood.</em>
  `);
}

function chatAnswerActions() {
  const pending  = state.actions.filter(a => a.status === "Pending" && !a.snoozed);
  const critical = pending.filter(a => a.priority === "Critical");
  const high     = pending.filter(a => a.priority === "High");

  return reply(`
    ✅ <strong>Pending Actions Summary</strong><br><br>
    ${infoRow("Total Pending",  pending.length)}
    ${infoRow("Critical",       critical.length > 0 ? "🔴 " + critical.length : "0")}
    ${infoRow("High",           high.length    > 0 ? "🟡 " + high.length    : "0")}<br>
    <em style="font-size:11px;color:var(--blue)">Go to Action Centre to complete or snooze tasks.</em>
  `);
}

function chatAnswerRoutes() {
  const id = state.selectedShipmentId || "SHP-001";
  const routes = ROUTE_ENGINE.getRouteEvaluation(id);
  const rec    = routes.find(r => r.type === "recommended") || routes[0];

  return reply(`
    🗺️ <strong>Route Recommendation for ${id}</strong><br><br>
    ${rec ? `
      ✅ <strong>Recommended Route: ${rec.name}</strong><br><br>
      ${infoRow("Distance",       rec.distance)}
      ${infoRow("Travel Time",    rec.travelTime || rec.time)}
      ${infoRow("Cost",           rec.cost || rec.addCost)}
      ${infoRow("Delay Saved",    rec.delayReduction)}
      ${infoRow("Risk Score",     rec.disruptionRisk || rec.risk + "/5")}
      ${infoRow("Route Score",    rec.score + "/10")}
    ` : "No recommended route found."}<br>
    <em style="font-size:11px;color:var(--blue)">Go to Route Optimisation to apply this route.</em>
  `);
}

function chatAnswerCarriers() {
  const best = [...CARRIERS_DATA].sort((a, b) => b.reliability - a.reliability);
  const rows = best.map(c => `<tr><td><strong>${c.name}</strong></td><td>${c.reliability}%</td><td>${c.cost}</td><td>${c.coldChain ? "✅" : "❌"}</td></tr>`).join("");
  return reply(`
    🚢 <strong>Available Alternative Carriers</strong><br><br>
    <table class="chat-table">
      <thead><tr><th>Carrier</th><th>Reliability</th><th>Cost</th><th>Cold ❄️</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `);
}

/* ── Formatting helpers ─────────────────────────────────────── */
function reply(html) {
  return { html, plain: html.replace(/<[^>]+>/g, "") };
}

function infoRow(label, val) {
  return `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12px;">
    <span style="color:var(--text-muted)">${label}</span>
    <span style="color:var(--text);font-weight:600;text-align:right;max-width:55%">${val}</span>
  </div>`;
}

/* ============================================================
   ALERT & NOTIFICATION SYSTEM ENGINE
   ============================================================ */

/**
 * Evaluates operational state dynamically across 7 breach categories
 * and generates real-time alerts.
 */
function evaluateRealtimeAlerts() {
  if (!state.alerts) state.alerts = [];

  // 1. Critical Temperature Breaches
  state.coldChain.forEach(c => {
    if (c.status === "Critical" || c.temp > c.maxTemp || c.temp < c.minTemp) {
      addRealtimeAlert({
        type: "temperature_breach",
        category: "Critical Temperature Breach",
        priority: "critical",
        title: `Cold-Chain Excursion: Sensor ${c.sensorId} (${c.shipmentId})`,
        message: `Temperature sensor reading ${c.temp}°C outside allowed range (${c.minTemp}°C to ${c.maxTemp}°C). Door: ${c.doorStatus || 'Closed'}.`,
        shipmentId: c.shipmentId,
        assetId: null,
        key: `temp_${c.sensorId}_${c.status}`
      });
    }
  });

  // 2. Shipment Delays (>2h)
  state.shipments.forEach(s => {
    if (s.status === "Delayed" && s.delayHours >= 2) {
      addRealtimeAlert({
        type: "shipment_delay",
        category: "Shipment Delay",
        priority: "warning",
        title: `Transit Delay: Shipment ${s.id} (+${s.delayHours}h)`,
        message: `Shipment ${s.id} (${s.origin} → ${s.destination}) delayed by ${s.delayHours} hours. Carrier: ${s.carrier || 'Unassigned'}.`,
        shipmentId: s.id,
        assetId: null,
        key: `delay_${s.id}`
      });
    }
  });

  // 3. Disruption Events
  if (state.activeDisruption && state.activeDisruption !== "none") {
    const sc = DISRUPTION_SCENARIOS[state.activeDisruption];
    if (sc) {
      addRealtimeAlert({
        type: "disruption_event",
        category: "Disruption Event",
        priority: sc.severityLevel >= 3 ? "critical" : "warning",
        title: `Active Disruption: ${sc.label} (${sc.type})`,
        message: `${sc.description} Location: ${sc.location}. Expected duration: ${sc.expectedDuration}.`,
        shipmentId: sc.affectedShipmentIds?.[0] || null,
        assetId: null,
        disruptionId: sc.id,
        key: `disruption_${sc.id}`
      });
    }
  }

  // 4. Missed ETA (delay >= 5h)
  state.shipments.forEach(s => {
    if (s.delayHours >= 5) {
      addRealtimeAlert({
        type: "missed_eta",
        category: "Missed ETA",
        priority: "warning",
        title: `Missed ETA SLA Breach Risk: ${s.id}`,
        message: `Shipment ${s.id} ETA is delayed by ${s.delayHours} hours, exceeding scheduled customer delivery window.`,
        shipmentId: s.id,
        assetId: null,
        key: `missed_eta_${s.id}`
      });
    }
  });

  // 5. Idle Vehicles (idle >= 2 days or idle status)
  state.fleet.forEach(f => {
    if (f.status === "Idle" || (f.idleDays && f.idleDays >= 2)) {
      addRealtimeAlert({
        type: "idle_vehicle",
        category: "Idle Vehicle",
        priority: "warning",
        title: `Underutilised Asset: ${f.id} (${f.type}) Idle`,
        message: `Asset ${f.id} stationed at ${f.location} idle for ${f.idleDays || 1} days. Holding penalty: $280/day.`,
        shipmentId: null,
        assetId: f.id,
        key: `idle_${f.id}`
      });
    }
  });

  // 6. Capacity Shortages (utilisation >= 85%)
  state.fleet.forEach(f => {
    if (f.utilisation >= 85 || (f.loadKg && f.capacityKg && (f.loadKg / f.capacityKg >= 0.85))) {
      addRealtimeAlert({
        type: "capacity_shortage",
        category: "Capacity Shortage",
        priority: "warning",
        title: `High Capacity Utilisation: ${f.id} (${f.utilisation}%)`,
        message: `Asset ${f.id} current load ${f.currentLoad || f.loadKg + 'kg'} nearing maximum rating (${f.capacity}).`,
        shipmentId: f.nearestAffected || null,
        assetId: f.id,
        key: `capacity_${f.id}`
      });
    }
  });

  // 7. High-Risk Cargo
  state.shipments.forEach(s => {
    if (s.riskLevel === "High" || s.cargoType === "Hazardous Materials" || s.tempSensitive) {
      if (s.status === "At Risk" || s.status === "Delayed") {
        addRealtimeAlert({
          type: "high_risk_cargo",
          category: "High-Risk Cargo",
          priority: "critical",
          title: `High-Risk Cargo Vulnerability: ${s.id}`,
          message: `Sensitive consignment ${s.id} (${s.cargoType}) is currently ${s.status.toLowerCase()} with high loss exposure.`,
          shipmentId: s.id,
          assetId: null,
          key: `high_risk_${s.id}`
        });
      }
    }
  });

  updateNotifBadge();
}

/**
 * Deduplicating alert creation helper.
 */
function addRealtimeAlert(data) {
  const existing = state.alerts.find(a =>
    a.type === data.type &&
    a.shipmentId === data.shipmentId &&
    a.assetId === data.assetId &&
    a.status === "open"
  );
  if (existing) return;

  const newAlert = {
    id: "ALT-" + String(state.alerts.length + 1).padStart(3, "0"),
    type: data.type,
    category: data.category,
    priority: data.priority,
    title: data.title,
    message: data.message,
    shipmentId: data.shipmentId || null,
    assetId: data.assetId || null,
    disruptionId: data.disruptionId || null,
    triggeredAt: new Date().toISOString().replace("T", " ").substring(0, 16) + " UTC",
    status: "open",
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null
  };

  state.alerts.unshift(newAlert);
  if (!SIM.paused && (data.priority === "critical" || data.priority === "warning")) {
    showToast(`🔔 Alert: ${data.title}`, data.priority === "critical" ? "error" : "warning");
  }
}

/**
 * User Acknowledge Action Handler
 */
async function acknowledgeAlert(alertId) {
  const alert = state.alerts.find(a => a.id === alertId);
  if (!alert || alert.status !== "open") return;

  alert.status = "acknowledged";
  alert.acknowledgedAt = new Date().toISOString().replace("T", " ").substring(0, 16) + " UTC";
  alert.acknowledgedBy = "Dispatcher User";

  if (window.API && window.API.available) {
    try { await window.API.acknowledgeAlert(alertId); } catch(e){ console.warn(e); }
  }

  addAuditEntry("Alert Acknowledged", alertId, "Status: Open", "Status: Acknowledged", "Dispatcher User");
  showToast(`Alert ${alertId} acknowledged.`, "info");
  updateNotifBadge();
  renderAlertsList();
  renderNotifDrawerContent();
}

/**
 * User Resolve Action Handler
 */
async function resolveAlert(alertId) {
  const alert = state.alerts.find(a => a.id === alertId);
  if (!alert || alert.status === "resolved") return;

  alert.status = "resolved";
  alert.resolvedAt = new Date().toISOString().replace("T", " ").substring(0, 16) + " UTC";
  alert.resolvedBy = "Dispatcher User";

  if (window.API && window.API.available) {
    try { await window.API.resolveAlert(alertId); } catch(e){ console.warn(e); }
  }

  addAuditEntry("Alert Resolved", alertId, alert.status, "Status: Resolved", "Dispatcher User");
  showToast(`Alert ${alertId} resolved cleanly.`, "success");
  updateNotifBadge();
  renderAlertsList();
  renderNotifDrawerContent();
}

/**
 * Updates notification bell counter badge & nav badge
 */
function updateNotifBadge() {
  const openAlerts = state.alerts.filter(a => a.status === "open");
  const count = openAlerts.length;
  const badge = document.getElementById("notif-badge");
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? "inline-block" : "none";
  }

  const navBadge = document.getElementById("badge-alerts");
  if (navBadge) {
    navBadge.textContent = count > 0 ? count : "";
    navBadge.style.display = count > 0 ? "inline-block" : "none";
  }
}

/**
 * Toggles Header Notification Drawer Dropdown
 */
function toggleNotifDrawer() {
  const drawer = document.getElementById("notif-drawer");
  if (!drawer) return;

  const isHidden = drawer.getAttribute("aria-hidden") === "true";
  if (isHidden) {
    renderNotifDrawerContent();
    drawer.setAttribute("aria-hidden", "false");
  } else {
    drawer.setAttribute("aria-hidden", "true");
  }
}

/**
 * Renders Notification Drawer Content
 */
function renderNotifDrawerContent() {
  const drawer = document.getElementById("notif-drawer");
  if (!drawer) return;

  const activeAlerts = state.alerts.filter(a => a.status !== "resolved").slice(0, 6);

  drawer.innerHTML = `
    <div class="notif-drawer-header">
      <span class="notif-drawer-title">🔔 Operational Notifications (${activeAlerts.length})</span>
      <button onclick="document.getElementById('notif-drawer').setAttribute('aria-hidden','true')" style="background:none;border:none;color:var(--text-dim);cursor:pointer;">✕</button>
    </div>
    <ul class="notif-drawer-list">
      ${activeAlerts.length === 0 ? `
        <li style="padding:16px;text-align:center;color:var(--text-dim);font-size:13px;">
          ✅ All operational alerts acknowledged & resolved.
        </li>
      ` : activeAlerts.map(a => `
        <li class="notif-drawer-item ${a.priority}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="sev-badge sev-${a.priority}">${a.priority}</span>
            <span style="font-size:11px;color:var(--text-dim);">${a.triggeredAt.split(" ")[1]}</span>
          </div>
          <strong style="font-size:13px;color:var(--text);margin-top:2px;">${a.title}</strong>
          <span style="font-size:12px;color:var(--text-dim);">${a.message.substring(0, 95)}…</span>
          <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end;">
            ${a.status === 'open' ? `
              <button class="btn-ack" onclick="acknowledgeAlert('${a.id}')">⚡ Acknowledge</button>
            ` : `<span class="status-pill acknowledged">Acknowledged</span>`}
            <button class="btn-resolve" onclick="resolveAlert('${a.id}')">✅ Resolve</button>
          </div>
        </li>
      `).join("")}
    </ul>
    <div class="notif-drawer-footer">
      <button onclick="document.getElementById('notif-drawer').setAttribute('aria-hidden','true');showSection('alerts')">View Alert Control Tower →</button>
    </div>
  `;
}

/**
 * Builds Alert & Notification Section Structure (#sec-alerts)
 */
function renderAlertSection() {
  const sec = document.getElementById("sec-alerts");
  if (!sec) return;

  sec.innerHTML = `
    <div class="section-header">
      <div>
        <h2>🔔 Alert & Notification Control Tower</h2>
        <p class="section-desc">Real-time operational breaches across temperature, delays, disruptions, missed ETAs, idle fleet, capacity, and high-risk cargo.</p>
      </div>
      <button class="btn-primary" onclick="evaluateRealtimeAlerts();renderAlertsList();showToast('Alert engine re-evaluated operational data.','info')">⚡ Re-evaluate Engine</button>
    </div>

    <!-- Alert KPI Summary Banner -->
    <div class="kpi-grid" id="alerts-kpi-banner" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 18px;"></div>

    <!-- Filters & Search Toolbar -->
    <div class="alerts-toolbar">
      <div class="alerts-filter-group">
        <label for="alert-filter-severity">Severity:</label>
        <select id="alert-filter-severity" onchange="state.alertFilter.priority=this.value;renderAlertsList();">
          <option value="all">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>

        <label for="alert-filter-status">Status:</label>
        <select id="alert-filter-status" onchange="state.alertFilter.status=this.value;renderAlertsList();">
          <option value="all">All Statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>

        <label for="alert-filter-type">Category:</label>
        <select id="alert-filter-type" onchange="state.alertFilter.type=this.value;renderAlertsList();">
          <option value="all">All 7 Categories</option>
          <option value="temperature_breach">Critical Temperature Breach</option>
          <option value="shipment_delay">Shipment Delay</option>
          <option value="disruption_event">Disruption Event</option>
          <option value="missed_eta">Missed ETA</option>
          <option value="idle_vehicle">Idle Vehicle</option>
          <option value="capacity_shortage">Capacity Shortage</option>
          <option value="high_risk_cargo">High-Risk Cargo</option>
        </select>
      </div>

      <div class="alerts-filter-group">
        <input type="text" id="alert-search" placeholder="Search alerts by shipment, asset, or title…" oninput="state.alertFilter.search=this.value.toLowerCase();renderAlertsList();" style="width:260px;" />
      </div>
    </div>

    <!-- Alert List Grid Container -->
    <div id="alerts-container" class="alert-card-grid"></div>
  `;

  renderAlertsList();
}

/**
 * Renders the filtered Alert Cards Grid and updates KPI summary banner
 */
function renderAlertsList() {
  const container = document.getElementById("alerts-container");
  const kpiBanner = document.getElementById("alerts-kpi-banner");
  if (!container) return;

  const allAlerts = state.alerts || [];

  // Update KPI Metrics
  const total = allAlerts.length;
  const critical = allAlerts.filter(a => a.priority === "critical" && a.status !== "resolved").length;
  const warning = allAlerts.filter(a => a.priority === "warning" && a.status !== "resolved").length;
  const openCount = allAlerts.filter(a => a.status === "open").length;
  const resolvedCount = allAlerts.filter(a => a.status === "resolved").length;

  if (kpiBanner) {
    kpiBanner.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Total System Alerts</div>
        <div class="kpi-val">${total}</div>
        <div class="kpi-sub">Across 7 breach types</div>
      </div>
      <div class="kpi-card" style="border-left:4px solid var(--red,#da1e28)">
        <div class="kpi-label">Active Critical Breaches</div>
        <div class="kpi-val" style="color:var(--red,#da1e28)">${critical}</div>
        <div class="kpi-sub">Immediate action needed</div>
      </div>
      <div class="kpi-card" style="border-left:4px solid var(--yellow,#f1c21b)">
        <div class="kpi-label">Active Warnings</div>
        <div class="kpi-val" style="color:var(--yellow,#f1c21b)">${warning}</div>
        <div class="kpi-sub">SLA & capacity alerts</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Open / Unactioned</div>
        <div class="kpi-val">${openCount}</div>
        <div class="kpi-sub">Pending acknowledgement</div>
      </div>
      <div class="kpi-card" style="border-left:4px solid var(--green,#24a148)">
        <div class="kpi-label">Resolved Breaches</div>
        <div class="kpi-val" style="color:var(--green,#24a148)">${resolvedCount}</div>
        <div class="kpi-sub">Archived resolution</div>
      </div>
    `;
  }

  // Filter Alerts
  const { priority, status, type, search } = state.alertFilter || {};
  const filtered = allAlerts.filter(a => {
    if (priority && priority !== "all" && a.priority !== priority) return false;
    if (status && status !== "all" && a.status !== status) return false;
    if (type && type !== "all" && a.type !== type) return false;
    if (search) {
      const target = `${a.id} ${a.title} ${a.message} ${a.shipmentId || ''} ${a.assetId || ''}`.toLowerCase();
      if (!target.includes(search)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; background: var(--surface); border: 1px solid var(--border); padding: 40px; text-align: center; border-radius: var(--radius-md);">
        <h3>No Alerts Found</h3>
        <p style="color: var(--text-dim); margin-top: 6px;">No operational alerts match the selected criteria (${priority !== 'all' ? priority : 'all severities'}, ${status !== 'all' ? status : 'all statuses'}).</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(a => `
    <div class="alert-card ${a.priority}">
      <div>
        <div class="alert-card-header">
          <span class="sev-badge sev-${a.priority}">${a.priority}</span>
          <span class="status-pill ${a.status}">${a.status}</span>
        </div>
        <div class="alert-card-title">${a.title}</div>
        <div class="alert-card-msg">${a.message}</div>
      </div>

      <div>
        <div class="alert-card-meta">
          <span>🆔 ${a.id}</span>
          ${a.shipmentId ? `<span style="color:var(--blue);cursor:pointer" onclick="state.selectedShipmentId='${a.shipmentId}';showSection('shipments')">📦 ${a.shipmentId}</span>` : ''}
          ${a.assetId ? `<span style="color:var(--purple);cursor:pointer" onclick="showSection('fleet')">🚛 ${a.assetId}</span>` : ''}
          <span>⏱️ ${a.triggeredAt}</span>
          ${a.acknowledgedBy ? `<span title="${a.acknowledgedAt}">👤 Ack: ${a.acknowledgedBy}</span>` : ''}
          ${a.resolvedBy ? `<span title="${a.resolvedAt}">✅ Res: ${a.resolvedBy}</span>` : ''}
        </div>

        <div class="alert-card-actions">
          ${a.status === 'open' ? `
            <button class="btn-ack" onclick="acknowledgeAlert('${a.id}')">⚡ Acknowledge</button>
          ` : ''}
          ${a.status !== 'resolved' ? `
            <button class="btn-resolve" onclick="resolveAlert('${a.id}')">✅ Resolve</button>
          ` : '<span style="font-size:12px;color:var(--green);font-weight:600;">✓ Resolved</span>'}
        </div>
      </div>
    </div>
  `).join("");
}


