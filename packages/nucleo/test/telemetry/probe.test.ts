// A sonda de porta do túnel (#175/AC-1), contra servidores do próprio teste em 127.0.0.1: a conexão
// que fica aberta é `open` (o outro lado responde), a que fecha na hora é `closed` (o `ssh` aceitou
// e lá não havia ninguém), e a porta sem ninguém é `refused`.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { describe, test } from 'node:test';
import { systemProbe } from '../../src/telemetry/adapters/system.ts';

function listen(onConnect: (s: import('node:net').Socket) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(onConnect);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

describe('#175/AC-1 sonda de porta', () => {
  test('aberta, fechada na hora e recusada', async () => {
    const openServer = await listen(() => {});
    const closingServer = await listen((s) => s.destroy());
    const available = await listen(() => {});
    const freePort = available.port;
    await new Promise<void>((r) => available.server.close(() => r()));
    try {
      const [a, f, l] = await Promise.all([systemProbe(openServer.port), systemProbe(closingServer.port), systemProbe(freePort)]);
      assert.deepEqual([a, f, l], ['open', 'closed', 'refused']);
    } finally {
      openServer.server.close();
      closingServer.server.close();
    }
  });
});
