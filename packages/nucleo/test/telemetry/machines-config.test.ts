// `machines.json` (#176): where the remote machines come from. The path is injected (a temporary
// folder), never the user's own `~/.ahrena-console`. Example values only: `ws-exemplo`, port 14720.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { defaultMachinesFile, loadMachinesConfig, parseMachinesConfig } from '../../src/telemetry/machines-config.ts';

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
    assert.match(defaultMachinesFile(), /[\\/]\.ahrena-console[\\/]machines\.json$/);
  });
});
