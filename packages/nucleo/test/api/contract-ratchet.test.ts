// The ratchet of the contract (#662): a new operation must declare a real response, the debt of the
// operations that do not yet is frozen in docs/contracts/core-api.legacy.json, and the list only
// shrinks (like test/english-internals.legacy.json): completing an operation removes its entry, and an
// entry can never be added to hide a new one.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { declaredOperations, hasRealResponseSchema, readLegacyOperations, readSpec, type OperationObject } from './openapi-spec.ts';

const spec = readSpec();
const operations = declaredOperations(spec).map((o) => ({ id: o.operation.operationId ?? `${o.method} ${o.path}`, operation: o.operation }));
const legacy = readLegacyOperations();

describe('#662 the response-schema ratchet', () => {
  test('#662 Given an operation outside the frozen legacy list, When it lacks a real response schema, Then the ratchet fails', () => {
    const frozen = new Set(legacy);
    const lacking = operations.filter((o) => !frozen.has(o.id) && !hasRealResponseSchema(o.operation)).map((o) => o.id);
    assert.deepEqual(lacking, [], 'declare a real response schema, or (never) add the operation to the legacy list');
  });

  test('#662 Given an entry of the legacy list, When the spec no longer has that operation, Then the ratchet fails so the list only shrinks', () => {
    const ids = new Set(operations.map((o) => o.id));
    assert.deepEqual(legacy.filter((id) => !ids.has(id)), []);
  });

  test('#662 Given an entry of the legacy list, When its operation now declares a real response, Then the ratchet fails until the entry is removed', () => {
    const real = new Set(operations.filter((o) => hasRealResponseSchema(o.operation)).map((o) => o.id));
    assert.deepEqual(legacy.filter((id) => real.has(id)), []);
  });

  test('#662 the legacy list is sorted and has no duplicate', () => {
    assert.deepEqual(legacy, [...new Set(legacy)].sort());
  });

  test('#662 the ratchet judges a schema by what it says: a bare object is a placeholder, a described shape and a typed text answer are not', () => {
    const answer = (content: NonNullable<OperationObject['responses']>[string]['content'], headers?: Record<string, unknown>, status = '200'): OperationObject => ({ responses: { [status]: { description: 'd', content, headers } } });
    assert.equal(hasRealResponseSchema(answer({ 'application/json': { schema: { type: 'object' } } })), false);
    assert.equal(hasRealResponseSchema(answer({ 'application/json': { schema: {} } })), false);
    assert.equal(hasRealResponseSchema(answer({ 'application/json': { schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } } } })), true);
    assert.equal(hasRealResponseSchema(answer({ 'application/json': { schema: { $ref: '#/components/schemas/X' } } })), true);
    assert.equal(hasRealResponseSchema(answer({ 'application/json': { schema: { type: 'array', items: { type: 'string' } } } })), true);
    assert.equal(hasRealResponseSchema(answer({ 'text/html': { schema: { type: 'string' } } })), true);
    assert.equal(hasRealResponseSchema(answer(undefined, { Location: { schema: { type: 'string' } } }, '302')), true);
    assert.equal(hasRealResponseSchema({ responses: { 404: { description: 'd', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } }), false);
  });
});
