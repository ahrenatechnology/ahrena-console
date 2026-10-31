// The terminal actions (#350): revalidation before every signal, the escalation's signals and group
// targets, what is never signaled, the second confirmation of SIGKILL, and the forward to a remote.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LocalTerminalActions, relayBody, TerminalActions } from '../../src/telemetry/terminal-actions.ts';
import { buildTerminals, parseTerminalsPs } from '../../src/telemetry/terminals.ts';
import { T0 } from './reading.ts';

const PS = `
 2210   812  2210      -1 ?        Ss      5400  1000 seguim   sshd: seguim@pts/0,pts/1
 2231  2210  2231   41233 pts/0    Ss      5400  1000 seguim   -bash
41233  2231 41233   41233 pts/0    S+      1560  1000 seguim   bash /tmp/claude-85401147/p/fe694084-bac4-42f8-a4c6-d8a3accf3a16/scratchpad/destrava.sh
 2260  2210  2260    2260 pts/1    Ss+     5400  1000 seguim   -bash
 4000   812  4000      -1 ?        Ss      3000     0 root     sshd: root@pts/5
 4010  4000  4010    4020 pts/5    Ss      3000     0 root     bash
 4020  4010  4020    4020 pts/5    S+       999     0 root     apt-get upgrade
`;
const reading = (over = {}) => buildTerminals(parseTerminalsPs(PS), { nowMs: T0, uid: 1000, selfPid: 999_999, ...over });

function setup(over: { tunnel?: number[]; ps?: string; read?: () => Promise<ReturnType<typeof reading> | null>; throws?: string } = {}) {
  const sent: [number, string][] = [];
  let resampled = 0;
  const local = new LocalTerminalActions({
    read: over.read ?? (async () => reading({ tunnelSshd: new Set(over.tunnel ?? []) })),
    signal: (pid, sig) => {
      if (over.throws) throw Object.assign(new Error('x'), { code: over.throws });
      sent.push([pid, sig]);
    },
    onSignaled: () => resampled++,
  });
  return { local, sent, resampled: () => resampled };
}

describe('#350 local actions', () => {
  test('interrupt signals the foreground GROUP with SIGINT, terminate with SIGTERM', async () => {
    const { local, sent, resampled } = setup();
    assert.deepEqual(await local.act('pts-0', 'interrupt', 41233, false), { kind: 'sent', action: 'interrupt', signal: 'SIGINT', pid: 41233, target: 'command' });
    assert.deepEqual((await local.act('pts-0', 'terminate', 41233, false)).kind, 'sent');
    assert.deepEqual(sent, [[-41233, 'SIGINT'], [-41233, 'SIGTERM']]);
    assert.equal(resampled(), 2);
  });

  test('kill needs the second confirmation: without confirm nothing is read or sent', async () => {
    const { local, sent } = setup();
    assert.deepEqual(await local.act('pts-0', 'kill', 41233, false), { kind: 'confirm-required' });
    assert.deepEqual(sent, []);
    assert.equal((await local.act('pts-0', 'kill', 41233, true)).kind, 'sent');
    assert.deepEqual(sent, [[-41233, 'SIGKILL']]);
  });

  test('hangup and end signal the connection\'s sshd, not the group', async () => {
    const { local, sent } = setup();
    assert.equal((await local.act('pts-0', 'hangup', 2210, false)).kind, 'sent');
    assert.equal((await local.act('pts-0', 'end', 2210, false)).kind, 'sent');
    assert.deepEqual(sent, [[2210, 'SIGHUP'], [2210, 'SIGTERM']]);
  });

  test('the pid must still be the terminal\'s: another pid, an idle terminal or the wrong target sends nothing', async () => {
    const { local, sent } = setup();
    assert.deepEqual(await local.act('pts-0', 'interrupt', 41290, false), { kind: 'changed' }); // a child, not the leader
    assert.deepEqual(await local.act('pts-0', 'interrupt', 2231, false), { kind: 'changed' }); // the shell
    assert.deepEqual(await local.act('pts-1', 'interrupt', 41233, false), { kind: 'changed' }); // idle, and not its pid
    assert.deepEqual(await local.act('pts-0', 'hangup', 41233, false), { kind: 'changed' }); // a command pid for a session action
    assert.deepEqual(await local.act('pts-9', 'interrupt', 41233, false), { kind: 'unknown-session' });
    assert.deepEqual(sent, []);
  });

  test('another user\'s process is refused', async () => {
    const { local, sent } = setup();
    assert.deepEqual(await local.act('pts-5', 'interrupt', 4020, false), { kind: 'refused', reason: 'other-user' });
    assert.deepEqual(await local.act('pts-5', 'end', 4000, false), { kind: 'refused', reason: 'other-user' });
    assert.deepEqual(sent, []);
  });

  test('the sshd the tunnel passes through is refused for end and hangup, even through pts/1', async () => {
    const { local, sent } = setup({ tunnel: [2210] });
    assert.deepEqual(await local.act('pts-0', 'hangup', 2210, false), { kind: 'refused', reason: 'tunnel' });
    assert.deepEqual(await local.act('pts-1', 'end', 2210, false), { kind: 'refused', reason: 'tunnel' });
    assert.equal((await local.act('pts-0', 'interrupt', 41233, false)).kind, 'sent'); // the command still goes
    assert.deepEqual(sent, [[-41233, 'SIGINT']]);
  });

  test('the núcleo and what runs it are refused', async () => {
    const { local, sent } = setup({ read: async () => reading({ selfPid: 41233 }) });
    assert.deepEqual(await local.act('pts-0', 'interrupt', 41233, false), { kind: 'refused', reason: 'core' });
    assert.deepEqual(await local.act('pts-0', 'end', 2210, false), { kind: 'refused', reason: 'core' });
    assert.deepEqual(sent, []);
  });

  test('an unreadable ps sends nothing; a process gone between the read and the signal is "changed"', async () => {
    assert.deepEqual(await setup({ read: async () => null }).local.act('pts-0', 'interrupt', 41233, false), { kind: 'unreadable' });
    assert.deepEqual(await setup({ throws: 'ESRCH' }).local.act('pts-0', 'interrupt', 41233, false), { kind: 'changed' });
    assert.deepEqual(await setup({ throws: 'EPERM' }).local.act('pts-0', 'interrupt', 41233, false), { kind: 'refused', reason: 'other-user' });
    await assert.rejects(setup({ throws: 'EIO' }).local.act('pts-0', 'interrupt', 41233, false));
  });

  test('a group 0 or 1 is never a target: kill(0) is the núcleo\'s own group, kill(-1) every process', async () => {
    for (const pgid of [0, 1]) {
      const r = reading();
      const s = r.sessions.find((x) => x.id === 'pts-0')!;
      const { local, sent } = setup({ read: async () => ({ ...r, sessions: [{ ...s, foreground: { ...s.foreground!, pgid } }] }) });
      assert.deepEqual(await local.act('pts-0', 'interrupt', 41233, false), { kind: 'changed' });
      assert.deepEqual(sent, []);
    }
  });
});

