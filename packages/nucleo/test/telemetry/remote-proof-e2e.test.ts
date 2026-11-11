// Decision 0020 (#388), layer 2, end to end: this Mac's side of the remote owner's credential, against a FAKE SSH
// (test/telemetry/fake-ssh.mjs, a real child process that records its argv and stdin) and a FAKE core (the real
// core's server on a test port, with an injected clock, generation, pid and identity: ../api/remote-credential-fixture.ts).
// No network beyond loopback, no Workstation. Each test names the #388 acceptance criterion it covers:
//   AC1 no proof, no data, no action, forged Origin included;
//   AC2 the configured views come back after a restart or reconnect, and old proof is refused;
//   AC3 no token or key in URL, HTML, logs, argv, registry output or error text;
//   AC4 wrong machine, wrong owner, replay, expiry and reconnect.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { panelPath } from '../../src/api/machine-panel.ts';
import { remoteDetailPath } from '../../src/api/machine-sessions.ts';
import type { RemoteCredentialStoreOptions } from '../../src/api/remote-credentials.ts';
import { loopbackWrite, REMOTE_CONNECTORS_PATH } from '../../src/clouds/remote-connectors.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { loopbackGet } from '../../src/telemetry/adapters/loopback-http.ts';
import type { ReconnectConfig } from '../../src/telemetry/machines-config.ts';
import { overviewPidVia, RemoteProofs, type RemoteProof } from '../../src/telemetry/remote-proof.ts';
import { RemoteMachine } from '../../src/telemetry/remote.ts';
import { localMachine, TelemetryService } from '../../src/telemetry/service.ts';
import { call, OWNER, remoteFixture, type Fixture, type Issued } from '../api/remote-credential-fixture.ts';
import { MemoryTelemetryStore } from './doubles.ts';
import { startFakeRemote } from './fake-remote.ts';
import { reading, T0 } from './reading.ts';

const FAKE_SSH = new URL('./fake-ssh.mjs', import.meta.url).pathname;
const CREDENTIAL_TTL_MS = 10 * 60_000;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

interface Run {
  argv: string[];
  stdin: string;
  stdout: string;
}

interface Script {
  mode?: 'issue' | 'exit' | 'slow' | 'garbage' | 'big' | 'other-nonce';
  url?: string;
  code?: number;
  override?: Record<string, unknown>;
  stderr?: string;
}

/** The remote core: the real server, with a telemetry reading so a good read is `connected`. */
async function startCore(o: { store?: RemoteCredentialStoreOptions; log?: (m: string) => void } = {}): Promise<Fixture> {
  const store = new MemoryTelemetryStore();
  await store.putSample('local', reading({}, T0), 3_600_000);
  const holder: { clock?: { now: number } } = {};
  const telemetry = new TelemetryService({ store, tracker: new AlertTracker(), machines: [localMachine()], now: () => holder.clock?.now ?? T0 });
  const f = await remoteFixture({ store: o.store, api: { telemetry, ...(o.log ? { log: o.log } : {}) } });
  holder.clock = f.clock;
  cleanup.push(() => f.close());
  return f;
}

