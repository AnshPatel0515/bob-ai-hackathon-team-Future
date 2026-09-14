# Source Code

This folder contains the complete source code for the Supply Chain Disruption Assistant & Fleet Utilisation Optimizer.

## Structure Guidelines
src/
│
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py
│   │   ├── database.py
│   │   ├── models.py
│   │   ├── schemas.py
│   │   ├── crud.py
│   │   └── risk_engine.py
│   │
│   └── requirements.txt
│
└── frontend/
    └── README.md
Backend

The backend is built using Python and FastAPI. It provides REST APIs for shipment management, fleet management, disruption tracking, and cold-chain temperature monitoring.

Frontend

The frontend will contain the user dashboard for viewing shipment risks, fleet utilisation, disruptions, alerts, and AI-generated recommendations.

Important Files
main.py — FastAPI application and API endpoints
database.py — PostgreSQL database connection
models.py — Database models
schemas.py — API data validation
crud.py — Database operations
risk_engine.py — Shipment and temperature risk calculations
requirements.txt — Python dependencies
Security

Environment variables and secrets are stored outside the source code in .env. The .env file must never be committed to GitHub.

### Web Application

```text
src/
├── backend/        ← FastAPI API server, database, risk engine
├── frontend/       ← Web dashboard for shipments, fleet and alerts
└── shared/         ← Shared utilities and common configuration
```

### Backend

The backend handles shipment management, fleet management, disruption monitoring, temperature alerts, risk scoring, and database operations.

### Frontend

The frontend provides a dashboard to visualize shipment risks, fleet utilisation, disruptions, alerts, and AI recommendations.

### Shared

The shared folder contains reusable utilities, constants, and data structures used by both the backend and frontend.

### CLI / Script-based Tool

src/
├── backend/        ← FastAPI API server
├── frontend/       ← Web dashboard
└── shared/         ← Shared utilities
src/
└── backend/
    ├── app/
    │   ├── main.py
    │   ├── database.py
    │   ├── models.py
    │   ├── schemas.py
    │   ├── crud.py
    │   └── risk_engine.py
    │
    └── requirements.txt
    
## Important Files to Include

* `src/backend/requirements.txt` — Python dependencies required to run the FastAPI backend.
* `.env.example` — Template for environment variables such as the PostgreSQL database connection and IBM watsonx.ai configuration. The actual `.env` file must never be committed.
* `src/backend/app/database.py` — PostgreSQL database connection and SQLAlchemy configuration.
* `src/backend/app/models.py` — Database models for shipments, fleet vehicles, disruptions, and temperature readings.
* `src/backend/app/schemas.py` — API request and response validation schemas.
* `src/backend/app/crud.py` — Database operations for creating and retrieving application data.
* `src/backend/app/risk_engine.py` — Shipment and cold-chain risk calculation logic.
* `src/backend/app/main.py` — FastAPI application and REST API endpoints.
* `.gitignore` — Prevents secrets, virtual environments, build files, and unnecessary files from being committed.

## What NOT to Include in `src/`

* `.env` files containing real passwords, API keys, database credentials, or other secrets.
* Large binary files such as videos, datasets, or other media files. Store them externally or use Git LFS when appropriate.
* `node_modules/` — frontend dependencies should not be committed.
* `venv/` or `.venv/` — Python virtual environments should not be committed.
* `__pycache__/` and compiled Python files.
* Build artifacts such as `dist/` and `build/`.
* Log files, temporary files, and local development data.
