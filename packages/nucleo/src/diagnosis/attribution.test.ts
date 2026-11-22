/*
 * The attribution of processes to agent sessions (#722, #720), pure: a process sample and the
 * registry of live sessions go in, the session trees and the processes outside any session come out.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { attributeProcesses, lstartMatches, loadOf, MAX_CLIMB_DEPTH, outsideLoadOf, rootCommandOf, type ProcessSample, type RegisteredSession } from './attribution.ts';

const START = 'Sat Nov 21 22:00:00 2026';
const sample = (pid: number, ppid: number, command: string, cpuPct = 0, start = START): ProcessSample => ({ pid, ppid, start, command, cpuPct });
const registered = (pid: number, sessionId: string, over: Partial<RegisteredSession> = {}): RegisteredSession => ({ pid, sessionId, cwd: '/work/spdx-307', procStart: START, ...over });

const SESSION = '0413a6d2-3b1c-4c0e-9d3a-6f1f0a2b7c11';
const OTHER = '9c1d2e3f-0a1b-4c2d-8e3f-4a5b6c7d8e9f';

/** claude(100) -> zsh -c(101) -> pnpm test(102) -> vitest(103) -> workers 104..117 (14), 600% in all. (#722) */
function vitestTree(): ProcessSample[] {
  const workers = Array.from({ length: 14 }, (_, i) => sample(104 + i, 103, 'node /work/spdx-307/node_modules/vitest/dist/worker.js', 40));
  return [sample(100, 1, 'claude --resume 0413a6d2', 10), sample(101, 100, '/bin/zsh -c -l eval pnpm test', 0), sample(102, 101, 'node /opt/pnpm/pnpm.cjs test', 10), sample(103, 102, 'node /work/spdx-307/node_modules/vitest/vitest.mjs run', 20), ...workers];
}

