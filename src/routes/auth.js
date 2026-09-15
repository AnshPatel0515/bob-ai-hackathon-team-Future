'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { body } = require('express-validator');

const { query }       = require('../config/db');
const { signToken, authenticate } = require('../middleware/auth');
const { validate }    = require('../middleware/validate');

const router = express.Router();

// ── POST /api/auth/register ─────────────────────────────────────────────────
router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('full_name').trim().notEmpty().withMessage('full_name is required'),
    body('company_id').isUUID().withMessage('Valid company_id (UUID) required'),
    body('role')
      .optional()
      .isIn(['admin','logistics_manager','fleet_operator','driver','customs_agent','analyst','viewer'])
      .withMessage('Invalid role'),
    body('phone').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { email, password, full_name, company_id, role = 'viewer', phone } = req.body;

      // Check company exists
      const companyCheck = await query('SELECT id FROM companies WHERE id = $1', [company_id]);
      if (!companyCheck.rows.length) {
        return res.status(422).json({ error: 'company_id does not exist' });
      }

      const hash = await bcrypt.hash(password, 12);

      const { rows } = await query(
        `INSERT INTO users (email, full_name, role, company_id, phone, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, full_name, role, company_id, phone, created_at`,
        [email, full_name, role, company_id, phone || null, hash]
      );

      const user  = rows[0];
      const token = signToken(user);

      res.status(201).json({ token, user });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ────────────────────────────────────────────────────
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const { rows } = await query(
        `SELECT id, email, full_name, role, company_id, phone, is_active, password_hash
         FROM users WHERE email = $1`,
        [email]
      );

      const user = rows[0];

      // Constant-time compare even when user not found
      const hash = user ? user.password_hash : '$2b$12$invalidhashplaceholderXXXXXXXXXXXXXXX';
      const match = await bcrypt.compare(password, hash);

      if (!user || !match) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      if (!user.is_active) {
        return res.status(403).json({ error: 'Account is inactive' });
      }

      // Update last_login_at
      await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

      const token = signToken(user);
      const { password_hash: _, ...safeUser } = user;

      res.json({ token, user: safeUser });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.role, u.phone, u.is_active,
              u.last_login_at, u.created_at,
              c.name AS company_name, c.country AS company_country
       FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/auth/me ──────────────────────────────────────────────────────
router.patch(
  '/me',
  authenticate,
  [
    body('full_name').optional().trim().notEmpty(),
    body('phone').optional().trim(),
    body('password')
      .optional()
      .isLength({ min: 8 })
      .withMessage('New password must be at least 8 characters'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { full_name, phone, password } = req.body;
      const updates = [];
      const values  = [];
      let idx = 1;

      if (full_name !== undefined) { updates.push(`full_name = $${idx++}`); values.push(full_name); }
      if (phone     !== undefined) { updates.push(`phone = $${idx++}`);     values.push(phone); }
      if (password  !== undefined) {
        const hash = await bcrypt.hash(password, 12);
        updates.push(`password_hash = $${idx++}`);
        values.push(hash);
      }

      if (!updates.length) {
        return res.status(422).json({ error: 'No updatable fields provided' });
      }

      values.push(req.user.id);
      const { rows } = await query(
        `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${idx}
         RETURNING id, email, full_name, role, phone, updated_at`,
        values
      );
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/auth/users  (admin only) ───────────────────────────────────────
router.get('/users', authenticate, async (req, res, next) => {
  try {
    if (!['admin', 'logistics_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.role, u.phone, u.is_active,
              u.last_login_at, u.created_at,
              c.name AS company_name
       FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE u.company_id = $1
       ORDER BY u.created_at DESC`,
      [req.user.company_id]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
