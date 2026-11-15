// The ratchet of the contract (#662): an operation must declare a real response, and the operations
// that do not yet are frozen in docs/contracts/core-api.legacy.json. What is asserted where:
//   - here, on the files as they are: every operation without a real response schema is in the list,
//     every entry of the list is an operation of the spec that still has the placeholder, and the list
//     is sorted without duplicates;
//   - in CI (.github/workflows/contract.yml, "The legacy list only shrinks"): the head's list is a
//     subset of the merge base's list, so an entry can never be added to hide a new operation. That
//     comparison needs git history, so it cannot run here; the script it runs
//     (scripts/check-contract-legacy-shrinks.mjs) is exercised below on planted lists.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { declaredOperations, hasRealResponseSchema, readLegacyOperations, readSpec, type OperationObject } from './openapi-spec.ts';

const spec = readSpec();
const operations = declaredOperations(spec).map((o) => ({ id: o.operation.operationId ?? `${o.method} ${o.path}`, operation: o.operation }));
const legacy = readLegacyOperations();

describe('#662 the response-schema ratchet', () => {
  test('#662 Given the spec, When an operation lacks a real response schema, Then it must be in the legacy list (a new operation cannot ship with a placeholder)', () => {
    const frozen = new Set(legacy);
    const lacking = operations.filter((o) => !frozen.has(o.id) && !hasRealResponseSchema(o.operation)).map((o) => o.id);
    assert.deepEqual(lacking, [], 'declare a real response schema, or (never) add the operation to the legacy list');
  });

  test('#662 Given an entry of the legacy list, When the spec no longer has that operation, Then the entry is reported as stale', () => {
    const ids = new Set(operations.map((o) => o.id));
    assert.deepEqual(legacy.filter((id) => !ids.has(id)), []);
  });

  test('#662 Given an entry of the legacy list, When its operation now declares a real response, Then the entry is reported until it is removed', () => {
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

const SCRIPT = new URL('../../../../scripts/check-contract-legacy-shrinks.mjs', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'ahrena-legacy-shrinks-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

/** Runs the script CI runs on a base list and a head list (`undefined` writes no file for it). */
function compare(base: unknown, head: unknown): { status: number | null; output: string } {
  const files = [base, head].map((list) => {
    const file = join(dir, `list-${(n += 1)}.json`);
    writeFileSync(file, typeof list === 'string' ? list : JSON.stringify(list));
    return file;
  });
  const r = spawnSync(process.execPath, [SCRIPT, ...files], { encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describe('#662 the legacy list only shrinks: the script CI runs against the merge base', () => {
  const base = { operations: ['a', 'b', 'c'] };

  test('#662 Given a head list that is a superset of the base, When compared, Then the script fails and names the added operation', () => {
    const r = compare(base, { operations: ['a', 'b', 'c', 'planted'] });
    assert.equal(r.status, 1);
    assert.match(r.output, /planted/);
  });

  test('#662 Given a head list with one entry swapped for another, When compared, Then the script fails (the same size is not a subset)', () => {
    assert.equal(compare(base, { operations: ['a', 'b', 'planted'] }).status, 1);
  });

  test('#662 Given a head list equal to the base, or one that dropped entries, When compared, Then the script passes', () => {
    assert.equal(compare(base, base).status, 0);
    assert.equal(compare(base, { operations: ['b'] }).status, 0);
    assert.equal(compare(base, { operations: [] }).status, 0);
  });

  test('#662 Given a file that is not a legacy list, When compared, Then the script fails with its own code, not as a pass', () => {
    assert.equal(compare(base, { operations: 'a' }).status, 2);
    assert.equal(compare('not json', base).status, 2);
  });
});
