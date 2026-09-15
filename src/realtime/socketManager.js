'use strict';
/**
 * SocketManager
 * =============
 * Owns the Socket.IO server instance and all room/namespace logic.
 *
 * Room design
 * ───────────
 *  company:<company_id>          – all users in a company (dashboard feed)
 *  shipment:<shipment_id>        – detail view subscribers
 *  asset:<asset_id>              – per-vehicle tracking page
 *  role:admin                    – system-level events (all companies)
 *
 * Auth handshake
 * ──────────────
 *  Client sends JWT as either:
 *    socket.auth = { token: '...' }
 *    query param  ?token=...
 *  Server verifies and attaches socket.data.user before allowing connection.
 */

const { Server }   = require('socket.io');
const jwt          = require('jsonwebtoken');
const { query }    = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

/** @type {import('socket.io').Server|null} */
let io = null;

// ── Initialise ────────────────────────────────────────────────────────────────

/**
 * Attach Socket.IO to an existing http.Server.
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
function init(httpServer) {
  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim());

  io = new Server(httpServer, {
    cors: {
      origin:      allowedOrigins,
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    // Tune for high-frequency GPS pings
    pingTimeout:   20000,
    pingInterval:  25000,
    transports:    ['websocket', 'polling'],
  });

  // ── JWT Authentication middleware ──────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.query?.token;

      if (!token) return next(new Error('AUTH_REQUIRED'));

      let payload;
      try {
        payload = jwt.verify(token, JWT_SECRET);
      } catch {
        return next(new Error('AUTH_INVALID'));
      }

      const { rows } = await query(
        'SELECT id, email, role, company_id, full_name FROM users WHERE id = $1 AND is_active = TRUE',
        [payload.sub]
      );
      if (!rows.length) return next(new Error('AUTH_INACTIVE'));

      socket.data.user = rows[0];
      next();
    } catch (err) {
      next(new Error('AUTH_ERROR'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const user = socket.data.user;
    console.log(`[WS] Connected: ${user.email} (${user.role}) | socket ${socket.id}`);

    // Always join company room + role room
    socket.join(`company:${user.company_id}`);
    socket.join(`role:${user.role}`);

    // ── Client-driven room subscriptions ──────────────────────────────────
    socket.on('subscribe:shipment', (shipmentId) => {
      if (typeof shipmentId === 'string' && shipmentId.length <= 40) {
        socket.join(`shipment:${shipmentId}`);
        console.log(`[WS] ${user.email} → room shipment:${shipmentId}`);
      }
    });

    socket.on('unsubscribe:shipment', (shipmentId) => {
      socket.leave(`shipment:${shipmentId}`);
    });

    socket.on('subscribe:asset', (assetId) => {
      if (typeof assetId === 'string' && assetId.length <= 40) {
        socket.join(`asset:${assetId}`);
        console.log(`[WS] ${user.email} → room asset:${assetId}`);
      }
    });

    socket.on('unsubscribe:asset', (assetId) => {
      socket.leave(`asset:${assetId}`);
    });

    // ── Ping / keep-alive ──────────────────────────────────────────────────
    socket.on('ping', () => socket.emit('pong', { ts: Date.now() }));

    socket.on('disconnect', (reason) => {
      console.log(`[WS] Disconnected: ${user.email} | ${reason}`);
    });
  });

  console.log('[WS] Socket.IO initialised');
  return io;
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

/** Emit to every socket in a company. */
function toCompany(companyId, event, data) {
  if (!io) return;
  io.to(`company:${companyId}`).emit(event, data);
}

/** Emit to subscribers of a single shipment detail view. */
function toShipment(shipmentId, event, data) {
  if (!io) return;
  io.to(`shipment:${shipmentId}`).emit(event, data);
}

/** Emit to subscribers of a specific asset/vehicle. */
function toAsset(assetId, event, data) {
  if (!io) return;
  io.to(`asset:${assetId}`).emit(event, data);
}

/** Emit to all admin sockets across all companies. */
function toAdmins(event, data) {
  if (!io) return;
  io.to('role:admin').emit(event, data);
}

/** Emit to both a company room and any specific shipment subscribers. */
function broadcastTrackingUpdate(companyId, shipmentId, assetId, payload) {
  if (!io) return;
  const event = 'tracking:update';
  toCompany(companyId, event, payload);
  if (shipmentId) toShipment(shipmentId, event, payload);
  if (assetId)    toAsset(assetId, event, payload);
}

function broadcastETAUpdate(companyId, shipmentId, payload) {
  if (!io) return;
  toCompany(companyId, 'eta:updated', payload);
  if (shipmentId) toShipment(shipmentId, 'eta:updated', payload);
}

function broadcastAlert(companyId, shipmentId, payload) {
  if (!io) return;
  toCompany(companyId, 'alert:new', payload);
  if (shipmentId) toShipment(shipmentId, 'alert:new', payload);
}

function broadcastDelayDetected(companyId, shipmentId, assetId, payload) {
  if (!io) return;
  toCompany(companyId, 'delay:detected', payload);
  if (shipmentId) toShipment(shipmentId, 'delay:detected', payload);
  if (assetId)    toAsset(assetId,    'delay:detected', payload);
}

function broadcastFleetStatus(companyId, payload) {
  if (!io) return;
  toCompany(companyId, 'fleet:status', payload);
}

function broadcastUtilisation(companyId, payload) {
  if (!io) return;
  toCompany(companyId, 'fleet:utilisation', payload);
}

/** Get the underlying io instance (for advanced use). */
function getIO() { return io; }

module.exports = {
  init,
  getIO,
  toCompany,
  toShipment,
  toAsset,
  toAdmins,
  broadcastTrackingUpdate,
  broadcastETAUpdate,
  broadcastAlert,
  broadcastDelayDetected,
  broadcastFleetStatus,
  broadcastUtilisation,
};
