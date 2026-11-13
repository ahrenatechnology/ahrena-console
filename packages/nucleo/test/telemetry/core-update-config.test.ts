// `connection.update` of machines.json (issue 462, decision 0022 section 1): the schema, the validation, the list
// form with no shell, and the items the núcleo refuses inside the declared command. Placeholders only.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FORBIDDEN_UPDATE_ITEMS, parseConnection, parseMachinesConfig, parseUpdate, type RemoteMachineConfig } from '../../src/telemetry/machines-config.ts';

const SSH = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', 'ahrena-tunnel', '/opt/node/bin/node', '--input-type=module', '-', '--checkout', '/srv/ahrena-console', '--port', '4720'];
const file = (update: unknown) => JSON.stringify({ machines: [{ id: 'ws-exemplo', label: 'Workstation', port: 14720, connection: { start: { command: ['/bin/true'] }, ...(update === undefined ? {} : { update }) } }] });

describe('issue 462 connection.update in machines.json', () => {
  test('a valid update: a list, 300 s by default, 60 to 900', () => {
    assert.deepEqual(parseUpdate({ command: SSH }), { command: SSH, timeoutSeconds: 300 });
    assert.deepEqual(parseUpdate({ command: SSH, timeoutSeconds: 60 }), { command: SSH, timeoutSeconds: 60 });
    assert.deepEqual(parseUpdate({ command: SSH, timeoutSeconds: 900 }), { command: SSH, timeoutSeconds: 900 });
  });

  test('the rules of the other commands: a text is not a list, no empty or NUL items, no shell form', () => {
    assert.deepEqual(parseUpdate('ssh host node -'), { problem: 'not-an-object' });
    assert.deepEqual(parseUpdate(null), { problem: 'not-an-object' });
    assert.deepEqual(parseUpdate([]), { problem: 'not-an-object' });
    assert.deepEqual(parseUpdate({ command: 'ssh host node -' }), { problem: 'bad-command' });
    assert.deepEqual(parseUpdate({ command: [] }), { problem: 'bad-command' });
    assert.deepEqual(parseUpdate({ command: ['ssh', ''] }), { problem: 'bad-command' });
    assert.deepEqual(parseUpdate({ command: ['ssh', 'a\0b'] }), { problem: 'bad-command' });
    assert.deepEqual(parseUpdate({ command: ['ssh', 5] }), { problem: 'bad-command' });
    assert.deepEqual(parseUpdate({}), { problem: 'bad-command' });
  });

  test('the timeout is an integer from 60 to 900', () => {
    for (const timeoutSeconds of [59, 901, 1.5, '300', null, Number.NaN]) assert.deepEqual(parseUpdate({ command: SSH, timeoutSeconds }), { problem: 'bad-timeout' }, String(timeoutSeconds));
  });

  test('the núcleo refuses --allow-disconnect, --force, --core-options, install-unit and the flags of its own tail, bare or with =', () => {
    for (const item of FORBIDDEN_UPDATE_ITEMS) {
      assert.deepEqual(parseUpdate({ command: [...SSH, item] }), { problem: 'forbidden-flag' }, item);
      assert.deepEqual(parseUpdate({ command: [...SSH, `${item}=x`] }), { problem: 'forbidden-flag' }, `${item}=`);
    }
    assert.deepEqual(parseUpdate({ command: [...SSH, '--core-options', '--port 4720 --data-dir /x'] }), { problem: 'forbidden-flag' });
    // --no-fetch and --data-dir are the user's to declare.
    assert.notEqual('problem' in parseUpdate({ command: [...SSH, '--no-fetch', '--data-dir', '/srv/data'] }), true);
  });

  test('an invalid update drops only that field: the machine stays, and the fixed reason is kept (never the value)', () => {
    const log: string[] = [];
    const m = parseMachinesConfig(file({ command: [...SSH, '--allow-disconnect'] }), (x) => log.push(x)) as RemoteMachineConfig[];
    assert.equal(m.length, 1);
    assert.equal(m[0]!.connection?.update, undefined);
    assert.equal(m[0]!.connection?.updateProblem, 'forbidden-flag');
    assert.equal(log.length, 1);
    assert.equal(log[0]!.includes('--allow-disconnect'), false, 'the log never carries the value');
    assert.match(log[0]!, /\.update: forbidden-flag; ignored/);
  });

  test('a valid update lands on connection.update and no problem', () => {
    const m = parseMachinesConfig(file({ command: SSH, timeoutSeconds: 120 })) as RemoteMachineConfig[];
    assert.deepEqual(m[0]!.connection?.update, { command: SSH, timeoutSeconds: 120 });
    assert.equal(m[0]!.connection?.updateProblem, undefined);
  });

  test('without update nothing changes for the connection', () => {
    const c = parseConnection({ start: { command: ['/bin/true'] } });
    assert.equal(typeof c, 'object');
    assert.equal('update' in (c as object), false);
    assert.equal('updateProblem' in (c as object), false);
  });
});
