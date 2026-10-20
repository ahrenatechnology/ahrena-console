// Os alertas da máquina (#175/AC-3): carga acima dos núcleos por 5 min, volume acima de 85%, porta
// em todas as interfaces, porta do túnel ocupada; e a passagem (entra, sai) que vai para /api/mudancas.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AlertTracker, computeAlerts, formatBytes, loadHighSince } from '../../src/telemetry/alerts.ts';
import { iso, point, reading, T0 } from './reading.ts';

const MIN = 60_000;
const altas = (n: number, load1 = 20) => Array.from({ length: n }, (_, i) => point(T0 - i * 30_000, { load1 }));

describe('#175/AC-3 alertas sobre as amostras', () => {
  test('carga acima dos núcleos há 5 min entra; há 4,5 min ainda não', () => {
    const r = reading({ cpu: { cores: 12, model: null, usedPct: 99, load: { one: 20, five: 18, fifteen: 10 } } });
    assert.deepEqual(computeAlerts(r, altas(10)).map((a) => a.id), []); // 0 a 4,5 min
    const [a] = computeAlerts(r, altas(11)); // 0 a 5 min
    assert.equal(a.id, 'load-high');
    assert.equal(a.level, 'error');
    assert.equal(a.message, 'CPU saturada: carga de 20 em 12 núcleos');
    assert.equal(a.since, iso(T0 - 5 * MIN));
  });

  test('uma amostra abaixo no meio zera a contagem', () => {
    const pts = altas(14);
    pts[3] = point(T0 - 3 * 30_000, { load1: 4 });
    assert.equal(loadHighSince(pts), T0 - 2 * 30_000);
    const r = reading({ cpu: { cores: 12, model: null, usedPct: 99, load: { one: 20, five: 18, fifteen: 10 } } });
    assert.equal(computeAlerts(r, pts).length, 0);
  });

  test('volume acima de 85% e o texto em pt-BR', () => {
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

  test('porta em todas as interfaces, uma vez por porta (IPv4 e IPv6); loopback não', () => {
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

  test('porta do túnel ocupada', () => {
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

  test('grupo ausente não gera alerta nem erro', () => {
    assert.deepEqual(computeAlerts(reading({ ports: null, tunnels: null, disk: { volumes: [] } }), []), []);
  });

  test('o tracker diz o que entrou e o que saiu e mantém o `since` de quem continua', () => {
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

  test('formatBytes em unidades de 1000, com vírgula', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1.85e12), '1,9 TB');
    assert.equal(formatBytes(146e9), '146 GB');
  });
});
