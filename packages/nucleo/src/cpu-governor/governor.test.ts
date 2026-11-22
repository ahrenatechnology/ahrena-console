/*
 * The CPU governor's loop (#723, #720), against a double of the machine: no real `renice` or `taskpolicy` runs here.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProcessSample, SessionTree } from '../diagnosis/attribution.ts';
import { CpuGovernor, type ChangeOutcome, type MachineControl, type Observation } from './governor.ts';

const START = 'Sat Nov 21 22:00:00 2026';
const proc = (pid: number, ppid: number, start = START): ProcessSample => ({ pid, ppid, start, command: 'node x', cpuPct: 1 });
const ROOT = 100;
const SELF = 9000;

class FakeMachine implements MachineControl {
  trees: SessionTree[] = [];
  nice = new Map<number, number>();
  /** The start `inspect` answers, by pid; a pid absent here is gone. */
  starts = new Map<number, string>();
  calls: string[] = [];
  outcome: (op: string, pid: number) => ChangeOutcome = () => 'done';
  async sample(): Promise<Observation | null> {
    return { trees: this.trees, nice: this.nice };
  }
  async inspect(pid: number) {
    const start = this.starts.get(pid);
    return start === undefined ? null : { start };
  }
  async renice(pid: number) {
    this.calls.push(`renice ${pid}`);
    return this.outcome('renice', pid);
  }
  async background(pid: number) {
    this.calls.push(`background ${pid}`);
    return this.outcome('background', pid);
  }
  async foreground(pid: number) {
    this.calls.push(`foreground ${pid}`);
    return this.outcome('foreground', pid);
  }
  /** One session: the root and its descendants, all at nice 0, all alive with the start they were sampled with. */
  session(pids: number[]): void {
    const processes = [proc(ROOT, 1), ...pids.map((pid) => proc(pid, ROOT))];
    this.trees = [{ sessionId: 's1', cwd: null, rootPids: [ROOT], processes }];
    for (const p of processes) {
      this.nice.set(p.pid, 0);
      this.starts.set(p.pid, p.start);
    }
  }
}

function setup(over: { platform?: 'darwin' | 'linux'; cores?: number } = {}) {
  const machine = new FakeMachine();
  const load = { load1: 1, cores: over.cores ?? 8 };
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  const governor = new CpuGovernor({ machine, load: () => ({ ...load }), nowMs: () => clock.now, log: (m) => logs.push(m), platform: over.platform ?? 'darwin', selfPid: SELF });
  const tick = async (stepMs = 3000) => {
    clock.now += stepMs;
    await governor.tick();
  };
  return { machine, governor, load, clock, logs, tick };
}

describe('#720/AC-3 the governor raises the nice of every descendant of a session to 10', () => {
  test('#720/AC-3 Given the governor on by default and descendants at nice 0, When the loop ticks, Then each gets renice 10 and the root does not', async () => {
    const { machine, governor, tick } = setup();
    machine.session([101, 102]);
    assert.equal(governor.state().enabled, true);
    await tick();
    assert.deepEqual(machine.calls, ['renice 101', 'renice 102']);
  });

  test('#720/AC-5 Given a descendant already at nice 10 or more, Then it is left alone: the nice is only raised', async () => {
    const { machine, tick } = setup();
    machine.session([101, 102, 103]);
    machine.nice.set(101, 10);
    machine.nice.set(102, 15);
    await tick();
    assert.deepEqual(machine.calls, ['renice 103']);
  });

  test('#720/AC-3 Given a process already reniced, When the loop ticks again, Then it is not reniced twice', async () => {
    const { machine, tick } = setup();
    machine.session([101]);
    await tick();
    await tick();
    assert.deepEqual(machine.calls, ['renice 101']);
  });

  test('#720/AC-3 Given a descendant that appears later, When the loop ticks, Then it is reniced on that tick', async () => {
    const { machine, tick } = setup();
    machine.session([101]);
    await tick();
    machine.session([101, 102]);
    machine.nice.set(101, 10);
    await tick();
    assert.deepEqual(machine.calls, ['renice 101', 'renice 102']);
  });

  test('#720/AC-3 Given the core inside a session tree, Then neither it nor its children are touched', async () => {
    const { machine, tick } = setup();
    machine.session([101]);
    machine.trees[0]!.processes.push(proc(SELF, 101), proc(9001, SELF));
    machine.nice.set(SELF, 0);
    machine.nice.set(9001, 0);
    machine.starts.set(SELF, START);
    machine.starts.set(9001, START);
    await tick();
    assert.deepEqual(machine.calls, ['renice 101']);
  });

  test('#720/AC-3 Given no session tree, Then nothing is touched', async () => {
    const { machine, tick } = setup();
    await tick();
    assert.deepEqual(machine.calls, []);
  });
});

