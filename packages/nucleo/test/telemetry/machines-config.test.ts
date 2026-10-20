// `machines.json` (#176): where the remote machines come from. The path is injected (a temporary
// folder), never the user's own `~/.ahrena-console`. Example values only: `ws-exemplo`, port 14720.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  DEFAULT_RECONNECT_TIMEOUT_SECONDS,
  defaultMachinesFile,
  loadMachinesConfig,
  parseMachinesConfig,
  parseReconnect,
  type RemoteMachineConfig,
} from '../../src/telemetry/machines-config.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-machines-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const VALID = JSON.stringify({ machines: [{ id: 'ws-exemplo', label: 'Workstation', port: 14720 }] });

describe('#176/AC-1 the remote machines come from machines.json', () => {
  test('#176/AC-1 a valid file gives its machines, in order, with the label trimmed', async () => {
    const p = file('ok.json', JSON.stringify({ machines: [{ id: 'ws-exemplo', label: '  Workstation  ', port: 14720 }, { id: 'ws-dois', label: 'Outra', port: 14721 }] }));
    const logs: string[] = [];
    assert.deepEqual(await loadMachinesConfig({ file: p, log: (m) => logs.push(m) }), {
      status: 'ok',
      machines: [
        { id: 'ws-exemplo', label: 'Workstation', port: 14720 },
        { id: 'ws-dois', label: 'Outra', port: 14721 },
      ],
    });
    assert.deepEqual(logs, []);
  });

  test('#176/AC-1 no file: only local, nothing logged', async () => {
    const logs: string[] = [];
    assert.deepEqual(await loadMachinesConfig({ file: join(dir, 'missing.json'), log: (m) => logs.push(m) }), { status: 'missing', machines: [] });
    assert.deepEqual(logs, []);
  });

  test('#176/AC-1 file turned off (the demo): only local', async () => {
    assert.deepEqual(await loadMachinesConfig({ file: null }), { status: 'missing', machines: [] });
  });

  test('#176/AC-1 an invalid file is logged and gives only local', async () => {
    const cases: [string, string][] = [
      ['not JSON', '{ machines: '],
      ['wrong shape', JSON.stringify({ hosts: [] })],
      ['bad id', JSON.stringify({ machines: [{ id: 'WS Exemplo', label: 'Workstation', port: 14720 }] })],
      ['reserved id', JSON.stringify({ machines: [{ id: 'local', label: 'Workstation', port: 14720 }] })],
      ['repeated id', JSON.stringify({ machines: [{ id: 'ws-exemplo', label: 'A', port: 14720 }, { id: 'ws-exemplo', label: 'B', port: 14721 }] })],
      ['empty label', JSON.stringify({ machines: [{ id: 'ws-exemplo', label: ' ', port: 14720 }] })],
      ['port out of range', JSON.stringify({ machines: [{ id: 'ws-exemplo', label: 'Workstation', port: 70000 }] })],
      ['port as text', JSON.stringify({ machines: [{ id: 'ws-exemplo', label: 'Workstation', port: '14720' }] })],
      ['one bad entry voids the file', JSON.stringify({ machines: [JSON.parse(VALID).machines[0], { id: 'ws-dois', label: 'Outra' }] })],
    ];
    for (const [name, content] of cases) {
      const logs: string[] = [];
      const p = file(`${name.replaceAll(' ', '-')}.json`, content);
      assert.deepEqual(await loadMachinesConfig({ file: p, log: (m) => logs.push(m) }), { status: 'invalid', machines: [] }, name);
      assert.equal(logs.length, 1, name);
      assert.match(logs[0]!, /machines: .* is invalid \(.+\); only this machine/, name);
    }
  });

  test('#176/AC-1 the parser says why a file is invalid', () => {
    assert.equal(parseMachinesConfig('[]'), 'expected { "machines": [...] }');
    assert.equal(parseMachinesConfig(JSON.stringify({ machines: [{ id: 'local', label: 'x', port: 1 }] })), 'machines[0].id: "local" is this machine');
    assert.deepEqual(parseMachinesConfig(VALID), [{ id: 'ws-exemplo', label: 'Workstation', port: 14720 }]);
  });

  test('#176/AC-1 the default path is ~/.ahrena-console/machines.json, like contas.json', () => {
    assert.match(defaultMachinesFile({}), /[\\/]\.ahrena-console[\\/]machines\.json$/);
  });

  test('#244 the default path follows AHRENA_CONSOLE_HOME, like the instance registry', () => {
    assert.equal(defaultMachinesFile({ AHRENA_CONSOLE_HOME: '/tmp/console-home' }), join('/tmp/console-home', 'machines.json'));
  });
});

