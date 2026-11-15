// registerRequest against fakes for the ports (#618, layer 2).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EXPIRY_MS, PermissionRefusal } from '../../src/permissions/model.ts';
import { DigestMismatch } from '../../src/permissions/errors.ts';
import { registerRequest } from '../../src/permissions/register-request.ts';
import { harness, registerInput, T0 } from './fakes.ts';

const SECRET = 'DATABASE_URL=postgres://u:hunter2pw@h/db npm run migrate';

describe('registerRequest (#618/AC-1, AC-7)', () => {
  test('#618/AC-1: a matching digest stores the request pending, with a new id and the expiry', async () => {
    const h = harness();
    const out = await registerRequest(h, await registerInput());
    assert.deepEqual(out, { requestId: 'rq-1', expiresAt: T0 + EXPIRY_MS });
    const stored = h.repository.find('S1', 'rq-1');
    assert.equal(stored?.state, 'pending');
    assert.equal(stored?.terminalOnly, false);
  });

  test('#618/AC-1: a digest that is not the one the core recomputes is refused and nothing is stored', async () => {
    const h = harness();
    const input = await registerInput();
    await assert.rejects(registerRequest(h, { ...input, digest: '0'.repeat(64) }), DigestMismatch);
    await assert.rejects(registerRequest(h, { ...input, sessionId: 'S2' }), DigestMismatch);
    await assert.rejects(registerRequest(h, { ...input, toolInput: { command: 'rm x' } }), DigestMismatch);
    assert.equal(h.repository.requests.size, 0);
    assert.deepEqual(h.audit.records.map((r) => [r.event, r.code]), [['refused', 'digest_mismatch'], ['refused', 'digest_mismatch'], ['refused', 'digest_mismatch']]);
  });

  test('#618/AC-1: an input nested too deep is refused by the domain and nothing is stored', async () => {
    const h = harness();
    let deep: unknown = 'x';
    for (let i = 0; i < 70; i += 1) deep = { a: deep };
    await assert.rejects(registerRequest(h, { sessionId: 'S1', toolName: 'Bash', toolInput: deep, cwd: '/w', permissionMode: null, digest: 'x' }), (e: unknown) => e instanceof PermissionRefusal && e.code === 'input_too_deep');
    assert.equal(h.repository.requests.size, 0);
  });

  test('#618/AC-7: only the redacted summary is kept, never the raw tool input', async () => {
    const h = harness();
    await registerRequest(h, await registerInput({ toolInput: { command: SECRET } }));
    const stored = h.repository.find('S1', 'rq-1');
    assert.ok(stored);
    assert.doesNotMatch(stored.summary, /hunter2pw/);
    assert.doesNotMatch(JSON.stringify(stored), /hunter2pw/);
    assert.equal(stored.terminalOnly, true, 'a mask acted on a Bash call');
  });

  test('#618/AC-6: the terminalOnly flag is stored with the request', async () => {
    const h = harness();
    await registerRequest(h, await registerInput({ toolInput: { command: 'git push --force' } }));
    assert.equal(h.repository.find('S1', 'rq-1')?.terminalOnly, true);
  });

  test('#618/AC-7: the audit records the registration without the input, the summary or the secret', async () => {
    const h = harness();
    await registerRequest(h, await registerInput({ toolInput: { command: SECRET } }));
    assert.equal(h.audit.records.length, 1);
    const [rec] = h.audit.records;
    assert.equal(rec?.event, 'registered');
    assert.equal(rec?.requestId, 'rq-1');
    const text = JSON.stringify(rec);
    assert.doesNotMatch(text, /hunter2pw|migrate|toolInput|summary/);
  });

  test('#618/AC-1: the change feed is told, with no input', async () => {
    const h = harness();
    await registerRequest(h, await registerInput());
    assert.deepEqual(h.notifier.published, [{ sessionId: 'S1', requestId: 'rq-1', state: 'pending' }]);
  });

  test('#618/AC-1: two identical calls of one session are two requests with two ids', async () => {
    const h = harness();
    const a = await registerRequest(h, await registerInput());
    const b = await registerRequest(h, await registerInput());
    assert.notEqual(a.requestId, b.requestId);
    assert.equal(h.repository.requests.size, 2);
  });
});
