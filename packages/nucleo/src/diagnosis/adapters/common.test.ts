/*
 * The `processes-by-session` collector (issue 722, epic 720): the Mac's collector driven with a recording command runner
 * and a registry double, so no real tool runs and no real session is read.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RegisteredSession } from '../attribution.ts';
import { CATALOG } from './catalog.ts';
import { type DiagnosisDeps, type DiagnosisFs, type RunOptions, type RunResult } from './common.ts';
import { DarwinDiagnosisCollector } from './darwin.ts';

const SESSION = '0413a6d2-3b1c-4c0e-9d3a-6f1f0a2b7c11';
const CLAUDE_START = 'Sat Nov 21 21:00:00 2026';
const CWD = '/Users/dev/work/spdx-307';

/** claude(67562) -> zsh -c -> pnpm test -> vitest -> 11 workers: 15 processes, 600% in all; and a server that descends from no session. */
function psTree(): string {
  const row = (pid: number, ppid: number, cpu: number, start: string, command: string) => `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${cpu.toFixed(1).padStart(6)} ${start} ${command}`;
  const rows = [
    row(67562, 1, 0, CLAUDE_START, 'claude --resume 0413a6d2'),
    row(67570, 67562, 0, 'Sat Nov 21 21:30:00 2026', '/bin/zsh -c -l eval pnpm test'),
    row(67580, 67570, 0, 'Sat Nov 21 21:30:01 2026', 'node /opt/pnpm/pnpm.cjs test'),
    row(67590, 67580, 50, 'Sat Nov 21 21:30:02 2026', 'node /w/node_modules/vitest/vitest.mjs run'),
    ...Array.from({ length: 11 }, (_, i) => row(67600 + i, 67590, 50, 'Sat Nov 21 21:30:05 2026', 'node /w/node_modules/vitest/worker.js')),
    row(300, 1, 30, 'Sat Nov 14 08:00:00 2026', 'node server.js'),
  ];
  return rows.join('\n');
}

function setup(over: { ps?: RunResult; registered?: () => Promise<RegisteredSession[]>; titleOf?: (id: string) => Promise<string | null> | string | null } = {}) {
  const runs: { command: string; args: readonly string[]; options: RunOptions }[] = [];
  const logs: string[] = [];
  const fs: DiagnosisFs = { isDirectory: async () => false, listDirs: async () => [], modifiedAtMs: async () => null, stamp: async () => null, exists: async () => false };
  const deps: DiagnosisDeps = {
    run: async (command, args, options) => {
      runs.push({ command, args, options });
      return over.ps ?? { ok: true, stdout: psTree() };
    },
    readFile: async () => null,
    fs,
    home: '/Users/dev',
    worktreeRoots: async () => [],
    nowMs: () => 0,
    log: (message) => logs.push(message),
    sessions: {
      registered: over.registered ?? (async () => [{ pid: 67562, sessionId: SESSION, cwd: CWD, procStart: CLAUDE_START }]),
      titleOf: async (id) => (over.titleOf ? over.titleOf(id) : id === SESSION ? 'Fix the flaky suite' : null),
    },
  };
  return { runs, logs, deps, collector: new DarwinDiagnosisCollector(deps) };
}
const ctx = () => ({ mount: null, signal: new AbortController().signal });

