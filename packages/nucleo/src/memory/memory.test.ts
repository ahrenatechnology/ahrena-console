// The memory module over the runner: version, setup plan and status, as the core asks for them (#727).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fakeSpawn, turn, type FakeChild } from './mocks/fake-child.ts';
import {
  bridgeHandoffsFixture,
  FAKE_DATA_DIR,
  FAKE_DB_PATH,
  FAKE_SESSION_ID,
  FAKE_TOKEN as PLANTED_TOKEN,
  handoffsFixture,
  initializeResult,
  OTHER_SESSION_ID,
  recentFixture,
  statusFixture,
  toolResult,
} from './mocks/fixtures.ts';
import { registeredAccountFolder } from '../tools/embedded-ai-memory.ts';
import { createMemoryModule, HANDOFF_LIST_LIMIT } from './memory.ts';

const BINARY = '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory';
const DATA_DIR = '/Users/someone/.ahrena-console/ai-memory';

function moduleWith(binaryPath: string | null = BINARY, extra: Partial<Parameters<typeof createMemoryModule>[0]> = {}) {
  const doubles = fakeSpawn();
  const lines: string[] = [];
  const memory = createMemoryModule({ dataDir: DATA_DIR, binaryPath, spawn: doubles.spawn, killGroup: () => {}, env: { PATH: '/usr/bin' }, log: (m) => lines.push(m), ...extra });
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

  test('#734/D2 the shareable setup plan carries no path, and setupPlanLocal answers data_dir, config_path and the service path', async () => {
    const { memory, calls } = moduleWith();
    const body = JSON.stringify({
      format: 1,
      data_dir: DATA_DIR,
      config_path: `${DATA_DIR}/config.toml`,
      fresh: false,
      service: { action: 'none', manager: 'launchd', path: '/Users/someone/Library/LaunchAgents/ai-memory.plist' },
      agents: [],
      other_agents: [],
    });
    const shared = memory.setupPlan();
    await turn();
    calls[0]!.child.finish(0, body);
    const sharedResult = await shared;
    assert.equal(sharedResult.ok, true);
    assert.equal(JSON.stringify(sharedResult).includes('/Users/'), false);
    const local = memory.setupPlanLocal();
    await turn();
    assert.deepEqual(calls[1]!.args, ['--data-dir', DATA_DIR, 'setup', '--plan', '--json', '--agent', 'claude-code']);
    calls[1]!.child.finish(0, body);
    assert.deepEqual(await local, { ok: true, value: { data_dir: DATA_DIR, config_path: `${DATA_DIR}/config.toml`, service_path: '/Users/someone/Library/LaunchAgents/ai-memory.plist' } });
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
  test('#733/AC-1 #734/D2 a running status carries the reprojected value and no local part', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.status();
    await turn();
    calls[0]!.child.finish(0, JSON.stringify(statusFixture()));
    const result = await pending;
    assert.equal(result.state, 'running');
    if (result.state !== 'running' || !result.status) return assert.fail('a running status carries its value');
    assert.equal(result.status.version, '3.5.1');
    assert.equal(result.status.client_auth, 'off');
    assert.equal('local' in result, false);
    assert.equal(JSON.stringify(result).includes(FAKE_DATA_DIR), false);
    assert.equal(JSON.stringify(result).includes(FAKE_DB_PATH), false);
  });

  test('#734/D2 statusLocal is the one method that answers data_dir and db_path', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.statusLocal();
    await turn();
    assert.deepEqual(calls[0]!.args, ['--data-dir', DATA_DIR, 'status', '--json']);
    calls[0]!.child.finish(0, JSON.stringify(statusFixture()));
    assert.deepEqual(await pending, { ok: true, value: { data_dir: FAKE_DATA_DIR, db_path: FAKE_DB_PATH } });
  });

  test('#735 statusWithLocal answers the shareable status and the local part from one run of status', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.statusWithLocal();
    await turn();
    calls[0]!.child.finish(0, JSON.stringify(statusFixture()));
    const result = await pending;
    assert.equal(calls.length, 1);
    assert.equal(result.state, 'running');
    if (result.state !== 'running' || !result.status || !result.local) return assert.fail('a running status carries both parts');
    assert.equal(result.status.bind, '127.0.0.1:7421');
    assert.deepEqual(result.local, { data_dir: FAKE_DATA_DIR, db_path: FAKE_DB_PATH });
    assert.equal(JSON.stringify(result.status).includes(FAKE_DATA_DIR), false);
  });

  test('#735 statusWithLocal of a stopped, absent or unreadable server carries no value and no path', async () => {
    const stopped = moduleWith();
    const pending = stopped.memory.statusWithLocal();
    await turn();
    stopped.calls[0]!.child.finish(1, '', `connection refused at ${FAKE_DATA_DIR}`);
    assert.deepEqual(await pending, { state: 'stopped' });
    assert.deepEqual(await moduleWith(null).memory.statusWithLocal(), { state: 'unavailable' });
    const garbled = moduleWith();
    const reading = garbled.memory.statusWithLocal();
    await turn();
    garbled.calls[0]!.child.finish(0, 'not json');
    assert.deepEqual(await reading, { state: 'running' });
  });

  test('#734/D2 statusLocal of a stopped server is a failed read, not a value', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.statusLocal();
    await turn();
    calls[0]!.child.finish(1, '', 'connection refused');
    assert.deepEqual(await pending, { ok: false, reason: 'exit' });
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
    if (result.ok) assert.deepEqual(Object.keys(result.value[0]!).sort(), ['created_at_ms', 'from_agent', 'id', 'to_agent']);
  });

  test('#734/D1 handoffs names no cwd, and handoffsLocal is the one method that answers it, by handoff id', async () => {
    const { memory, calls } = moduleWith();
    const shared = memory.handoffs('app');
    await turn();
    calls[0]!.child.finish(0, JSON.stringify(handoffsFixture()));
    assert.equal(JSON.stringify(await shared).includes('/Users/'), false);
    const local = memory.handoffsLocal('app');
    await turn();
    assert.deepEqual(calls[1]!.args, ['--data-dir', DATA_DIR, 'handoffs', '--workspace', 'default', '--project', 'app', '--json']);
    calls[1]!.child.finish(0, JSON.stringify(handoffsFixture()));
    assert.deepEqual(await local, { ok: true, value: [{ id: 'h-0001', cwd: '/Users/someone/work/app' }, { id: 'h-0002', cwd: null }] });
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


/** Plays the bridge's side: answers initialize, then the tool call with `reply`, then exits 0 (#734). */
async function playBridge(child: FakeChild, reply: Record<string, unknown>): Promise<void> {
  await turn();
  child.say({ jsonrpc: '2.0', id: 1, result: initializeResult() });
  await turn();
  await turn();
  child.say({ jsonrpc: '2.0', id: 2, ...reply });
  await turn();
  child.finish(0);
}

const NOT_FOUND = `session ${FAKE_SESSION_ID} not found in default/app`;

describe('memory module, the bridge reads (#734)', () => {
  test('#734/AC-2 bridgeHandoffs calls memory_handoff_list for the project and returns the listed fields, with no body field', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.bridgeHandoffs('app');
    await turn();
    assert.deepEqual(calls[0]!.args, ['--data-dir', DATA_DIR, 'mcp-bridge', '--no-session-id']);
    await playBridge(calls[0]!.child, { result: toolResult({ handoffs: bridgeHandoffsFixture() }) });
    assert.deepEqual(calls[0]!.child.sent()[2], { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_handoff_list', arguments: { workspace: 'default', project: 'app', limit: 200 } } });
    const result = await pending;
    assert.equal(result.ok, true);
    const text = JSON.stringify(result);
    for (const planted of ['summary', 'open_questions', 'next_steps', 'files_touched', PLANTED_TOKEN, '/Users/']) assert.equal(text.includes(planted), false, planted);
    if (result.ok) assert.equal(result.value.length, 2);
  });

  test('#719/AC-7 the handoff list asks for the upstream cap of 200 open handoffs, no more', async () => {
    assert.equal(HANDOFF_LIST_LIMIT, 200);
    const { memory, calls } = moduleWith();
    const pending = memory.bridgeHandoffs('app');
    await turn();
    await playBridge(calls[0]!.child, { result: toolResult({ handoffs: [] }) });
    await pending;
    const sent = calls[0]!.child.sent()[2] as { params: { arguments: Record<string, unknown> } };
    assert.equal(sent.params.arguments.limit, HANDOFF_LIST_LIMIT);
  });

  test('#734/D1 bridgeHandoffsLocal is the one method that answers the handoffs cwd, by handoff id', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.bridgeHandoffsLocal('app');
    await turn();
    await playBridge(calls[0]!.child, { result: toolResult({ handoffs: bridgeHandoffsFixture() }) });
    const result = await pending;
    assert.deepEqual(result.ok && result.value.map((l) => l.cwd), ['/Users/someone/work/app', '/Users/someone/work/other']);
    assert.deepEqual(result.ok && result.value.map((l) => l.owner_user), ['local:someone', 'local:someone']);
  });

  test('#735/D2 bridgeHandoffs carries no owner_user and no accepted_by_user: they come only out of the Local methods', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.bridgeHandoffs('app');
    await turn();
    await playBridge(calls[0]!.child, { result: toolResult({ handoffs: bridgeHandoffsFixture() }) });
    const text = JSON.stringify(await pending);
    for (const name of ['owner_user', 'accepted_by_user', 'local:someone']) assert.equal(text.includes(name), false, name);
  });

  test('#735 bridgeHandoffsWithLocal answers the shareable handoffs and the local part from one bridge call', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.bridgeHandoffsWithLocal('app');
    await turn();
    await playBridge(calls[0]!.child, { result: toolResult({ handoffs: bridgeHandoffsFixture() }) });
    const result = await pending;
    assert.equal(calls.length, 1);
    assert.equal(result.ok && result.value.handoffs.length, 2);
    assert.deepEqual(result.ok && result.value.local.map((l) => l.id), result.ok ? result.value.handoffs.map((h) => h.id) : []);
    assert.equal(JSON.stringify(result.ok && result.value.handoffs).includes('/Users/'), false);
  });

  test('#735 sessionHandoffsWithLocal answers the handoffs the session opened and the local part of those only', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.sessionHandoffsWithLocal('app', FAKE_SESSION_ID);
    await turn();
    await playBridge(calls[0]!.child, { result: toolResult({ handoffs: bridgeHandoffsFixture() }) });
    const result = await pending;
    assert.equal(result.ok && result.value.opened.length, 1);
    assert.deepEqual(result.ok && result.value.local.map((l) => l.id), ['7b0e3a1c-2d4f-4a6b-8c9d-0e1f2a3b4c5d']);
  });

  test('#735 sessionHandoffsWithLocal refuses an id outside the formats before the bridge is spawned', async () => {
    const { memory, calls } = moduleWith();
    assert.deepEqual(await memory.sessionHandoffsWithLocal('app', '--evil'), { ok: false, reason: 'failed' });
    assert.equal(calls.length, 0);
  });

  test('#719/AC-8 sessionHandoffs lists the handoffs the session opened, matched by from_session_id', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.sessionHandoffs('app', FAKE_SESSION_ID);
    await turn();
    await playBridge(calls[0]!.child, { result: toolResult({ handoffs: bridgeHandoffsFixture() }) });
    const result = await pending;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.opened.map((h) => h.from_session_id), [FAKE_SESSION_ID]);
      assert.deepEqual(Object.keys(result.value), ['opened']);
    }
    assert.equal(JSON.stringify(result).includes('/Users/'), false);
  });

  test('#734/AC-2 a handoff list that does not fit is rejected and logs the tool and the closed code only', async () => {
    const { memory, calls, lines } = moduleWith();
    const pending = memory.bridgeHandoffs('app');
    await turn();
    await playBridge(calls[0]!.child, { result: toolResult({ handoffs: [{ id: 1, summary: PLANTED_TOKEN }] }) });
    assert.deepEqual(await pending, { ok: false, reason: 'rejected' });
    assert.deepEqual(lines, ['memory: memory_handoff_list rejected malformed-bridge']);
  });

  test('#734/AC-3 a session with observations is captured, and the observations are neither requested in bulk nor returned', async () => {
    const { memory, calls } = moduleWith();
    const pending = memory.sessionCaptured('app', FAKE_SESSION_ID);
    await turn();
    await playBridge(calls[0]!.child, { result: toolResult({ session: { id: FAKE_SESSION_ID }, observations: [{ body: `prompt ${PLANTED_TOKEN}` }], total: 3 }) });
    const sent = calls[0]!.child.sent()[2] as { params: { name: string; arguments: Record<string, unknown> } };
    assert.equal(sent.params.name, 'memory_read_session_observations');
    assert.deepEqual(sent.params.arguments, { workspace: 'default', project: 'app', session_id: FAKE_SESSION_ID, limit: 1, offset: 1_000_000 });
    const result = await pending;
    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(JSON.stringify(result).includes(PLANTED_TOKEN), false);
  });

  test('#734/AC-3 a JSON-RPC error -32602 "session X not found in default/<project>" is not captured', async () => {
    const { memory, calls, lines } = moduleWith();
    const pending = memory.sessionCaptured('app', FAKE_SESSION_ID);
    await turn();
    await playBridge(calls[0]!.child, { error: { code: -32602, message: NOT_FOUND } });
    assert.deepEqual(await pending, { ok: true, value: false });
    assert.deepEqual(lines, ['memory: bridge memory_read_session_observations rpc-error -32602']);
  });

  test('#734/AC-3 a -32602 about something else, or another session, is a failed read, not "not captured"', async () => {
    for (const message of ['unknown order "x"', `session ${OTHER_SESSION_ID} not found in default/app`, `${NOT_FOUND} extra`, `session ${FAKE_SESSION_ID} not found in default/other`]) {
      const { memory, calls } = moduleWith();
      const pending = memory.sessionCaptured('app', FAKE_SESSION_ID);
      await turn();
      await playBridge(calls[0]!.child, { error: { code: -32602, message } });
      assert.deepEqual(await pending, { ok: false, reason: 'failed' }, message);
    }
  });

  test('#734/AC-3 any other error, and a tool result flagged as an error, is a failed read', async () => {
    for (const reply of [{ error: { code: -32603, message: NOT_FOUND } }, { result: { isError: true, content: [{ type: 'text', text: 'denied' }] } }]) {
      const { memory, calls } = moduleWith();
      const pending = memory.sessionCaptured('app', FAKE_SESSION_ID);
      await turn();
      await playBridge(calls[0]!.child, reply);
      assert.deepEqual(await pending, { ok: false, reason: 'failed' });
    }
  });

  test('#734/AC-3 a bridge that is too slow is a timeout, not "not captured"', async () => {
    const { memory } = moduleWith(BINARY, { timeoutMs: 10, killGraceMs: 10 });
    assert.deepEqual(await memory.sessionCaptured('app', FAKE_SESSION_ID), { ok: false, reason: 'timeout' });
  });

  test('#734/AC-3 a project or a session id that does not fit the format is a failed read and nothing is spawned', async () => {
    const { memory, calls } = moduleWith();
    assert.deepEqual(await memory.bridgeHandoffs('--global'), { ok: false, reason: 'failed' });
    assert.deepEqual(await memory.sessionCaptured('app', '--all'), { ok: false, reason: 'failed' });
    assert.deepEqual(await memory.sessionCaptured('app', 'a b'), { ok: false, reason: 'failed' });
    assert.deepEqual(await memory.sessionCaptured('app', ''), { ok: false, reason: 'failed' });
    assert.deepEqual(await memory.sessionCaptured('a/b', FAKE_SESSION_ID), { ok: false, reason: 'failed' });
    assert.deepEqual(await memory.sessionHandoffs('app', 'x'.repeat(200)), { ok: false, reason: 'failed' });
    assert.equal(calls.length, 0);
  });

  test('#734/AC-1 with no embedded binary the bridge reads report unavailable and spawn nothing', async () => {
    const { memory, calls } = moduleWith(null);
    assert.deepEqual(await memory.bridgeHandoffs('app'), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await memory.bridgeHandoffsLocal('app'), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await memory.sessionHandoffs('app', FAKE_SESSION_ID), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await memory.sessionCaptured('app', FAKE_SESSION_ID), { ok: false, reason: 'unavailable' });
    assert.equal(calls.length, 0);
  });

  test('#734/AC-1 close ends a running bridge call and refuses the next one', async () => {
    const { memory, calls } = moduleWith(BINARY, { killGraceMs: 10 });
    const running = memory.bridgeHandoffs('app');
    await turn();
    await memory.close();
    assert.deepEqual(await running, { ok: false, reason: 'failed' });
    assert.equal(calls.length, 1);
    assert.deepEqual(await memory.bridgeHandoffs('app'), { ok: false, reason: 'failed' });
  });

  test('#734/AC-4 #719/AC-10 a token planted in the environment and in the bridge output reaches no argv, no child env and no result', async () => {
    const doubles = fakeSpawn();
    const memory = createMemoryModule({
      dataDir: DATA_DIR,
      binaryPath: BINARY,
      spawn: doubles.spawn,
      killGroup: () => {},
      env: { PATH: '/usr/bin', AI_MEMORY_AUTH_TOKEN: PLANTED_TOKEN },
    });
    const pending = memory.sessionCaptured('app', FAKE_SESSION_ID);
    await turn();
    await playBridge(doubles.calls[0]!.child, { result: toolResult({ observations: [{ body: PLANTED_TOKEN }] }) });
    const result = await pending;
    assert.equal(JSON.stringify([doubles.calls[0]!.command, doubles.calls[0]!.args, doubles.calls[0]!.options.env, result]).includes(PLANTED_TOKEN), false);
    assert.equal('AI_MEMORY_AUTH_TOKEN' in (doubles.calls[0]!.options.env ?? {}), false);
  });
});

