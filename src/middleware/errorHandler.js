'use strict';

/**
 * Central error handler. Must be registered last in Express.
 * Differentiates between known operational errors and unexpected crashes.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // PostgreSQL error codes → HTTP status mapping
  const pgErrors = {
    '23505': { status: 409, message: 'Duplicate entry — resource already exists' },
    '23503': { status: 409, message: 'Foreign key constraint violation' },
    '23502': { status: 422, message: 'Required field is null' },
    '22P02': { status: 422, message: 'Invalid input syntax' },
    '42703': { status: 422, message: 'Column does not exist' },
    '42P01': { status: 500, message: 'Relation does not exist — run migrations' },
  };

  // Structured PostgreSQL errors
  if (err.code && pgErrors[err.code]) {
    const { status, message } = pgErrors[err.code];
    return res.status(status).json({
      error: message,
      detail: process.env.NODE_ENV === 'development' ? err.detail : undefined,
    });
  }

  // JWT errors (shouldn't reach here normally, but belt-and-braces)
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Authentication token invalid or expired' });
  }

  // Programmer errors — log full stack in development
  const isDev = process.env.NODE_ENV === 'development';
  console.error('[ERROR]', err);

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    stack: isDev ? err.stack : undefined,
  });
}

/**
 * 404 handler — must be registered before errorHandler but after all routes.
 */
function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFound };
