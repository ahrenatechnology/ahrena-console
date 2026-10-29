// Releasing a port (#286, decision 0015): the pid is checked again, only the user's own process is
// signalled, the núcleo, the app and a container's proxy never are, and SIGKILL is its own request.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PortReleaser, listPortsWith, summarizeCommand, type PortReleaserDeps } from '../../src/ports/release.ts';
import type { ListeningPort } from '../../src/telemetry/model.ts';

const listener = (port: number, pid: number | null, process: string | null): ListeningPort => ({ port, interface: 'all', address: null, process, pid });

function setup(initial: ListeningPort[], opts: { ps?: Record<number, string>; closesOnSignal?: boolean; uid?: number | null; killError?: string } = {}) {
  let ports = initial;
  const signals: [number, string][] = [];
  const commands: string[][] = [];
  const deps: PortReleaserDeps = {
    listPorts: async () => ports,
    run: async (command, args) => {
      commands.push([command, ...args]);
      const pid = Number(args[args.length - 1]);
      return opts.ps?.[pid] ?? null;
    },
    uid: () => (opts.uid === undefined ? 501 : opts.uid),
    selfPid: 100,
    parentPid: 50,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (opts.killError) throw Object.assign(new Error(opts.killError), { code: opts.killError });
      if (opts.closesOnSignal) ports = ports.filter((p) => p.pid !== pid);
    },
    sleep: async () => {},
    waitMs: { TERM: 500, KILL: 500 },
  };
  return { releaser: new PortReleaser(deps), signals, commands };
}

describe('PortReleaser', () => {
  test('sends SIGTERM to the owner and reports the port released once it closes', async () => {
    const t = setup([listener(5432, 2210, 'postgres')], { ps: { 2210: '501 /usr/bin/postgres -D data' }, closesOnSignal: true });
    assert.deepEqual(await t.releaser.release(5432, 2210, 'TERM'), { kind: 'released' });
    assert.deepEqual(t.signals, [[2210, 'SIGTERM']]);
  });

  test('reports still-listening when the process stays, and SIGKILL is a separate request', async () => {
    const t = setup([listener(5432, 2210, 'postgres')], { ps: { 2210: '501 postgres' } });
    assert.deepEqual(await t.releaser.release(5432, 2210, 'TERM'), { kind: 'still-listening' });
    assert.deepEqual(await t.releaser.release(5432, 2210, 'KILL'), { kind: 'still-listening' });
    assert.deepEqual(t.signals, [[2210, 'SIGTERM'], [2210, 'SIGKILL']]);
  });

  test('sends nothing when the pid no longer owns the port, and says who does', async () => {
    const t = setup([listener(5432, 5120, 'redis-server')], { ps: { 5120: '501 redis-server' } });
    assert.deepEqual(await t.releaser.release(5432, 2210, 'TERM'), { kind: 'refused', reason: 'owner-changed', now: { process: 'redis-server', pid: 5120 } });
    assert.deepEqual(t.signals, []);
  });

  test('sends nothing when the port is already free', async () => {
    const t = setup([]);
    assert.deepEqual(await t.releaser.release(5432, 2210, 'TERM'), { kind: 'refused', reason: 'already-free' });
    assert.deepEqual(t.signals, []);
  });

  test('never signals the núcleo itself, its parent (the app), or the app bundle', async () => {
    const t = setup([listener(4720, 100, 'node'), listener(4731, 50, 'node'), listener(4740, 7002, 'Ahrena Console')], { ps: { 100: '501 node', 50: '501 app', 7002: '501 /Applications/Ahrena Console.app/Contents/MacOS/app' } });
    assert.equal(((await t.releaser.release(4720, 100, 'KILL')) as { reason: string }).reason, 'self');
    assert.equal(((await t.releaser.release(4731, 50, 'KILL')) as { reason: string }).reason, 'app');
    assert.equal(((await t.releaser.release(4740, 7002, 'KILL')) as { reason: string }).reason, 'app');
    assert.deepEqual(t.signals, []);
  });

  test('never signals a container proxy: the stack is the owner', async () => {
    const t = setup([listener(15306, 4417, 'docker-proxy')], { ps: { 4417: '501 docker-proxy' } });
    assert.equal(((await t.releaser.release(15306, 4417, 'TERM')) as { reason: string }).reason, 'container');
    assert.deepEqual(t.signals, []);
  });

  test('never signals a process of another user, nor asks for a password', async () => {
    const t = setup([listener(22, 811, 'sshd')], { ps: { 811: '0 /usr/sbin/sshd -D' } });
    assert.equal(((await t.releaser.release(22, 811, 'TERM')) as { reason: string }).reason, 'other-user');
    assert.deepEqual(t.signals, []);
    assert.ok(t.commands.every((c) => c[0] === 'ps'), 'only ps is run');
  });

  test('a process without a pid in the reading is not released', async () => {
    const t = setup([listener(5433, null, null)]);
    assert.equal(((await t.releaser.release(5433, 2210, 'TERM')) as { reason: string }).reason, 'owner-changed');
  });

  test('refuses where there is no uid (Windows) and when the listeners cannot be read', async () => {
    const noUid = setup([listener(5432, 2210, 'postgres')], { uid: null, ps: { 2210: '501 postgres' } });
    assert.equal(((await noUid.releaser.release(5432, 2210, 'TERM')) as { reason: string }).reason, 'unavailable');
    const unreadable = new PortReleaser({ ...({} as PortReleaserDeps), listPorts: async () => null });
    assert.equal(((await unreadable.release(5432, 2210, 'TERM')) as { reason: string }).reason, 'unavailable');
  });

  test('ESRCH means it already left; EPERM means another user', async () => {
    const gone = setup([listener(5432, 2210, 'postgres')], { ps: { 2210: '501 postgres' }, killError: 'ESRCH' });
    assert.deepEqual(await gone.releaser.release(5432, 2210, 'TERM'), { kind: 'released' });
    const denied = setup([listener(5432, 2210, 'postgres')], { ps: { 2210: '501 postgres' }, killError: 'EPERM' });
    assert.equal(((await denied.releaser.release(5432, 2210, 'TERM')) as { reason: string }).reason, 'other-user');
  });
});

