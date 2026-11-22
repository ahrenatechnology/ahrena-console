// The memory module over the runner: version, setup plan and status, as the core asks for them (#727).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fakeSpawn, turn } from './mocks/fake-child.ts';
import { FAKE_DATA_DIR, FAKE_DB_PATH, FAKE_TOKEN as PLANTED_TOKEN, handoffsFixture, recentFixture, statusFixture } from './mocks/fixtures.ts';
import { createMemoryModule } from './memory.ts';

const BINARY = '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory';
const DATA_DIR = '/Users/someone/.ahrena-console/ai-memory';

function moduleWith(binaryPath: string | null = BINARY) {
  const doubles = fakeSpawn();
  const lines: string[] = [];
  const memory = createMemoryModule({ dataDir: DATA_DIR, binaryPath, spawn: doubles.spawn, killGroup: () => {}, env: { PATH: '/usr/bin' }, log: (m) => lines.push(m) });
  return { memory, calls: doubles.calls, lines };
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
    assert.deepEqual(calls[0]!.args, ['--data-dir', DATA_DIR, 'status', '--json']);
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

describe('memory module refusal log (#727)', () => {
  const FAKE_TOKEN = 'fake-token-0000-not-real';

  test('#727 malformed JSON logs the command and the closed code only', async () => {
    const { memory, calls, lines } = moduleWith();
    const pending = memory.setupPlan();
    await turn();
    calls[0]!.child.finish(0, `{ not json ${FAKE_TOKEN}`);
    assert.deepEqual(await pending, { ok: false, reason: 'rejected' });
    assert.deepEqual(lines, ['memory: setup-plan rejected malformed-plan']);
  });

  test('#727 an unsupported format with a planted token logs the command and the closed code only', async () => {
    const { memory, calls, lines } = moduleWith();
    const pending = memory.setupPlan();
    await turn();
    calls[0]!.child.finish(0, JSON.stringify({ format: 2, token: FAKE_TOKEN }));
    await pending;
    assert.deepEqual(lines, ['memory: setup-plan rejected unsupported-format']);
  });

  test('#727 a version refusal logs its code', async () => {
    const { memory, calls, lines } = moduleWith();
    const pending = memory.version();
    await turn();
    calls[0]!.child.finish(0, `nope ${FAKE_TOKEN}`);
    await pending;
    assert.deepEqual(lines, ['memory: version rejected malformed-version']);
  });
});


describe('memory module, typed reads (#733)', () => {
  test('#733/AC-1 a running status carries the reprojected value and the local part held apart', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.status();
    await turn();
    calls[0]!.child.finish(0, JSON.stringify(statusFixture()));
    const result = await pending;
    assert.equal(result.state, 'running');
    if (result.state !== 'running' || !result.status || !result.local) return assert.fail('a running status carries its value');
    assert.equal(result.status.version, '3.5.1');
    assert.equal(result.status.client_auth, 'off');
    assert.deepEqual(result.local, { data_dir: FAKE_DATA_DIR, db_path: FAKE_DB_PATH });
    assert.equal(JSON.stringify(result.status).includes(FAKE_DATA_DIR), false);
  });

  test('#733/AC-1 a non-zero exit is still "stopped", with no value', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.status();
    await turn();
    calls[0]!.child.finish(1, '', 'connection refused');
    assert.deepEqual(await pending, { state: 'stopped' });
  });

  test('#733/AC-1 a status that exits 0 but does not fit is "running" with no value, and logs the closed code only', async () => {
    const { memory, calls, lines } = moduleWith();
    const pending = memory.status();
    await turn();
    calls[0]!.child.finish(0, JSON.stringify({ ...statusFixture(), client: { auth: PLANTED_TOKEN } }));
    assert.deepEqual(await pending, { state: 'running' });
    assert.deepEqual(lines, ['memory: status rejected malformed-status']);
  });

  test('#733/AC-2 handoffs asks for the project and returns the five fields only', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.handoffs('app');
    await turn();
    assert.deepEqual(calls[0]!.args, ['--data-dir', DATA_DIR, 'handoffs', '--workspace', 'default', '--project', 'app', '--json']);
    calls[0]!.child.finish(0, JSON.stringify(handoffsFixture()));
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(PLANTED_TOKEN), false);
    if (result.ok) assert.deepEqual(Object.keys(result.value[0]!).sort(), ['created_at_ms', 'cwd', 'from_agent', 'id', 'to_agent']);
  });

  test('#733/AC-2 a project the server does not know reads as an empty list, for handoffs and for recent', async () => {
    const { memory, calls } = moduleWith();
    const handoffs = memory.handoffs('ghost');
    await turn();
    calls[0]!.child.finish(1, '', "Error: project 'ghost' not found in workspace 'default'");
    assert.deepEqual(await handoffs, { ok: true, value: [] });
    const recent = memory.recent('ghost');
    await turn();
    calls[1]!.child.finish(1, '', "Error: project 'ghost' not found in workspace 'default'");
    assert.deepEqual(await recent, { ok: true, value: [] });
  });

  test('#733/AC-2 any other failure of handoffs is an exit failure, not an empty list', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.handoffs('app');
    await turn();
    calls[0]!.child.finish(1, '', 'connection refused');
    assert.deepEqual(await pending, { ok: false, reason: 'exit' });
  });

  test('#733/AC-2 an invalid project is a failure and nothing is spawned', async () => {
    const { memory, calls } = moduleWith();
    assert.deepEqual(await memory.handoffs('--global'), { ok: false, reason: 'failed' });
    assert.deepEqual(await memory.recent('a b'), { ok: false, reason: 'failed' });
    assert.equal(calls.length, 0);
  });

  test('#733/AC-3 recent returns path, title and updated_at, and the planted snippet is not in the result', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.recent('app');
    await turn();
    assert.deepEqual(calls[0]!.args, ['--data-dir', DATA_DIR, 'recent', '--workspace', 'default', '--project', 'app', '--json']);
    calls[0]!.child.finish(0, JSON.stringify(recentFixture()));
    const result = await pending;
    assert.equal(result.ok, true);
    const text = JSON.stringify(result);
    assert.equal(text.includes('snippet'), false);
    assert.equal(text.includes(PLANTED_TOKEN), false);
    assert.equal(text.includes('buy milk'), false);
  });

  test('#733/AC-3 a recent that does not fit is rejected and logs the closed code only', async () => {
    const { memory, calls, lines } = moduleWith();
    const pending = memory.recent('app');
    await turn();
    calls[0]!.child.finish(0, JSON.stringify([{ path: 1, snippet: PLANTED_TOKEN }]));
    assert.deepEqual(await pending, { ok: false, reason: 'rejected' });
    assert.deepEqual(lines, ['memory: recent rejected malformed-recent']);
  });

  test('#733/AC-2 with no embedded binary the new reads report unavailable and spawn nothing', async () => {
    const { memory, calls } = moduleWith(null);
    assert.deepEqual(await memory.handoffs('app'), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await memory.recent('app'), { ok: false, reason: 'unavailable' });
    assert.equal(calls.length, 0);
  });
});