describe('processes-by-session collector', () => {
  test('#720/AC-1 Given the vitest tree under a registered session, Then it lists the session with title, root command, folder, 15 processes and 600%, and the outside line apart', async () => {
    const { collector } = setup();
    assert.deepEqual(await collector.collect('processes-by-session', ctx()), {
      items: [{ sessionId: SESSION, title: 'Fix the flaky suite', rootCommand: 'pnpm test', cwd: CWD, processCount: 15, cpuPct: 600 }],
      outsideSession: { processCount: 1, cpuPct: 30 },
    });
  });

  test('#720/AC-1 The process list is read with one catalog command: fixed argv, UTC dates, a time and a size bound', async () => {
    const { collector, runs } = setup();
    await collector.collect('processes-by-session', ctx());
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]!.command, ...runs[0]!.args], ['ps', '-axo', 'pid=,ppid=,pcpu=,lstart=,args=']);
    assert.deepEqual(runs[0]!.options.env, { TZ: 'UTC' });
    assert.equal(runs[0]!.options.timeoutMs, CATALOG['ps-tree'].timeoutMs);
    assert.equal(runs[0]!.options.maxBytes, CATALOG['ps-tree'].maxBytes);
  });

  test('#720/AC-2 Given the registered pid was reused (procStart differs), Then the whole tree is outside any session', async () => {
    const { collector } = setup({ registered: async () => [{ pid: 67562, sessionId: SESSION, cwd: CWD, procStart: 'Mon Nov 2 07:00:01 2026' }] });
    assert.deepEqual(await collector.collect('processes-by-session', ctx()), { items: [], outsideSession: { processCount: 16, cpuPct: 630 } });
  });

  test('#720/AC-2 Given no live session is registered, Then every process is outside any session', async () => {
    const { collector } = setup({ registered: async () => [] });
    const r = (await collector.collect('processes-by-session', ctx())) as { items: unknown[]; outsideSession: { processCount: number } };
    assert.deepEqual(r.items, []);
    assert.equal(r.outsideSession.processCount, 16);
  });

  test('#720/AC-1 Given 12 sessions, Then the titles are asked only for the 10 that heaviest, and the list is ordered by CPU', async () => {
    const rows: string[] = [];
    const registry: RegisteredSession[] = [];
    for (let i = 0; i < 12; i++) {
      const pid = 1000 + i;
      rows.push(`${pid} 1 ${i + 1}.0 ${CLAUDE_START} claude`);
      registry.push({ pid, sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cwd: null, procStart: CLAUDE_START });
    }
    const asked: string[] = [];
    const { collector } = setup({ ps: { ok: true, stdout: rows.join('\n') }, registered: async () => registry, titleOf: (id) => (asked.push(id), null) });
    const r = (await collector.collect('processes-by-session', ctx())) as { items: { cpuPct: number }[] };
    assert.equal(r.items.length, 10);
    assert.deepEqual(r.items.map((s) => s.cpuPct), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    assert.equal(asked.length, 10);
  });

  test('#720/AC-1 Given a title lookup that fails, Then the session is listed with a null title and the log names the operation, not the error text', async () => {
    const { collector, logs } = setup({
      titleOf: () => {
        throw new Error('EACCES: permission denied, open /Users/dev/secret-path');
      },
    });
    const r = (await collector.collect('processes-by-session', ctx())) as { items: { title: string | null }[] };
    assert.equal(r.items[0]!.title, null);
    assert.ok(logs.some((l) => l.includes('title')));
    assert.ok(!logs.join('\n').includes('secret-path'));
  });

  test('#720/AC-1 Given the registry cannot be read, Then the section is unavailable with a generic reason, and neither it nor the log holds the error text', async () => {
    const { collector, logs } = setup({
      registered: async () => {
        throw new Error('EACCES: permission denied, scandir /Users/dev/.claude/sessions');
      },
    });
    const r = (await collector.collect('processes-by-session', ctx())) as { unavailable: true; reason: string };
    assert.equal(r.unavailable, true);
    assert.equal(r.reason, 'session registry not readable');
    assert.ok(!r.reason.includes('/Users'));
    assert.ok(!logs.join('\n').includes('/Users'));
  });

  test('#720/AC-1 Given no registry is wired, Then the section is unavailable', async () => {
    const { deps } = setup();
    const { sessions: _omitted, ...bare } = deps;
    const r = await new DarwinDiagnosisCollector(bare).collect('processes-by-session', ctx());
    assert.deepEqual(r, { unavailable: true, reason: 'no session registry on this machine' });
  });

  test('#720/AC-1 Given ps is missing or its output is not understood, Then the section is unavailable', async () => {
    assert.deepEqual(await setup({ ps: { ok: false, why: 'missing' } }).collector.collect('processes-by-session', ctx()), { unavailable: true, reason: 'ps not found' });
    assert.deepEqual(await setup({ ps: { ok: true, stdout: 'garbage' } }).collector.collect('processes-by-session', ctx()), { unavailable: true, reason: 'ps output not understood' });
  });
});
