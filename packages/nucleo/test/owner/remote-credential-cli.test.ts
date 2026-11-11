// `core remote-credential --port <n>` (decision 0020 section 1, #388): AC1 (wrong owner on the lock: exit 10, nothing
// printed, the core gets no request) and AC3 (no token, no key in stderr, the registry or the refusals).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeInstance } from '../../src/owner/registry.ts';
import { runRemoteCredential } from '../../src/owner/remote-credential.ts';
import { readOwnerToken } from '../../src/owner/lock-token.ts';
import { hex, remoteFixture, OWNER, signHeader, call, type Fixture } from '../api/remote-credential-fixture.ts';

const CLI = fileURLToPath(new URL('../../src/owner/cli.ts', import.meta.url));
const request = (o: { revoke?: string[]; nonce?: string } = {}) => JSON.stringify({ version: 1, nonce: o.nonce ?? hex(16), ...(o.revoke ? { revoke: o.revoke } : {}) });

let root: string;
let home: string;
let dataDir: string;
let f: Fixture;
let issued: number;

function lock(port: number, token = OWNER) {
  writeFileSync(join(dataDir, 'nucleo.json'), JSON.stringify({ pid: process.pid, port, token, startedAt: new Date().toISOString() }), { mode: 0o600 });
  chmodSync(join(dataDir, 'nucleo.json'), 0o600);
}
function register(port: number) {
  writeInstance({ id: `dev-${process.pid}`, installation: 'dev', pid: process.pid, port, version: '0.0.0', commit: null, dataDir, startedAt: new Date().toISOString() }, { home });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'remote-credential-'));
  home = join(root, 'home');
  dataDir = join(root, 'data');
  for (const d of [home, dataDir]) { mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700); }
  f = await remoteFixture();
  issued = 0;
  const original = f.store.issue.bind(f.store);
  f.store.issue = (o) => { issued++; return original(o); };
  lock(f.port);
  register(f.port);
});
afterEach(async () => {
  await f.close();
  rmSync(root, { recursive: true, force: true });
});

