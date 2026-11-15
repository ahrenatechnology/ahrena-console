/*
 * #663: the guard that gives an authored schema file its type, instead of an assertion.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isSchema } from './json-schema-subset.ts';

describe('isSchema (#663)', () => {
  test('accepts a plain object with a string-array required and an object properties', () => {
    assert.equal(isSchema({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }), true);
  });
  test('accepts an object with neither required nor properties', () => {
    assert.equal(isSchema({ type: 'string' }), true);
  });
  test('rejects a non-object and an array', () => {
    for (const value of [null, 'x', 3, []]) assert.equal(isSchema(value), false);
  });
  test('rejects a required that is not a string array', () => {
    assert.equal(isSchema({ required: 'x' }), false);
    assert.equal(isSchema({ required: [1] }), false);
  });
  test('rejects a properties that is not a plain object', () => {
    assert.equal(isSchema({ properties: [] }), false);
    assert.equal(isSchema({ properties: 'x' }), false);
  });
});