describe('#740/AC-1 the setup plan of a registered account folder', () => {
  const FOLDER = '/Users/someone/.claude-work';
  const folder = registeredAccountFolder(FOLDER, [FOLDER], () => true)!;
  const PLAN = { format: 1, data_dir: DATA_DIR, config_path: `${DATA_DIR}/config.toml`, fresh: true, service: { action: 'install', manager: 'launchd', path: '/Users/someone/Library/LaunchAgents/x.plist' }, agents: [{ agent: 'claude-code', found: true, wiring: 'hooks' }], other_agents: [] };

  test('#740/AC-1 Given a registered folder, When its plan is read, Then the plan and its local part come back reprojected', async () => {
    const { memory, calls } = moduleWith(BINARY, { env: { PATH: '/usr/bin' } });
    const pending = memory.setupPlanWithLocalFor(folder);
    await turn();
    assert.deepEqual(calls[0]!.options.env, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: FOLDER });
    calls[0]!.child.finish(0, JSON.stringify({ ...PLAN, extra: 'dropped' }));
    const result = await pending;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.plan.service.action, 'install');
      assert.equal(result.value.local.config_path, `${DATA_DIR}/config.toml`);
      assert.equal('extra' in result.value.plan, false);
    }
  });

  test('#740/AC-1 Given a failing run or a malformed plan, Then the read fails with a closed reason', async () => {
    const { memory, calls } = moduleWith();
    const failing = memory.setupPlanWithLocalFor(folder);
    await turn();
    calls[0]!.child.finish(3);
    assert.deepEqual(await failing, { ok: false, reason: 'exit' });
    const malformed = memory.setupPlanWithLocalFor(folder);
    await turn();
    calls[1]!.child.finish(0, '{"format":2}');
    assert.deepEqual(await malformed, { ok: false, reason: 'rejected' });
  });
});
