import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeCommand, RuntimeCorrelation, RuntimeResult } from '../../src/runtime/contracts.ts';
import { fixture } from './fixtures.ts';

// TEST-ONLY transport. No fake adapter or admission override is exported by production.
class FakeAdapter implements RuntimeAdapter {
  readonly provider: 'claude' | 'codex';
  readonly capabilities: RuntimeCapabilities = { start: 'supported', resume: 'supported', send: 'supported', interrupt: 'supported', close: 'supported', respond: 'unsupported' };
  calls = 0;
  disconnected = false;
  constructor(provider: 'claude' | 'codex') { this.provider = provider; }
  async execute(scope: RuntimeCorrelation, command: RuntimeCommand): Promise<RuntimeResult> {
    if (scope.provider !== this.provider || this.capabilities[command.operation] !== 'supported') return { status: 'unsupported' };
    this.calls++;
    return { status: this.disconnected ? 'transport_error' : 'accepted' };
  }
}
for (const provider of ['claude', 'codex'] as const) test(`${provider}: same fake contract, unsupported and uncertain delivery stay explicit`, async () => {
  const f = await fixture(provider);
  try {
    const adapter: RuntimeAdapter = new FakeAdapter(provider);
    const record = f.runs.createRun(f.scope, 1000);
    const correlation = { ...f.scope, runId: record.id, turnId: record.turnId, requestId: null };
    for (const operation of ['start', 'resume', 'interrupt', 'close'] as const) {
      assert.deepEqual(await adapter.execute(correlation, { operation }), { status: 'accepted' });
    }
    assert.deepEqual(await adapter.execute(correlation, { operation: 'send', message: 'synthetic' }), { status: 'accepted' });
    assert.deepEqual(await adapter.execute(correlation, { operation: 'respond', requestId: 'synthetic', response: { kind: 'approval', decision: 'approve' } }), { status: 'unsupported' });
    f.runs.transition(f.scope, record.id, 'running', 1001);
    const request = f.runs.request(f.scope, record.id, 'approval', 3000, 1002);
    (adapter as FakeAdapter).disconnected = true;
    const before = (adapter as FakeAdapter).calls;
    const result = await adapter.execute(correlation, { operation: 'send', message: 'synthetic' });
    assert.equal(result.status, 'transport_error');
    f.runs.transition(f.scope, record.id, 'transport_error', 1003);
    assert.equal((adapter as FakeAdapter).calls, before + 1);
    assert.throws(() => f.runs.claimResponse(f.scope, record.id, request.id, { kind: 'approval', decision: 'approve' }, () => 1004));
  } finally { await f.storage.close(); }
});

test('restart invalidates pending requests without a transport or implicit approval', async () => {
  const f = await fixture();
  try {
    const record = f.runs.createRun(f.scope, 1000);
    f.runs.transition(f.scope, record.id, 'running', 1001);
    const request = f.runs.request(f.scope, record.id, 'approval', 3000, 1002);
    assert.equal(f.runs.recoverDisconnected(1003), 1);
    assert.equal(f.runs.recoverDisconnected(1004), 0);
    assert.equal(f.runs.getRun(record.id)!.state, 'transport_error');
    assert.throws(() => f.runs.claimResponse(f.scope, record.id, request.id, { kind: 'approval', decision: 'approve' }, () => 1005));
  } finally { await f.storage.close(); }
});
