'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '5432', 10),
  database:           process.env.DB_NAME     || 'supply_chain',
  user:               process.env.DB_USER     || 'postgres',
  password:           process.env.DB_PASSWORD || '',
  max:                parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis:  parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT || '2000', 10),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Execute a parameterised query and return rows.
 * @param {string} text   SQL with $1, $2 … placeholders
 * @param {Array}  params Parameter values
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  if (process.env.NODE_ENV === 'development') {
    console.debug(`[DB] ${Date.now() - start}ms → ${text.slice(0, 80)}`);
  }
  return result;
}

/** Acquire a client for multi-statement transactions. */
async function getClient() {
  return pool.connect();
}

/** Run fn(client) inside BEGIN/COMMIT, auto-rollback on error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, getClient, withTransaction, pool };
