// The machine's alerts (#175/AC-3): load above the core count for 5 min, a volume above 85%, a port
// on all interfaces, a busy tunnel port; and the transition (enter, exit) that goes to /api/changes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AlertTracker, computeAlerts, formatBytes, loadHighSince } from '../../src/telemetry/alerts.ts';
import { iso, point, reading, T0 } from './reading.ts';

const MIN = 60_000;
const highPoints = (n: number, load1 = 20) => Array.from({ length: n }, (_, i) => point(T0 - i * 30_000, { load1 }));

describe('#175/AC-3 alerts over the samples', () => {
  test('load above the cores for 5 min enters; for 4.5 min not yet', () => {
    const r = reading({ cpu: { cores: 12, model: null, usedPct: 99, load: { one: 20, five: 18, fifteen: 10 } } });
    assert.deepEqual(computeAlerts(r, highPoints(10)).map((a) => a.id), []); // 0 to 4.5 min
    const [a] = computeAlerts(r, highPoints(11)); // 0 to 5 min
    assert.equal(a.id, 'load-high');
    assert.equal(a.level, 'error');
    assert.equal(a.message, 'CPU saturada: carga de 20 em 12 núcleos');
    assert.equal(a.since, iso(T0 - 5 * MIN));
  });

  test('one sample below in the middle resets the count', () => {
    const pts = highPoints(14);
    pts[3] = point(T0 - 3 * 30_000, { load1: 4 });
    assert.equal(loadHighSince(pts), T0 - 2 * 30_000);
    const r = reading({ cpu: { cores: 12, model: null, usedPct: 99, load: { one: 20, five: 18, fifteen: 10 } } });
    assert.equal(computeAlerts(r, pts).length, 0);
  });

  test('volume above 85% and the pt-BR text', () => {
    const r = reading({
      disk: {
        volumes: [
          { mount: '/', totalBytes: 170e9, usedBytes: 146e9, freeBytes: 24e9, usedPct: 85.9 },
          { mount: '/home', totalBytes: 492e9, usedBytes: 109e9, freeBytes: 383e9, usedPct: 22 },
          { mount: '/dados', totalBytes: 100e9, usedBytes: 85e9, freeBytes: 15e9, usedPct: 85 },
        ],
      },
    });
    const as = computeAlerts(r, []);
    assert.deepEqual(as.map((a) => a.id), ['volume-full:/']);
    assert.equal(as[0].message, 'O volume / passou de 85%');
    assert.equal(as[0].detail, '146 GB de 170 GB usados (86%) · 24 GB livres');
  });

  test('port on all interfaces, once per port (IPv4 and IPv6); loopback does not', () => {
    const r = reading({
      ports: [
        { port: 5432, interface: 'all', address: null, process: 'postgres', pid: 10 },
        { port: 5432, interface: 'all', address: null, process: 'postgres', pid: 10 },
        { port: 4720, interface: 'loopback', address: null, process: 'node', pid: 11 },
        { port: 22, interface: 'all', address: null, process: null, pid: null },
      ],
    });
    const as = computeAlerts(r, []);
    assert.deepEqual(as.map((a) => a.id), ['port-exposed:22', 'port-exposed:5432']);
    assert.equal(as[1].message, 'A porta 5432 escuta em todas as interfaces');
    assert.equal(as[1].detail, 'postgres · qualquer um na rede alcança');
  });

  test('busy tunnel port', () => {
    const r = reading({
      tunnels: [
        {
          pid: 40,
          destination: 'ws-exemplo',
          since: null,
          ports: [
            { localPort: 14720, remoteHost: '127.0.0.1', remotePort: 4720, state: 'up', heldBy: null },
            { localPort: 18080, remoteHost: '127.0.0.1', remotePort: 8080, state: 'busy', heldBy: 'node' },
          ],
        },
      ],
    });
    const as = computeAlerts(r, []);
    assert.deepEqual(as.map((a) => a.id), ['tunnel-busy:18080']);
    assert.equal(as[0].message, 'A porta 18080 do túnel está ocupada');
    assert.match(as[0].detail ?? '', /^node deste Mac segura a porta/);
  });

  test('an absent group produces no alert and no error', () => {
    assert.deepEqual(computeAlerts(reading({ ports: null, tunnels: null, disk: { volumes: [] } }), []), []);
  });

  test('the tracker says what entered and what exited and keeps the `since` of what continues', () => {
    const t = new AlertTracker();
    const r1 = reading({ ports: [{ port: 5432, interface: 'all', address: null, process: 'postgres', pid: 1 }] }, T0);
    const u1 = t.update('local', computeAlerts(r1, []));
    assert.deepEqual(u1.entered.map((a) => a.id), ['port-exposed:5432']);
    assert.deepEqual(u1.exited, []);

    const r2 = reading({ ports: [{ port: 5432, interface: 'all', address: null, process: 'postgres', pid: 1 }] }, T0 + 30_000);
    const u2 = t.update('local', computeAlerts(r2, []));
    assert.deepEqual(u2.entered, []);
    assert.equal(u2.active[0].since, iso(T0));

    const u3 = t.update('local', computeAlerts(reading({}, T0 + 60_000), []));
    assert.deepEqual(u3.exited.map((a) => a.id), ['port-exposed:5432']);
    assert.deepEqual(t.active('local'), []);
    assert.deepEqual(t.active('workstation'), []);
  });

  test('formatBytes in units of 1000, with a comma', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1.85e12), '1,9 TB');
    assert.equal(formatBytes(146e9), '146 GB');
  });
});