describe('AC1 · the lock decides who may ask (wrong owner exits 10 and prints nothing)', () => {
  test('AC1 a good lock issues, prints exactly one JSON line and the credential works', async () => {
    const nonce = hex(16);
    const r = await runRemoteCredential({ port: f.port, input: request({ nonce }), home });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /^\{[^\n]*\}\n$/);
    const c = JSON.parse(r.stdout);
    assert.equal(c.nonce, nonce);
    assert.equal(c.corePort, f.port);
    assert.equal((await f.signed(c, 'GET', '/api/wall')).status, 200);
    assert.ok(!r.stdout.includes(OWNER), 'the token is never relayed');
  });

  test('AC1 a lock owned by another uid exits 10, prints nothing and the core gets no request', async () => {
    const foreign = (process.getuid?.() ?? 0) + 1;
    const r = await runRemoteCredential({ port: f.port, input: request(), home, uid: foreign });
    assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 10, stdout: '' });
    assert.equal(issued, 0);
    assert.equal(readOwnerToken(dataDir, f.port, process.pid, foreign), null);
  });

  test('AC1 group or other bits on the lock file or its folder exit 10', async () => {
    for (const mode of [0o640, 0o604, 0o660]) {
      chmodSync(join(dataDir, 'nucleo.json'), mode);
      const r = await runRemoteCredential({ port: f.port, input: request(), home });
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 10, stdout: '' }, `file ${mode.toString(8)}`);
    }
    chmodSync(join(dataDir, 'nucleo.json'), 0o600);
    chmodSync(dataDir, 0o750);
    const r = await runRemoteCredential({ port: f.port, input: request(), home });
    assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 10, stdout: '' }, 'folder 750');
    assert.equal(issued, 0);
  });

  test('AC1 a symlink in place of the lock exits 10', async () => {
    const real = join(root, 'real.json');
    renameSync(join(dataDir, 'nucleo.json'), real);
    symlinkSync(real, join(dataDir, 'nucleo.json'));
    const r = await runRemoteCredential({ port: f.port, input: request(), home });
    assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 10, stdout: '' });
    assert.equal(issued, 0);
  });

  test('AC1 a lock for another port or pid, no registry entry, or an unreadable lock exits 10', async () => {
    lock(f.port + 1);
    assert.equal((await runRemoteCredential({ port: f.port, input: request(), home })).code, 10);
    lock(f.port);
    writeInstance({ id: `dev-${process.pid}`, installation: 'dev', pid: process.pid, port: f.port, version: '0.0.0', commit: null, dataDir: join(root, 'missing'), startedAt: new Date().toISOString() }, { home });
    assert.equal((await runRemoteCredential({ port: f.port, input: request(), home })).code, 10);
    register(f.port);
    assert.equal((await runRemoteCredential({ port: f.port + 7, input: request(), home })).code, 10, 'nobody of this user on that port');
    assert.equal((await runRemoteCredential({ port: f.port, input: request(), home: join(root, 'empty') })).code, 10);
    assert.equal(issued, 0);
  });

  test('AC1 an input that is not the request exits 12 before anything is read or sent', async () => {
    for (const input of ['', 'not json', '[]', '{"version":2,"nonce":"x"}', JSON.stringify({ version: 1, nonce: hex(16), revoke: ['nope'] }), JSON.stringify({ version: 1, nonce: hex(16), pad: 'x'.repeat(1100) }), JSON.stringify({ version: 1, nonce: hex(16), token: OWNER })]) {
      const r = await runRemoteCredential({ port: f.port, input, home });
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 12, stdout: '' }, input.slice(0, 20));
    }
    assert.equal((await runRemoteCredential({ port: 0, input: request(), home })).code, 12);
    assert.equal(issued, 0);
  });
});

describe('AC1 · what the core answers decides the other exit codes', () => {
  let fake: Server;
  afterEach(() => {
    fake?.closeAllConnections();
    fake?.close();
  });
  async function fakeCore(reply: (path: string) => { status: number; body: string }) {
    fake = createServer((req, res) => {
      if (req.url === '/api/overview') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ ok: true, name: 'ahrena-console', version: '0.0.1', pid: process.pid, commit: null }));
      }
      req.resume();
      const r = reply(req.url ?? '');
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
    });
    fake.listen(0, '127.0.0.1');
    await once(fake, 'listening');
    const port = (fake.address() as AddressInfo).port;
    lock(port);
    register(port);
    return port;
  }

  test('AC1 a core without the route (older than 0020) exits 11', async () => {
    const port = await fakeCore(() => ({ status: 404, body: '{"error":"não encontrado"}' }));
    const r = await runRemoteCredential({ port, input: request(), home });
    assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 11, stdout: '' });
  });

  test('AC1 a refusal, a server error or a bad answer exits 12 and relays nothing the core said', async () => {
    for (const reply of [{ status: 403, body: '{"error":"x"}' }, { status: 500, body: 'secret-text' }, { status: 200, body: 'not json' }, { status: 200, body: JSON.stringify({ version: 1, nonce: hex(16), credentialId: hex(16) }) }]) {
      fake?.closeAllConnections();
      fake?.close();
      const port = await fakeCore(() => reply);
      const r = await runRemoteCredential({ port, input: request(), home });
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 12, stdout: '' });
      assert.ok(!r.stderr.includes('secret-text'));
    }
  });

  test('AC1 an answer with another nonce is refused (exit 12)', async () => {
    const port = await fakeCore(() => ({ status: 200, body: JSON.stringify({ version: 1, nonce: hex(16), credentialId: hex(16), key: 'k'.repeat(43), machineIdentity: 'b'.repeat(64), uid: 1, corePid: 2, corePort: 3, generation: hex(16), issuedAt: 1, expiresAt: 2 }) }));
    assert.equal((await runRemoteCredential({ port, input: request(), home })).code, 12);
  });
});

