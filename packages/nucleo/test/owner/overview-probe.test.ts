// The `/api/overview` probe (#86) recognises the core by `name` (#173 phase 2b); the old `nome` left
// in phase 6. Fake servers on free ports: never 4720.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { probeCore, probe } from '../../src/owner/index.ts';

let server: Server | null = null;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

function answer(body: unknown): Promise<number> {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port)));
}

describe('#173: probing /api/overview', () => {
  test('the current core: name and version', async () => {
    const port = await answer({ ok: true, name: 'ahrena-console', version: '0.2.0', pid: 42, commit: 'abc' });
    assert.deepEqual(await probe(port), { name: 'ahrena-console', version: '0.2.0', pid: 42, commit: 'abc' });
  });

  test('only name and version, no commit', async () => {
    const port = await answer({ ok: true, name: 'ahrena-console', version: '0.3.0', pid: 7, commit: null });
    assert.deepEqual(await probeCore(port), { name: 'ahrena-console', version: '0.3.0', pid: 7, commit: null });
  });

  test('a core from before phase 2b (only nome and versao) is not recognised since phase 6', async () => {
    const port = await answer({ ok: true, nome: 'ahrena-console', versao: '0.1.0', pid: 9 });
    assert.equal(await probeCore(port), null);
  });

  test('another service is not the core', async () => {
    const port = await answer({ name: 'outro' });
    assert.equal(await probeCore(port), null);
  });
});
