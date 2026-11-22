// The launchd probe: true only when `launchctl print <target>` exits 0 (#740).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { launchdLoaded, type LaunchctlExec } from './launchd-probe.ts';

const TARGET = 'gui/501/com.example.agent';

function fakeExec(result: Error | null) {
  const calls: { file: string; args: readonly string[]; options: { timeout?: number; windowsHide?: boolean; shell?: unknown } }[] = [];
  const exec: LaunchctlExec = (file, args, options, done) => {
    calls.push({ file, args, options });
    done(result);
  };
  return { exec, calls };
}

describe('launchdLoaded', () => {
  test('is true when launchctl print exits 0', async () => {
    const { exec } = fakeExec(null);
    assert.equal(await launchdLoaded(TARGET, exec), true);
  });

  test('is false on a non-zero exit, even when the command printed something', async () => {
    const { exec } = fakeExec(Object.assign(new Error('exit 113'), { code: 113 }));
    assert.equal(await launchdLoaded(TARGET, exec), false);
  });

  test('is false when the binary is missing or the call times out', async () => {
    const { exec } = fakeExec(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    assert.equal(await launchdLoaded(TARGET, exec), false);
  });

  test('runs the fixed argv, with no shell and a short timeout', async () => {
    const { exec, calls } = fakeExec(null);
    await launchdLoaded(TARGET, exec);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, '/bin/launchctl');
    assert.deepEqual(calls[0]?.args, ['print', TARGET]);
    assert.equal(calls[0]?.options.shell, undefined);
    assert.equal(calls[0]?.options.windowsHide, true);
    assert.ok((calls[0]?.options.timeout ?? 0) > 0 && (calls[0]?.options.timeout ?? 0) <= 5_000);
  });
});
