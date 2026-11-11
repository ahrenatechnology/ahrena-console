// Decision 0020 (#388), layer 2, the parts of this Mac's proof that need no core: the credential command's own
// runner (a real child process: the fake SSH), the answer's parsing, `connection.credential` in machines.json,
// the renewal rules, and the two new unreachable reasons. The end-to-end half is remote-proof-e2e.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { machineUnreachableAlert } from '../../src/telemetry/alerts.ts';
import { parseMachinesConfig, type ReconnectConfig } from '../../src/telemetry/machines-config.ts';
import { UNREACHABLE_REASONS } from '../../src/telemetry/model.ts';
import type { RemoteGetResult } from '../../src/telemetry/ports.ts';
import { credentialRunner, ISSUE_BACKOFF_MS, MAX_CREDENTIAL_OUTPUT_BYTES, parseIssued, RemoteProofs, sendWithProof, signRequest, type CredentialRunner } from '../../src/telemetry/remote-proof.ts';
import { sign } from '../../src/api/remote-auth.ts';

const FAKE_SSH = new URL('./fake-ssh.mjs', import.meta.url).pathname;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const NONCE = '1'.repeat(32);
function answer(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    nonce: NONCE,
    credentialId: '2'.repeat(32),
    key: 'k'.repeat(43),
    machineIdentity: '3'.repeat(64),
    uid: 501,
    corePid: 4242,
    corePort: 4720,
    generation: '4'.repeat(32),
    issuedAt: 1_000_000,
    expiresAt: 1_600_000,
    ...over,
  };
}

function fakeSsh(script: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-ssh-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'script.json');
  const record = join(dir, 'record.jsonl');
  writeFileSync(file, JSON.stringify({ record, ...script }));
  const config: ReconnectConfig = { command: [process.execPath, FAKE_SSH, file], timeoutSeconds: 5 };
  return { config, record: () => readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string }) };
}

describe('AC3 · the credential command runs on its own runner', () => {
  test('AC3 the request goes on stdin as one JSON line, argv stays constant, stderr is discarded and a non-zero exit says only its code', async () => {
    const f = fakeSsh({ mode: 'exit', code: 12, stderr: 'secret-looking stderr\n' });
    const input = JSON.stringify({ version: 1, nonce: NONCE, revoke: [] });
    const r = await credentialRunner()(f.config, input);
    assert.deepEqual(r, { kind: 'failed', why: 'exit 12' });
    const [run] = f.record();
    assert.equal(run!.stdin, `${input}\n`);
    assert.deepEqual(run!.argv, [f.config.command[2]]);
    assert.ok(!JSON.stringify(r).includes('stderr'));
  });

  test('AC3 an answer over 4 KiB kills the command and fails as invalid-output, keeping nothing of it', async () => {
    const f = fakeSsh({ mode: 'big' });
    const r = await credentialRunner()(f.config, '{}');
    assert.deepEqual(r, { kind: 'failed', why: 'invalid-output' });
    assert.ok(MAX_CREDENTIAL_OUTPUT_BYTES === 4096);
  });

  test('AC3 a command past its timeout has its process group killed and fails as timeout', async () => {
    const f = fakeSsh({ mode: 'slow' });
    const started = Date.now();
    const r = await credentialRunner({ msPerSecond: 40 })(f.config, '{}');
    assert.deepEqual(r, { kind: 'failed', why: 'timeout' });
    assert.ok(Date.now() - started < 5_000);
  });

  test('AC3 a command that does not exist fails as spawn-error', async () => {
    const r = await credentialRunner()({ command: ['/nonexistent/ssh-for-tests'], timeoutSeconds: 5 }, '{}');
    assert.deepEqual(r, { kind: 'failed', why: 'spawn-error' });
  });
});

