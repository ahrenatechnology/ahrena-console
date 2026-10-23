// machines.json `connection` (#278, decision 0013 section 4): parsed with the rules and limits of
// `reconnect`; an invalid field dropped with a log line while the machine stays; a lone `reconnect`
// read as `connection.start`; with both, `connection` wins and the log says so. Placeholders only.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connectionOf, DEFAULT_RECONNECT_TIMEOUT_SECONDS, MachinesFileSource, parseConnection, parseMachinesConfig } from '../../src/telemetry/machines-config.ts';
import { RemoteMachines, type ManagedMachine } from '../../src/telemetry/remote-machines.ts';

const START = ['/caminho/para/conectar.sh', 'tunnel', 'start'];
const STOP = ['/caminho/para/conectar.sh', 'tunnel', 'stop'];
const file = (entry: Record<string, unknown>) => JSON.stringify({ machines: [{ id: 'ws-exemplo', label: 'Workstation', port: 14720, ...entry }] });

describe('#278 the connection of a remote machine in machines.json', () => {
  test('#278 a full connection keeps start, stop and the cloud profile; reconnect becomes its start', () => {
    const logs: string[] = [];
    const [m] = parseMachinesConfig(
      file({ connection: { start: { command: START, timeoutSeconds: 120 }, stop: { command: STOP }, cloudProfile: { connector: 'aws', profile: 'perfil-dev' } } }),
      (x) => logs.push(x),
    ) as ReturnType<typeof parseMachinesConfig> & object[];
    assert.deepEqual(m, {
      id: 'ws-exemplo',
      label: 'Workstation',
      port: 14720,
      reconnect: { command: START, timeoutSeconds: 120 },
      connection: {
        start: { command: START, timeoutSeconds: 120 },
        stop: { command: STOP, timeoutSeconds: DEFAULT_RECONNECT_TIMEOUT_SECONDS },
        cloudProfile: { connector: 'aws', profile: 'perfil-dev' },
      },
    });
    assert.deepEqual(logs, []);
  });

  test('#278 a lone reconnect is read as connection.start, and the parsed machine is unchanged', () => {
    const [m] = parseMachinesConfig(file({ reconnect: { command: START } })) as { reconnect?: unknown; connection?: unknown }[];
    assert.equal(m!.connection, undefined);
    assert.deepEqual(connectionOf(m as never), { start: { command: START, timeoutSeconds: DEFAULT_RECONNECT_TIMEOUT_SECONDS } });
    assert.equal(connectionOf({}), null);
  });

  test('#278 with both, connection wins and the log says so', () => {
    const logs: string[] = [];
    const [m] = parseMachinesConfig(file({ reconnect: { command: ['/caminho/antigo.sh'] }, connection: { start: { command: START } } }), (x) => logs.push(x)) as {
      reconnect: { command: string[] };
    }[];
    assert.deepEqual(m!.reconnect.command, START);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^machines\[0\]: both "reconnect" and "connection"; "connection" wins/);
  });

  test('#278 an invalid start drops the whole connection (the machine stays; a valid reconnect still applies)', () => {
    const logs: string[] = [];
    const out = parseMachinesConfig(
      JSON.stringify({
        machines: [
          { id: 'ws-exemplo', label: 'Workstation', port: 14720, connection: { start: { command: [] } } },
          { id: 'ws-dois', label: 'Outra', port: 14721, reconnect: { command: START }, connection: { stop: { command: STOP } } },
        ],
      }),
      (x) => logs.push(x),
    ) as { id: string; connection?: unknown; reconnect?: unknown }[];
    assert.equal(out.length, 2);
    assert.equal(out[0]!.connection, undefined);
    assert.equal(out[0]!.reconnect, undefined);
    assert.equal(out[1]!.connection, undefined);
    assert.deepEqual(connectionOf(out[1] as never)?.start.command, START);
    assert.match(logs[0]!, /^machines\[0\]\.connection\.start\.command: .+; ignored$/);
    assert.match(logs[1]!, /^machines\[1\]\.connection\.start: required; ignored \(the "reconnect" applies\)$/);
  });

  test('#278 an invalid stop or cloudProfile drops only that field, with a log line each', () => {
    const cases: [string, unknown, RegExp][] = [
      ['stop without command', { start: { command: START }, stop: { command: [] } }, /^\.stop\.command: .+; ignored$/],
      ['stop timeout too long', { start: { command: START }, stop: { command: STOP, timeoutSeconds: 5000 } }, /^\.stop\.timeoutSeconds: .+; ignored$/],
      ['unknown connector', { start: { command: START }, cloudProfile: { connector: 'nuvem-x', profile: 'perfil-dev' } }, /^\.cloudProfile\.connector: .+; ignored$/],
      ['unsafe profile name', { start: { command: START }, cloudProfile: { connector: 'aws', profile: 'perfil dev; rm' } }, /^\.cloudProfile\.profile: .+; ignored$/],
      ['cloudProfile not an object', { start: { command: START }, cloudProfile: 'perfil-dev' }, /^\.cloudProfile: .+; ignored$/],
    ];
    for (const [name, v, re] of cases) {
      const logs: string[] = [];
      const c = parseConnection(v, (m) => logs.push(m));
      assert.equal(typeof c, 'object', name);
      assert.deepEqual((c as { start: { command: string[] } }).start.command, START, name);
      assert.equal(logs.length, 1, name);
      assert.match(logs[0]!, re, name);
    }
  });

  test('#278 the registry serves the connection from the freshest reading and notices a change of it alone', async () => {
    let text = file({ connection: { start: { command: START } } });
    let stamp = 1;
    const source = new MachinesFileSource({ file: '/example/machines.json', stat: async () => ({ mtimeMs: stamp, size: text.length }), read: async () => text });
    const changes: string[] = [];
    const created: string[] = [];
    const reg = new RemoteMachines<ManagedMachine>({
      source,
      ownPort: 4720,
      create: (c) => (created.push(c.id), { id: c.id, label: c.label, port: c.port, start() {}, async stop() {} }),
      onChange: (id) => changes.push(id),
    });
    await reg.refresh();
    assert.deepEqual(reg.connectionOf('ws-exemplo'), { start: { command: START, timeoutSeconds: DEFAULT_RECONNECT_TIMEOUT_SECONDS } });
    assert.equal(reg.connectionOf('ws-nenhuma'), undefined);
    text = file({ connection: { start: { command: START }, stop: { command: STOP } } });
    stamp++;
    await reg.refresh();
    assert.deepEqual(reg.connectionOf('ws-exemplo')?.stop?.command, STOP);
    assert.deepEqual(created, ['ws-exemplo'], 'kept, not recreated');
    assert.deepEqual(changes, ['ws-exemplo', 'ws-exemplo']);
  });
});
