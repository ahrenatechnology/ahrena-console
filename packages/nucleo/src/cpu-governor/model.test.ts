/*
 * The CPU governor's policy (#723, #720), pure: when the machine is saturated, and which processes of a session tree the
 * governor may touch.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProcessSample, SessionTree } from '../diagnosis/attribution.ts';
import { CONTAIN_AFTER_MS, initialPressure, nextPressure, RELEASE_AFTER_MS, targetsOf, type Pressure } from './model.ts';

const START = 'Sat Nov 21 22:00:00 2026';
const proc = (pid: number, ppid: number): ProcessSample => ({ pid, ppid, start: START, command: 'node x', cpuPct: 1 });
const tree = (sessionId: string, rootPids: number[], processes: ProcessSample[]): SessionTree => ({ sessionId, cwd: null, rootPids, processes });

const CORES = 8;
const HIGH = { load1: 9, cores: CORES };
const LOW = { load1: 5, cores: CORES };
const MID = { load1: 7, cores: CORES };

/** Feeds one reading per `stepMs` for `durationMs`, from `from`. */
function run(from: Pressure, load: { load1: number; cores: number }, startMs: number, durationMs: number, stepMs = 3000): { pressure: Pressure; at: number } {
  let pressure = from;
  let at = startMs;
  for (; at <= startMs + durationMs; at += stepMs) pressure = nextPressure(pressure, load, at, true);
  return { pressure, at };
}

describe('#720/AC-4 containing starts after 30 s above the cores and ends after 2 min below 80%', () => {
  test('#720/AC-4 Given load above the cores for less than 30 s, Then the mode stays normal', () => {
    const { pressure } = run(initialPressure(), HIGH, 0, CONTAIN_AFTER_MS - 3000);
    assert.equal(pressure.mode, 'normal');
  });

  test('#720/AC-4 Given load above the cores continuously for 30 s, Then the mode becomes containing', () => {
    const { pressure } = run(initialPressure(), HIGH, 0, CONTAIN_AFTER_MS);
    assert.equal(pressure.mode, 'containing');
  });

  test('#720/AC-4 Given a dip to the cores or below before 30 s, Then the 30 s count starts again', () => {
    let p = run(initialPressure(), HIGH, 0, 24_000).pressure;
    p = nextPressure(p, { load1: CORES, cores: CORES }, 27_000, true);
    p = run(p, HIGH, 30_000, 24_000).pressure;
    assert.equal(p.mode, 'normal');
  });

  test('#720/AC-4 Given containing and load below 80% of the cores for 2 min, Then the mode returns to normal', () => {
    const containing = run(initialPressure(), HIGH, 0, CONTAIN_AFTER_MS);
    const before = run(containing.pressure, LOW, containing.at, RELEASE_AFTER_MS - 3000);
    assert.equal(before.pressure.mode, 'containing');
    const after = run(containing.pressure, LOW, containing.at, RELEASE_AFTER_MS);
    assert.equal(after.pressure.mode, 'normal');
  });

  test('#720/AC-4 Given containing and load between 80% and 100% of the cores, Then it keeps containing', () => {
    const containing = run(initialPressure(), HIGH, 0, CONTAIN_AFTER_MS);
    assert.equal(run(containing.pressure, MID, containing.at, RELEASE_AFTER_MS * 2).pressure.mode, 'containing');
  });

  test('#720/AC-4 Given a machine that cannot contain (no taskpolicy), Then the mode never leaves normal', () => {
    let p = initialPressure();
    for (let at = 0; at <= 5 * CONTAIN_AFTER_MS; at += 3000) p = nextPressure(p, HIGH, at, false);
    assert.equal(p.mode, 'normal');
  });
});

describe('#720/AC-6 the targets are the descendants of a session, never its root pid', () => {
  test('#720/AC-6 Given a tree whose processes list the root pid, Then the root pid is not a target', () => {
    const t = tree('s1', [100], [proc(100, 1), proc(101, 100), proc(102, 101)]);
    assert.deepEqual(targetsOf([t], new Set()).map((x) => x.pid), [101, 102]);
  });

  test('#720/AC-6 Given a session with two root pids, Then neither is a target', () => {
    const t = tree('s1', [100, 200], [proc(100, 1), proc(200, 1), proc(201, 200)]);
    assert.deepEqual(targetsOf([t], new Set()).map((x) => x.pid), [201]);
  });

  test('#720/AC-3 Given the core itself and its children inside a session tree, Then none of them is a target', () => {
    const t = tree('s1', [100], [proc(100, 1), proc(101, 100), proc(500, 101), proc(501, 500), proc(102, 100)]);
    assert.deepEqual(targetsOf([t], new Set([500])).map((x) => x.pid), [101, 102]);
  });

  test('#720/AC-3 Given a session whose root was started by the core (the core is above the tree, not in it), Then its descendants are still targets', () => {
    const t = tree('s1', [100], [proc(100, 500), proc(101, 100)]);
    assert.deepEqual(targetsOf([t], new Set([500])).map((x) => x.pid), [101]);
  });

  test('#720/AC-3 Given a target, Then it carries its session and the start it was sampled with', () => {
    const t = tree('s1', [100], [proc(100, 1), proc(101, 100)]);
    assert.deepEqual(targetsOf([t], new Set()), [{ sessionId: 's1', pid: 101, start: START }]);
  });
});
