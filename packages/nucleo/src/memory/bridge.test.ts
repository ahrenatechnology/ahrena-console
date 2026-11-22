// The stdio JSON-RPC client of `ai-memory mcp-bridge --no-session-id`: fixed argv, no shell, one call at a time, closed lifecycle (#734).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMemoryBridge } from './bridge.ts';
import { fakeSpawn, turn, type FakeChild } from './mocks/fake-child.ts';
import { FAKE_TOKEN, initializeResult, toolResult } from './mocks/fixtures.ts';

const BINARY = '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory';
const DATA_DIR = '/Users/someone/.ahrena-console/ai-memory';
const TOOL = 'memory_handoff_list';
const ARGS = { workspace: 'default', project: 'app' };

function bridgeWith(extra: Partial<Parameters<typeof createMemoryBridge>[0]> = {}) {
  const doubles = fakeSpawn();
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const lines: string[] = [];
  const bridge = createMemoryBridge({
    binaryPath: BINARY,
    dataDir: DATA_DIR,
    spawn: doubles.spawn,
    killGroup: (pid, signal) => signals.push({ pid, signal }),
    env: { PATH: '/usr/bin', HOME: '/Users/someone' },
    log: (message) => lines.push(message),
    ...extra,
  });
  return { bridge, calls: doubles.calls, signals, lines };
}

/** Answers `initialize` and lets the client send the notification and the tool call (#734). */
async function handshake(child: FakeChild): Promise<void> {
  await turn();
  child.say({ jsonrpc: '2.0', id: 1, result: initializeResult() });
  await turn();
  await turn();
}

describe('memory bridge, the process (#734/AC-1)', () => {
  test('#734/AC-1 the bridge runs the embedded binary by absolute path with a fixed argv, no shell, its own group and piped stdin', async () => {
    const { bridge, calls } = bridgeWith();
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.command, BINARY);
    assert.deepEqual(call.args, ['--data-dir', DATA_DIR, 'mcp-bridge', '--no-session-id']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.detached, true);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    call.child.finish(1);
    await pending;
  });

  test('#734/AC-1 #719/AC-10 the child env is the allowlist: the planted token and every credential stay out', async () => {
    const { bridge, calls } = bridgeWith({
      env: { PATH: '/usr/bin', HOME: '/Users/someone', AI_MEMORY_AUTH_TOKEN: FAKE_TOKEN, AHRENA_CONSOLE_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: FAKE_TOKEN, LC_ALL: 'C' },
    });
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    const env = calls[0]!.options.env ?? {};
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LC_ALL', 'PATH']);
    assert.equal('AI_MEMORY_AUTH_TOKEN' in env, false);
    assert.equal(JSON.stringify([calls[0]!.command, calls[0]!.args, env]).includes(FAKE_TOKEN), false);
    calls[0]!.child.finish(1);
    await pending;
  });

  test('#734/AC-1 with no embedded binary the bridge is unavailable and nothing is spawned', async () => {
    const { bridge, calls } = bridgeWith({ binaryPath: null });
    assert.equal(bridge.available, false);
    assert.deepEqual(await bridge.call(TOOL, ARGS), { kind: 'unavailable' });
    assert.equal(calls.length, 0);
  });

  test('#719/AC-10 with no injected data dir the bridge argv carries no --data-dir (#735)', async () => {
    const { bridge, calls } = bridgeWith({ dataDir: undefined });
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    assert.deepEqual(calls[0]!.args, ['mcp-bridge', '--no-session-id']);
    calls[0]!.child.finish(1);
    await pending;
  });

  test('#734/AC-1 a relative binary path or data dir is refused when the bridge is built', () => {
    assert.throws(() => bridgeWith({ binaryPath: 'ai-memory' }), TypeError);
    assert.throws(() => bridgeWith({ dataDir: 'data' }), TypeError);
  });

  test('#734/AC-1 a spawn that throws is a failed spawn, with no detail', async () => {
    const { bridge, lines } = bridgeWith({
      spawn: () => {
        throw new Error(`boom ${FAKE_TOKEN}`);
      },
    });
    assert.deepEqual(await bridge.call(TOOL, ARGS), { kind: 'failed', reason: 'spawn' });
    assert.deepEqual(lines, [`memory: bridge ${TOOL} failed spawn`]);
  });
});

