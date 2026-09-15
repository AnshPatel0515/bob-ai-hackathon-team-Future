'use strict';
require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const compression  = require('compression');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

const authRouter            = require('./routes/auth');
const shipmentsRouter       = require('./routes/shipments');
const trackingRouter        = require('./routes/tracking');
const fleetRouter           = require('./routes/fleet');
const sensorsRouter         = require('./routes/sensors');
const disruptionsRouter     = require('./routes/disruptions');
const alertsRouter          = require('./routes/alerts');
const recommendationsRouter = require('./routes/recommendations');
const realtimeRouter        = require('./routes/realtime');
const coldChainRouter       = require('./routes/coldChain');
const fleetOptimizerRouter  = require('./routes/fleetOptimizer');

const { errorHandler, notFound } = require('./middleware/errorHandler');

const app = express();

// ── Security & transport ──────────────────────────────────────────────────────
app.use(helmet());
app.use(compression());

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── Request logging ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX        || '200',   10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10),
  message: { error: 'Too many authentication attempts, please try again in 15 minutes' },
});

app.use('/api', globalLimiter);
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',            authRouter);
app.use('/api/shipments',       shipmentsRouter);
app.use('/api/tracking',        trackingRouter);
app.use('/api/fleet',           fleetRouter);
app.use('/api/sensors',         sensorsRouter);
app.use('/api/disruptions',     disruptionsRouter);
app.use('/api/alerts',          alertsRouter);
app.use('/api/recommendations', recommendationsRouter);
app.use('/api/realtime',        realtimeRouter);
app.use('/api/cold-chain',      coldChainRouter);
app.use('/api/fleet-optimizer', fleetOptimizerRouter);

// ── Error handling ────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
