// The ready-made `"update"` block (issue 462, decision 0022 section 1): built from the user's own
// `connection.credential`, and always a block the validator accepts. Placeholders only.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildUpdateBlock } from '../../src/telemetry/core-update-block.ts';
import { parseConnection, parseUpdate } from '../../src/telemetry/machines-config.ts';

const PREFIX = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'SessionType=default', '-o', 'ControlMaster=no', '-o', 'ClearAllForwardings=yes', 'ahrena-tunnel'];
const credential = (extra: string[] = []) => ({
  command: [...PREFIX, '/opt/node/bin/node', '/srv/ahrena-console/packages/nucleo/src/owner/cli.ts', 'remote-credential', '--port', '4720', ...extra],
  timeoutSeconds: 20,
});

describe('issue 462 the ready-made block', () => {
  test('copies the SSH prefix of the credential and swaps its tail for the stdin script run', () => {
    const b = buildUpdateBlock(credential(), null)!;
    assert.deepEqual(b.command, [...PREFIX, '/opt/node/bin/node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-', '--checkout', '/srv/ahrena-console', '--port', '4720']);
    assert.equal(b.timeoutSeconds, 300);
    assert.match(b.text, /^"update": \{\n {2}"command": \[\n {4}"\/usr\/bin\/ssh",/);
    assert.match(b.text, /\n {2}"timeoutSeconds": 300\n\}$/);
  });

  test('the block pasted into a connection is accepted by the validator, and is the same command', () => {
    const b = buildUpdateBlock(credential(), null)!;
    const pasted = JSON.parse(`{ ${b.text} }`) as { update: unknown };
    assert.deepEqual(parseUpdate(pasted.update), { command: b.command, timeoutSeconds: 300 });
    const c = parseConnection({ start: { command: ['/bin/true'] }, credential: credential(), ...pasted });
    assert.equal(typeof c, 'object');
    assert.deepEqual((c as { update: unknown }).update, { command: b.command, timeoutSeconds: 300 });
  });

  test('connection.checkout wins over the one the cli.ts path implies', () => {
    const b = buildUpdateBlock(credential(), '/home/dev/console')!;
    assert.equal(b.command[b.command.indexOf('--checkout') + 1], '/home/dev/console');
  });

  test('no block when the credential is missing, not the known shape, or the checkout is unusable', () => {
    assert.equal(buildUpdateBlock(null, null), null);
    assert.equal(buildUpdateBlock({ command: ['/usr/bin/ssh', 'host', 'whatever'], timeoutSeconds: 20 }, null), null);
    assert.equal(buildUpdateBlock({ command: [...PREFIX, 'node', '/x/other/cli.ts', 'remote-credential', '--port', '4720'], timeoutSeconds: 20 }, null), null);
    assert.equal(buildUpdateBlock({ command: [...PREFIX, 'node', '/srv/a/packages/nucleo/src/owner/cli.ts', 'remote-credential'], timeoutSeconds: 20 }, null), null);
    assert.equal(buildUpdateBlock({ command: [...PREFIX, 'node', '/srv/a/packages/nucleo/src/owner/cli.ts', 'remote-credential', '--port', 'abc'], timeoutSeconds: 20 }, null), null);
    assert.equal(buildUpdateBlock({ command: [...PREFIX, 'node', '/srv/$HOME/packages/nucleo/src/owner/cli.ts', 'remote-credential', '--port', '4720'], timeoutSeconds: 20 }, null), null);
    assert.equal(buildUpdateBlock(credential(), 'relative/path'), null);
  });

  test('a credential prefix that carries a forbidden item gives no block', () => {
    const c = credential();
    c.command.splice(1, 0, '--force');
    assert.equal(buildUpdateBlock(c, null), null);
  });
});
