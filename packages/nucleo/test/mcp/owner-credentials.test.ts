import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readOwnerToken } from '../../src/mcp/owner-credentials.ts';
import { httpBridge } from '../../src/mcp/stdio.ts';

test('owner credentials reject broad permissions, wrong identity and symlinks, and reload rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrena-owner-client-'));
  const file = join(dir, 'nucleo.json');
  const first = 'a'.repeat(64), next = 'b'.repeat(64);
  const save = (token: string) => writeFileSync(file, JSON.stringify({ port: 4321, pid: 123, token }), { mode: 0o600 });
  try {
    save(first);
    assert.equal(readOwnerToken(dir, 4321, 123), first);
    assert.equal(readOwnerToken(dir, 4322, 123), null);
    assert.equal(readOwnerToken(dir, 4321, 124), null);
    chmodSync(file, 0o644);
    assert.equal(readOwnerToken(dir, 4321), null);
    chmodSync(file, 0o600);
    save(next);
    assert.equal(readOwnerToken(dir, 4321), next);
    chmodSync(dir, 0o755);
    assert.equal(readOwnerToken(dir, 4321), null);
    chmodSync(dir, 0o700);
    rmSync(file);
    symlinkSync('/dev/null', file);
    assert.equal(readOwnerToken(dir, 4321), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bridge carries owner proof in headers only, refuses missing proof and disallows redirects', async () => {
  let token: string | null = 'a'.repeat(64);
  let calls = 0;
  const bridge = httpBridge('http://127.0.0.1:4321/mcp', {
    ownerToken: () => token,
    withoutCore: async () => null,
    fetcher: async (url, init) => {
      calls++;
      assert.equal(String(url), 'http://127.0.0.1:4321/mcp');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      assert.equal(init?.redirect, 'error');
      assert.ok(!String(init?.body).includes(token!));
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}');
    },
  });
  await bridge({ jsonrpc: '2.0', id: 1, method: 'ping' });
  token = null;
  await bridge({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(calls, 1);
});