/** This Mac's side: the fake SSH as the credential command, the proof, the signed transports and the remote machine. */
async function setup(o: { core?: Fixture; port?: number; credential?: boolean; store?: RemoteCredentialStoreOptions; timeoutMs?: number } = {}) {
  const core = o.core ?? (await startCore({ store: o.store }));
  const dir = mkdtempSync(join(tmpdir(), 'remote-proof-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const scriptFile = join(dir, 'script.json');
  const recordFile = join(dir, 'record.jsonl');
  writeFileSync(recordFile, '');
  const script = (s: Script = {}) => writeFileSync(scriptFile, JSON.stringify({ record: recordFile, url: core.url, bearer: OWNER, mode: 'issue', ...s }));
  script();
  const port = o.port ?? core.port;
  const credential: ReconnectConfig = { command: [process.execPath, FAKE_SSH, scriptFile], timeoutSeconds: 10 };
  const machine = { id: 'ws', credential: o.credential === false ? null : credential };
  const mono = { now: 1_000 };
  const logs: string[] = [];
  const makeProofs = () =>
    new RemoteProofs({
      machineFor: (p) => (p === port ? machine : undefined),
      overviewPid: overviewPidVia(loopbackGet({ host: core.host })),
      monotonic: () => mono.now,
      log: (m) => logs.push(m),
    });
  const ctx = { proofs: makeProofs(), signedAttempts: 0 };
  // Counts the signed attempts (a renewal repeats a request once), and lets a test swap the proof (a Mac restart).
  const proof: RemoteProof = {
    authorize: async (...a) => {
      const s = await ctx.proofs.authorize(...a);
      if (s) ctx.signedAttempts++;
      return s;
    },
    settle: (s, r) => ctx.proofs.settle(s, r),
  };
  const timeoutMs = o.timeoutMs ?? 3_000;
  const get = loopbackGet({ proof, host: core.host, timeoutMs });
  const write = loopbackWrite({ proof, host: core.host, timeoutMs });
  const remote = new RemoteMachine({
    config: { id: 'ws', label: 'Estação', port },
    get,
    store: new MemoryTelemetryStore(),
    tracker: new AlertTracker(),
    now: () => T0,
    log: (m) => logs.push(m),
    ownerAuthReason: (id) => ctx.proofs.reason(id, machine.credential !== null),
  });
  const runs = (): Run[] =>
    readFileSync(recordFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Run);
  const issued = (i: number): Issued => JSON.parse(runs()[i]!.stdout) as Issued;
  /** Both clocks move together: the remote's wall clock and this Mac's monotonic one. */
  const tick = (ms: number) => {
    mono.now += ms;
    core.clock.now += ms;
  };
  return { core, port, dir, script, machine, mono, logs, ctx, get, write, remote, runs, issued, tick, restartMac: () => (ctx.proofs = makeProofs()) };
}

const statusOf = (r: Awaited<ReturnType<ReturnType<typeof loopbackGet>>>) => (r.kind === 'response' ? r.status : r.reason);

/** A server on the tunnel port that answers `/api/overview` as the core and keeps every other request without answering. */
async function startCapture(pid: number): Promise<{ port: number; captured: { method: string; url: string; headers: IncomingMessage['headers'] }[] }> {
  const captured: { method: string; url: string; headers: IncomingMessage['headers'] }[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/overview') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true, name: 'ahrena-console', version: '0', pid }));
    }
    captured.push({ method: req.method!, url: req.url!, headers: req.headers });
    req.resume();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { port: (server.address() as { port: number }).port, captured };
}

/** A tunnel port that forwards every request to the core unchanged, keeping the URL and headers the core received. */
async function startRecordingTunnel(core: Fixture): Promise<{ port: number; received: { url: string; headers: IncomingMessage['headers'] }[] }> {
  const received: { url: string; headers: IncomingMessage['headers'] }[] = [];
  const server: Server = createServer((req, res) => {
    received.push({ url: req.url!, headers: req.headers });
    const out = request({ host: '127.0.0.1', port: core.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode!, answer.headers);
      answer.pipe(res);
    });
    out.on('error', () => res.destroy());
    req.pipe(out);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { port: (server.address() as { port: number }).port, received };
}

describe('AC2 · configured remote views work, and come back after restart and reconnect', () => {
  test('AC2 a machine with a credential command is connected against a core that requires proof, every read signed', async () => {
    const s = await setup();
    assert.deepEqual(await s.remote.pollOnce(), { state: 'connected', reason: null, version: 1 });
    assert.equal(s.runs().length, 1, 'one SSH');
    assert.equal(s.ctx.signedAttempts, 2, 'telemetry and attention, both signed');
    assert.equal(s.core.store.liveCount(), 1);
    assert.deepEqual(s.logs.filter((l) => l.startsWith('credential')), ['credential (ws): ok']);
    // The next round reuses it: no SSH per poll.
    s.tick(30_000);
    assert.equal((await s.remote.pollOnce()).state, 'connected');
    assert.equal(s.runs().length, 1);
  });

  test('AC2 every tunnelled private read and the AWS login writes go signed and pass the closed list', async () => {
    const s = await setup();
    const targets = [
      '/api/telemetry',
      '/api/attention',
      REMOTE_CONNECTORS_PATH,
      '/api/sessions?page=1&perPage=50',
      remoteDetailPath('proj:abc', null, ''),
      remoteDetailPath('proj:abc', 'events', 'limit=10'),
      panelPath('proj:abc', new URLSearchParams({ account: 'equipe' })),
    ];
    for (const t of targets) {
      const r = await s.get(s.port, t);
      assert.ok(r.kind === 'response' && r.status !== 401 && r.status !== 403, `${t}: ${statusOf(r)}`);
    }
    for (const method of ['POST', 'DELETE'] as const) {
      const r = await s.write(s.port, method, '/api/connectors/aws/sessions/equipe-dev/login', method === 'POST' ? '{"mode":"device-code"}' : null);
      assert.ok(r.kind === 'response' && r.status !== 401 && r.status !== 403, `${method} login: ${statusOf(r)}`);
    }
    assert.equal(s.ctx.signedAttempts, targets.length + 2);
    assert.equal(s.runs().length, 1);
  });

  test('AC2 AC4 a restart of the remote core: the old proof gets credential-unknown, the Mac renews over SSH and stays connected', async () => {
    const s = await setup();
    await s.remote.pollOnce();
    const first = s.issued(0);
    s.core.store.restart();
    s.tick(30_000);
    assert.equal((await s.remote.pollOnce()).state, 'connected');
    assert.equal(s.runs().length, 2, 'one renewal');
    assert.deepEqual(JSON.parse(s.runs()[1]!.stdin).revoke, [first.credentialId], 'the dropped one is revoked');
    assert.equal(s.ctx.signedAttempts, 2 + 3, 'telemetry refused and repeated once, then attention');
    assert.equal((await s.core.signed(first, 'GET', '/api/telemetry')).json?.reason, 'credential-unknown');
  });

  test('AC2 AC4 reconnect: a start of the connection drops the credential, the next issue revokes it, and the old one is refused', async () => {
    const s = await setup();
    await s.remote.pollOnce();
    const old = s.issued(0);
    s.ctx.proofs.discard('ws');
    assert.equal(s.ctx.proofs.holds('ws'), false);
    assert.equal((await s.remote.pollOnce()).state, 'connected');
    assert.deepEqual(JSON.parse(s.runs()[1]!.stdin).revoke, [old.credentialId]);
    assert.equal((await s.core.signed(old, 'GET', '/api/telemetry')).json?.reason, 'credential-unknown');
    assert.equal(s.core.store.liveCount(), 1);
  });

  test('AC2 a restart of this Mac\'s core issues again, pins again and is connected; a fourth issue evicts the oldest', async () => {
    const s = await setup();
    await s.remote.pollOnce();
    for (let i = 0; i < 3; i++) {
      s.restartMac();
      assert.equal((await s.remote.pollOnce()).state, 'connected');
    }
    assert.equal(s.runs().length, 4);
    for (const r of s.runs()) assert.deepEqual(JSON.parse(r.stdin).revoke, [], 'a restarted Mac remembers nothing to revoke');
    assert.equal(s.core.store.liveCount(), 3, 'at most 3 live per core');
    assert.equal((await s.core.signed(s.issued(0), 'GET', '/api/telemetry')).json?.reason, 'credential-unknown');
  });

  test('AC2 AC4 expiry: past expiresAt the core says credential-expired, and the Mac renews and repeats the request once', async () => {
    const s = await setup();
    await s.remote.pollOnce();
    // The remote's clock runs past the TTL while this Mac's monotonic clock stood still (it slept).
    s.core.clock.now += CREDENTIAL_TTL_MS + 1_000;
    s.ctx.signedAttempts = 0;
    assert.equal((await s.remote.pollOnce()).state, 'connected');
    assert.equal(s.runs().length, 2);
    assert.equal(s.ctx.signedAttempts, 3, 'one refusal, one repeat, then attention');
  });

  test('AC2 AC4 renewal ahead of expiry: with less than 2 min left the Mac issues a new one before the core refuses', async () => {
    const s = await setup();
    await s.remote.pollOnce();
    s.tick(CREDENTIAL_TTL_MS - 60_000);
    s.ctx.signedAttempts = 0;
    assert.equal((await s.remote.pollOnce()).state, 'connected');
    assert.equal(s.runs().length, 2);
    assert.equal(s.ctx.signedAttempts, 2, 'no refusal, no repeat');
  });

  test('AC2 compatibility: a core older than #391 that answers 200 without proof and a CLI that exits 2 stay connected, unsigned', async () => {
    const old = await startFakeRemote({});
    cleanup.push(() => old.close());
    const core = await startCore();
    const s = await setup({ core, port: old.port });
    // Its CLI does not know `remote-credential` and exits 2.
    s.script({ mode: 'exit', code: 2 });
    const logs: string[] = [];
    // 81251bd answers its overview with its pid, so the SSH does run.
    const proofs = new RemoteProofs({ machineFor: () => s.machine, overviewPid: async () => process.pid, log: (m) => logs.push(m) });
    // The old fake core refuses any Host but its own 4720: the unsigned request keeps the default.
    const remote = new RemoteMachine({
      config: { id: 'ws', label: 'Estação', port: old.port },
      get: loopbackGet({ proof: proofs }),
      store: new MemoryTelemetryStore(),
      tracker: new AlertTracker(),
      now: () => T0,
      ownerAuthReason: (id) => proofs.reason(id, true),
    });
    assert.equal((await remote.pollOnce()).state, 'connected');
    assert.equal(s.runs().length, 1);
    assert.deepEqual(logs, ['credential (ws): failed (exit 2)']);
    assert.equal(proofs.holds('ws'), false);
    assert.ok(old.requests.length >= 2 && old.requests.every((r) => r.host === '127.0.0.1:4720'), 'unsigned, with the remote\'s own Host');
  });
});

describe('AC1 · without proof, nothing private and no fallback', () => {
  test('AC1 a machine without a credential command stays owner-auth-required against a core that requires proof', async () => {
    const s = await setup({ credential: false });
    assert.deepEqual(await s.remote.pollOnce(), { state: 'unreachable', reason: 'owner-auth-required', version: null });
    assert.equal(s.runs().length, 0);
    assert.equal(s.ctx.signedAttempts, 0);
  });

  test('AC1 a credential command that fails leaves the machine owner-auth-failed, unsigned, with no Origin or tunnel fallback', async () => {
    const s = await setup();
    for (const [script, why] of [
      [{ mode: 'exit', code: 12 }, 'failed (exit 12)'],
      [{ mode: 'garbage' }, 'failed (invalid-output)'],
      [{ mode: 'big' }, 'failed (invalid-output)'],
    ] as const) {
      s.script(script);
      s.ctx.proofs.discard('ws');
      assert.deepEqual(await s.remote.pollOnce(), { state: 'unreachable', reason: 'owner-auth-failed', version: null });
      assert.ok(s.logs.includes(`credential (ws): ${why}`), why);
    }
    assert.equal(s.ctx.signedAttempts, 0);
    assert.equal(s.core.store.liveCount(), 0);
  });

  test('AC1 a failed issue waits 30 s, 60 s, then 5 min before the next SSH', async () => {
    const s = await setup();
    s.script({ mode: 'exit', code: 12 });
    await s.remote.pollOnce();
    s.tick(29_000);
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 1, 'still waiting');
    s.tick(1_000);
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 2);
    s.tick(59_000);
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 2);
    s.tick(1_000);
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 3);
    s.tick(299_000);
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 3);
    s.tick(1_000);
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 4);
  });

  test('AC2 Tentar agora (388-2, 388-4): retryNow skips the wait once, two clicks at once cost one SSH, and a good answer brings the machine back', async () => {
    const s = await setup();
    s.script({ mode: 'exit', code: 12 });
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 1);
    s.tick(5_000);
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 1, 'inside the 30 s wait');
    await Promise.all([s.ctx.proofs.retryNow(s.port), s.ctx.proofs.retryNow(s.port)]);
    assert.equal(s.runs().length, 2, 'the wait skipped once, and the second click joined the issue in flight');
    await s.remote.pollOnce();
    assert.equal(s.runs().length, 2, 'failed again: the wait is back');
    s.script();
    await s.ctx.proofs.retryNow(s.port);
    assert.equal(s.runs().length, 3);
    assert.ok(s.ctx.proofs.holds('ws'));
    assert.equal((await s.remote.pollOnce()).state, 'connected');
    // With a credential held, a click costs no SSH.
    await s.ctx.proofs.retryNow(s.port);
    assert.equal(s.runs().length, 3);
  });

  test('AC1 Tentar agora on a machine without a credential command, or on a port that is no machine, runs nothing', async () => {
    const s = await setup({ credential: false });
    await s.ctx.proofs.retryNow(s.port);
    await s.ctx.proofs.retryNow(s.port + 1);
    assert.equal(s.runs().length, 0);
  });

  test('AC1 a signed request the Mac sent, replayed by someone else with a forged Origin, is refused', async () => {
    const core = await startCore();
    const capture = await startCapture(process.pid);
    const s = await setup({ core, port: capture.port, timeoutMs: 300 });
    await s.get(capture.port, '/api/telemetry');
    const sent = capture.captured.find((c) => c.url === '/api/telemetry')!;
    assert.equal(sent.headers.origin, undefined, 'the Mac never sends an Origin');
    const r = await call(core.url, '/api/telemetry', 'GET', { authorization: String(sent.headers.authorization), origin: `http://${core.host}` });
    assert.equal(r.status, 403);
  });
});

