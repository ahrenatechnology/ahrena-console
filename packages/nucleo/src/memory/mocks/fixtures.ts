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
