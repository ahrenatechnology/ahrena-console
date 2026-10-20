// machines.json read live (#244, decision 0012 section 2): re-read by modification time every 30 s and
// right before a reconnect, so a machine added, removed or changed applies without a restart, and an
// invalid file keeps the last good reading. The file system and the timer are doubles: no real file,
// no real 30 s. Example values only: `ws-exemplo`, ports 1472x, a generic script path.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MachinesFileSource, type FileStamp, type RemoteMachineConfig } from '../../src/telemetry/machines-config.ts';
import { RemoteMachines, type ManagedMachine } from '../../src/telemetry/remote-machines.ts';

/** An in-memory machines.json: its text and its stamp, which a test bumps on every write. */
class FakeFile {
  text: string | null = null;
  stamp = 0;
  reads = 0;
  write(value: unknown) {
    this.text = typeof value === 'string' ? value : JSON.stringify(value);
    this.stamp++;
  }
  remove() {
    this.text = null;
  }
  stat = async (): Promise<FileStamp> => {
    if (this.text === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { mtimeMs: this.stamp, size: this.text.length };
  };
  read = async (): Promise<string> => {
    this.reads++;
    if (this.text === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return this.text;
  };
}

const ws = (over: Partial<RemoteMachineConfig> = {}): RemoteMachineConfig => ({ id: 'ws-exemplo', label: 'Workstation', port: 14720, ...over });

function source(f: FakeFile, logs: string[] = []) {
  return new MachinesFileSource({ file: '/example/machines.json', stat: f.stat, read: f.read, log: (m) => logs.push(m) });
}

describe('#244 machines.json is re-read by its modification time', () => {
  test('#244 the first refresh reads the file; an unchanged stamp does not read it again', async () => {
    const f = new FakeFile();
    f.write({ machines: [ws()] });
    const s = source(f);
    assert.deepEqual((await s.refresh()).config, { status: 'ok', machines: [ws()] });
    await s.refresh();
    await s.refresh();
    assert.equal(f.reads, 1);
  });

  test('#244 a new stamp is read again and its machines replace the old ones', async () => {
    const f = new FakeFile();
    f.write({ machines: [ws()] });
    const s = source(f);
    await s.refresh();
    f.write({ machines: [ws({ port: 14721 }), ws({ id: 'ws-dois', label: 'Outra', port: 14722 })] });
    const r = await s.refresh();
    assert.equal(r.changed, true);
    assert.deepEqual(r.config.machines, [ws({ port: 14721 }), ws({ id: 'ws-dois', label: 'Outra', port: 14722 })]);
  });

  test('#244 an invalid file keeps the last good reading, logs once per write', async () => {
    const f = new FakeFile();
    const logs: string[] = [];
    f.write({ machines: [ws()] });
    const s = source(f, logs);
    await s.refresh();
    f.write('{ machines: ');
    const r = await s.refresh();
    assert.equal(r.changed, false);
    assert.equal(r.invalid, true);
    assert.deepEqual(r.config, { status: 'ok', machines: [ws()] });
    await s.refresh();
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /machines: .* is invalid \(.+\); keeping the last good reading/);
  });

  test('#244 an invalid file on the first read gives only this machine, as before', async () => {
    const f = new FakeFile();
    f.write({ machines: [{ id: 'local', label: 'x', port: 1 }] });
    assert.deepEqual((await source(f).refresh()).config, { status: 'invalid', machines: [] });
  });

  test('#244 a file that disappears leaves no remote machine', async () => {
    const f = new FakeFile();
    f.write({ machines: [ws()] });
    const s = source(f);
    await s.refresh();
    f.remove();
    const r = await s.refresh();
    assert.equal(r.changed, true);
    assert.deepEqual(r.config, { status: 'missing', machines: [] });
  });

  test('#244 the file turned off (the demo) never reads anything', async () => {
    const f = new FakeFile();
    f.write({ machines: [ws()] });
    const s = new MachinesFileSource({ file: null, stat: f.stat, read: f.read });
    assert.deepEqual((await s.refresh()).config, { status: 'missing', machines: [] });
    assert.equal(f.reads, 0);
  });
});

/** A remote machine double: records start and stop. */
class FakeMachine implements ManagedMachine {
  started = 0;
  stopped = 0;
  readonly id: string;
  readonly label: string;
  readonly port: number;
  constructor(c: RemoteMachineConfig) {
    this.id = c.id;
    this.label = c.label;
    this.port = c.port;
  }
  start() {
    this.started++;
  }
  async stop() {
    this.stopped++;
  }
}

function registry(f: FakeFile, over: { ownPort?: number } = {}) {
  const created: FakeMachine[] = [];
  const changes: string[] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  let tick: (() => void) | null = null;
  let interval = 0;
  const machines = new RemoteMachines<FakeMachine>({
    source: source(f, logs),
    create: (c) => {
      const m = new FakeMachine(c);
      created.push(m);
      return m;
    },
    ownPort: over.ownPort ?? 4720,
    onChange: (id) => changes.push(id),
    onRemoved: (id) => removed.push(id),
    timers: {
      setInterval: (fn, ms) => {
        tick = fn;
        interval = ms;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
    },
    log: (m) => logs.push(m),
  });
  return { machines, created, changes, removed, logs, tick: () => tick?.(), interval: () => interval };
}

describe('#244 the remote machines follow machines.json without a restart', () => {
  test('#244 a machine added to the file is created and started on the next 30 s refresh', async () => {
    const f = new FakeFile();
    f.write({ machines: [] });
    const r = registry(f);
    await r.machines.refresh();
    r.machines.start();
    assert.equal(r.interval(), 30_000);
    assert.deepEqual(r.machines.list(), []);
    f.write({ machines: [ws()] });
    await r.machines.refresh();
    assert.deepEqual(r.machines.list().map((m) => m.id), ['ws-exemplo']);
    assert.equal(r.created[0]!.started, 1);
    assert.deepEqual(r.changes, ['ws-exemplo']);
  });

  test('#244 the 30 s timer refreshes the file', async () => {
    const f = new FakeFile();
    f.write({ machines: [] });
    const r = registry(f);
    await r.machines.refresh();
    r.machines.start();
    f.write({ machines: [ws()] });
    r.tick();
    await r.machines.refresh(); // waits for the refresh the tick started
    assert.deepEqual(r.machines.list().map((m) => m.id), ['ws-exemplo']);
  });

  test('#244 a machine removed from the file is stopped and its alerts cleared', async () => {
    const f = new FakeFile();
    f.write({ machines: [ws()] });
    const r = registry(f);
    await r.machines.refresh();
    r.machines.start();
    f.write({ machines: [] });
    await r.machines.refresh();
    assert.deepEqual(r.machines.list(), []);
    assert.equal(r.created[0]!.stopped, 1);
    assert.deepEqual(r.removed, ['ws-exemplo']);
    assert.equal(r.machines.has('ws-exemplo'), false);
  });

  test('#244 a machine whose port or label changes is replaced; one whose reconnect changes is kept', async () => {
    const f = new FakeFile();
    f.write({ machines: [ws()] });
    const r = registry(f);
    await r.machines.refresh();
    r.machines.start();
    f.write({ machines: [ws({ port: 14721 })] });
    await r.machines.refresh();
    assert.equal(r.created.length, 2);
    assert.equal(r.created[0]!.stopped, 1);
    assert.equal(r.machines.get('ws-exemplo')!.port, 14721);
    const reconnect = { command: ['/opt/example/connect.sh'], timeoutSeconds: 60 };
    f.write({ machines: [ws({ port: 14721, reconnect })] });
    await r.machines.refresh();
    assert.equal(r.created.length, 2);
    assert.deepEqual(r.machines.reconnectOf('ws-exemplo'), reconnect);
    f.write({ machines: [ws({ port: 14721 })] });
    await r.machines.refresh();
    assert.equal(r.machines.reconnectOf('ws-exemplo'), null);
    assert.equal(r.machines.reconnectOf('nao-existe'), undefined);
  });

  test('#244 an invalid file keeps the machines of the last good reading', async () => {
    const f = new FakeFile();
    f.write({ machines: [ws()] });
    const r = registry(f);
    await r.machines.refresh();
    f.write('not json');
    await r.machines.refresh();
    assert.deepEqual(r.machines.list().map((m) => m.id), ['ws-exemplo']);
  });

  test('#244 while the file is invalid the registry says so (reconnect refused), keeping the last good command for display; fixed, it clears', async () => {
    const f = new FakeFile();
    const reconnect = { command: ['/opt/example/connect.sh'], timeoutSeconds: 60 };
    f.write({ machines: [ws({ reconnect })] });
    const r = registry(f);
    await r.machines.refresh();
    assert.equal(r.machines.fileInvalid(), false);
    f.write('{ "machines": [ { "id": "ws-exemplo", ');
    await r.machines.refresh();
    assert.equal(r.machines.fileInvalid(), true);
    assert.deepEqual(r.machines.reconnectOf('ws-exemplo'), reconnect);
    await r.machines.refresh(); // same stamp: still invalid
    assert.equal(r.machines.fileInvalid(), true);
    f.write({ machines: [ws()] });
    await r.machines.refresh();
    assert.equal(r.machines.fileInvalid(), false);
    assert.equal(r.machines.reconnectOf('ws-exemplo'), null);
  });

  test('#244 a machine on the core own port is skipped, also when it is added live', async () => {
    const f = new FakeFile();
    f.write({ machines: [] });
    const r = registry(f, { ownPort: 14720 });
    await r.machines.refresh();
    f.write({ machines: [ws(), ws({ id: 'ws-dois', label: 'Outra', port: 14722 })] });
    await r.machines.refresh();
    assert.deepEqual(r.machines.list().map((m) => m.id), ['ws-dois']);
    assert.equal(r.machines.has('ws-exemplo'), false);
    assert.ok(r.logs.some((l) => /ws-exemplo uses port 14720, this core's own; skipped/.test(l)));
  });

  test('#244 machines are not started before start(), and stop() stops them all and the timer', async () => {
    const f = new FakeFile();
    f.write({ machines: [ws()] });
    const r = registry(f);
    await r.machines.refresh();
    assert.equal(r.created[0]!.started, 0);
    r.machines.start();
    assert.equal(r.created[0]!.started, 1);
    await r.machines.stop();
    assert.equal(r.created[0]!.stopped, 1);
  });
});
