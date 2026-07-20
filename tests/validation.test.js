'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validate, validateBody } = require('../server/lib/validation.js');

describe('validate.isString', () => {
  test('accepts a string at the maxLen boundary', () => {
    assert.equal(validate.isString('abc', 3), true);
  });

  test('rejects a string one char over maxLen', () => {
    assert.equal(validate.isString('abcd', 3), false);
  });

  test('rejects a non-string', () => {
    assert.equal(validate.isString(123), false);
  });
});

describe('validate.isNumber', () => {
  test('accepts a value within [min, max]', () => {
    assert.equal(validate.isNumber(5, 1, 10), true);
  });

  test('accepts the max boundary (inclusive)', () => {
    assert.equal(validate.isNumber(10, 1, 10), true);
  });

  test('rejects a value below min', () => {
    assert.equal(validate.isNumber(0, 1, 10), false);
  });

  test('rejects NaN', () => {
    assert.equal(validate.isNumber(NaN), false);
  });

  test('rejects a numeric string (must be a number type)', () => {
    assert.equal(validate.isNumber('5', 1, 10), false);
  });
});

describe('validate.isUUID', () => {
  test('accepts a valid v4-shaped UUID', () => {
    assert.equal(validate.isUUID('123e4567-e89b-12d3-a456-426614174000'), true);
  });

  test('rejects a malformed UUID', () => {
    assert.equal(validate.isUUID('not-a-uuid'), false);
  });
});

describe('validate.isArray', () => {
  test('accepts an array at the maxLen boundary', () => {
    assert.equal(validate.isArray([1, 2, 3], 3), true);
  });

  test('rejects an array over maxLen', () => {
    assert.equal(validate.isArray([1, 2, 3, 4], 3), false);
  });

  test('rejects a non-array', () => {
    assert.equal(validate.isArray('nope'), false);
  });
});

describe('validate.sanitizeInt', () => {
  test('returns the default when value is not parseable', () => {
    assert.equal(validate.sanitizeInt('abc', 7), 7);
  });

  test('clamps above max', () => {
    assert.equal(validate.sanitizeInt(100, 0, 1, 10), 10);
  });

  test('clamps below min', () => {
    assert.equal(validate.sanitizeInt(-5, 0, 1, 10), 1);
  });

  test('parses and passes through an in-range value', () => {
    assert.equal(validate.sanitizeInt('42'), 42);
  });
});

describe('validateBody (Express middleware factory)', () => {
  // Minimal fake req/res/next harness for exercising the returned middleware.
  function run(schema, body) {
    const outcome = { nextCalled: false, statusCode: null, payload: null };
    const req = { body };
    const res = {
      status(code) {
        outcome.statusCode = code;
        return this;
      },
      json(obj) {
        outcome.payload = obj;
        return this;
      },
    };
    const next = () => {
      outcome.nextCalled = true;
    };
    validateBody(schema)(req, res, next);
    return outcome;
  }

  const schema = {
    name: { required: true, type: 'string', maxLen: 5 },
    level: { type: 'number', min: 1, max: 20 },
  };

  test('calls next() for a valid body', () => {
    const outcome = run(schema, { name: 'abc', level: 5 });
    assert.equal(outcome.nextCalled, true);
    assert.equal(outcome.statusCode, null);
  });

  test('responds 400 when a required field is missing', () => {
    const outcome = run(schema, { level: 5 });
    assert.equal(outcome.nextCalled, false);
    assert.equal(outcome.statusCode, 400);
    assert.equal(outcome.payload.error, 'Validation failed');
    assert.ok(outcome.payload.details.some((d) => d.includes('name')));
  });

  test('responds 400 when a field violates its type/range rule', () => {
    const outcome = run(schema, { name: 'toolong', level: 999 });
    assert.equal(outcome.nextCalled, false);
    assert.equal(outcome.statusCode, 400);
    assert.equal(outcome.payload.details.length, 2);
  });
});
