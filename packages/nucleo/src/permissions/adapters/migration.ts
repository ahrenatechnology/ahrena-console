// The `permission_requests` table (#618, layer 3). One row per request, with every field of the aggregate and the
// `tool_use_id` a PreToolUse of the same call linked to it. There is no column for the tool input: the aggregate never holds
// it (#618/AC-7). No foreign key to `sessions`: the hook may register before the core has read the session.
// The lists below repeat the model's (`REQUEST_STATES`, `DECISIONS`, `CHANNELS`, `SETTLERS`); a test keeps them equal.
export const PERMISSION_REQUESTS_MIGRATION_DESCRIPTION = 'Permission requests from the sessions (#618)';

export const PERMISSION_REQUESTS_MIGRATION_SQL = `
CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_truncated INTEGER NOT NULL CHECK(summary_truncated IN (0,1)),
  cwd TEXT NOT NULL,
  permission_mode TEXT,
  terminal_only INTEGER NOT NULL CHECK(terminal_only IN (0,1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','answered','delivered','expired','withdrawn','answered_elsewhere','core_restarted')),
  decision TEXT CHECK(decision IN ('allow','deny')),
  reason TEXT,
  answered_by TEXT,
  channel TEXT CHECK(channel IN ('ui')),
  answered_at INTEGER,
  settled_at INTEGER,
  settled_by TEXT CHECK(settled_by IN ('expiry','hook','session_event','core_restart')),
  tool_use_id TEXT,
  CHECK(state NOT IN ('answered','delivered') OR decision IS NOT NULL)
) STRICT;
CREATE INDEX permission_requests_by_session ON permission_requests(session_id, created_at);
CREATE INDEX permission_requests_by_state ON permission_requests(state, created_at);
`;
