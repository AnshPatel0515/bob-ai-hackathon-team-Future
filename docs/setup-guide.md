# Setup Guide

> **This file is read by the automated evaluation pipeline. Be precise and complete.**

## Prerequisites

Before you begin, ensure you have the following installed or available:

* [ ] Node.js 18+
* [ ] npm 9+
* [ ] PostgreSQL 14+
* [ ] Git
* [ ] An IBM Cloud account with access to the required IBM AI services
* [ ] API credentials for any external services used by the application, such as weather, traffic, or port data APIs

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Example environment variables:

```env
PORT=5000
DATABASE_URL=postgresql://username:password@localhost:5432/supply_chain

IBM_API_KEY=your_ibm_api_key
IBM_PROJECT_ID=your_ibm_project_id

WEATHER_API_KEY=your_weather_api_key
TRAFFIC_API_KEY=your_traffic_api_key

CLIENT_URL=http://localhost:3000
```

> Do not commit `.env` to Git. Keep API keys, database credentials, and other secrets private.

## Installation

Clone the repository and install the dependencies:

```bash
git clone <your-repository-url>
cd <your-repository-name>
```

Install backend dependencies:

```bash
cd backend
npm install
```

Install frontend dependencies:

```bash
cd ../frontend
npm install
```

## Database Setup

Create a PostgreSQL database for the application.

Example:

```sql
CREATE DATABASE supply_chain;
```

Configure the database connection using the `DATABASE_URL` environment variable.

Run the project's database migrations or initialization script, if provided:

```bash
npm run migrate
```

## Running the Application

Start the backend:

```bash
cd backend
npm run dev
```

Start the frontend in a separate terminal:

```bash
cd frontend
npm start
```

The frontend and backend should now be available through their configured local development URLs.

## Verification

After starting the application:

1. Open the frontend dashboard in a browser.
2. Verify that the dashboard loads successfully.
3. Add or view transportation and shipment information.
4. Verify that data is being stored and retrieved from PostgreSQL.
5. Test the AI disruption analysis and risk prediction features.
6. Verify that alerts and recommendations appear on the dashboard.
7. Verify that real-time updates are received through Socket.IO.


| Variable | Description | Required |
|---|---|---|
| `WATSONX_API_KEY` | Your IBM watsonx.ai API key | Yes |
| `WATSONX_PROJECT_ID` | Your watsonx.ai project ID | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `SLACK_WEBHOOK_URL` | Slack webhook for alerts | No |

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/AnshPatel0515/bob-ai-hackathon-team-Future.git
cd [bob-ai-hackathon-team-Future]

# 2. Install backend dependencies
[your command — e.g.: pip install -r requirements.txt]

# 3. Install frontend dependencies (if applicable)
[your command — e.g.: cd frontend && npm install]

# 4. Set up the database (if applicable)
[your command — e.g.: python manage.py migrate]
```

## Running the Application

```bash
# Start the backend
[your command — e.g.: uvicorn app.main:app --reload]

# Start the frontend (in a separate terminal, if applicable)
[your command — e.g.: cd frontend && npm run dev]
```

The application will be available at: `http://localhost:[PORT]`

## Running Tests

```bash
[your test command — e.g.: pytest tests/ -v]
```

## Quick Demo (Optional)

If you have a demo script or sample data to showcase the project quickly:

```bash
[e.g.: python demo/seed_demo_data.py]
[e.g.: open http://localhost:8000/demo]
```

## Troubleshooting

| Issue | Solution |
|---|---|
| [e.g., `ModuleNotFoundError`] | [e.g., Run `pip install -r requirements.txt` again] |
| [e.g., Database connection refused] | [e.g., Ensure PostgreSQL is running: `docker compose up db`] |
| [e.g., watsonx.ai 401 error] | [e.g., Check `WATSONX_API_KEY` in your `.env` file] |
