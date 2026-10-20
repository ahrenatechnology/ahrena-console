// The `/api/overview` probe (#86) recognises the core by `name` (#173 phase 2b) and, on an older
// core, by `nome`. Fake servers on free ports: never 4720.

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

describe('#173 phase 2b: probing /api/overview', () => {
  test('the current core: name and version (with nome and versao alongside)', async () => {
    const port = await answer({ ok: true, name: 'ahrena-console', version: '0.2.0', pid: 42, commit: 'abc', nome: 'ahrena-console', versao: '0.2.0' });
    assert.deepEqual(await probe(port), { name: 'ahrena-console', version: '0.2.0', pid: 42, commit: 'abc' });
  });

  test('only name and version: the phase 6 core', async () => {
    const port = await answer({ ok: true, name: 'ahrena-console', version: '0.3.0', pid: 7, commit: null });
    assert.deepEqual(await probeCore(port), { name: 'ahrena-console', version: '0.3.0', pid: 7, commit: null });
  });

  test('an old core: only nome and versao', async () => {
    const port = await answer({ ok: true, nome: 'ahrena-console', versao: '0.1.0', pid: 9 });
    assert.deepEqual(await probeCore(port), { name: 'ahrena-console', version: '0.1.0', pid: 9, commit: null });
  });

  test('another service is not the core', async () => {
    const port = await answer({ name: 'outro' });
    assert.equal(await probeCore(port), null);
  });
});
