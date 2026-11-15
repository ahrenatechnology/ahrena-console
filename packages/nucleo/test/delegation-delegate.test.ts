// The delegation use cases (#567): preview then open, against doubles for every port.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { delegate, previewDelegation, type DelegationDeps, type DiagnosisAnswer, type Launcher, type SshLaunchResult, type LaunchResult } from '../src/delegation/delegate.ts';
import { SSH_HOST, URL_BUDGET } from '../src/delegation/model.ts';
import { createPreviewStore } from '../src/delegation/preview-store.ts';
import type { Diagnosis } from '../src/diagnosis/model.ts';
import type { Alert } from '../src/telemetry/model.ts';

const WORKSTATION = 'workstation-1';
const HOME = '/home/core-user';
const swap: Alert = { id: 'swap-high', kind: 'swap-high', level: 'warning', message: 'Swap alto', detail: null, since: '2026-11-14T10:00:00Z' };
const memory: Alert = { id: 'memory-high', kind: 'memory-high', level: 'warning', message: 'Memoria alta', detail: null, since: '2026-11-14T10:00:00Z' };

const diagnosis: Diagnosis = {
  machine: 'local',
  alertId: 'swap-high',
  kind: 'swap-high',
  takenAt: '2026-11-14T10:05:00.000Z',
  sections: [{ id: 'swap', status: 'ok', items: [{ usedBytes: 9, totalBytes: 10 }] }],
};

interface Calls {
  desktop: Array<[string, string]>;
  terminal: Array<[string, string]>;
  ssh: Array<[string, string]>;
}

interface World {
  deps: DelegationDeps;
  calls: Calls;
  state: { clock: string; open: Record<string, Alert[]>; answer: DiagnosisAnswer; desktop: LaunchResult; terminal: LaunchResult; ssh: SshLaunchResult };
}

function world(): World {
  const calls: Calls = { desktop: [], terminal: [], ssh: [] };
  const state: World['state'] = {
    clock: '2026-11-14T10:06:00.000Z',
    open: { local: [swap], [WORKSTATION]: [memory] },
    answer: { kind: 'ok', diagnosis },
    desktop: 'opened',
    terminal: 'opened',
    ssh: 'opened',
  };
  const launcher: Launcher = {
    openDesktop: async (folder, prompt) => (calls.desktop.push([folder, prompt]), state.desktop),
    openTerminal: async (folder, prompt) => (calls.terminal.push([folder, prompt]), state.terminal),
    openSsh: async (host, prompt) => (calls.ssh.push([host, prompt]), state.ssh),
  };
  const deps: DelegationDeps = {
    alerts: { active: (machine) => state.open[machine] ?? [] },
    isKnownMachine: (machine) => machine === 'local' || machine === WORKSTATION,
    diagnosis: async () => state.answer,
    launcher,
    previews: createPreviewStore(),
    localFolder: () => HOME,
    now: () => state.clock,
  };
  return { deps, calls, state };
}

function launched(calls: Calls): number {
  return calls.desktop.length + calls.terminal.length + calls.ssh.length;
}

async function previewed(w: World, machine = 'local', alertId = 'swap-high') {
  const result = await previewDelegation({ machine, alertId }, w.deps);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('preview refused');
  return result;
}

