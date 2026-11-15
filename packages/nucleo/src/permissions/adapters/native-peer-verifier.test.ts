// The adapter maps the helper's exit code to a verdict and treats every other outcome as unavailable (#619, layer 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALLED_APP_PATH, NativePeerVerifier, type HelperProcess, type NativePeerVerifierDeps } from './native-peer-verifier.ts';

interface Call {
  file: string;
  args: readonly string[];
  stdio: unknown;
  shell: unknown;
}

class FakeHelper extends EventEmitter implements HelperProcess {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** A fake helper that ends the way the test says; records how it was spawned and whether it was killed. */
function fake(end: (p: EventEmitter) => void): { spawn: NativePeerVerifierSpawn; calls: Call[]; killed: () => boolean } {
  const calls: Call[] = [];
  let helper: FakeHelper | null = null;
  const spawn: NativePeerVerifierSpawn = (file, args, options) => {
    calls.push({ file, args, stdio: options.stdio, shell: options.shell });
    const p = new FakeHelper();
    helper = p;
    queueMicrotask(() => end(p));
    return p;
  };
  return { spawn, calls, killed: () => helper?.killed === true };
}
type NativePeerVerifierSpawn = NonNullable<NativePeerVerifierDeps['spawn']>;

const verifier = (spawn: NativePeerVerifierSpawn, extra: { platform?: NodeJS.Platform; timeoutMs?: number; appPath?: string } = {}) =>
  new NativePeerVerifier({ spawn, appPath: extra.appPath ?? INSTALLED_APP_PATH, platform: extra.platform ?? 'darwin', timeoutMs: extra.timeoutMs ?? 5000 });

test('the constant path is the installed app inside /Applications', () => {
  assert.equal(INSTALLED_APP_PATH, '/Applications/Ahrena Console.app/Contents/MacOS/ahrena-console-desktop');
});

test('the helper is the constant path with the one argument, the channel as stdin, no shell', async () => {
  const f = fake((p) => p.emit('exit', 100, null));
  await verifier(f.spawn).verify(7);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.file, INSTALLED_APP_PATH);
  assert.deepEqual(f.calls[0]?.args, ['--verify-window-peer']);
  assert.deepEqual(f.calls[0]?.stdio, [7, 'ignore', 'ignore']);
  assert.notEqual(f.calls[0]?.shell, true);
});

test('exit 100 is match, 101 is mismatch, 102 is unavailable', async () => {
  for (const [code, verdict] of [[100, 'match'], [101, 'mismatch'], [102, 'unavailable']] as const) {
    const f = fake((p) => p.emit('exit', code, null));
    assert.equal(await verifier(f.spawn).verify(7), verdict);
  }
});

test('any other exit code (0 of an app without the mode included), a signal and a spawn error are unavailable', async () => {
  for (const end of [(p: EventEmitter) => p.emit('exit', 0, null), (p: EventEmitter) => p.emit('exit', 3, null), (p: EventEmitter) => p.emit('exit', null, 'SIGKILL'), (p: EventEmitter) => p.emit('error', new Error('ENOENT with /secret/text'))]) {
    assert.equal(await verifier(fake(end).spawn).verify(7), 'unavailable');
  }
});

test('a spawn that throws is unavailable', async () => {
  const v = verifier(() => {
    throw new Error('boom');
  });
  assert.equal(await v.verify(7), 'unavailable');
});

test('a helper that does not answer in time is killed and unavailable', async () => {
  const f = fake(() => {});
  assert.equal(await verifier(f.spawn, { timeoutMs: 20 }).verify(7), 'unavailable');
  assert.equal(f.killed(), true);
});

test('off macOS nothing is spawned and the answer is unavailable', async () => {
  const f = fake((p) => p.emit('exit', 100, null));
  assert.equal(await verifier(f.spawn, { platform: 'linux' }).verify(7), 'unavailable');
  assert.equal(f.calls.length, 0);
});

test('the real process spawn: an executable that exits 101 is mismatch, one that is absent is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrena-peer-'));
  const script = join(dir, 'helper');
  writeFileSync(script, '#!/bin/sh\nexit 101\n');
  chmodSync(script, 0o700);
  const fd = openSync('/dev/null', 'r');
  const real = (appPath: string) => new NativePeerVerifier({ appPath, platform: 'darwin', timeoutMs: 5000 });
  assert.equal(await real(script).verify(fd), 'mismatch');
  assert.equal(await real(join(dir, 'absent')).verify(fd), 'unavailable');
});
