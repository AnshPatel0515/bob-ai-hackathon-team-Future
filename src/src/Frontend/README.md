# Supply Chain Disruption Assistant & Fleet Utilisation Optimizer

> **Simulated Logistics Environment** — All data is synthetic and fictional.
> No real GPS, weather, traffic, IoT, or carrier APIs are connected.

---

## Overview

A full-stack, real-time supply chain management dashboard that simulates
disruptions, shipment movement, cold-chain monitoring, fleet redeployment,
and AI-driven investigation briefs — all powered by a Node.js backend with
Server-Sent Events (SSE) for live frontend updates.

---

## Architecture

```
project root/
├── index.html          Frontend entry point
├── style.css           All UI styles (CSS variables, responsive)
├── script.js           Frontend logic, rendering, simulation engine
├── api-client.js       Frontend ↔ Backend SSE + REST integration
├── data.js             Static seed data (used in standalone mode)
├── README.md           This file
│
└── backend/
    ├── package.json
    └── src/
        ├── server.js               Express entry point
        ├── data/
        │   ├── seedData.js         Immutable synthetic data
        │   └── store.js            In-memory live state database
        ├── engine/
        │   ├── simulation.js       Master tick orchestrator + SSE broadcast
        │   ├── movementEngine.js   Moves shipments along route polylines
        │   ├── disruptionEngine.js Triggers/resolves disruptions, recalculates risk
        │   ├── coldChainEngine.js  Drifts sensor temperatures, generates alerts
        │   ├── fleetEngine.js      Fleet utilisation, fuel, breakdowns, redeployment
        │   └── briefEngine.js      Rule-based AI investigation brief generator
        └── routes/
            ├── api.js              REST API routes
            └── sse.js              Server-Sent Events endpoint
```

---

## Prerequisites

- **Node.js** ≥ 18.0.0 — https://nodejs.org/
- **npm** ≥ 9.0.0 (bundled with Node.js)
- A modern browser (Chrome, Firefox, Edge, Safari)

---

## Setup & Run

### Option A — Full Backend (Recommended)

```bash
# 1. Install backend dependencies
cd backend
npm install

# 2. Start the server
npm start
# or for auto-reload during development:
npm run dev

# 3. Open the app
# Visit http://localhost:3000 in your browser
```

The server:
- Serves `index.html` and all frontend files from the project root
- Exposes REST API at `http://localhost:3000/api/`
- Streams live updates via SSE at `http://localhost:3000/api/events`
- Auto-starts the simulation on boot

### Option B — Standalone (No Node.js)

Open `index.html` directly in a browser.
The frontend detects no backend is available and runs its own
built-in simulation engine (pure JavaScript, no network required).

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server health, sim status |
| GET | `/api/state` | Full state snapshot |
| GET | `/api/metrics` | Dashboard KPI metrics |
| GET | `/api/shipments` | All shipments |
| GET | `/api/shipments/:id` | Single shipment + alt routes |
| POST | `/api/shipments/:id/reroute` | Apply recommended route |
| GET | `/api/disruptions` | Active disruptions |
| POST | `/api/disruptions/trigger` | Trigger disruption `{ templateKey }` |
| DELETE | `/api/disruptions/:id` | Resolve a disruption |
| DELETE | `/api/disruptions` | Clear all disruptions |
| GET | `/api/fleet` | All fleet assets |
| GET | `/api/fleet/redeployment` | Redeployment recommendations |
| POST | `/api/fleet/:id/redeploy` | Redeploy vehicle `{ targetShipmentId }` |
| GET | `/api/sensors` | Cold-chain sensor readings |
| POST | `/api/sensors/:id/acknowledge` | Acknowledge alert |
| POST | `/api/sensors/:id/escalate` | Escalate alert |
| GET | `/api/carriers` | Available carriers |
| GET | `/api/actions` | Action centre items |
| PATCH | `/api/actions/:id/complete` | Mark action complete |
| PATCH | `/api/actions/:id/snooze` | Snooze action |
| GET | `/api/audit` | Activity audit log |
| GET | `/api/brief` | AI investigation brief |
| POST | `/api/sim/start` | Start simulation |
| POST | `/api/sim/pause` | Pause simulation |
| POST | `/api/sim/resume` | Resume simulation |
| POST | `/api/sim/stop` | Stop simulation |
| POST | `/api/sim/reset` | Reset all data + restart |
| GET | `/api/sim/status` | Sim running/paused/time |
| GET | `/api/events` | **SSE stream** — live updates |

