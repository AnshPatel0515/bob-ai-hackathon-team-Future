'use strict';

/**
 * Parse and validate common pagination query params.
 * Defaults: page=1, limit=20, max limit=100.
 *
 * @param {object} query  req.query
 * @returns {{ limit: number, offset: number, page: number }}
 */
function parsePagination(query) {
  const page  = Math.max(1, parseInt(query.page  || '1',  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Build a consistent paginated response envelope.
 *
 * @param {Array}  rows       Data rows for the current page
 * @param {number} total      Total row count (from COUNT(*))
 * @param {number} page       Current page number
 * @param {number} limit      Page size
 */
function paginatedResponse(rows, total, page, limit) {
  return {
    data:       rows,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
}

/**
 * Sanitise a sort column against an allowlist to prevent SQL injection.
 *
 * @param {string} col       Value from req.query.sort
 * @param {string[]} allowed Allowed column names
 * @param {string} fallback  Default column name
 */
function safeSort(col, allowed, fallback) {
  return allowed.includes(col) ? col : fallback;
}

/**
 * Parse sort direction — only 'asc' or 'desc' allowed.
 */
function safeDir(dir) {
  return dir === 'asc' ? 'ASC' : 'DESC';
}

module.exports = { parsePagination, paginatedResponse, safeSort, safeDir };
