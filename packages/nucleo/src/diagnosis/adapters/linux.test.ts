/*
 * The Linux `processes-by-session` collector (#722, #720): `procStart` is field 22 of `/proc/<pid>/stat`, read through the
 * injected file reader, so no real process is read.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DiagnosisDeps, DiagnosisFs } from './common.ts';
import { LinuxDiagnosisCollector } from './linux.ts';

const SESSION = '0413a6d2-3b1c-4c0e-9d3a-6f1f0a2b7c11';
const CLAUDE_START = 'Sat Nov 21 21:00:00 2026';
const CWD = '/home/dev/work/spdx-307';

/** claude(67562) -> pnpm test (67580) -> 11 workers: 13 processes, and a server that descends from no session (#722). */
function psTree(): string {
  const row = (pid: number, ppid: number, cpu: number, command: string) => `${pid} ${ppid} ${cpu.toFixed(1)} ${CLAUDE_START} ${command}`;
  return [
    row(67562, 1, 0, 'claude --resume 0413a6d2'),
    row(67580, 67562, 0, 'node /opt/pnpm/pnpm.cjs test'),
    ...Array.from({ length: 11 }, (_, i) => row(67600 + i, 67580, 50, 'node worker.js')),
    row(300, 1, 30, 'node server.js'),
  ].join('\n');
}

const ctx = () => ({ mount: null, signal: new AbortController().signal });

describe('processes-by-session collector on Linux', () => {
  const TICKS = '480890526';
  /* Field 3 onward of /proc/<pid>/stat, starttime being the 20th. (#722) */
  const stat = (pid: number, ticks: string) => `${pid} (claude code) S 1 1 1 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 ${ticks} 123456 789 18446744073709551615\n`;

  function linux(files: Record<string, string | null>, procStart: string | null = TICKS) {
    const fs: DiagnosisFs = { isDirectory: async () => false, listDirs: async () => [], modifiedAtMs: async () => null, stamp: async () => null, exists: async () => false };
    const reads: string[] = [];
    const deps: DiagnosisDeps = {
      run: async () => ({ ok: true, stdout: psTree() }),
      readFile: async (path) => (reads.push(path), files[path] ?? null),
      fs,
      home: '/home/dev',
      worktreeRoots: async () => [],
      nowMs: () => 0,
      log: () => {},
      sessions: { registered: async () => [{ pid: 67562, sessionId: SESSION, cwd: CWD, procStart }], titleOf: async () => null },
    };
    return { reads, collector: new LinuxDiagnosisCollector(deps) };
  }

  test('#720/AC-2 Given procStart in clock ticks equal to field 22 of the pid stat, Then the tree is attributed to the session', async () => {
    const { collector } = linux({ '/proc/67562/stat': stat(67562, TICKS) });
    const r = (await collector.collect('processes-by-session', ctx())) as { items: { sessionId: string; processCount: number }[]; outsideSession: { processCount: number } };
    assert.deepEqual(r.items.map((s) => [s.sessionId, s.processCount]), [[SESSION, 13]]);
    assert.equal(r.outsideSession.processCount, 1);
  });

  test('#720/AC-2 Given the pid was reused (its stat holds another start), Then the whole tree is outside any session', async () => {
    const { collector } = linux({ '/proc/67562/stat': stat(67562, '999') });
    const r = (await collector.collect('processes-by-session', ctx())) as { items: unknown[]; outsideSession: { processCount: number } };
    assert.deepEqual(r.items, []);
    assert.equal(r.outsideSession.processCount, 14);
  });

  test('#720/AC-2 Given the stat cannot be read or is not understood, Then the pid is unverified and its tree is outside any session', async () => {
    for (const files of [{}, { '/proc/67562/stat': 'garbage' }]) {
      const r = (await linux(files).collector.collect('processes-by-session', ctx())) as { items: unknown[]; outsideSession: { processCount: number } };
      assert.deepEqual(r.items, []);
      assert.equal(r.outsideSession.processCount, 14);
    }
  });

  test('#720/AC-2 Given a registry start in lstart text on Linux, Then it does not match the ticks and the tree is outside', async () => {
    const { collector } = linux({ '/proc/67562/stat': stat(67562, TICKS) }, CLAUDE_START);
    const r = (await collector.collect('processes-by-session', ctx())) as { items: unknown[] };
    assert.deepEqual(r.items, []);
  });

  test('#720/AC-2 The stat is read only for the registered pids that are alive in the sample, never for every process', async () => {
    const { collector, reads } = linux({ '/proc/67562/stat': stat(67562, TICKS) });
    await collector.collect('processes-by-session', ctx());
    assert.deepEqual(reads, ['/proc/67562/stat']);
  });
});