describe('AC3 · nothing secret on stderr, in the registry or in a refusal (remote side)', () => {
  const encodings = (s: string) => [s, Buffer.from(s).toString('hex'), Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), Buffer.from(s).toString('base64').replace(/=+$/, '')];

  test('AC3 with a sentinel token and key, no output, registry file or error body carries them in hex, base64 or base64url', async () => {
    const sentinelToken = 'c0ffee'.repeat(10) + 'beef';
    await f.close();
    f = await remoteFixture({ token: sentinelToken, store: { random: (n) => Buffer.alloc(n, 0x5a) } });
    lock(f.port, sentinelToken);
    register(f.port);
    const sentinelKey = Buffer.alloc(32, 0x5a).toString('base64url');

    const seen: string[] = [];
    const ok = await runRemoteCredential({ port: f.port, input: request(), home });
    assert.equal(ok.code, 0);
    assert.ok(ok.stdout.includes(sentinelKey), 'the key is the one thing the answer is for');
    seen.push(ok.stderr);
    seen.push(...[10, 11, 12].map(() => ''));
    for (const [input, uid] of [[request(), (process.getuid?.() ?? 0) + 1], ['nope', undefined]] as const) {
      const r = await runRemoteCredential({ port: f.port, input, home, uid });
      seen.push(r.stdout, r.stderr);
    }
    // Every refusal body of the core, for a signed request that fails each way.
    const c = JSON.parse(ok.stdout);
    for (const ts of [f.clock.now + 60_000]) seen.push((await f.signed(c, 'GET', '/api/wall', { ts })).text);
    seen.push((await call(f.url, '/api/wall', 'GET', { authorization: signHeader(c, { method: 'GET', target: '/api/wall', host: f.host, ts: f.clock.now, key: 'x' }) })).text);
    seen.push((await f.signed(c, 'GET', '/api/changes')).text);
    seen.push((await call(f.url, '/api/wall', 'GET', { authorization: `AhrenaRemote id=${c.credentialId}` })).text);
    seen.push((await call(f.url, '/api/owner/remote-credentials', 'POST', {}, '{}')).text);
    for (const file of readdirSync(join(home, 'instances'))) seen.push(readFileSync(join(home, 'instances', file), 'utf8'));
    const all = seen.join('\n');
    for (const secret of [sentinelToken, sentinelKey]) for (const form of encodings(secret)) assert.ok(!all.includes(form), `leaked ${form.slice(0, 8)}…`);
    assert.ok(!all.includes(c.credentialId), 'no error body or registry file names a credential id');
  });

  test('AC3 the real process prints one line on stdout, a fixed message on stderr and exits with the code', async () => {
    const env = { ...process.env, AHRENA_CONSOLE_HOME: home };
    const cli = (port: number, input: string) =>
      new Promise<{ code: number; out: string; err: string }>((resolve) => {
        const child = execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'remote-credential', '--port', String(port)], { env });
        let out = '';
        let err = '';
        child.stdout!.on('data', (d) => (out += d));
        child.stderr!.on('data', (d) => (err += d));
        child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
        child.stdin!.end(input);
      });

    const good = await cli(f.port, request());
    assert.equal(good.code, 0);
    assert.equal(good.err, '');
    assert.equal(good.out.split('\n').filter(Boolean).length, 1);
    assert.equal(JSON.parse(good.out).corePort, f.port);
    assert.ok(!good.out.includes(OWNER));

    const empty = await cli(f.port, '');
    assert.deepEqual(empty, { code: 12, out: '', err: 'could not issue a credential\n' });
    const nobody = await cli(f.port + 1, request());
    assert.deepEqual(nobody, { code: 10, out: '', err: 'no core of this user on that port, or its lock is not readable\n' });
  });
});
