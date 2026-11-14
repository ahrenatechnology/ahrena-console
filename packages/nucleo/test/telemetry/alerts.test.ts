// The machine's alerts (#175/AC-3): load above the core count for 5 min, a volume above 85%, a port
// on all interfaces, a busy tunnel port; and the transition (enter, exit) that goes to /api/changes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AlertTracker, computeAlerts, formatBytes, loadHighSince, machineUnreachableAlert } from '../../src/telemetry/alerts.ts';
import { UNREACHABLE_REASONS, type TelemetryReading } from '../../src/telemetry/model.ts';
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

describe('#388 the alert of a remote that refuses the owner proof', () => {
  test('AC1 · 388-4: the title says "sem acesso" for the three owner-proof reasons and "sem conexão" for the tunnel down and the core not answering', () => {
    const titles = Object.fromEntries(UNREACHABLE_REASONS.map((r) => [r, machineUnreachableAlert('Workstation', 14720, r, iso(T0)).message]));
    assert.deepEqual(titles, {
      'port-closed': 'Workstation sem conexão',
      'no-response': 'Workstation sem conexão',
      'owner-auth-required': 'Workstation sem acesso',
      'owner-auth-failed': 'Workstation sem acesso',
      'owner-auth-mismatch': 'Workstation sem acesso',
    });
  });

  for (const reason of UNREACHABLE_REASONS) {
    const level = reason === 'owner-auth-required' ? 'warning' : 'error';
    test(`AC1 · 388-4: ${reason} raises the alert at level ${level} (yellow to configure, red for a failure)`, () => {
      assert.equal(machineUnreachableAlert('Workstation', 14720, reason, iso(T0)).level, level);
    });
  }

  test('AC3 · 388-4: the alert of each reason names no credential, key or command output', () => {
    for (const r of UNREACHABLE_REASONS) {
      const a = machineUnreachableAlert('Workstation', 14720, r, iso(T0));
      assert.doesNotMatch(`${a.message} ${a.detail}`, /token|Bearer|BEGIN|secret|stderr|ssh -/i, r);
    }
  });
});

const memory = (over: Partial<TelemetryReading['memory']>) => reading({ memory: { ...reading().memory, ...over } });
const GB = 1e9;
const swapOf = (usedGb: number, totalGb: number | null) => memory({ swapTotalBytes: totalGb === null ? null : totalGb * GB, swapUsedBytes: usedGb * GB });
const memoryAlerts = (r: TelemetryReading) => computeAlerts(r, []).filter((a) => a.kind === 'memory-high');
const swapAlerts = (r: TelemetryReading) => computeAlerts(r, []).filter((a) => a.kind === 'swap-high');

describe('#564/AC-1 swap-high error', () => {
  test('#564/AC-1 swap at 93% opens swap-high error with used and total in the detail', () => {
    const [a, ...rest] = swapAlerts(swapOf(19, 20.4));
    assert.equal(rest.length, 0);
    assert.equal(a.id, 'swap-high');
    assert.equal(a.level, 'error');
    assert.equal(a.detail, '19 GB de 20,4 GB usados (93%)');
    assert.equal(a.since, iso(T0));
  });

  test('#564/AC-1 swap at exactly 90% is already error', () => {
    assert.equal(swapAlerts(swapOf(18, 20))[0]?.level, 'error');
  });
});

describe('#564/AC-2 swap-high warning and none', () => {
  test('#564/AC-2 swap between 80% and 90% opens swap-high warning, exactly 80% included', () => {
    assert.equal(swapAlerts(swapOf(16, 20))[0]?.level, 'warning');
    assert.equal(swapAlerts(swapOf(17.9, 20))[0]?.level, 'warning');
  });

  test('#564/AC-2 swap below 80% opens nothing', () => {
    assert.deepEqual(swapAlerts(swapOf(15.9, 20)), []);
  });

  test('#564/AC-2 swap total 0 or unknown opens nothing', () => {
    assert.deepEqual(swapAlerts(swapOf(0, 0)), []);
    assert.deepEqual(swapAlerts(swapOf(5, null)), []);
    assert.deepEqual(swapAlerts(memory({ swapTotalBytes: 20 * GB, swapUsedBytes: null })), []);
  });
});

describe('#564/AC-3 memory-high by pressure', () => {
  test('#564/AC-3 pressure critical opens memory-high error, warning opens warning, normal opens nothing', () => {
    const low = { totalBytes: 36 * GB, usedBytes: 10 * GB };
    const [c] = memoryAlerts(memory({ ...low, pressure: 'critical' }));
    assert.equal(c.id, 'memory-high');
    assert.equal(c.level, 'error');
    assert.equal(memoryAlerts(memory({ ...low, pressure: 'warning' }))[0]?.level, 'warning');
    assert.deepEqual(memoryAlerts(memory({ ...low, pressure: 'normal' })), []);
  });

  test('#564/AC-3 pressure normal wins over a high used percentage', () => {
    assert.deepEqual(memoryAlerts(memory({ totalBytes: 36 * GB, usedBytes: 35 * GB, pressure: 'normal' })), []);
  });
});

describe('#564/AC-4 memory-high by percentage without pressure', () => {
  const noPressure = (usedGb: number) => memory({ totalBytes: 100 * GB, usedBytes: usedGb * GB, pressure: null });

  test('#564/AC-4 exactly 90% opens warning and exactly 95% opens error', () => {
    assert.equal(memoryAlerts(noPressure(90))[0]?.level, 'warning');
    assert.equal(memoryAlerts(noPressure(94.9))[0]?.level, 'warning');
    assert.equal(memoryAlerts(noPressure(95))[0]?.level, 'error');
  });

  test('#564/AC-4 below 90% opens nothing, and a zero total opens nothing', () => {
    assert.deepEqual(memoryAlerts(noPressure(89.9)), []);
    assert.deepEqual(memoryAlerts(memory({ totalBytes: 0, usedBytes: 0, pressure: null })), []);
  });

  test('#564/AC-4 the detail carries used and total', () => {
    assert.equal(memoryAlerts(noPressure(96))[0]?.detail, '96 GB de 100 GB usados (96%)');
  });
});