describe('#350 forward to a remote machine', () => {
  const calls: [number, string, string, string | null][] = [];
  const remote = (answer: { status: number; body: unknown } | 'down') => ({
    port: (id: string) => (id === 'ws-exemplo' ? 14720 : undefined),
    write: async (port: number, method: 'POST' | 'DELETE', path: string, body: string | null) => {
      calls.push([port, method, path, body]);
      return answer === 'down' ? ({ kind: 'unreachable', reason: 'port-closed' } as const) : ({ kind: 'response', status: answer.status, body: answer.body } as const);
    },
  });
  const make = (answer: Parameters<typeof remote>[0], onRemoteSent?: (m: string) => void) => new TerminalActions({ local: setup().local, remote: remote(answer), onRemoteSent });

  test('only the ids travel, to the same path, and the remote\'s answer is relayed', async () => {
    calls.length = 0;
    const sent: string[] = [];
    const r = await make({ status: 200, body: { result: 'sent', signal: 'SIGINT', target: 'command', secret: 'x' } }, (m) => sent.push(m)).act('ws-exemplo', 'pts-0', 'interrupt', 41233, false);
    assert.deepEqual(calls, [[14720, 'POST', '/api/terminals/pts-0/actions/interrupt', '{"pid":41233}']]);
    assert.deepEqual(r, { kind: 'relayed', status: 200, body: { result: 'sent', signal: 'SIGINT', target: 'command' } });
    assert.deepEqual(sent, ['ws-exemplo']);
  });

  test('kill forwards confirm; a 409 and a 403 come back with their reason', async () => {
    calls.length = 0;
    const r = await make({ status: 403, body: { error: 'x', reason: 'tunnel' } }).act('ws-exemplo', 'pts-0', 'kill', 41233, true);
    assert.equal(calls[0]![3], '{"pid":41233,"confirm":true}');
    assert.deepEqual(r, { kind: 'relayed', status: 403, body: { error: 'x', reason: 'tunnel' } });
  });

  test('an unknown machine, a remote that is down and an odd status', async () => {
    assert.deepEqual(await make('down').act('outra', 'pts-0', 'interrupt', 1, false), { kind: 'unknown-machine' });
    assert.deepEqual(await make('down').act('ws-exemplo', 'pts-0', 'interrupt', 1, false), { kind: 'unreachable' });
    assert.equal(((await make({ status: 500, body: 'x' }).act('ws-exemplo', 'pts-0', 'interrupt', 1, false)) as { status: number }).status, 502);
  });

  test('local actions never touch the remote', async () => {
    calls.length = 0;
    await make({ status: 200, body: {} }).act('local', 'pts-0', 'interrupt', 41233, false);
    assert.deepEqual(calls, []);
  });

  test('relayBody keeps only the known fields', () => {
    assert.deepEqual(relayBody({ error: 'e'.repeat(300), reason: 'Bad Reason!', signal: 'SIGUSR1', target: 'x', extra: 1 }), { error: 'e'.repeat(200) });
    assert.deepEqual(relayBody(null), {});
  });
});

describe('#350 settings', () => {
  test('config.json gives the extra interactive commands, checked', async () => {
    const { parseTerminalSettings } = await import('../../src/telemetry/terminal-config.ts');
    assert.deepEqual(parseTerminalSettings('{}'), { interactiveCommands: [] });
    assert.deepEqual(parseTerminalSettings('nope'), { interactiveCommands: [] });
    assert.deepEqual(parseTerminalSettings('{"terminal":{"interactiveCommands":["vite","rm -rf /",7,"npm"]}}').interactiveCommands, ['vite', 'npm']);
  });
});
