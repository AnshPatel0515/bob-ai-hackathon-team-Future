'use strict';
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

/**
 * Verify the Bearer JWT and attach req.user.
 * Responds 401 if token is missing/invalid, 403 if account inactive.
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
      return res.status(401).json({ error: msg });
    }

    // Re-check user still exists and is active
    const { rows } = await query(
      `SELECT id, email, full_name, role, company_id, is_active
         FROM users WHERE id = $1`,
      [payload.sub]
    );

    if (!rows.length || !rows[0].is_active) {
      return res.status(403).json({ error: 'Account inactive or not found' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Factory: require one of the listed roles.
 * Must be used after authenticate().
 *
 * @param {...string} roles  Allowed role names
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(', ')}`,
      });
    }
    next();
  };
}

/**
 * Generate a signed access token.
 * @param {object} user  User row from DB
 */
function signToken(user) {
  return jwt.sign(
    {
      sub:        user.id,
      email:      user.email,
      role:       user.role,
      company_id: user.company_id,
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

module.exports = { authenticate, authorize, signToken };
