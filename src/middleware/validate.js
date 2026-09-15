'use strict';
const { validationResult } = require('express-validator');

/**
 * Run after express-validator chains.
 * Returns 422 with structured field errors if any failed.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: 'Validation failed',
      details: errors.array().map((e) => ({
        field:   e.path,
        message: e.msg,
        value:   e.value,
      })),
    });
  }
  next();
}

module.exports = { validate };