### SSE Event Types

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | `{ message, clients, simTimeISO }` | Initial handshake |
| `state` | Full state snapshot | Sent every 10 s tick |
| `disruption` | `{ event, type, id? }` | Disruption activated/resolved |
| `coldchain_alert` | Array of critical sensors | Cold-chain breach detected |
| `sim_control` | `{ action }` | start/pause/resume/stop/reset |

---

## Disruption Templates

Trigger via `POST /api/disruptions/trigger` with one of these `templateKey` values:

| Key | Type | Severity |
|-----|------|----------|
| `severe_storm` | Weather | Critical |
| `port_strike` | Labour | High |
| `highway_closure` | Infrastructure | Medium |
| `vehicle_breakdown` | Operational | High |
| `geopolitical` | Regulatory | High |
| `extreme_heat` | Weather | High |

---

## How the Simulation Works

1. **10-second real-time tick** — each tick advances simulated time by 20 minutes
2. **Movement engine** — shipments move along geo-polylines (lat/lng waypoints)
3. **Disruption engine** — auto-cycles through scenarios every ~3 minutes; also manually triggerable
4. **Cold-chain engine** — temperatures drift ±0.3°C/tick; disrupted cargo drifts faster; door-open events accelerate drift
5. **Fleet engine** — fuel drains, breakdowns occur randomly (0.3% chance/tick), recovery 2% chance/tick
6. **Risk scoring** — each shipment gets a 0–10 risk score based on delay, disruption severity, and priority
7. **Brief engine** — generates structured situation report from live state on every API call
8. **SSE broadcast** — every tick pushes full state to all connected browser clients
9. **No duplicate timers** — single `setInterval` with idempotent start/stop guards

---

## Demo Walkthrough

### 1. Start with a clear state
```
Open http://localhost:3000 → Dashboard shows all shipments on time
```

### 2. Trigger a storm disruption
```bash
curl -X POST http://localhost:3000/api/disruptions/trigger \
  -H "Content-Type: application/json" \
  -d '{"templateKey":"severe_storm"}'
```
→ Dashboard KPIs update, affected shipments go "At Risk", cold-chain alerts appear

### 3. Watch automatic updates
- Every 10 seconds the dashboard, shipment table, and charts refresh
- Cold-chain sensor temperatures drift; Critical alerts auto-generate
- Fleet fuel levels drop; low-fuel actions are auto-created

### 4. Apply a recommended route
- Click any affected shipment → Route Optimisation section
- Click **"Apply Recommended Route"** → status changes to "Rerouting"

### 5. Redeploy a fleet asset
- Go to Fleet Utilisation → Idle Asset Redeployment
- Click **"Redeploy Asset"** → vehicle becomes "Reserved"

### 6. Acknowledge cold-chain alert
- Go to Cold-Chain Monitor
- Click **"✓ Acknowledge"** on any Critical sensor

### 7. Use simulation controls (header)
- **■ Stop** — stops backend simulation engine
- **⏸ Pause** — pauses ticks without stopping timer
- **▶ Resume** — resumes paused simulation
- **Reset** button in header — resets all data to seed state

### 8. Auto-disruption cycling
- Every ~3 minutes the backend auto-rotates through all disruption scenarios
- Each rotation triggers/resolves disruptions and broadcasts alerts

---

## Data & Limitations

| Item | Count |
|------|-------|
| Shipments | 12 |
| Fleet vehicles | 8 |
| Cold-chain sensors | 10 |
| Disruption templates | 6 |
| Carrier options | 5 |
| Route waypoint sets | 12 |

### What is NOT real
- GPS positions are interpolated along synthetic polylines
- Weather data is fully synthetic
- Temperature readings are computed via random drift equations
- Carrier names and company names are fictional
- Dollar values are illustrative only
- No real port, traffic, or customs APIs are connected

---

## Future Improvements

- PostgreSQL/MongoDB persistence for multi-session state
- Real-time mapping with Leaflet.js / Mapbox
- Integration with OpenWeatherMap for live weather triggers
- OAuth2 authentication and user roles
- Push notifications (Web Push API)
- Historical trend analytics and export to CSV/PDF
- Real carrier API integrations (FedEx, UPS, DHL)
- Machine-learning delay prediction model

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML5, CSS3, Vanilla JavaScript, Chart.js 4.4 |
| Backend  | Node.js 18+, Express 4.18 |
| Transport| Server-Sent Events (SSE) |
| State    | In-memory (no external DB required) |
| Data     | Synthetic / rule-based simulation |

---

*Simulated Logistics Environment — for demonstration purposes only.*
