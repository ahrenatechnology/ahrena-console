import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HOOK_EVENTS, InvalidHookError, MAX_STRING_IN_DATA, normalizeHook } from '../../src/ingest/hooks/index.ts';
import { validateEvent } from '../../src/model.ts';
import { T0, at } from '../fixtures.ts';
import { HOOK_NAMES, HOOK_PAYLOADS } from './hook-payloads.ts';

const opts = { receivedAt: T0 };

describe('hook normalization', () => {
  test('the synthetic payloads cover every expected event', () => {
    assert.deepEqual([...HOOK_NAMES].sort(), [...HOOK_EVENTS].sort());
  });

  for (const name of HOOK_NAMES) {
    test(`${name} becomes a valid core event`, () => {
      const { event, known } = normalizeHook(HOOK_PAYLOADS[name], opts);
      validateEvent(event);
      assert.equal(event.type, name);
      assert.equal(event.sessionId, 'sess-hooks-1');
      assert.equal(event.createdAt, T0);
      assert.equal(known, true);
    });
  }

  test('summary and tool of each event', () => {
    const summary = (name: (typeof HOOK_NAMES)[number]) => normalizeHook(HOOK_PAYLOADS[name], opts).event.summary;
    assert.equal(summary('SessionStart'), 'startup');
    assert.equal(summary('UserPromptSubmit'), 'Rode os testes e corrija o que falhar');
    assert.equal(summary('PreToolUse'), 'npm test');
    assert.equal(summary('PostToolUse'), 'npm test');
    assert.equal(summary('Notification'), 'Claude needs your permission to use Bash');
    assert.equal(summary('SubagentStop'), 'Explore');
    assert.equal(summary('Stop'), null);
    assert.equal(summary('SessionEnd'), 'prompt_input_exit');
    assert.equal(normalizeHook(HOOK_PAYLOADS.PreToolUse, opts).event.toolName, 'Bash');
    assert.equal(normalizeHook(HOOK_PAYLOADS.Stop, opts).event.toolName, null);
  });

  test('PostToolUse with an error marks the summary', () => {
    const p = { ...HOOK_PAYLOADS.PostToolUse, tool_response: { is_error: true, content: 'exit 1' } };
    assert.equal(normalizeHook(p, opts).event.summary, 'erro: npm test');
  });

  test('a hook fired inside a subagent carries the agent_id', () => {
    assert.equal(normalizeHook(HOOK_PAYLOADS.SubagentStop, opts).event.agentId, 'agent-7');
    assert.equal(normalizeHook(HOOK_PAYLOADS.PreToolUse, opts).event.agentId, null);
  });

  test("SessionStart gives the session's hints; the model may come as an object", () => {
    const { hints } = normalizeHook(HOOK_PAYLOADS.SessionStart, opts);
    assert.deepEqual(hints, {
      cwd: '/repo/app',
      model: 'claude-opus-5-5',
      source: 'startup',
      transcriptPath: HOOK_PAYLOADS.SessionStart.transcript_path,
      permissionMode: 'default',
      env: null,
    });
    const obj = { ...HOOK_PAYLOADS.SessionStart, model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet' } };
    assert.equal(normalizeHook(obj, opts).hints.model, 'claude-sonnet-5-5');
    assert.equal(normalizeHook(HOOK_PAYLOADS.Stop, opts).hints.model, null);
  });

  test('uses the firing time when valid, otherwise the receiving time', () => {
    assert.equal(normalizeHook(HOOK_PAYLOADS.Stop, { ...opts, firedAt: at(-1) }).event.createdAt, at(-1));
    assert.equal(normalizeHook(HOOK_PAYLOADS.Stop, { ...opts, firedAt: 'ontem' }).event.createdAt, T0);
  });

  test('stable id: the same delivery or the same tool_use_id give the same event', () => {
    const a = normalizeHook(HOOK_PAYLOADS.Stop, { ...opts, deliveryId: 'd1' }).event.id;
    assert.equal(normalizeHook(HOOK_PAYLOADS.Stop, { ...opts, deliveryId: 'd1' }).event.id, a);
    assert.notEqual(normalizeHook(HOOK_PAYLOADS.Stop, { ...opts, deliveryId: 'd2' }).event.id, a);

    const pre1 = normalizeHook(HOOK_PAYLOADS.PreToolUse, { ...opts, deliveryId: 'x' }).event.id;
    const pre2 = normalizeHook(HOOK_PAYLOADS.PreToolUse, { ...opts, deliveryId: 'y' }).event.id;
    const post = normalizeHook(HOOK_PAYLOADS.PostToolUse, { ...opts, deliveryId: 'x' }).event.id;
    assert.equal(pre1, pre2);
    assert.notEqual(pre1, post);

    const noId1 = normalizeHook(HOOK_PAYLOADS.Stop, opts).event.id;
    assert.notEqual(normalizeHook(HOOK_PAYLOADS.Stop, opts).event.id, noId1);
  });

  test('cuts long strings in data, without losing the rest of the payload', () => {
    const big = 'x'.repeat(MAX_STRING_IN_DATA + 500);
    const p = { ...HOOK_PAYLOADS.PostToolUse, tool_response: { stdout: big } };
    const data = normalizeHook(p, opts).event.data as { tool_response: { stdout: string }; tool_use_id: string };
    assert.ok(data.tool_response.stdout.length < big.length);
    assert.match(data.tool_response.stdout, /\[\+500 caracteres\]$/);
    assert.equal(data.tool_use_id, 'toolu_01');
  });

  test('an event we do not know yet is accepted and marked', () => {
    const r = normalizeHook({ session_id: 's', hook_event_name: 'PreCompact', trigger: 'auto' }, opts);
    assert.equal(r.event.type, 'PreCompact');
    assert.equal(r.known, false);
  });

  test('rejects a payload without the minimum', () => {
    for (const bad of [null, [], 'texto', {}, { session_id: 's' }, { hook_event_name: 'Stop' }, { session_id: 's', hook_event_name: 'a b' }]) {
      assert.throws(() => normalizeHook(bad, opts), InvalidHookError);
    }
  });
});
