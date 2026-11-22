/* The `processes-by-session` section through the use case (#722, #720): the alert kind asks for it, and the shaping is the use case's. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diagnose, shape, type CollectContext, type DiagnoseDeps, type SectionCollector } from './diagnose.ts';
import { sectionsFor, type SectionId, type SessionLoadItem } from './model.ts';
import type { Alert } from '../telemetry/model.ts';

const NOW = '2026-11-21T12:00:00.000Z';
const loadHigh: Alert = { id: 'load-high', kind: 'load-high', level: 'warning', message: 'm', detail: null, since: NOW };
const load = (n: number, cpuPct: number): SessionLoadItem => ({ sessionId: `s${n}`, title: null, rootCommand: 'pnpm test', cwd: '/w', processCount: 2, cpuPct });

type Loose = (id: SectionId, context: CollectContext) => Promise<unknown>;
const deps = (collect: Loose): DiagnoseDeps => ({ alerts: { active: () => [loadHigh] }, isKnownMachine: () => true, collect: collect as SectionCollector, platform: 'darwin', log: () => {}, now: () => NOW, sectionTimeoutMs: 50 });

describe('processes-by-session in the diagnosis', () => {
  test('#720/AC-1 Given load-high, Then the sections are processes-by-cpu and processes-by-session, in that order, on both OSes', () => {
    assert.deepEqual(sectionsFor('load-high', 'darwin'), ['processes-by-cpu', 'processes-by-session']);
    assert.deepEqual(sectionsFor('load-high', 'linux'), ['processes-by-cpu', 'processes-by-session']);
  });

  test('#720/AC-1 Given 12 sessions, Then at most 10 come back, ordered by summed CPU, and the outside-session line comes apart from them', async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => load(i, (i * 37) % 101));
    const collect: Loose = async (id) => (id === 'processes-by-session' ? { items: sessions, outsideSession: { processCount: 4, cpuPct: 33.3 } } : []);
    const r = await diagnose({ machine: 'local', alertId: 'load-high' }, deps(collect));
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    const section = r.diagnosis.sections.find((s) => s.id === 'processes-by-session');
    assert.ok(section && section.id === 'processes-by-session');
    assert.equal(section.status, 'ok');
    assert.equal(section.items.length, 10);
    const cpu = section.items.map((s) => s.cpuPct);
    assert.deepEqual(cpu, [...cpu].sort((a, b) => b - a));
    assert.equal(Math.max(...cpu), Math.max(...sessions.map((s) => s.cpuPct)));
    assert.deepEqual(section.outsideSession, { processCount: 4, cpuPct: 33.3 });
  });

  test('#720/AC-1 Given a collector with no outside line, Then the section carries none', async () => {
    const collect: Loose = async (id) => (id === 'processes-by-session' ? [load(1, 5)] : []);
    const r = await diagnose({ machine: 'local', alertId: 'load-high' }, deps(collect));
    if (r.kind !== 'ok') return assert.fail('not ok');
    const section = r.diagnosis.sections.find((s) => s.id === 'processes-by-session');
    assert.ok(section && !('outsideSession' in section));
  });

  test('#720/AC-1 shape sorts sessions by CPU, highest first', () => {
    assert.deepEqual(shape('processes-by-session', [load(1, 1), load(2, 9), load(3, 5)]).map((s) => s.sessionId), ['s2', 's3', 's1']);
  });
});
