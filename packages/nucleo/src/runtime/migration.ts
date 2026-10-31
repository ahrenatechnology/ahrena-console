export const RUNTIME_MIGRATION_SQL = `
CREATE TABLE runtime_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  profile_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','running','blocked','interrupted','closed','transport_error')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX runtime_active_session ON runtime_runs(session_id)
  WHERE state IN ('prepared','running');
CREATE TABLE runtime_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runtime_runs(id),
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval','question')),
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','invalidated'))
) STRICT;
CREATE INDEX runtime_requests_by_run ON runtime_requests(run_id);
`;