describe('previewDelegation', () => {
  test('returns the prompt with the alert and the diagnosis, and the diagnosis instant', async () => {
    const w = world();
    const result = await previewed(w);
    assert.ok(result.prompt.includes('swap-high'));
    assert.ok(result.prompt.includes('usedBytes'));
    assert.equal(result.takenAt, diagnosis.takenAt);
    assert.equal(result.truncated, false);
    assert.equal(result.size, encodeURIComponent(result.prompt).length);
  });

  test('an unavailable diagnosis still previews, with no diagnosis in it and the clock as takenAt', async () => {
    const w = world();
    w.state.answer = { kind: 'unavailable' };
    const result = await previewed(w);
    assert.equal(result.takenAt, w.state.clock);
    assert.ok(!result.prompt.includes('usedBytes'));
  });

  test('refuses an unknown machine and does not ask for a diagnosis', async () => {
    const w = world();
    let asked = 0;
    w.deps.diagnosis = async () => (asked++, w.state.answer);
    assert.deepEqual(await previewDelegation({ machine: 'nope', alertId: 'swap-high' }, w.deps), { kind: 'unknown-machine' });
    assert.equal(asked, 0);
  });

  test('refuses a closed alert', async () => {
    const w = world();
    assert.deepEqual(await previewDelegation({ machine: 'local', alertId: 'gone' }, w.deps), { kind: 'alert-not-open' });
  });

  test('refuses when the diagnosis port reports the alert closed meanwhile', async () => {
    const w = world();
    w.state.answer = { kind: 'alert-not-open' };
    assert.deepEqual(await previewDelegation({ machine: 'local', alertId: 'swap-high' }, w.deps), { kind: 'alert-not-open' });
  });

  test('a refused preview stores nothing', async () => {
    const w = world();
    await previewDelegation({ machine: 'local', alertId: 'gone' }, w.deps);
    assert.equal(w.deps.previews.find('local', 'gone', Date.parse(w.state.clock)), null);
  });
});

