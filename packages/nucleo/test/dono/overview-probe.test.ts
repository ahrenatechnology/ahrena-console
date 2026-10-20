// A sonda do `/api/overview` (#86) reconhece o núcleo pelo `name` (#173 fase 2b) e, num núcleo mais
// antigo, pelo `nome`. Servidores falsos em portas livres: nunca a 4720.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { ehNucleo, sondar } from '../../src/dono/index.ts';

let server: Server | null = null;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

function responder(corpo: unknown): Promise<number> {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(corpo));
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port)));
}

describe('#173 phase 2b: sondar o /api/overview', () => {
  test('o núcleo de agora: name e version (com nome e versao ao lado)', async () => {
    const porta = await responder({ ok: true, name: 'ahrena-console', version: '0.2.0', pid: 42, commit: 'abc', nome: 'ahrena-console', versao: '0.2.0' });
    assert.deepEqual(await sondar(porta), { nome: 'ahrena-console', versao: '0.2.0', pid: 42, commit: 'abc' });
  });

  test('só name e version: o núcleo da fase 6', async () => {
    const porta = await responder({ ok: true, name: 'ahrena-console', version: '0.3.0', pid: 7, commit: null });
    assert.deepEqual(await ehNucleo(porta), { nome: 'ahrena-console', versao: '0.3.0', pid: 7, commit: null });
  });

  test('um núcleo antigo: só nome e versao', async () => {
    const porta = await responder({ ok: true, nome: 'ahrena-console', versao: '0.1.0', pid: 9 });
    assert.deepEqual(await ehNucleo(porta), { nome: 'ahrena-console', versao: '0.1.0', pid: 9, commit: null });
  });

  test('outro serviço não é o núcleo', async () => {
    const porta = await responder({ name: 'outro' });
    assert.equal(await ehNucleo(porta), null);
  });
});
