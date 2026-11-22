/*
 * The remote reading of `processes-by-session` (#722, #720): a remote core's answer goes through the same
 * shaping as a local one, and an older core that has no such section is still a diagnosis.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Alert } from '../telemetry/model.ts';
import type { RemoteGet } from '../telemetry/ports.ts';
import { createDiagnosisReader, type DiagnosisReading } from './diagnosis.ts';

const NOW = '2026-11-21T12:00:00.000Z';
const open: Alert = { id: 'load-high', kind: 'load-high', level: 'warning', message: 'm', detail: null, since: NOW };
const session = (n: number, cpuPct: unknown = n) => ({ sessionId: `s${n}`, title: null, rootCommand: 'pnpm test', cwd: '/w', processCount: 2, cpuPct });
const cpuSection = { id: 'processes-by-cpu', status: 'ok', items: [] };

function read(sections: unknown[]): Promise<DiagnosisReading> {
  const get: RemoteGet = async () => ({ kind: 'response', status: 200, body: { machine: 'local', alertId: 'load-high', kind: 'load-high', takenAt: NOW, sections } });
  const reader = createDiagnosisReader({ alerts: { active: (m: string) => (m === 'workstation' ? [open] : []) }, local: null, remote: { port: () => 14720, get } });
  return reader('workstation', 'load-high');
}
const bySession = (r: DiagnosisReading) => {
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') throw new Error('not ok');
  return r.diagnosis.sections.find((s) => s.id === 'processes-by-session');
};

describe('a remote diagnosis with processes-by-session', () => {
  test('#720/AC-1 Given 12 sessions from the remote core, Then 10 come back, ordered by CPU, with the outside line and no key the contract does not name', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ ...session(i), extra: 'x' }));
    const section = bySession(await read([cpuSection, { id: 'processes-by-session', status: 'ok', items, outsideSession: { processCount: 3, cpuPct: 12.5, leak: 'x' } }]));
    assert.ok(section && section.id === 'processes-by-session');
    assert.equal(section.items.length, 10);
    assert.deepEqual(section.items.map((s) => s.cpuPct), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    assert.ok(section.items.every((s) => !('extra' in s)));
    assert.deepEqual(section.outsideSession, { processCount: 3, cpuPct: 12.5 });
  });

  test('#720/AC-1 Given an older remote core that sends only processes-by-cpu for load-high, Then it is still a diagnosis', async () => {
    const r = await read([cpuSection]);
    assert.equal(r.kind, 'ok');
  });

  test('#720/AC-1 Given a session item of the wrong shape, Then the answer is not a diagnosis', async () => {
    const r = await read([cpuSection, { id: 'processes-by-session', status: 'ok', items: [session(1, 'lots')] }]);
    assert.equal(r.kind, 'bad-response');
  });

  test('#720/AC-1 Given a malformed outside line, Then it is dropped and the section stays', async () => {
    const section = bySession(await read([cpuSection, { id: 'processes-by-session', status: 'ok', items: [session(1)], outsideSession: { processCount: 'many' } }]));
    assert.ok(section && section.id === 'processes-by-session');
    assert.equal(section.items.length, 1);
    assert.ok(!('outsideSession' in section));
  });

  test('#720/AC-1 Given a section that did not come, Then it carries no items and no outside line', async () => {
    const section = bySession(await read([cpuSection, { id: 'processes-by-session', status: 'unavailable', items: [], reason: 'ps not found', outsideSession: { processCount: 1, cpuPct: 1 } }]));
    assert.ok(section && section.id === 'processes-by-session');
    assert.equal(section.status, 'unavailable');
    assert.ok(!('outsideSession' in section));
  });
});