describe('#720/AC-2 attribution climbs the ppid chain to a live registered pid', () => {
  test('#720/AC-2 Given a process under a registered claude with a matching procStart, Then it is attributed to that session', () => {
    const a = attributeProcesses(vitestTree(), [registered(100, SESSION)]);
    assert.equal(a.sessions.length, 1);
    assert.equal(a.sessions[0]!.sessionId, SESSION);
    assert.equal(a.sessions[0]!.processes.length, 18);
    assert.deepEqual(a.outside, []);
  });

  test('#720/AC-2 Given the registered pid itself, Then it belongs to its own session', () => {
    const a = attributeProcesses([sample(100, 1, 'claude')], [registered(100, SESSION)]);
    assert.deepEqual(a.sessions[0]!.processes.map((p) => p.pid), [100]);
  });

  test('#720/AC-2 Given two registered sessions nested, Then each process goes to the nearest one', () => {
    const procs = [sample(100, 1, 'claude'), sample(101, 100, 'node a'), sample(200, 101, 'claude'), sample(201, 200, 'node b')];
    const a = attributeProcesses(procs, [registered(100, SESSION), registered(200, OTHER)]);
    const pids = (id: string) => a.sessions.find((s) => s.sessionId === id)!.processes.map((p) => p.pid).sort();
    assert.deepEqual(pids(SESSION), [100, 101]);
    assert.deepEqual(pids(OTHER), [200, 201]);
  });

  test('#720/AC-2 Given the ancestor pid was reused (procStart differs from its real start), Then the process is outside any session', () => {
    const a = attributeProcesses(vitestTree(), [registered(100, SESSION, { procStart: 'Sat Nov 21 10:00:00 2026' })]);
    assert.deepEqual(a.sessions, []);
    assert.equal(a.outside.length, 18);
  });

  test('#720/AC-2 Given the registered pid is dead (not in the sample), Then its orphans are outside any session', () => {
    const orphans = vitestTree().filter((p) => p.pid !== 100);
    const a = attributeProcesses(orphans, [registered(100, SESSION)]);
    assert.deepEqual(a.sessions, []);
    assert.equal(a.outside.length, 17);
  });

  test('#720/AC-2 Given no ancestor is registered, Then the process is outside any session, never a guessed one', () => {
    const a = attributeProcesses(vitestTree(), [registered(999, SESSION)]);
    assert.deepEqual(a.sessions, []);
    assert.equal(a.outside.length, 18);
  });

  test('#720/AC-2 Given the registry holds no procStart for the pid, Then the start cannot be checked and the tree is outside', () => {
    const a = attributeProcesses(vitestTree(), [registered(100, SESSION, { procStart: null })]);
    assert.deepEqual(a.sessions, []);
  });

  test('#720/AC-2 Given the start differs only in spacing, Then it still matches', () => {
    const a = attributeProcesses([sample(100, 1, 'claude', 0, 'Sat Nov  7 08:15:02 2026')], [registered(100, SESSION, { procStart: 'Sat Nov 7 08:15:02 2026' })]);
    assert.equal(a.sessions.length, 1);
  });

  test('#720/AC-2 Given two registry files claim one pid for different sessions, Then nothing is guessed', () => {
    const a = attributeProcesses([sample(100, 1, 'claude')], [registered(100, SESSION), registered(100, OTHER)]);
    assert.deepEqual(a.sessions, []);
    assert.equal(a.outside.length, 1);
  });

  test('#720/AC-2 Given a ppid cycle, Then the climb ends and the process is outside', () => {
    const a = attributeProcesses([sample(10, 11, 'a'), sample(11, 10, 'b')], [registered(100, SESSION)]);
    assert.equal(a.outside.length, 2);
  });

  test('#720/AC-2 Given a chain deeper than the cap, Then the process is outside, and one within the cap is attributed', () => {
    const chain = (length: number) => [sample(1000, 1, 'claude'), ...Array.from({ length }, (_, i) => sample(1001 + i, 1000 + i, 'sh'))];
    const within = attributeProcesses(chain(MAX_CLIMB_DEPTH - 1), [registered(1000, SESSION)]);
    assert.equal(within.outside.length, 0);
    const beyond = attributeProcesses(chain(MAX_CLIMB_DEPTH + 5), [registered(1000, SESSION)]);
    assert.equal(beyond.outside.length, 5);
  });

  test('#720/AC-2 Given a session tree, Then every pid of it is listed with its own start, for the next layer to re-check before acting', () => {
    const procs = [sample(100, 1, 'claude'), sample(101, 100, 'node', 0, 'Sat Nov 21 22:05:00 2026')];
    const tree = attributeProcesses(procs, [registered(100, SESSION)]).sessions[0]!;
    assert.deepEqual(tree.rootPids, [100]);
    assert.deepEqual(tree.processes.map((p) => [p.pid, p.start]), [[100, START], [101, 'Sat Nov 21 22:05:00 2026']]);
  });
});

describe('#720/AC-2 the check of a registered start is a per-OS fact the collector supplies', () => {
  const TICKS = '480890526';

  test('#720/AC-2 Given a Linux procStart in clock ticks and the default (lstart) check, Then the pid is not verified and the process is outside', () => {
    const a = attributeProcesses([sample(100, 1, 'claude')], [registered(100, SESSION, { procStart: TICKS })]);
    assert.deepEqual(a.sessions, []);
    assert.equal(a.outside.length, 1);
  });

  test('#720/AC-2 Given a check that verifies the ticks of the registered pid, Then the tree is attributed', () => {
    const verified = (entry: RegisteredSession, real: ProcessSample) => entry.pid === real.pid && entry.procStart === TICKS;
    const a = attributeProcesses(vitestTree(), [registered(100, SESSION, { procStart: TICKS })], verified);
    assert.equal(a.sessions[0]!.processes.length, 18);
    assert.deepEqual(a.outside, []);
  });

  test('#720/AC-2 Given a check that refuses the pid, Then nothing under it is attributed even when the lstart text would match', () => {
    const a = attributeProcesses(vitestTree(), [registered(100, SESSION)], () => false);
    assert.deepEqual(a.sessions, []);
    assert.equal(a.outside.length, 18);
  });

  test('#720/AC-2 The lstart check compares the registry start with the sample start, spacing aside, and refuses a missing procStart', () => {
    assert.equal(lstartMatches(registered(1, SESSION, { procStart: 'Sat Nov 7 08:15:02 2026' }), sample(1, 0, 'x', 0, 'Sat Nov  7 08:15:02 2026')), true);
    assert.equal(lstartMatches(registered(1, SESSION, { procStart: null }), sample(1, 0, 'x')), false);
    assert.equal(lstartMatches(registered(1, SESSION, { procStart: TICKS }), sample(1, 0, 'x')), false);
  });
});