describe('AC4 · wrong machine, wrong owner, replay', () => {
  test('AC4 wrong machine: a later issue with another machine identity is owner-auth-mismatch, and nothing is signed', async () => {
    const s = await setup();
    await s.remote.pollOnce();
    s.script({ override: { machineIdentity: 'e'.repeat(64) } });
    s.ctx.proofs.discard('ws');
    s.ctx.signedAttempts = 0;
    assert.deepEqual(await s.remote.pollOnce(), { state: 'unreachable', reason: 'owner-auth-mismatch', version: null });
    assert.equal(s.ctx.signedAttempts, 0);
    assert.ok(s.logs.includes('credential (ws): identity-mismatch'));
    // The refused one is revoked at the next issue.
    s.script();
    s.tick(30_000);
    assert.equal((await s.remote.pollOnce()).state, 'connected');
    assert.ok(JSON.parse(s.runs().at(-1)!.stdin).revoke.includes(s.issued(1).credentialId));
  });

  test('AC4 wrong owner (Mac side): the uid changes between two issues, owner-auth-mismatch', async () => {
    const s = await setup();
    await s.remote.pollOnce();
    s.script({ override: { uid: s.issued(0).uid + 1 } });
    s.ctx.proofs.discard('ws');
    assert.deepEqual(await s.remote.pollOnce(), { state: 'unreachable', reason: 'owner-auth-mismatch', version: null });
  });

  test('AC4 wrong machine: the tunnel port leads to another core, the pid does not match, owner-auth-failed; that core refuses the credential it did not issue', async () => {
    const tunnelled = await startCore();
    const other = await startCore({ store: { corePid: 999_999 } });
    const s = await setup({ core: tunnelled });
    s.script({ url: other.url });
    s.ctx.signedAttempts = 0;
    assert.deepEqual(await s.remote.pollOnce(), { state: 'unreachable', reason: 'owner-auth-failed', version: null });
    assert.equal(s.ctx.signedAttempts, 0, 'nothing signed');
    assert.ok(s.logs.includes('credential (ws): pid-mismatch'));
    const foreign = s.issued(0);
    assert.equal((await tunnelled.signed({ ...foreign }, 'GET', '/api/telemetry')).json?.reason, 'credential-unknown');
  });

  test('AC4 replay: an answer to another nonce is owner-auth-failed', async () => {
    const s = await setup();
    s.script({ mode: 'other-nonce' });
    assert.deepEqual(await s.remote.pollOnce(), { state: 'unreachable', reason: 'owner-auth-failed', version: null });
    assert.ok(s.logs.includes('credential (ws): failed (nonce-mismatch)'));
  });

  test('AC4 replay: a request that did not arrive passes once within 10 s, then never again; after 10 s or a revoking issue it is refused', async () => {
    const core = await startCore();
    const capture = await startCapture(process.pid);
    const s = await setup({ core, port: capture.port, timeoutMs: 300 });
    const r = await s.get(capture.port, '/api/telemetry');
    assert.equal(statusOf(r), 'no-response');
    assert.ok(s.ctx.proofs.holds('ws'), 'a slow tunnel keeps the credential: no SSH per poll');
    const deliver = (c: { url: string; headers: IncomingMessage['headers'] }) => call(core.url, c.url, 'GET', { authorization: String(c.headers.authorization) });
    // Within 10 s: the declared residue, exactly once.
    const first = capture.captured.at(-1)!;
    assert.equal((await deliver(first)).status, 200);
    assert.equal((await deliver(first)).json?.reason, 'credential-replayed');
    // Another one, delivered late.
    await s.get(capture.port, '/api/telemetry');
    const late = capture.captured.at(-1)!;
    core.clock.now += 10_001;
    assert.equal((await deliver(late)).json?.reason, 'credential-clock');
    core.clock.now -= 10_001;
    // Another one, delivered after the Mac issued again with it in `revoke`.
    await s.get(capture.port, '/api/telemetry');
    const revoked = capture.captured.at(-1)!;
    s.ctx.proofs.discard('ws');
    await s.get(capture.port, '/api/telemetry');
    assert.equal(s.runs().length, 2);
    assert.equal((await deliver(revoked)).json?.reason, 'credential-unknown');
  });

  test('AC4 a closed tunnel port drops the credential and costs no SSH until the port answers again', async () => {
    const core = await startCore();
    const capture = await startCapture(process.pid);
    const s = await setup({ core, port: capture.port, timeoutMs: 300 });
    await s.get(capture.port, '/api/telemetry');
    assert.equal(s.runs().length, 1);
    // Simulates the refusal through the proof's own settle, as the transport reports it.
    s.ctx.proofs.settle({ authorization: '', host: '', machineId: 'ws', credentialId: s.issued(0).credentialId, retried: false }, { kind: 'unreachable', reason: 'port-closed' });
    assert.equal(s.ctx.proofs.holds('ws'), false);
    // Nothing answers on a fresh closed port: no issue.
    const closed = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    const s2 = await setup({ core, port: closed });
    assert.equal(statusOf(await s2.get(closed, '/api/telemetry')), 'port-closed');
    assert.equal(s2.runs().length, 0);
  });
});

