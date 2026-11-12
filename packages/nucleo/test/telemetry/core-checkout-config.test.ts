// Issue 449, decision 0021 section 2, criterion AC1: `connection.checkout` of machines.json is a text
// that only feeds the command the screen shows. It is never run, so it is validated as a plain absolute
// path; an invalid one drops only that field, with a log line, like `credential`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_CHECKOUT_LENGTH, parseCheckout, parseMachinesConfig } from '../../src/telemetry/machines-config.ts';

const machines = (checkout: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ machines: [{ id: 'ws', label: 'WS', port: 14720, connection: { start: { command: ['/bin/true'] }, checkout, ...extra } }] });

describe('AC1 connection.checkout validation', () => {
  test('AC1 parseCheckout accepts an absolute path', () => {
    for (const ok of ['/home/ubuntu/ahrena-console', '/opt/a b/c', '/srv/app.v2/checkout_1', '/']) assert.equal(parseCheckout(ok), ok);
  });

  test('AC1 parseCheckout refuses relative, .., ~, NUL, shell expansion, control characters, empty and too long', () => {
    const bad: unknown[] = [
      'ahrena-console',
      './ahrena-console',
      '',
      '/home/../etc',
      '/home/ubuntu/..',
      '~/ahrena-console',
      '/home/~ubuntu/x',
      '/home/ub\0untu',
      '/home/$HOME/x',
      '/home/`id`/x',
      '/home/ubuntu\\x',
      '/home/ubuntu\nrm -rf /',
      '/' + 'a'.repeat(MAX_CHECKOUT_LENGTH),
      42,
      null,
      ['/home'],
    ];
    for (const v of bad) assert.ok(typeof parseCheckout(v) === 'object' && 'refused' in (parseCheckout(v) as object), `${JSON.stringify(v)} should be refused`);
  });

  test('AC1 a path of exactly the limit is accepted, one more is not', () => {
    const at = '/' + 'a'.repeat(MAX_CHECKOUT_LENGTH - 1);
    assert.equal(at.length, MAX_CHECKOUT_LENGTH);
    assert.equal(MAX_CHECKOUT_LENGTH, 512);
    assert.equal(parseCheckout(at), at);
    assert.ok(typeof parseCheckout(at + 'a') === 'object');
  });

  test('AC1 a valid checkout reaches the machine config', () => {
    const logs: string[] = [];
    const parsed = parseMachinesConfig(machines('/home/ubuntu/ahrena-console'), (m) => logs.push(m));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0]!.connection?.checkout, '/home/ubuntu/ahrena-console');
    assert.deepEqual(logs, []);
  });

  test('AC1 an invalid checkout drops only that field, with one log line, and keeps start, credential and the machine', () => {
    for (const bad of ['relative/path', '/a/../b', '~/x', '/a\0b', '/a'.padEnd(600, 'a'), 7]) {
      const logs: string[] = [];
      const parsed = parseMachinesConfig(machines(bad, { credential: { command: ['/bin/true'] } }), (m) => logs.push(m));
      assert.ok(Array.isArray(parsed), String(bad));
      const connection = parsed[0]!.connection!;
      assert.equal(connection.checkout, undefined);
      assert.deepEqual(connection.start.command, ['/bin/true']);
      assert.deepEqual(connection.credential?.command, ['/bin/true']);
      assert.equal(logs.length, 1);
      assert.match(logs[0]!, /connection\.checkout.*ignored/);
    }
  });

  test('AC1 the log line never repeats the refused value', () => {
    const logs: string[] = [];
    parseMachinesConfig(machines('/home/$SECRET_TOKEN/x'), (m) => logs.push(m));
    assert.ok(!logs.join('\n').includes('SECRET_TOKEN'));
  });

  test('AC1 no checkout is the same as before: the field is absent', () => {
    const parsed = parseMachinesConfig(JSON.stringify({ machines: [{ id: 'ws', label: 'WS', port: 14720, connection: { start: { command: ['/bin/true'] } } }] }));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0]!.connection?.checkout, undefined);
  });
});