describe('#720/AC-1 the load of a session and of what is outside any session', () => {
  test('#720/AC-1 Given the vitest tree, Then the session load has the title, root command, folder, 18 processes and the summed CPU', () => {
    const tree = attributeProcesses(vitestTree(), [registered(100, SESSION)]).sessions[0]!;
    assert.deepEqual(loadOf(tree, 'Fix the flaky suite'), { sessionId: SESSION, title: 'Fix the flaky suite', rootCommand: 'pnpm test', cwd: '/work/spdx-307', processCount: 18, cpuPct: 600 });
  });

  test('#720/AC-1 Given an unknown title, Then the title is null', () => {
    const tree = attributeProcesses([sample(100, 1, 'claude')], [registered(100, SESSION)]).sessions[0]!;
    assert.equal(loadOf(tree, null).title, null);
  });

  test('#720/AC-1 Given float CPU values, Then the sum is rounded to one decimal', () => {
    const tree = attributeProcesses([sample(100, 1, 'claude', 0.1), sample(101, 100, 'node', 0.2)], [registered(100, SESSION)]).sessions[0]!;
    assert.equal(loadOf(tree, null).cpuPct, 0.3);
  });

  test('#720/AC-1 Given processes of no session, Then their count and CPU come in the outside-session load', () => {
    const procs = [sample(100, 1, 'claude', 5), sample(300, 1, 'node server.js', 30.5), sample(301, 300, 'node', 10)];
    const a = attributeProcesses(procs, [registered(100, SESSION)]);
    assert.deepEqual(outsideLoadOf(a), { processCount: 2, cpuPct: 40.5 });
  });

  test('#720/AC-1 Given no process outside, Then the outside-session load is zero', () => {
    assert.deepEqual(outsideLoadOf({ sessions: [], outside: [] }), { processCount: 0, cpuPct: 0 });
  });
});

describe('#720/AC-1 the root command of a session', () => {
  const treeOf = (procs: ProcessSample[]) => attributeProcesses(procs, [registered(100, SESSION)]).sessions[0]!;

  test('#720/AC-1 Given claude -> zsh -c -> pnpm test, Then the shell wrapper is skipped and the root command is "pnpm test"', () => {
    assert.equal(rootCommandOf(treeOf(vitestTree())), 'pnpm test');
  });

  test('#720/AC-1 Given two children, Then the one whose subtree carries more CPU is the root command', () => {
    const procs = [sample(100, 1, 'claude'), sample(101, 100, 'git status', 1), sample(102, 100, 'cargo build', 2), sample(103, 102, 'rustc', 300)];
    assert.equal(rootCommandOf(treeOf(procs)), 'cargo build');
  });

  test('#720/AC-1 Given a wrapper with no child, Then the root command is the session own program', () => {
    assert.equal(rootCommandOf(treeOf([sample(100, 1, '/usr/local/bin/claude --resume 0413a6d2', 3), sample(101, 100, 'bash -c sleep 1', 0)])), 'claude');
  });

  test('#720/AC-1 Given flags, values and paths, Then only the program (a script launched by node by its name) and up to two plain words are kept', () => {
    const procs = [sample(100, 1, 'claude'), sample(101, 100, 'node /opt/pnpm/pnpm.cjs test --token=abc123 --coverage', 9)];
    assert.equal(rootCommandOf(treeOf(procs)), 'pnpm test');
  });

  test('#720/AC-1 Given a long word or a word with an equals sign, Then the command stops before it', () => {
    assert.equal(rootCommandOf(treeOf([sample(100, 1, 'claude'), sample(101, 100, `make ${'x'.repeat(40)} deploy`, 9)])), 'make');
    assert.equal(rootCommandOf(treeOf([sample(100, 1, 'claude'), sample(101, 100, 'env API_KEY=hunter2 node', 9)])), 'env');
  });
});