describe('memory bridge, the lifecycle (#734/AC-1)', () => {
  test('#734/AC-1 it sends initialize, then the initialized notification and the tool call, then ends stdin', async () => {
    const { bridge, calls } = bridgeWith();
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    const child = calls[0]!.child;
    assert.deepEqual(child.sent(), [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ahrena-console', version: '0' } } },
    ]);
    await handshake(child);
    assert.deepEqual(child.sent().slice(1), [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: TOOL, arguments: ARGS } },
    ]);
    assert.equal(child.stdinEnded, false, 'stdin stays open until the answer is in');
    child.say({ jsonrpc: '2.0', id: 2, result: toolResult({ handoffs: [] }) });
    await turn();
    assert.equal(child.stdinEnded, true);
    child.finish(0);
    const result = await pending;
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') assert.deepEqual(JSON.parse(result.text), { handoffs: [] });
  });

  test('#734/AC-1 a server notification between the replies is ignored', async () => {
    const { bridge, calls } = bridgeWith();
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    const child = calls[0]!.child;
    child.say({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
    await handshake(child);
    child.say({ jsonrpc: '2.0', id: 2, result: toolResult({ handoffs: [] }) });
    await turn();
    child.finish(0);
    assert.equal((await pending).kind, 'ok');
  });

  test('#734/AC-1 one call at a time: the second spawn waits for the first to end', async () => {
    const { bridge, calls } = bridgeWith();
    const first = bridge.call(TOOL, ARGS);
    const second = bridge.call(TOOL, { workspace: 'default', project: 'other' });
    await turn();
    assert.equal(calls.length, 1);
    calls[0]!.child.finish(1);
    await first;
    await turn();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.child.sent()[0]!.method, 'initialize');
    calls[1]!.child.finish(1);
    await second;
  });

  test('#734/AC-1 a call that is slower than the timeout gets SIGTERM and then SIGKILL to the group, and ends as a timeout', async () => {
    const { bridge, signals, lines } = bridgeWith({ timeoutMs: 10, killGraceMs: 10 });
    const result = await bridge.call(TOOL, ARGS);
    assert.deepEqual(result, { kind: 'timeout' });
    assert.deepEqual(signals, [
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ]);
    assert.deepEqual(lines, [`memory: bridge ${TOOL} timeout`]);
  });

  test('#734/AC-1 a child that answers but does not exit after stdin ends is terminated after the grace, and the answer still stands', async () => {
    const { bridge, calls, signals } = bridgeWith({ killGraceMs: 10 });
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    await handshake(calls[0]!.child);
    calls[0]!.child.say({ jsonrpc: '2.0', id: 2, result: toolResult({ handoffs: [] }) });
    const result = await pending;
    assert.equal(result.kind, 'ok');
    assert.deepEqual(signals.map((s) => s.signal), ['SIGTERM', 'SIGKILL']);
  });

  test('#734/AC-1 a child that exits before it answers is a failed read', async () => {
    const { bridge, calls } = bridgeWith();
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    calls[0]!.child.finish(1, '', `stderr ${FAKE_TOKEN}`);
    assert.deepEqual(await pending, { kind: 'failed', reason: 'exit' });
  });
});

