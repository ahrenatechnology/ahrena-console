import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { authorizeOwner } from '../../src/api/owner-auth.ts';

const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
async function fixture() {
  const storage = await openSqliteStorage({ path: ':memory:' });
  let token: string | null = first;
  const changes = new ChangeCursor({ minIntervalMs: 0 });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder, hooks: { storage }, port: 0, ownerToken: () => token, changes, log: () => {} });
  return { ...api, changes, rotate: (next: string | null) => { token = next; }, close: async () => { await api.close(); await storage.close(); } };
}
function call(base: string, path: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(base + path, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('all writes fail closed without owner proof, including forged Origin and future managed routes', async () => {
  const api = await fixture();
  try {
    const routes = ['/api/hooks', '/mcp', '/api/new-session', '/open/local_00000000-0000-0000-0000-000000000000', '/api/project/move', '/api/project/selection', '/api/connections/github/start', '/api/agent-config/skill', '/api/framework-install/a/b', '/api/sessions/id/messages', '/api/sessions/id/commands', '/api/sessions/id/open', '/api/decisions/id/confirm', '/api/machines/id/reconnect', '/api/machines/id/connection/start', '/api/connectors/aws/sessions/id/login', '/api/tools/id/actions/run', '/api/ports/release', '/api/docker/actions/start', '/api/app-update/state', '/api/runtime/start', '/api/runtime/resume', '/api/runtime/send', '/api/runtime/cancel', '/api/runtime/approvals/id'];
    for (const route of routes) for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await call(api.url, route, method, { origin: api.url })).status, 403, `${method} ${route}`);
    }
    for (const authorization of ['', `Bearer ${second}`, first, `Bearer ${first}, Bearer ${first}`]) {
      assert.equal((await call(api.url, '/api/changes', 'GET', { authorization, origin: api.url })).status, 403);
    }
  } finally { await api.close(); }
});

test('private conversation, changes, MCP and unknown streams require owner proof; static GET never carries it', async () => {
  const api = await fixture();
  try {
    for (const path of ['/api/changes', '/api/events', '/api/sessions/id/conversation', '/api/panel/id', '/api/runtime/stream', '/mcp']) {
      assert.equal((await call(api.url, path, 'GET', { origin: api.url })).status, 403);
    }
    for (const path of ['/ui', '/ui/api.js', '/api/overview', '/api/hooks/health']) {
      const response = await call(api.url, path);
      assert.equal(response.status, 200);
      assert.ok(!response.text.includes(first));
    }
    assert.equal((await call(api.url, `/api/changes?token=${first}`)).status, 403);
    assert.equal((await call(api.url, '/api/changes', 'GET', { cookie: `token=${first}` })).status, 403);
  } finally { await api.close(); }
});

test('owner reads and writes retain Host and Origin defenses and missing context denies even valid bearer', async () => {
  const api = await fixture();
  try {
    const headers = { authorization: `Bearer ${first}`, origin: api.url };
    assert.equal((await call(api.url, '/api/changes?wait=0', 'GET', headers)).status, 200);
    // Reaches the actual handler: no new-session JSON body, rather than an authentication refusal.
    assert.equal((await call(api.url, '/api/new-session', 'POST', headers)).status, 415);
    for (const extra of [{ origin: 'http://evil.invalid' }, { host: 'evil.invalid' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      assert.equal((await call(api.url, '/api/changes', 'GET', { ...headers, ...extra })).status, 403);
    }
    api.rotate(null);
    assert.equal((await call(api.url, '/api/changes', 'GET', headers)).status, 403);
  } finally { await api.close(); }
});

test('expiration closes an active private long poll; reconnect requires the fresh owner context', async () => {
  const api = await fixture();
  try {
    const old = { authorization: `Bearer ${first}` };
    const pending = call(api.url, `/api/changes?since=${encodeURIComponent(api.changes.current)}&wait=25`, 'GET', old);
    const aborted = assert.rejects(pending);
    for (let n = 0; n < 100 && api.changes.openWaits === 0; n++) await new Promise(r => setTimeout(r, 5));
    assert.equal(api.changes.openWaits, 1);
    api.rotate(null);
    await aborted;
    assert.equal((await call(api.url, '/api/changes?wait=0', 'GET', old)).status, 403);
    api.rotate(second);
    assert.equal((await call(api.url, '/api/changes?wait=0', 'GET', old)).status, 403);
    assert.equal((await call(api.url, '/api/changes?wait=0', 'GET', { authorization: `Bearer ${second}` })).status, 200);
  } finally { await api.close(); }
});

test('revocation blocks every private stream body boundary after headers have already been sent', async () => {
  for (const boundary of ['write', 'end'] as const) {
    let token: string | null = first;
    const server = createServer((req, res) => {
      const port = (server.address() as AddressInfo).port;
      if (!authorizeOwner(req, res, port, () => token)) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      // Revoke synchronously with the body operation, before the revocation timer can run.
      setImmediate(() => {
        token = null;
        if (boundary === 'write') {
          res.write('data: PRIVATE_AFTER_REVOCATION\n\n');
          res.end();
        } else {
          res.end('data: PRIVATE_AFTER_REVOCATION\n\n');
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const port = (server.address() as AddressInfo).port;
      const received = await new Promise<string>((resolve, reject) => {
        const req = request(`http://127.0.0.1:${port}/private-stream`, { headers: { authorization: `Bearer ${first}` } }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('error', () => resolve(body));
          res.on('close', () => resolve(body));
        });
        req.on('error', err => {
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve('');
          else reject(err);
        });
        req.end();
      });
      assert.equal(received, '', `${boundary} must not send data after owner revocation`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  }
});

test('no-lock bootstrap accepts only an explicit private owner file', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readOwnerTokenFile } = await import('../../src/api/owner-auth.ts');
  const dir = mkdtempSync(join(tmpdir(), 'owner-bootstrap-'));
  const file = join(dir, 'owner-token');
  try {
    writeFileSync(file, first, { mode: 0o600 });
    assert.equal(readOwnerTokenFile(file), first);
    assert.equal(readOwnerTokenFile(undefined), null);
    assert.equal(readOwnerTokenFile(dir), null);
    chmodSync(file, 0o644);
    assert.equal(readOwnerTokenFile(file), null);
    chmodSync(file, 0o600);
    symlinkSync(file, join(dir, 'alias'));
    assert.equal(readOwnerTokenFile(join(dir, 'alias')), null);
    writeFileSync(file, 'invalid');
    assert.equal(readOwnerTokenFile(file), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('owner UI sends native-bootstrap proof in headers for reads and writes, never in URLs', async () => {
  const { httpReader, httpWriter } = await import('../../ui/api.js');
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const previous = globalThis.__AHRENA_OWNER_TOKEN__;
  globalThis.__AHRENA_OWNER_TOKEN__ = first;
  try {
    const fetch = async (url: URL, options: RequestInit) => {
      seen.push({ url: String(url), headers: options.headers as Record<string, string> });
      return new Response('{}', { status: 200 });
    };
    await httpReader({ base: 'http://127.0.0.1:4720', fetch })('/api/changes');
    await httpWriter({ base: 'http://127.0.0.1:4720', fetch })('/api/new-session', {});
    assert.equal(seen.length, 2);
    for (const request of seen) {
      assert.equal(request.headers.authorization, `Bearer ${first}`);
      assert.ok(!request.url.includes(first));
    }
  } finally {
    if (previous === undefined) delete globalThis.__AHRENA_OWNER_TOKEN__;
    else globalThis.__AHRENA_OWNER_TOKEN__ = previous;
  }
});
