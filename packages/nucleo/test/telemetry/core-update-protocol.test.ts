// The closed argv tail, the NDJSON parser and the exit classifier of the Update button (issue 462, decision 0022
// sections 1, 4 and 7). Pure functions: no process, no network.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildTail, classify, MAX_UPDATE_OUTPUT_BYTES, parseProgressLine, phaseAdvances, ProgressParser, reasonFits, refOf, type ProgressEvent } from '../../src/telemetry/core-update-protocol.ts';
import { phase, result } from './core-update-fixture.ts';

describe('issue 462 the closed argv tail', () => {
  test('the exact tail of the update and of the check; never --allow-disconnect, --force or --core-options', () => {
    const base = { ref: 'app-v0.0.17', telemetryVersion: 1, credentialCommand: true };
    assert.deepEqual(buildTail({ ...base, check: false }), ['--ref', 'app-v0.0.17', '--mac-telemetry-version', '1', '--mac-credential-command', 'yes', '--progress', 'json']);
    assert.deepEqual(buildTail({ ...base, credentialCommand: false, check: true }), ['--ref', 'app-v0.0.17', '--mac-telemetry-version', '1', '--mac-credential-command', 'no', '--progress', 'json', '--check']);
    const all = [...buildTail({ ...base, check: true })!];
    for (const bad of ['--allow-disconnect', '--force', '--core-options']) assert.equal(all.includes(bad), false);
  });

  test('every value is pinned by its regex: a ref or a number with a shell metacharacter gives no tail at all', () => {
    const ok = { ref: 'app-v1.2.3', telemetryVersion: 1, credentialCommand: true, check: false };
    for (const ref of ['origin/main', 'app-v1.2', 'app-v1.2.3; rm -rf /', 'app-v1.2.3\n', '$(id)', 'app-v1.2.3-dev', '', '--check']) assert.equal(buildTail({ ...ok, ref }), null, ref);
    for (const telemetryVersion of [-1, 1.5, Number.NaN, 10_000_000]) assert.equal(buildTail({ ...ok, telemetryVersion }), null, String(telemetryVersion));
  });

  test('refOf: a plain release only', () => {
    assert.equal(refOf('0.0.17'), 'app-v0.0.17');
    assert.equal(refOf('0.0.17-dev'), null);
    assert.equal(refOf('0.0'), null);
  });
});

describe('issue 462 the NDJSON parser', () => {
  test('phases and results inside the schema', () => {
    assert.deepEqual(parseProgressLine('{"v":1,"event":"phase","phase":"swap"}'), { event: 'phase', phase: 'swap' });
    assert.deepEqual(parseProgressLine(result(41, { reason: 'started-failed', backup: '/srv/b/update-1', oldCommit: 'abc1234', newCommit: 'def5678' }).trim()), {
      event: 'result',
      exit: 41,
      reason: 'started-failed',
      backup: '/srv/b/update-1',
      oldCommit: 'abc1234',
      newCommit: 'def5678',
    });
  });

  test('anything outside the schema is ignored', () => {
    const bad = [
      '',
      'hello',
      '[]',
      'null',
      '{"v":2,"event":"phase","phase":"swap"}',
      '{"event":"phase","phase":"swap"}',
      '{"v":1,"event":"phase","phase":"reboot"}',
      '{"v":1,"event":"phase","phase":"swap","x":1}',
      '{"v":1,"event":"other"}',
      '{"v":1,"event":"result","exit":"0","reason":null,"backup":null,"oldCommit":null,"newCommit":null}',
      '{"v":1,"event":"result","exit":256,"reason":null,"backup":null,"oldCommit":null,"newCommit":null}',
      '{"v":1,"event":"result","exit":1.5,"reason":null,"backup":null,"oldCommit":null,"newCommit":null}',
      '{"v":1,"event":"result","exit":30,"reason":"because","backup":null,"oldCommit":null,"newCommit":null}',
      '{"v":1,"event":"result","exit":40,"reason":null,"backup":"relative","oldCommit":null,"newCommit":null}',
      '{"v":1,"event":"result","exit":40,"reason":null,"backup":"/a\\u0007b","oldCommit":null,"newCommit":null}',
      `{"v":1,"event":"result","exit":40,"reason":null,"backup":"/${'a'.repeat(600)}","oldCommit":null,"newCommit":null}`,
      '{"v":1,"event":"result","exit":40,"reason":null,"backup":null,"oldCommit":"XYZ","newCommit":null}',
      '{"v":1,"event":"result","exit":40,"reason":null,"backup":null,"oldCommit":"abc","newCommit":null}',
      '{"v":1,"event":"result","exit":40,"reason":null,"backup":null,"oldCommit":null}',
    ];
    for (const line of bad) assert.equal(parseProgressLine(line), null, line);
  });

  test('lines split across chunks, CRLF, and a last line without a newline', () => {
    const seen: ProgressEvent[] = [];
    const p = new ProgressParser((e) => seen.push(e));
    const text = phase('check').trim() + '\r\n' + phase('backup') + result(0).trim();
    p.push(Buffer.from(text.slice(0, 20)));
    p.push(Buffer.from(text.slice(20, 70)));
    p.push(Buffer.from(text.slice(70)));
    assert.equal(seen.length, 2);
    p.end();
    assert.deepEqual(seen.map((e) => e.event), ['phase', 'phase', 'result']);
  });

  test('past 64 KiB the rest is dropped, but the lines inside the cap are read', () => {
    const seen: ProgressEvent[] = [];
    const p = new ProgressParser((e) => seen.push(e));
    p.push(Buffer.concat([Buffer.from(phase('swap')), Buffer.alloc(MAX_UPDATE_OUTPUT_BYTES + 10, 'x')]));
    assert.equal(p.overflow, true);
    assert.deepEqual(seen, [{ event: 'phase', phase: 'swap' }]);
    p.push(Buffer.from(phase('verify')));
    p.end();
    assert.equal(seen.length, 1);
  });

  test('a phase never moves back', () => {
    assert.equal(phaseAdvances(null, 'check'), true);
    assert.equal(phaseAdvances('swap', 'check'), false);
    assert.equal(phaseAdvances('swap', 'swap'), true);
    assert.equal(phaseAdvances('verify', 'rollback'), true);
    assert.equal(phaseAdvances('rollback', 'verify'), false);
  });
});