describe('memory bridge, the channel (#734/AC-1, #719/AC-11)', () => {
  test('#734/AC-1 a stdout line that is not JSON is a failed read and the group is terminated', async () => {
    const { bridge, calls, signals } = bridgeWith({ killGraceMs: 10 });
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    calls[0]!.child.sayRaw(`not json ${FAKE_TOKEN}`);
    const result = await pending;
    assert.deepEqual(result, { kind: 'failed', reason: 'protocol' });
    assert.equal(signals[0]?.signal, 'SIGTERM');
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  });

  test('#734/AC-1 a reply whose id is not the one asked is a failed read', async () => {
    const { bridge, calls } = bridgeWith({ killGraceMs: 10 });
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    calls[0]!.child.say({ jsonrpc: '2.0', id: 7, result: initializeResult() });
    assert.deepEqual(await pending, { kind: 'failed', reason: 'protocol' });
  });

  test('#734/AC-1 an initialize that answers with an error is a failed read', async () => {
    const { bridge, calls } = bridgeWith({ killGraceMs: 10 });
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    calls[0]!.child.say({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: `bad ${FAKE_TOKEN}` } });
    assert.deepEqual(await pending, { kind: 'failed', reason: 'protocol' });
  });

  test('#734/AC-1 stdout past the bound is a failed read, output-too-large', async () => {
    const { bridge, calls } = bridgeWith({ maxStdoutBytes: 64, killGraceMs: 10 });
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    calls[0]!.child.say({ jsonrpc: '2.0', id: 1, result: { padding: 'x'.repeat(200) } });
    assert.deepEqual(await pending, { kind: 'failed', reason: 'output-too-large' });
  });

  test('#734/AC-1 a tool result flagged as an error is a failed read, and its text is not returned', async () => {
    const { bridge, calls } = bridgeWith();
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    await handshake(calls[0]!.child);
    calls[0]!.child.say({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: `denied ${FAKE_TOKEN}` }] } });
    await turn();
    calls[0]!.child.finish(0);
    const result = await pending;
    assert.deepEqual(result, { kind: 'failed', reason: 'tool-error' });
  });

  test('#734/AC-3 a JSON-RPC error carries its code and whether its message is the expected one, never the message', async () => {
    const message = 'session s-1 not found in default/app';
    for (const [sent, expected] of [
      [message, true],
      [`${message} ${FAKE_TOKEN}`, false],
      ['something else', false],
    ] as const) {
      const { bridge, calls } = bridgeWith();
      const pending = bridge.call(TOOL, ARGS, { expectedErrorMessage: message });
      await turn();
      await handshake(calls[0]!.child);
      calls[0]!.child.say({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: sent } });
      await turn();
      calls[0]!.child.finish(0);
      const result = await pending;
      assert.deepEqual(result, { kind: 'rpc-error', code: -32602, expected });
    }
  });

  test('#734/AC-3 with discardResult the text of a successful tool result is not returned', async () => {
    const { bridge, calls } = bridgeWith();
    const pending = bridge.call(TOOL, ARGS, { discardResult: true });
    await turn();
    await handshake(calls[0]!.child);
    calls[0]!.child.say({ jsonrpc: '2.0', id: 2, result: toolResult({ observations: [{ body: `prompt ${FAKE_TOKEN}` }] }) });
    await turn();
    calls[0]!.child.finish(0);
    assert.deepEqual(await pending, { kind: 'ok', text: '' });
  });

  test('#734/AC-1 #719/AC-11 stderr is drained and dropped: no log line and no result holds it', async () => {
    const { bridge, calls, lines } = bridgeWith();
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    await handshake(calls[0]!.child);
    calls[0]!.child.say({ jsonrpc: '2.0', id: 2, result: toolResult({ handoffs: [] }) });
    await turn();
    calls[0]!.child.finish(0, '', `panic at /Users/someone/secret ${FAKE_TOKEN}`);
    const result = await pending;
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
    assert.equal(lines.join('\n').includes(FAKE_TOKEN), false);
    assert.equal(lines.join('\n').includes('/Users/'), false);
  });

  test('#734/AC-1 the log names the tool and the result kind only', async () => {
    const { bridge, calls, lines } = bridgeWith();
    const pending = bridge.call(TOOL, ARGS);
    await turn();
    calls[0]!.child.finish(3);
    await pending;
    assert.deepEqual(lines, [`memory: bridge ${TOOL} failed exit`]);
  });
});

describe('memory bridge, closing (#734/AC-1)', () => {
  test('#734/AC-1 close refuses the queue, ends the running group and refuses what comes after', async () => {
    const { bridge, calls, signals } = bridgeWith({ killGraceMs: 10 });
    const running = bridge.call(TOOL, ARGS);
    const queued = bridge.call(TOOL, ARGS);
    await turn();
    await bridge.close();
    assert.deepEqual(await running, { kind: 'failed', reason: 'closed' });
    assert.deepEqual(await queued, { kind: 'failed', reason: 'closed' });
    assert.equal(calls.length, 1);
    assert.deepEqual(signals.map((s) => s.signal), ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(await bridge.call(TOOL, ARGS), { kind: 'failed', reason: 'closed' });
  });
});