describe('#720/AC-6 the session root pid never receives renice nor taskpolicy', () => {
  test('#720/AC-6 Given the root pid listed in SessionTree.processes at nice 0, When it is containing, Then the root gets neither renice nor taskpolicy', async () => {
    const { machine, load, tick } = setup();
    machine.session([101]);
    load.load1 = 12;
    for (let i = 0; i < 12; i++) await tick();
    assert.ok(machine.calls.includes('background 101'));
    assert.ok(!machine.calls.some((c) => c.endsWith(` ${ROOT}`)), machine.calls.join(','));
  });

  test('#720/AC-6 Given the root pid, When the governor is turned off, Then it is not touched either', async () => {
    const { machine, governor, load, tick } = setup();
    machine.session([101]);
    load.load1 = 12;
    for (let i = 0; i < 12; i++) await tick();
    await governor.setEnabled(false);
    assert.ok(!machine.calls.some((c) => c.endsWith(` ${ROOT}`)), machine.calls.join(','));
  });
});

describe('#720/AC-4 containing: taskpolicy -b on the descendants, -B on the ones it set, the nice stays', () => {
  test('#720/AC-4 Given load above the cores for 30 s on darwin, Then the mode is containing and each descendant gets taskpolicy -b', async () => {
    const { machine, governor, load, tick } = setup();
    machine.session([101, 102]);
    load.load1 = 12;
    for (let i = 0; i < 11; i++) await tick();
    assert.equal(governor.state().mode, 'containing');
    assert.deepEqual(machine.calls.filter((c) => c.startsWith('background')), ['background 101', 'background 102']);
    assert.deepEqual(governor.state().containedSessions, ['s1']);
  });

  test('#720/AC-4 Given load above the cores for less than 30 s, Then nothing is put in the background', async () => {
    const { machine, governor, load, tick } = setup();
    machine.session([101]);
    load.load1 = 12;
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(governor.state().mode, 'normal');
    assert.ok(!machine.calls.some((c) => c.startsWith('background')));
  });

  test('#720/AC-4 Given containing and a new descendant, Then it gets taskpolicy -b on its tick', async () => {
    const { machine, load, tick } = setup();
    machine.session([101]);
    load.load1 = 12;
    for (let i = 0; i < 12; i++) await tick();
    machine.session([101, 102]);
    machine.nice.set(101, 10);
    await tick();
    assert.ok(machine.calls.includes('background 102'));
    assert.equal(machine.calls.filter((c) => c === 'background 101').length, 1);
  });

  test('#720/AC-4 Given containing and load below 80% of the cores for 2 min, Then taskpolicy -B runs only on the pids it set, the mode is normal and the nice stays', async () => {
    const { machine, governor, load, tick } = setup();
    machine.session([101, 102]);
    machine.nice.set(102, 10);
    load.load1 = 12;
    for (let i = 0; i < 12; i++) await tick();
    load.load1 = 2;
    for (let i = 0; i < 45; i++) await tick();
    assert.equal(governor.state().mode, 'normal');
    assert.deepEqual(machine.calls.filter((c) => c.startsWith('foreground')), ['foreground 101', 'foreground 102']);
    assert.deepEqual(governor.state().containedSessions, []);
    assert.ok(!machine.calls.some((c) => /renice/.test(c) && c !== 'renice 101'));
  });

  test('#720/AC-4 Given a machine that is not darwin, When the load stays high, Then no taskpolicy runs and the mode stays normal', async () => {
    const { machine, governor, load, tick } = setup({ platform: 'linux' });
    machine.session([101]);
    load.load1 = 12;
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(governor.state().mode, 'normal');
    assert.deepEqual(machine.calls, ['renice 101']);
  });
});

