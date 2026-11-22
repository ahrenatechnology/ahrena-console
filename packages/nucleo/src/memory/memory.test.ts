// The memory module over the runner: version, setup plan and status, as the core asks for them (#727).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fakeSpawn, turn } from './mocks/fake-child.ts';
import { createMemoryModule } from './memory.ts';

const BINARY = '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory';
const DATA_DIR = '/Users/someone/.ahrena-console/ai-memory';

function moduleWith(binaryPath: string | null = BINARY) {
  const doubles = fakeSpawn();
  const memory = createMemoryModule({ dataDir: DATA_DIR, binaryPath, spawn: doubles.spawn, killGroup: () => {}, env: { PATH: '/usr/bin' } });
  return { memory, calls: doubles.calls };
}

describe('memory module (#727/AC-3)', () => {
  test('#727/AC-3 the core asks for the version and gets { version: "3.5.1" } from "ai-memory 3.5.1"', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.version();
    await turn();
    assert.deepEqual(calls[0]!.args, ['--data-dir', DATA_DIR, '--version']);
    calls[0]!.child.finish(0, 'ai-memory 3.5.1\n');
    assert.deepEqual(await pending, { ok: true, value: { version: '3.5.1' } });
  });

  test('#727/AC-3 a version output that is not "ai-memory X.Y.Z" is rejected, not passed through', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.version();
    await turn();
    calls[0]!.child.finish(0, 'something else entirely\n');
    assert.deepEqual(await pending, { ok: false, reason: 'rejected' });
  });

  test('#727/AC-3 the setup plan is read with --plan --json and reprojected', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.setupPlan();
    await turn();
    assert.deepEqual(calls[0]!.args, ['--data-dir', DATA_DIR, 'setup', '--plan', '--json', '--agent', 'claude-code']);
    calls[0]!.child.finish(
      0,
      JSON.stringify({ format: 1, data_dir: DATA_DIR, config_path: `${DATA_DIR}/config.toml`, fresh: false, service: { action: 'none', manager: 'launchd', path: null }, agents: [], other_agents: [], extra: 1 }),
    );
    const result = await pending;
    assert.equal(result.ok, true);
    if (result.ok) assert.equal('extra' in result.value, false);
  });

  test('#727/AC-3 a plan with another format is rejected', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.setupPlan();
    await turn();
    calls[0]!.child.finish(0, JSON.stringify({ format: 2 }));
    assert.deepEqual(await pending, { ok: false, reason: 'rejected' });
  });

  test('#727/AC-3 a status that exits non-zero is the state "stopped"', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.status();
    await turn();
    assert.deepEqual(calls[0]!.args, ['--data-dir', DATA_DIR, 'status']);
    calls[0]!.child.finish(1, '', 'connection refused');
    assert.deepEqual(await pending, { state: 'stopped' });
  });

  test('#727/AC-3 a status killed by a signal the runner did not send is "unknown", not "stopped"', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.status();
    await turn();
    calls[0]!.child.finish(null);
    assert.deepEqual(await pending, { state: 'unknown' });
  });

  test('#727/AC-3 a status that exits 0 is the state "running"', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.status();
    await turn();
    calls[0]!.child.finish(0, 'whatever it prints');
    assert.deepEqual(await pending, { state: 'running' });
  });

  test('#727/AC-3 a status that times out or fails to spawn is "unknown", not "stopped"', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.status();
    await turn();
    calls[0]!.child.emit('error', new Error('x'));
    assert.deepEqual(await pending, { state: 'unknown' });
  });

  test('#727/AC-1 with the embedded path null every read reports unavailable and nothing is spawned', async () => {
    const { memory, calls } = moduleWith(null);
    assert.equal(memory.available, false);
    assert.deepEqual(await memory.version(), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await memory.setupPlan(), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await memory.status(), { state: 'unavailable' });
    assert.equal(calls.length, 0);
  });
});
