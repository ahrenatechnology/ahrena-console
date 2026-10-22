// SQLite schema for the Tools checks (#280, decision 0014 section 2). It goes into the adapter's
// migration list (adapters/sqlite/migrations.ts) as a migration of its own, additive: a new table.
//
// One row per machine and tool: the source it was read from, the installed and latest versions, when
// and the error of the latest read. A row is valid for 6 h (store.ts); a check replaces the
// machine's rows at once.

export const TOOLS_MIGRATION_DESCRIPTION = 'tool checks: installed and latest versions per machine (#280)';

export const TOOLS_MIGRATION_SQL = `
  CREATE TABLE tool_checks (
    machine_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    source_id TEXT,
    installed TEXT,
    latest TEXT,
    checked_at INTEGER NOT NULL,
    error TEXT,
    PRIMARY KEY (machine_id, tool_id)
  ) STRICT;
`;
