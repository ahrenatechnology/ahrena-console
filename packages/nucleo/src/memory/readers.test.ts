// The memory readers: field-by-field reprojection of what the real v3.5.1 binary confirmed (#727/AC-3).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryReadError, readSetupPlan, readVersion } from './readers.ts';

const PLAN = {
  format: 1,
  data_dir: '/Users/someone/.ahrena-console/ai-memory',
  config_path: '/Users/someone/.ahrena-console/ai-memory/config.toml',
  fresh: true,
  service: { action: 'install', manager: 'launchd', path: '/Users/someone/Library/LaunchAgents/ai-memory.plist' },
  agents: [{ agent: 'claude-code', found: true, wiring: 'mcp' }],
  other_agents: ['codex'],
};

describe('readVersion (#727/AC-3)', () => {
  test('#727/AC-3 "ai-memory 3.5.1" is { version: "3.5.1" }', () => {
    assert.deepEqual(readVersion('ai-memory 3.5.1\n'), { version: '3.5.1' });
  });

  for (const bad of ['', 'ai-memory', '3.5.1', 'other-tool 3.5.1', 'ai-memory 3.5.1 extra', 'ai-memory 3.5\n', 'ai-memory 3.5.1\nsecond line']) {
    test(`#727/AC-3 ${JSON.stringify(bad)} is rejected`, () => {
      assert.throws(() => readVersion(bad), MemoryReadError);
    });
  }
});

describe('readSetupPlan (#727/AC-3)', () => {
  test('#727/AC-3 a format 1 plan comes back field by field', () => {
    assert.deepEqual(readSetupPlan(JSON.stringify(PLAN)), {
      data_dir: PLAN.data_dir,
      config_path: PLAN.config_path,
      fresh: true,
      service: PLAN.service,
      agents: [{ agent: 'claude-code', found: true, wiring: 'mcp' }],
      other_agents: ['codex'],
    });
  });

  test('#727/AC-3 any field outside the list is dropped, at the top and inside each object', () => {
    const noisy = {
      ...PLAN,
      auth_token: 'fake-token-0000-not-real',
      service: { ...PLAN.service, secret: 'fake-token-0000-not-real' },
      agents: [{ agent: 'claude-code', found: false, wiring: 'none', env: { AI_MEMORY_AUTH_TOKEN: 'fake-token-0000-not-real' } }],
    };
    const out = readSetupPlan(JSON.stringify(noisy));
    assert.equal(JSON.stringify(out).includes('fake-token-0000-not-real'), false);
    assert.deepEqual(Object.keys(out).sort(), ['agents', 'config_path', 'data_dir', 'fresh', 'other_agents', 'service']);
    assert.deepEqual(Object.keys(out.service).sort(), ['action', 'manager', 'path']);
    assert.deepEqual(Object.keys(out.agents[0]!).sort(), ['agent', 'found', 'wiring']);
  });

  test('#727/AC-3 a service with no path or a null wiring is kept as null', () => {
    const out = readSetupPlan(JSON.stringify({ ...PLAN, service: { action: 'none', manager: 'none', path: null }, agents: [{ agent: 'claude-code', found: false, wiring: null }] }));
    assert.equal(out.service.path, null);
    assert.equal(out.agents[0]!.wiring, null);
  });

  for (const format of [0, 2, '1', null, undefined]) {
    test(`#727/AC-3 format ${String(format)} is rejected, never passed through`, () => {
      const plan: Record<string, unknown> = { ...PLAN, format };
      if (format === undefined) delete plan.format;
      assert.throws(() => readSetupPlan(JSON.stringify(plan)), (error) => error instanceof MemoryReadError && error.code === 'unsupported-format');
    });
  }

  for (const [name, text] of [
    ['malformed JSON', '{not json'],
    ['an empty output', ''],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['a plan without data_dir', JSON.stringify({ ...PLAN, data_dir: undefined })],
    ['a fresh that is not a boolean', JSON.stringify({ ...PLAN, fresh: 'yes' })],
    ['a service that is not an object', JSON.stringify({ ...PLAN, service: 'launchd' })],
    ['agents that is not an array', JSON.stringify({ ...PLAN, agents: {} })],
    ['an agent without found', JSON.stringify({ ...PLAN, agents: [{ agent: 'claude-code', wiring: 'mcp' }] })],
    ['other_agents with a non-string', JSON.stringify({ ...PLAN, other_agents: [1] })],
  ] as const) {
    test(`#727/AC-3 ${name} is rejected`, () => {
      assert.throws(() => readSetupPlan(text), MemoryReadError);
    });
  }

  test('#727/AC-3 the error carries a code and no part of the input', () => {
    try {
      readSetupPlan('{"format": 1, "data_dir": "fake-token-0000-not-real"');
      assert.fail('should throw');
    } catch (error) {
      assert.ok(error instanceof MemoryReadError);
      assert.equal(String(error.message).includes('fake-token-0000-not-real'), false);
      assert.equal(error.code, 'malformed-plan');
    }
  });
});