describe('delegate', () => {
  test('desktop opens the home folder with the exact previewed prompt', async () => {
    const w = world();
    const p = await previewed(w);
    const result = await delegate({ machine: 'local', alertId: 'swap-high', via: 'desktop', takenAt: p.takenAt }, w.deps);
    assert.deepEqual(result, { kind: 'opened', via: 'desktop' });
    assert.deepEqual(w.calls.desktop, [[HOME, p.prompt]]);
    assert.equal(launched(w.calls), 1);
  });

  test('terminal opens the home folder with the exact previewed prompt', async () => {
    const w = world();
    const p = await previewed(w);
    const result = await delegate({ machine: 'local', alertId: 'swap-high', via: 'terminal', takenAt: p.takenAt }, w.deps);
    assert.deepEqual(result, { kind: 'opened', via: 'terminal' });
    assert.deepEqual(w.calls.terminal, [[HOME, p.prompt]]);
    assert.equal(launched(w.calls), 1);
  });

  test('ssh on the workstation opens the fixed host with the previewed prompt', async () => {
    const w = world();
    const p = await previewed(w, WORKSTATION, 'memory-high');
    const result = await delegate({ machine: WORKSTATION, alertId: 'memory-high', via: 'ssh', takenAt: p.takenAt }, w.deps);
    assert.deepEqual(result, { kind: 'opened', via: 'ssh' });
    assert.deepEqual(w.calls.ssh, [[SSH_HOST, p.prompt]]);
    assert.equal(SSH_HOST, 'ahrena-workstation');
  });

  test('uses the stored prompt even when the diagnosis changed after the preview', async () => {
    const w = world();
    const p = await previewed(w);
    w.state.answer = { kind: 'unavailable' };
    await delegate({ machine: 'local', alertId: 'swap-high', via: 'desktop', takenAt: p.takenAt }, w.deps);
    assert.equal(w.calls.desktop[0]?.[1], p.prompt);
  });

  test('a second request with the same takenAt reopens the same prompt', async () => {
    const w = world();
    const p = await previewed(w);
    const request = { machine: 'local', alertId: 'swap-high', via: 'terminal', takenAt: p.takenAt } as const;
    await delegate(request, w.deps);
    assert.deepEqual(await delegate(request, w.deps), { kind: 'opened', via: 'terminal' });
    assert.deepEqual(w.calls.terminal.map((c) => c[1]), [p.prompt, p.prompt]);
  });

  describe('refusals never reach the launcher', () => {
    test('ssh is not accepted on local', async () => {
      const w = world();
      const p = await previewed(w);
      assert.deepEqual(await delegate({ machine: 'local', alertId: 'swap-high', via: 'ssh', takenAt: p.takenAt }, w.deps), { kind: 'via-not-accepted' });
      assert.equal(launched(w.calls), 0);
    });

    test('desktop and terminal are not accepted on the workstation', async () => {
      const w = world();
      const p = await previewed(w, WORKSTATION, 'memory-high');
      for (const via of ['desktop', 'terminal'] as const) {
        assert.deepEqual(await delegate({ machine: WORKSTATION, alertId: 'memory-high', via, takenAt: p.takenAt }, w.deps), { kind: 'via-not-accepted' });
      }
      assert.equal(launched(w.calls), 0);
    });

    test('unknown machine', async () => {
      const w = world();
      assert.deepEqual(await delegate({ machine: 'nope', alertId: 'swap-high', via: 'desktop', takenAt: 'x' }, w.deps), { kind: 'unknown-machine' });
      assert.equal(launched(w.calls), 0);
    });

    test('alert closed between the preview and the request', async () => {
      const w = world();
      const p = await previewed(w);
      w.state.open.local = [];
      assert.deepEqual(await delegate({ machine: 'local', alertId: 'swap-high', via: 'desktop', takenAt: p.takenAt }, w.deps), { kind: 'alert-not-open' });
      assert.equal(launched(w.calls), 0);
    });

    test('stale: no preview was held', async () => {
      const w = world();
      assert.deepEqual(await delegate({ machine: 'local', alertId: 'swap-high', via: 'desktop', takenAt: diagnosis.takenAt }, w.deps), { kind: 'stale' });
      assert.equal(launched(w.calls), 0);
    });

    test('stale: takenAt differs from the last preview', async () => {
      const w = world();
      await previewed(w);
      assert.deepEqual(await delegate({ machine: 'local', alertId: 'swap-high', via: 'desktop', takenAt: '2026-01-01T00:00:00.000Z' }, w.deps), { kind: 'stale' });
      assert.equal(launched(w.calls), 0);
    });

    test('stale: the preview expired', async () => {
      const w = world();
      const p = await previewed(w);
      w.state.clock = '2026-11-14T10:16:01.000Z';
      assert.deepEqual(await delegate({ machine: 'local', alertId: 'swap-high', via: 'desktop', takenAt: p.takenAt }, w.deps), { kind: 'stale' });
      assert.equal(launched(w.calls), 0);
    });

    test('too large for the desktop URL', async () => {
      const w = world();
      w.deps.previews.save('local', 'swap-high', { prompt: 'a b'.repeat(URL_BUDGET), takenAt: 't' }, Date.parse(w.state.clock));
      assert.deepEqual(await delegate({ machine: 'local', alertId: 'swap-high', via: 'desktop', takenAt: 't' }, w.deps), { kind: 'too-large' });
      assert.equal(launched(w.calls), 0);
    });
  });

  test('an opener that is missing is unsupported', async () => {
    const w = world();
    const p = await previewed(w);
    w.state.desktop = 'unsupported';
    w.state.terminal = 'unsupported';
    assert.deepEqual(await delegate({ machine: 'local', alertId: 'swap-high', via: 'desktop', takenAt: p.takenAt }, w.deps), { kind: 'unsupported' });
    assert.deepEqual(await delegate({ machine: 'local', alertId: 'swap-high', via: 'terminal', takenAt: p.takenAt }, w.deps), { kind: 'unsupported' });
  });

  test('an ssh failure carries its stable reason', async () => {
    const w = world();
    const p = await previewed(w, WORKSTATION, 'memory-high');
    w.state.ssh = { failed: 'ssh-timeout' };
    assert.deepEqual(await delegate({ machine: WORKSTATION, alertId: 'memory-high', via: 'ssh', takenAt: p.takenAt }, w.deps), { kind: 'ssh-failed', reason: 'ssh-timeout' });
  });
});
