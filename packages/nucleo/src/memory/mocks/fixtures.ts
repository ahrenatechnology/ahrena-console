// What the real ai-memory 3.5.1 prints for status, handoffs and recent, with invented values (#733).

/** An obviously fake secret, planted in the fixtures to prove it never comes out (#733). */
export const FAKE_TOKEN = 'fake-token-0000-not-real';
export const FAKE_DATA_DIR = '/Users/someone/.ahrena-console/ai-memory';
export const FAKE_DB_PATH = `${FAKE_DATA_DIR}/ai-memory.db`;

/** The `status --json` object of a running server, noise fields included (#733). */
export function statusFixture(): Record<string, unknown> {
  return {
    version: '3.5.1',
    data_dir: FAKE_DATA_DIR,
    bind: '127.0.0.1:7421',
    db_path: FAKE_DB_PATH,
    counts: { pages_latest: 12, pages_all: 40, sessions: 3, observations: 250 },
    derived: { stale_embeddings: 0, pending_summaries: 2 },
    storage: { page_size: 4096, page_count: 800, freelist_count: 5, database_bytes: 3276800, reclaimable_bytes: 20480, data_dir_free_bytes: 52428800000 },
    providers: {
      llm: { status: 'ok', provider: 'ollama', model: 'llama3.2', dim: null, last_call_at: '2026-11-20T10:00:00Z', endpoint: 'http://127.0.0.1:11434' },
      embedding: { status: 'disabled', provider: null, model: null, dim: null },
      llm_candidates: [{ provider: 'ollama', model: 'llama3.2' }],
      llm_workloads: [{ name: 'summaries', provider: 'ollama' }],
    },
    spool: { pending: 0, dir: `${FAKE_DATA_DIR}/spool` },
    recovery: { last_run_at: null, recovered: 0 },
    capture_mode: 'denylist',
    ingest: { last_event_at: '2026-11-20T10:01:00Z' },
    client: { version: '3.5.1', server_url: 'http://127.0.0.1:7421', auth: false },
    auth_posture: { posture: 'none_loopback', fix: 'ai-memory auth enable' },
    write_queue: { depth: 0 },
    wiki_format: 'markdown',
    windows_logon: null,
    consolidation: { enabled: false },
  };
}

/** The `handoffs --json` array, with a body the core must never read (#733). */
export function handoffsFixture(): Record<string, unknown>[] {
  return [
    { id: 'h-0001', from_agent: 'claude-code', to_agent: 'codex', cwd: '/Users/someone/work/app', created_at_ms: 1763632800000, body: `plan: ${FAKE_TOKEN}` },
    { id: 'h-0002', from_agent: 'codex', to_agent: null, cwd: null, created_at_ms: 1763632900000, body: 'free text' },
  ];
}

/** The `recent --json` array, with a snippet the core must never read (#733). */
export function recentFixture(): Record<string, unknown>[] {
  return [
    { path: 'notes/design.md', title: 'Design notes', snippet: `the key is ${FAKE_TOKEN}`, updated_at: '2026-11-20T09:00:00Z' },
    { path: 'notes/todo.md', title: 'Todo', snippet: 'buy milk', updated_at: '2026-11-19T09:00:00Z' },
  ];
}

/** The session the bridge fixtures speak about (#734). */
export const FAKE_SESSION_ID = '0c9e1b52-6f1d-4c0a-9a53-2d1f0b7c9e11';
export const OTHER_SESSION_ID = '5a7d2f90-1b3c-4e68-8f42-7c0d9a1b2e33';

/**
 * The text of a `memory_handoff_list` result: a handoff as ai-memory 3.5.1 serializes it (flattened), body fields
 * and noise included, with invented values (#734/AC-2).
 */
export function bridgeHandoffFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7b0e3a1c-2d4f-4a6b-8c9d-0e1f2a3b4c5d',
    workspace_id: '11111111-1111-4111-8111-111111111111',
    project_id: '22222222-2222-4222-8222-222222222222',
    from_session_id: FAKE_SESSION_ID,
    from_agent: 'claude-code',
    to_agent: 'codex',
    cwd: '/Users/someone/work/app',
    owner_user: 'local:someone',
    summary: `summary with ${FAKE_TOKEN}`,
    open_questions: ['which database?'],
    next_steps: ['run the migration'],
    files_touched: ['src/secret-plan.ts'],
    state: 'open',
    created_at: '2026-11-20T10:00:00Z',
    accepted_by: null,
    accepted_at: null,
    accepted_by_session: null,
    accepted_by_user: null,
    ...over,
  };
}

/** The handoffs of one project: one opened by the session, one of another session (#734). */
export function bridgeHandoffsFixture(): Record<string, unknown>[] {
  return [
    bridgeHandoffFixture(),
    bridgeHandoffFixture({ id: '9d2a5c3e-4f6b-4c8d-8e1f-2a3b4c5d6e7f', from_session_id: OTHER_SESSION_ID, cwd: '/Users/someone/work/other' }),
  ];
}

/** A `tools/call` result the way the bridge forwards it: the JSON as one text block (#734). */
export function toolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** The `initialize` result of the bridge (#734). */
export function initializeResult(): Record<string, unknown> {
  return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ai-memory', version: '3.5.1' } };
}