describe('#244 the optional reconnect command of a remote machine', () => {
  const withReconnect = (reconnect: unknown) => JSON.stringify({ machines: [{ id: 'ws-exemplo', label: 'Workstation', port: 14720, reconnect }] });

  test('#244 a valid reconnect keeps the command list as written and the timeout given', () => {
    const logs: string[] = [];
    assert.deepEqual(parseMachinesConfig(withReconnect({ command: ['/opt/example/connect.sh', 'tunnel', 'restart'], timeoutSeconds: 60 }), (m) => logs.push(m)), [
      { id: 'ws-exemplo', label: 'Workstation', port: 14720, reconnect: { command: ['/opt/example/connect.sh', 'tunnel', 'restart'], timeoutSeconds: 60 } },
    ]);
    assert.deepEqual(logs, []);
  });

  test('#244 without timeoutSeconds the timeout is 180 s', () => {
    assert.deepEqual(parseMachinesConfig(withReconnect({ command: ['example-connect'] })), [
      { id: 'ws-exemplo', label: 'Workstation', port: 14720, reconnect: { command: ['example-connect'], timeoutSeconds: DEFAULT_RECONNECT_TIMEOUT_SECONDS } },
    ]);
    assert.equal(DEFAULT_RECONNECT_TIMEOUT_SECONDS, 180);
  });

  test('#244 the timeout bounds 10 and 900 are accepted', () => {
    for (const t of [10, 900]) {
      const [m] = parseMachinesConfig(withReconnect({ command: ['x'], timeoutSeconds: t })) as RemoteMachineConfig[];
      assert.equal(m!.reconnect?.timeoutSeconds, t);
    }
  });

  test('#244 an invalid reconnect drops only that field, logs why, and keeps the machine and the rest of the file', () => {
    const cases: [string, unknown][] = [
      ['not an object', 'example-connect tunnel'],
      ['a list at the top', ['example-connect']],
      ['no command', { timeoutSeconds: 60 }],
      ['command as text', { command: 'example-connect tunnel restart' }],
      ['empty command', { command: [] }],
      ['an item that is not text', { command: ['example-connect', 3] }],
      ['an empty item', { command: ['example-connect', ''] }],
      ['an empty executable', { command: [''] }],
      ['an item with NUL', { command: ['example-connect', 'a\u0000b'] }],
      ['an item too long', { command: ['example-connect', 'a'.repeat(1025)] }],
      ['too many items', { command: Array.from({ length: 33 }, () => 'a') }],
      ['timeout below 10', { command: ['x'], timeoutSeconds: 9 }],
      ['timeout above 900', { command: ['x'], timeoutSeconds: 901 }],
      ['timeout not an integer', { command: ['x'], timeoutSeconds: 30.5 }],
      ['timeout as text', { command: ['x'], timeoutSeconds: '60' }],
      ['null', null],
    ];
    for (const [name, reconnect] of cases) {
      const logs: string[] = [];
      const text = JSON.stringify({ machines: [{ id: 'ws-exemplo', label: 'Workstation', port: 14720, reconnect }, { id: 'ws-dois', label: 'Outra', port: 14721 }] });
      assert.deepEqual(
        parseMachinesConfig(text, (m) => logs.push(m)),
        [
          { id: 'ws-exemplo', label: 'Workstation', port: 14720 },
          { id: 'ws-dois', label: 'Outra', port: 14721 },
        ],
        name,
      );
      assert.equal(logs.length, 1, name);
      assert.match(logs[0]!, /^machines\[0\]\.reconnect(\.[a-zA-Z]+)?: .+; ignored$/, name);
    }
  });

  test('#244 loadMachinesConfig logs an invalid reconnect with the file name and still returns ok', async () => {
    const p = file('bad-reconnect.json', withReconnect({ command: [] }));
    const logs: string[] = [];
    assert.deepEqual(await loadMachinesConfig({ file: p, log: (m) => logs.push(m) }), { status: 'ok', machines: [{ id: 'ws-exemplo', label: 'Workstation', port: 14720 }] });
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^machines: .*bad-reconnect\.json: machines\[0\]\.reconnect.*; ignored$/);
  });

  test('#244 parseReconnect says why a reconnect is invalid', () => {
    assert.deepEqual(parseReconnect({ command: ['x', 'y'] }), { command: ['x', 'y'], timeoutSeconds: 180 });
    assert.equal(typeof parseReconnect({ command: [] }), 'string');
  });
});
