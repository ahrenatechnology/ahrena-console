// The subset validator the contract tests rely on (#662): every keyword it implements is proved to
// accept and to refuse, and a keyword it does not implement is refused loudly (fail closed).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { UnsupportedSchemaError, validate, type Schema } from './json-schema-validator.ts';

const problems = (schema: Schema, value: unknown, doc = {}) => validate(schema, value, doc);

describe('#662 json schema subset validator', () => {
  test('type accepts the declared types, a union and null, and refuses the others', () => {
    assert.deepEqual(problems({ type: 'string' }, 'a'), []);
    assert.deepEqual(problems({ type: ['string', 'null'] }, null), []);
    assert.equal(problems({ type: 'integer' }, 1.5).length, 1);
    assert.equal(problems({ type: 'number' }, '1').length, 1);
    assert.equal(problems({ type: 'object' }, []).length, 1);
    assert.equal(problems({ type: 'array' }, {}).length, 1);
    assert.equal(problems({ type: 'boolean' }, 0).length, 1);
  });

  test('object keywords: required, properties, additionalProperties false and as a schema', () => {
    const schema: Schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } }, additionalProperties: false };
    assert.deepEqual(problems(schema, { a: 'x' }), []);
    assert.deepEqual(problems(schema, {}), ['$: missing required a']);
    assert.deepEqual(problems(schema, { a: 1 }), ['$.a: expected string']);
    assert.deepEqual(problems(schema, { a: 'x', b: 1 }), ['$: unexpected property b']);
    assert.deepEqual(problems({ type: 'object', additionalProperties: { type: 'integer' } }, { k: 1 }), []);
    assert.equal(problems({ type: 'object', additionalProperties: { type: 'integer' } }, { k: 'x' }).length, 1);
    assert.deepEqual(problems({ type: 'object', additionalProperties: true }, { k: 'x' }), []);
  });

  test('array keywords: items, minItems, maxItems', () => {
    const schema: Schema = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2 };
    assert.deepEqual(problems(schema, [1, 2]), []);
    assert.deepEqual(problems(schema, [1, 'x']), ['$[1]: expected integer']);
    assert.equal(problems(schema, []).length, 1);
    assert.equal(problems(schema, [1, 2, 3]).length, 1);
  });

  test('scalar keywords: enum, const, minimum, maximum, minLength, maxLength, pattern', () => {
    assert.deepEqual(problems({ enum: ['a', 'b'] }, 'a'), []);
    assert.equal(problems({ enum: ['a', 'b'] }, 'c').length, 1);
    assert.deepEqual(problems({ const: 7 }, 7), []);
    assert.equal(problems({ const: 7 }, 8).length, 1);
    assert.deepEqual(problems({ type: 'number', minimum: 0, maximum: 10 }, 5), []);
    assert.equal(problems({ type: 'number', minimum: 0 }, -1).length, 1);
    assert.equal(problems({ type: 'number', maximum: 10 }, 11).length, 1);
    assert.deepEqual(problems({ type: 'string', minLength: 1, maxLength: 3 }, 'abc'), []);
    assert.equal(problems({ type: 'string', minLength: 1 }, '').length, 1);
    assert.equal(problems({ type: 'string', maxLength: 3 }, 'abcd').length, 1);
    assert.deepEqual(problems({ type: 'string', pattern: '^a+$' }, 'aa'), []);
    assert.equal(problems({ type: 'string', pattern: '^a+$' }, 'ab').length, 1);
  });

  test('format date-time accepts an ISO instant and refuses other text; another format is unsupported', () => {
    assert.deepEqual(problems({ type: 'string', format: 'date-time' }, '2026-11-14T12:00:00.000Z'), []);
    assert.equal(problems({ type: 'string', format: 'date-time' }, 'yesterday').length, 1);
    assert.equal(problems({ type: 'string', format: 'date-time' }, '2026-13-45T99:00:00Z').length, 1);
    assert.throws(() => problems({ type: 'string', format: 'email' }, 'a@b'), UnsupportedSchemaError);
  });

  test('oneOf, anyOf and allOf count the options that match', () => {
    const s = { type: 'string' };
    const n = { type: 'number' };
    assert.deepEqual(problems({ oneOf: [s, n] }, 'x'), []);
    assert.equal(problems({ oneOf: [s, { type: 'string', minLength: 1 }] }, 'x').length, 1);
    assert.equal(problems({ oneOf: [s, n] }, null).length, 1);
    assert.deepEqual(problems({ anyOf: [s, n] }, 1), []);
    assert.equal(problems({ anyOf: [s, n] }, null).length, 1);
    assert.deepEqual(problems({ allOf: [s, { minLength: 2 }] }, 'ab'), []);
    assert.equal(problems({ allOf: [s, { minLength: 2 }] }, 'a').length, 1);
  });

  test('$ref resolves a component schema and refuses an unknown one', () => {
    const doc = { components: { schemas: { Id: { type: 'string', minLength: 1 } } } };
    assert.deepEqual(problems({ $ref: '#/components/schemas/Id' }, 'a', doc), []);
    assert.equal(problems({ $ref: '#/components/schemas/Id' }, '', doc).length, 1);
    assert.throws(() => problems({ $ref: '#/components/schemas/Nope' }, 'a', doc), UnsupportedSchemaError);
    assert.throws(() => problems({ $ref: 'http://elsewhere/schema.json' }, 'a', doc), UnsupportedSchemaError);
  });

  test('annotations are ignored and a keyword outside the subset throws, so nothing passes by being skipped', () => {
    assert.deepEqual(problems({ type: 'string', description: 'd', example: 'e', title: 't', default: 'x' }, 'a'), []);
    assert.throws(() => problems({ type: 'object', patternProperties: { '^a': { type: 'string' } } }, {}), UnsupportedSchemaError);
    assert.throws(() => problems({ not: { type: 'string' } }, 1), UnsupportedSchemaError);
    assert.throws(() => problems({ type: 'file' }, 1), UnsupportedSchemaError);
  });
});
