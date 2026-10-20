// The tunnel port probe (#175/AC-1), against the test's own servers on 127.0.0.1: a connection that
// stays open is `open` (the other side answers), one that closes at once is `closed` (`ssh` accepted
// and nobody was there), and a port with nobody listening is `refused`.
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

describe('#175/AC-1 port probe', () => {
  test('open, closed at once and refused', async () => {
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