describe('AC4 · the issue answer', () => {
  test('AC4 an answer is accepted only for its own nonce and with every field in shape', () => {
    assert.equal(typeof parseIssued(`${JSON.stringify(answer())}\n`, NONCE), 'object');
    assert.equal(parseIssued(JSON.stringify(answer()), 'f'.repeat(32)), 'nonce-mismatch');
    for (const bad of [{ version: 2 }, { key: 'short' }, { credentialId: 'X'.repeat(32) }, { corePort: 0 }, { expiresAt: 1 }, { uid: -1 }, { machineIdentity: 'z' }]) {
      assert.equal(parseIssued(JSON.stringify(answer(bad)), NONCE), 'invalid-output', JSON.stringify(bad));
    }
    assert.equal(parseIssued('not json', NONCE), 'invalid-output');
    assert.equal(parseIssued(`${JSON.stringify(answer())}\n${JSON.stringify(answer())}`, NONCE), 'invalid-output', 'one line only');
  });

  test('AC4 the Mac signs exactly the string the remote verifier checks', () => {
    const c = answer();
    const p = { method: 'POST', target: '/api/connectors/aws/sessions/equipe/login', host: '127.0.0.1:4720', ts: 1_000_123, nonce: '5'.repeat(32), body: '{"mode":"device-code"}' };
    const header = signRequest(c, p);
    assert.match(header, /^AhrenaRemote id=2{32}, ts=1000123, nonce=5{32}, sig=[0-9a-f]{64}$/);
    assert.equal(header.split('sig=')[1], sign(c.key, { ...p, generation: c.generation }));
  });
});

describe('machines.json · connection.credential', () => {
  const machine = (credential: unknown) => JSON.stringify({ machines: [{ id: 'ws', label: 'WS', port: 14720, connection: { start: { command: ['/bin/true'] }, credential } }] });

  test('AC1 a valid credential command is read as a list with its timeout (20 s by default, 5 to 60)', () => {
    const parsed = parseMachinesConfig(machine({ command: ['/usr/bin/ssh', '-T', 'ahrena-tunnel', 'node', 'cli.ts', 'remote-credential', '--port', '4720'] }));
    assert.ok(Array.isArray(parsed));
    assert.deepEqual(parsed[0]!.connection?.credential, { command: ['/usr/bin/ssh', '-T', 'ahrena-tunnel', 'node', 'cli.ts', 'remote-credential', '--port', '4720'], timeoutSeconds: 20 });
    const sixty = parseMachinesConfig(machine({ command: ['/x'], timeoutSeconds: 60 }));
    assert.ok(Array.isArray(sixty) && sixty[0]!.connection?.credential?.timeoutSeconds === 60);
  });

  test('AC1 an invalid credential drops only that field, with a log line; the machine stays without proof', () => {
    for (const bad of [{ command: 'ssh host' }, { command: [] }, { command: ['/x'], timeoutSeconds: 4 }, { command: ['/x'], timeoutSeconds: 61 }, { command: ['a\0b'] }, 'ssh']) {
      const warnings: string[] = [];
      const parsed = parseMachinesConfig(machine(bad), (m) => warnings.push(m));
      assert.ok(Array.isArray(parsed), JSON.stringify(bad));
      assert.equal(parsed[0]!.connection?.credential, undefined);
      assert.ok(parsed[0]!.connection?.start, 'the rest of the connection stays');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /\.credential.*ignored$/);
    }
  });
});