describe('#720/AC-5 the governor only undoes what it changed itself and checks the start before every change', () => {
  test('#720/AC-5 Given a pid reused by another process since the sample, Then renice skips it', async () => {
    const { machine, tick } = setup();
    machine.session([101, 102]);
    machine.starts.set(101, 'Sat Nov 21 23:59:59 2026');
    await tick();
    assert.deepEqual(machine.calls, ['renice 102']);
  });

  test('#720/AC-5 Given a pid that died between the sample and the change, Then it is skipped', async () => {
    const { machine, tick } = setup();
    machine.session([101]);
    machine.starts.delete(101);
    await tick();
    assert.deepEqual(machine.calls, []);
  });

  test('#720/AC-5 Given a pid it put in the background that was then reused, When the load drops, Then taskpolicy -B skips it', async () => {
    const { machine, load, tick } = setup();
    machine.session([101, 102]);
    load.load1 = 12;
    for (let i = 0; i < 12; i++) await tick();
    machine.starts.set(101, 'Sun Nov 22 00:00:00 2026');
    load.load1 = 2;
    for (let i = 0; i < 45; i++) await tick();
    assert.deepEqual(machine.calls.filter((c) => c.startsWith('foreground')), ['foreground 102']);
  });

  test('#720/AC-5 Given EPERM on one pid, Then it is logged by operation, pid and outcome, the loop goes on and the pid is not retried', async () => {
    const { machine, logs, tick } = setup();
    machine.session([101, 102]);
    machine.outcome = (_op, pid) => (pid === 101 ? 'denied' : 'done');
    await tick();
    await tick();
    assert.deepEqual(machine.calls, ['renice 101', 'renice 102']);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /renice/);
    assert.match(logs[0]!, /denied/);
    assert.match(logs[0]!, /pid=101/);
  });

  test('#720/AC-5 Given a machine whose sample fails, Then the tick ends quietly and the next one works', async () => {
    const { machine, tick } = setup();
    machine.session([101]);
    const real = machine.sample.bind(machine);
    machine.sample = async () => {
      throw new Error('ps blew up with /secret/path');
    };
    await tick();
    machine.sample = real;
    await tick();
    assert.deepEqual(machine.calls, ['renice 101']);
  });

  test('#720/AC-5 Given a tick that failed, Then the log carries the operation and not the error text', async () => {
    const { machine, logs, tick } = setup();
    machine.sample = async () => {
      throw new Error('ps blew up with /secret/path');
    };
    await tick();
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0]!, /secret/);
    assert.match(logs[0]!, /tick/);
  });
});

describe('#720/AC-6 turning the governor off', () => {
  test('#720/AC-6 Given some pids under -b, When it is turned off, Then taskpolicy -B runs only on those, no renice runs and the state is off and normal', async () => {
    const { machine, governor, load, tick } = setup();
    machine.session([101, 102]);
    load.load1 = 12;
    for (let i = 0; i < 12; i++) await tick();
    machine.calls.length = 0;
    await governor.setEnabled(false);
    assert.deepEqual(machine.calls, ['foreground 101', 'foreground 102']);
    assert.equal(governor.state().enabled, false);
    assert.equal(governor.state().mode, 'normal');
    assert.deepEqual(governor.state().containedSessions, []);
  });

  test('#720/AC-6 Given the governor off, When the loop ticks with new descendants, Then nothing is touched', async () => {
    const { machine, governor, tick } = setup();
    await governor.setEnabled(false);
    machine.session([101, 102]);
    await tick();
    assert.deepEqual(machine.calls, []);
  });

  test('#720/AC-6 Given a pid under -b that was reused, When it is turned off, Then taskpolicy -B skips it', async () => {
    const { machine, governor, load, tick } = setup();
    machine.session([101, 102]);
    load.load1 = 12;
    for (let i = 0; i < 12; i++) await tick();
    machine.starts.set(101, 'Sun Nov 22 00:00:00 2026');
    machine.calls.length = 0;
    await governor.setEnabled(false);
    assert.deepEqual(machine.calls, ['foreground 102']);
  });

  test('#720/AC-6 Given the governor turned off and on again, Then it reniced descendants stay and new ones are reniced', async () => {
    const { machine, governor, tick } = setup();
    machine.session([101]);
    await tick();
    await governor.setEnabled(false);
    await governor.setEnabled(true);
    machine.session([101, 102]);
    machine.nice.set(101, 10);
    await tick();
    assert.deepEqual(machine.calls, ['renice 101', 'renice 102']);
    assert.equal(governor.state().enabled, true);
  });

  test('#720/AC-6 Given the state, Then it reports enabled, mode, contained sessions and since when', () => {
    const { governor, clock } = setup();
    const s = governor.state();
    assert.deepEqual(Object.keys(s).sort(), ['containedSessions', 'enabled', 'mode', 'since']);
    assert.equal(s.since, new Date(clock.now).toISOString());
  });
});