describe('listPortsWith', () => {
  test('reads ss on Linux and lsof on macOS, and nothing elsewhere', async () => {
    const calls: string[] = [];
    const run = async (c: string) => {
      calls.push(c);
      return c === 'ss' ? 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))\n' : 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 77 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)\n';
    };
    assert.deepEqual((await listPortsWith(run, 'linux')())?.map((p) => [p.port, p.pid]), [[22, 812]]);
    assert.deepEqual((await listPortsWith(run, 'darwin')())?.map((p) => [p.port, p.pid]), [[3000, 77]]);
    assert.equal(await listPortsWith(run, 'win32')(), null);
    assert.deepEqual(calls, ['ss', 'lsof']);
  });
});

describe('preview and the command summary', () => {
  test('the preview names the process, its short command and every port the pid holds, and signals nothing', async () => {
    const t = setup([listener(13000, 6102, 'ssh'), listener(14720, 6102, 'ssh'), listener(3000, 7741, 'node')], { ps: { 6102: '501 ssh -N ws-exemplo' } });
    assert.deepEqual(await t.releaser.preview(13000, 6102), { kind: 'ok', process: 'ssh', pid: 6102, command: 'ssh -N ws-exemplo', ports: [13000, 14720], interface: 'all' });
    assert.deepEqual(t.signals, []);
  });

  test('the preview gives the same refusals a release would', async () => {
    const t = setup([listener(22, 811, 'sshd')], { ps: { 811: '0 /usr/sbin/sshd -D' } });
    assert.equal(((await t.releaser.preview(22, 811)) as { reason: string }).reason, 'other-user');
    assert.equal(((await t.releaser.preview(22, 1)) as { reason: string }).reason, 'owner-changed');
  });

  test('the summary is one short line without credentials', () => {
    assert.equal(summarizeCommand('psql postgres://admin:hunter2@db:5432/x --api-token abc123 --password=p4ss'), 'psql postgres://***@db:5432/x --api-token *** --password=***');
    assert.equal(summarizeCommand('a\nb\tc'), 'a b c');
    assert.equal(summarizeCommand('x'.repeat(500)).length, 160);
  });
});
