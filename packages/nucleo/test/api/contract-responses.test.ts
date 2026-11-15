// Response validation against the authored contract (#662): the answers of the agent view and of the
// diagnosis routes are validated inside their own route tests (agent-view-route.test.ts and
// diagnosis-api.test.ts); this file proves the validation can fail (a deviation is reported), that the
// spec stays inside the validator's subset, and validates the answers of the two health routes.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isAnnotation, SUPPORTED_KEYWORDS, type Schema } from './json-schema-validator.ts';
import { startContractProbeServer, type ContractProbeServer } from './contract-probe-server.ts';
import { assertAnswersTheSpec, readSpec, responseProblems } from './openapi-spec.ts';

const spec = readSpec();
const AGENT = '/api/sessions/{sessionId}/agents/{agentId}';
const NOW = '2026-11-14T12:00:00.000Z';

const agentView = (over: Record<string, unknown> = {}) => ({
  agentId: 'a1b2', agentType: 'Explore', description: 'Find the cost code', brief: 'first prompt', briefTruncated: false, spawnedByToolUseId: 'toolu_T1',
  steps: [
    { id: 'toolu_R1', kind: 'tool', name: 'Read', summary: 'src/cost.ts', state: 'ok', start: NOW, end: NOW, childAgentId: null },
    { id: 'toolu_A1', kind: 'agent', name: 'Agent', summary: null, state: 'running', start: NOW, end: null, childAgentId: 'c3d4' },
  ],
  result: null, resultTruncated: false, costUsd: 0.42, costNote: null, totalCostUsd: 0.9, state: 'completed', start: NOW, end: NOW, ...over,
});
const diagnosis = (sections: unknown[]) => ({ machine: 'local', alertId: 'swap-high', kind: 'swap-high', takenAt: NOW, sections });
const process1 = { pid: 412, name: 'next-server', rssBytes: 2147483648, cpuPct: 56, startedAt: NOW };

describe('#662 response validation against the spec', () => {
  test('#662 Given an agent view as the contract describes it, When validated, Then it conforms', () => {
    assert.deepEqual(responseProblems(spec, 'GET', AGENT, 200, agentView()), []);
    assert.deepEqual(responseProblems(spec, 'GET', AGENT, 200, agentView({ machine: { id: 'workstation', label: 'Workstation' } })), []);
    assert.deepEqual(responseProblems(spec, 'GET', AGENT, 404, { error: 'a sessão não tem este agente', code: 'agent_not_found' }), []);
  });

  test('#662 Given an agent view that deviates, When validated, Then each deviation is reported', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['a field is missing', (({ costNote: _, ...rest }) => rest)(agentView())],
      ['a field is not declared', agentView({ extra: 1 })],
      ['cost is zero where the note is the contract', agentView({ costUsd: '0' })],
      ['the cost note is not one of the two', agentView({ costNote: 'free' })],
      ['the state is not an agent status', agentView({ state: 'done' })],
      ['a step state is not declared', agentView({ steps: [{ id: 'x', kind: 'tool', name: 'Read', summary: null, state: 'queued', start: NOW, end: null, childAgentId: null }] })],
      ['a time is not an instant', agentView({ start: 'yesterday' })],
    ];
    for (const [what, body] of cases) assert.ok(responseProblems(spec, 'GET', AGENT, 200, body).length > 0, what);
  });

  test('#662 Given a diagnosis as the contract describes it, When validated, Then it conforms, with a section that did not come back inside it', () => {
    const ok = diagnosis([
      { id: 'processes-by-rss', status: 'ok', items: [process1] },
      { id: 'swap', status: 'unavailable', items: [], reason: 'short reason' },
      { id: 'known-caches', status: 'ok', items: [{ id: 'npm', path: '/p', bytes: 1, actionId: 'npm-cache' }, { id: 'worktree', path: '/w', bytes: 2, lastUsedAt: NOW, hasUncommitted: false, hasUnpushed: true, actionId: null }], worktrees: { oldAfterDays: 14, root: '~/Workspace' } },
      { id: 'journal', status: 'ok', items: [{ bytes: 7 }], partial: { reason: 'one folder unreadable' } },
    ]);
    assert.deepEqual(responseProblems(spec, 'GET', '/api/diagnosis', 200, ok), []);
    assert.deepEqual(responseProblems(spec, 'GET', '/api/diagnosis', 501, { error: 'diagnosis-unsupported' }), []);
    assert.deepEqual(responseProblems(spec, 'GET', '/api/diagnosis', 422, { error: 'e', reason: 'not-diagnosable' }), []);
  });

  test('#662 Given a diagnosis that deviates, When validated, Then each deviation is reported', () => {
    const cases: [string, unknown][] = [
      ['a section id the contract does not name', diagnosis([{ id: 'network', status: 'ok', items: [] }])],
      ['an item of another section', diagnosis([{ id: 'swap', status: 'ok', items: [process1] }])],
      ['a status that is not one of the three', diagnosis([{ id: 'swap', status: 'broken', items: [] }])],
      ['a reason past 120 characters', diagnosis([{ id: 'swap', status: 'unavailable', items: [], reason: 'x'.repeat(121) }])],
      ['more than 10 processes', diagnosis([{ id: 'processes-by-cpu', status: 'ok', items: Array.from({ length: 11 }, () => process1) }])],
      ['an alert kind that is not diagnosable', { ...diagnosis([]), kind: 'port-exposed' }],
      ['a cache action that is not a catalog one', diagnosis([{ id: 'known-caches', status: 'ok', items: [{ id: 'npm', path: '/p', bytes: 1, actionId: 'rm-rf' }] }])],
    ];
    for (const [what, body] of cases) assert.ok(responseProblems(spec, 'GET', '/api/diagnosis', 200, body).length > 0, what);
    assert.ok(responseProblems(spec, 'GET', '/api/diagnosis', 501, { error: 'something else' }).length > 0, 'the stable 501 value');
  });

  test('#662 Given a status the spec does not declare, or an operation it does not have, When validated, Then it is reported', () => {
    assert.match(responseProblems(spec, 'GET', '/api/diagnosis', 418, {})[0]!, /not declared/);
    assert.match(responseProblems(spec, 'GET', '/api/planted', 200, {})[0]!, /not declared/);
    assert.throws(() => assertAnswersTheSpec('GET', '/api/diagnosis', 200, {}), /does not conform/);
  });

  test('#662 the schemas of the spec stay inside the validator\'s subset, so none of it is skipped', () => {
    const used = new Set<string>();
    const walk = (node: unknown, inSchemaMap = false): void => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n));
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node as Schema)) {
        if (!inSchemaMap) used.add(key);
        walk(value, key === 'properties');
      }
    };
    Object.values(spec.components?.schemas ?? {}).forEach((schema) => walk(schema));
    const outside = [...used].filter((k) => !SUPPORTED_KEYWORDS.has(k) && !isAnnotation(k));
    assert.deepEqual(outside, []);
  });
});

describe('#662 the health routes answer what the spec declares', () => {
  let server: ContractProbeServer;
  before(async () => {
    server = await startContractProbeServer();
  });
  after(async () => {
    await server.close();
  });

  for (const [path, template] of [['/api/overview', '/api/overview'], ['/api/hooks/health', '/api/hooks/health']] as const) {
    test(`#662 Given the core running, When GET ${path} is called, Then the answer conforms`, async () => {
      const r = await server.fetch(path);
      assertAnswersTheSpec('GET', template, r.status, await r.json());
    });
  }
});