describe('AC3 · no token or key leaks', () => {
  test('AC3 with sentinel keys and token, nothing leaks into argv, stdin, logs, reconnect.log, /api/machines, the /ui, the registry projection, error text or the URLs and headers the core received', async () => {
    const MAC_TOKEN = 'c0ffee00'.repeat(8);
    const keys: Buffer[] = [];
    let n = 0;
    const random = (bytes: number) => {
      const b = Buffer.alloc(bytes, 0x5a);
      b[0] = ++n;
      if (bytes === 32) keys.push(b);
      return b;
    };
    const coreLogs: string[] = [];
    const core = await startCore({ store: { random }, log: (m) => coreLogs.push(m) });
    const tunnel = await startRecordingTunnel(core);
    const s = await setup({ core, port: tunnel.port });
    s.script({ stderr: `stderr with ${MAC_TOKEN}\n` });
    const bodies: string[] = [];
    const keep = (r: Awaited<ReturnType<typeof s.get>>) => r.kind === 'response' && bodies.push(JSON.stringify(r.body ?? null));
    await s.remote.pollOnce();
    keep(await s.get(s.port, '/api/wall'));
    keep(await s.get(s.port, '/api/changes'));
    s.core.store.restart();
    keep(await s.get(s.port, '/api/telemetry'));
    s.script({ override: { machineIdentity: 'e'.repeat(64) } });
    s.ctx.proofs.discard('ws');
    await s.remote.pollOnce();
    keep(await s.get(s.port, '/api/telemetry'));

    // This Mac's core, serving the remote machine as the /ui sees it.
    const storage = openSqliteStorage({ path: ':memory:' });
    cleanup.push(() => storage.close());
    const macStore = new MemoryTelemetryStore();
    const telemetry = new TelemetryService({ store: macStore, tracker: new AlertTracker(), machines: [localMachine(), s.remote], now: () => T0 });
    const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
    const macLogs: string[] = [];
    const mac = await startLocalApi({ ownerToken: () => MAC_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log: (m) => macLogs.push(m), telemetry });
    cleanup.push(() => mac.close());
    const auth = { authorization: `Bearer ${MAC_TOKEN}` };
    const pages = [
      (await call(mac.url, '/api/machines', 'GET', auth)).text,
      (await call(mac.url, '/api/telemetry?machine=ws', 'GET', auth)).text,
      (await call(mac.url, '/ui/', 'GET', {})).text,
    ];

    assert.match(pages[0]!, /"id":"ws"/, '/api/machines lists the remote machine');
    assert.match(pages[0]!, /owner-auth-mismatch/, 'and only its reason');
    const runs = s.runs();
    assert.ok(runs.length >= 3);
    for (const r of runs) {
      assert.deepEqual(r.argv, [runs[0]!.argv[0]], 'argv is constant: only the script path');
      const req = JSON.parse(r.stdin) as Record<string, unknown>;
      assert.deepEqual(Object.keys(req).sort(), ['nonce', 'revoke', 'version']);
      assert.match(String(req.nonce), /^[0-9a-f]{32}$/);
      assert.ok((req.revoke as string[]).every((id) => /^[0-9a-f]{32}$/.test(id)));
    }
    const projections = [inspect(s.ctx.proofs, { depth: 10, showHidden: true }), JSON.stringify(s.ctx.proofs), JSON.stringify(s.remote.status()), inspect(s.remote, { depth: 4 })];
    const argvAndStdin = runs.map((r) => JSON.stringify({ argv: r.argv, stdin: r.stdin })).join('\n');
    // What the core received on the tunnel port: every URL and header, the proof header kept apart (it is the
    // AhrenaRemote one by design, and is scanned for the key below).
    assert.ok(tunnel.received.length > 0, 'the core was reached through the tunnel port');
    const proofHeaders = tunnel.received.map((r) => String(r.headers.authorization ?? ''));
    const received = tunnel.received.map((r) => JSON.stringify({ url: r.url, headers: Object.entries(r.headers).filter(([name]) => name !== 'authorization') }));
    const everything = [argvAndStdin, ...s.logs, ...coreLogs, ...macLogs, ...bodies, ...pages, ...projections, ...received, readdirSync(s.dir).join(' ')].join('\n');
    const forms = (b: Buffer) => [b.toString('hex'), b.toString('base64'), b.toString('base64url')];
    assert.ok(keys.length >= 3);
    for (const k of keys) for (const f of forms(k)) assert.ok(!everything.includes(f) && !proofHeaders.some((h) => h.includes(f)), `key leaked as ${f.slice(0, 8)}…`);
    for (const f of [MAC_TOKEN, ...forms(Buffer.from(MAC_TOKEN)), ...forms(Buffer.from(MAC_TOKEN, 'hex'))]) assert.ok(!everything.includes(f), 'the Mac token leaked');
    assert.ok(!everything.includes('AhrenaRemote'), 'no proof header anywhere');
    assert.ok(!everything.includes('stderr with'), 'the command stderr is discarded');
    assert.deepEqual(readdirSync(s.dir).sort(), ['record.jsonl', 'script.json'], 'no reconnect.log or other file from the runner');
    for (const l of s.logs.filter((x) => x.startsWith('credential'))) assert.match(l, /^credential \(ws\): (ok|failed \([a-z0-9 -]+\)|identity-mismatch|pid-mismatch|refused after renewal)$/);
  });
});