describe('AC4 · renewal rules', () => {
  const PORT = 14720;
  function proofsWith(runner: CredentialRunner, o: { overview?: () => number | null } = {}) {
    const clock = { now: 0 };
    let issued = 0;
    const run: CredentialRunner = async (config, input) => {
      issued++;
      return runner(config, input);
    };
    const proofs = new RemoteProofs({
      machineFor: (p) => (p === PORT ? { id: 'ws', credential: { command: ['/x'], timeoutSeconds: 5 } } : undefined),
      overviewPid: async () => (o.overview ? o.overview() : 4242),
      run,
      monotonic: () => clock.now,
    });
    return { proofs, clock, issued: () => issued };
  }
  const goodRunner: CredentialRunner = async (_c, input) => {
    const { nonce } = JSON.parse(input) as { nonce: string };
    const id = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
    return { kind: 'ok', stdout: JSON.stringify(answer({ nonce, credentialId: id })) };
  };
  const refused = (reason: string, status = 401): RemoteGetResult => ({ kind: 'response', status, body: { error: 'x', reason } });

  for (const [reason, status] of [['credential-signature', 401], ['credential-busy', 429]] as const) {
    test(`AC4 a ${status} ${reason} never fires a renewal nor a repeat`, async () => {
      const t = proofsWith(goodRunner);
      let sends = 0;
      const r = await sendWithProof(t.proofs, PORT, 'GET', '/api/telemetry', null, async () => (sends++, refused(reason, status)));
      assert.equal(r.kind === 'response' && r.status, status);
      assert.equal(sends, 1);
      assert.equal(t.issued(), 1);
      await sendWithProof(t.proofs, PORT, 'GET', '/api/telemetry', null, async () => refused(reason, status));
      assert.equal(t.issued(), 1, 'still the same credential');
    });
  }

  for (const reason of ['credential-unknown', 'credential-expired', 'credential-clock']) {
    test(`AC4 a 401 ${reason} renews once and repeats the request once; refused again, the machine is owner-auth-failed`, async () => {
      const t = proofsWith(goodRunner);
      let sends = 0;
      await sendWithProof(t.proofs, PORT, 'GET', '/api/telemetry', null, async () => (sends++, refused(reason)));
      assert.equal(sends, 2);
      assert.equal(t.issued(), 2);
      assert.equal(t.proofs.reason('ws', true), 'owner-auth-failed');
      // And then it waits before the next SSH.
      await sendWithProof(t.proofs, PORT, 'GET', '/api/telemetry', null, async () => refused(reason));
      assert.equal(t.issued(), 2);
      t.clock.now += ISSUE_BACKOFF_MS[0];
      await sendWithProof(t.proofs, PORT, 'GET', '/api/telemetry', null, async () => ({ kind: 'response', status: 200, body: {} }));
      assert.equal(t.issued(), 3);
    });
  }

  test('AC4 no-response after a signed request keeps the credential: a slow tunnel never costs one SSH per poll', async () => {
    const t = proofsWith(goodRunner);
    for (let i = 0; i < 5; i++) {
      await sendWithProof(t.proofs, PORT, 'GET', '/api/telemetry', null, async () => ({ kind: 'unreachable', reason: 'no-response' }));
      t.clock.now += 30_000;
    }
    assert.equal(t.issued(), 1);
    assert.ok(t.proofs.holds('ws'));
  });

  test('AC4 port-closed after a signed request drops the credential; while the overview does not answer, no SSH runs', async () => {
    let up = true;
    const t = proofsWith(goodRunner, { overview: () => (up ? 4242 : null) });
    await sendWithProof(t.proofs, PORT, 'GET', '/api/telemetry', null, async () => ({ kind: 'unreachable', reason: 'port-closed' }));
    assert.equal(t.proofs.holds('ws'), false);
    up = false;
    for (let i = 0; i < 3; i++) {
      const signed = await t.proofs.authorize(PORT, 'GET', '/api/telemetry', '');
      assert.equal(signed, null, 'sent without proof');
    }
    assert.equal(t.issued(), 1);
  });

  test('AC4 concurrent requests share one issue', async () => {
    const t = proofsWith(async (c, i) => {
      await new Promise((r) => setTimeout(r, 20));
      return goodRunner(c, i);
    });
    const all = await Promise.all([1, 2, 3, 4].map(() => t.proofs.authorize(PORT, 'GET', '/api/telemetry', '')));
    assert.equal(t.issued(), 1);
    assert.equal(new Set(all.map((s) => s?.credentialId)).size, 1);
    assert.equal(new Set(all.map((s) => s?.authorization)).size, 4, 'a fresh nonce per request');
  });

  test('AC4 a port that is not a configured machine is never signed', async () => {
    const t = proofsWith(goodRunner);
    assert.equal(await t.proofs.authorize(PORT + 1, 'GET', '/api/telemetry', ''), null);
    assert.equal(t.issued(), 0);
  });
});

describe('the two new reasons', () => {
  test('AC1 owner-auth-failed and owner-auth-mismatch are unreachable reasons with their own alert detail', () => {
    assert.ok(UNREACHABLE_REASONS.includes('owner-auth-failed'));
    assert.ok(UNREACHABLE_REASONS.includes('owner-auth-mismatch'));
    const details = UNREACHABLE_REASONS.map((r) => machineUnreachableAlert('Estação', 14720, r, '2026-11-11T12:00:00.000Z').detail);
    assert.equal(new Set(details).size, UNREACHABLE_REASONS.length, 'each reason says something different');
  });
});