describe('issue 462 the exit classifier', () => {
  test('the script codes, the Mac codes, and what nothing else says', () => {
    const c = (exitCode: number | null, extra: Partial<Parameters<typeof classify>[0]> = {}, kind: 'check' | 'update' = 'update') => classify({ exitCode, reason: null, phase: null, ...extra }, kind);
    assert.deepEqual(c(0), { state: 'succeeded', key: 'exit-0' });
    assert.deepEqual(c(0, {}, 'check'), { state: 'ready', key: 'check-ready' });
    for (const n of [20, 21, 22, 23, 31, 33]) assert.deepEqual(c(n), { state: 'refused', key: `exit-${n}` });
    assert.deepEqual(c(30, { reason: 'dirty-tree' }), { state: 'refused', key: 'exit-30-dirty-tree' });
    assert.deepEqual(c(32, { reason: 'no-options' }), { state: 'refused', key: 'exit-32-no-options' });
    assert.deepEqual(c(32), { state: 'refused', key: 'exit-32' });
    assert.deepEqual(c(40), { state: 'rolled-back', key: 'exit-40' });
    assert.deepEqual(c(41), { state: 'rollback-failed', key: 'exit-41' });
    assert.deepEqual(c(130), { state: 'canceled', key: 'canceled' });
    assert.deepEqual(c(255), { state: 'failed', key: 'ssh-unreachable' });
    assert.deepEqual(c(255, { phase: 'check' }), { state: 'failed', key: 'ssh-unreachable' });
    assert.deepEqual(c(255, { phase: 'backup' }), { state: 'timed-out', key: 'timeout-after-swap' });
    assert.deepEqual(c(null, { phase: 'swap' }), { state: 'timed-out', key: 'timeout-after-swap' });
    assert.deepEqual(c(126), { state: 'failed', key: 'node-not-found' });
    assert.deepEqual(c(127), { state: 'failed', key: 'node-not-found' });
    assert.deepEqual(c(2), { state: 'failed', key: 'unknown-exit' });
    assert.deepEqual(c(77), { state: 'failed', key: 'unknown-exit' });
    assert.deepEqual(c(null, { spawnFailed: true }), { state: 'failed', key: 'spawn-failed' });
  });

  test('a reason is kept only when the script lists it for that exit code', () => {
    assert.equal(reasonFits(30, 'dirty-tree'), 'dirty-tree');
    assert.equal(reasonFits(30, 'no-options'), null);
    assert.equal(reasonFits(32, 'no-options'), 'no-options');
    assert.equal(reasonFits(40, 'started-failed'), 'started-failed');
    assert.equal(reasonFits(0, 'started-failed'), null);
    assert.equal(reasonFits(null, 'dirty-tree'), null);
  });
});
