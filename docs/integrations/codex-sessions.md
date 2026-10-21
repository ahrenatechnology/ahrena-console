# Codex sessions: local read integration

The Sessions screen combines Claude sessions already indexed by the core with non-archived user threads from the installed Codex `state_5.sqlite`. It reads only thread metadata and section names using a read-only SQLite connection; it does not read credentials, modify the Codex database, import conversation turns, or execute resume commands. Internal subagent threads are excluded.

The adapter is isolated because the desktop SQLite schema is private and versioned. Missing databases produce no Codex rows; incompatible databases produce a visible source error. `CODEX_HOME` selects the Codex data directory. Demo mode never reads the real Codex index.

Origin and group filters apply before pagination. Codex groups are its actual sidebar sections; Claude fallback groups explicitly say `Pasta:` and identify a directory, not a sidebar section. Title, directory, id, and group are searchable. The screen refreshes every 30 seconds. Runtime state, duration, agent count, and cost are not inferred from metadata: Codex state is unavailable, and unknown metrics are displayed without invented values.

## Supported operations and boundaries

- List/search/filter real local Codex threads alongside Claude: implemented.
- Display a safely quoted `codex resume <UUID>` command: implemented. The installed CLI documents this command. No new turn is started by the Console.
- Open the Codex desktop chat: not enabled. An attempted `codex://threads/<id>` validation was blocked by browser automation policy; no alternate route was attempted.
- Send messages, start/stop turns, live status, remote Codex machines, dashboard/wall and history integration: outside this read integration. Existing Claude operations remain unchanged.
- The supported Codex app-server protocol documents thread lifecycle operations: https://learn.chatgpt.com/docs/app-server . A future live adapter should use that protocol with explicit ownership of turns and approval handling, rather than writing this SQLite database.

## Validation on 2026-10-21

Based on main `24e5b8f`. Isolated clone, independent core database and localhost port; existing Claude worktrees and installed app preserved. Read 60 non-archived Codex user chats (239 index records before excluding internal agents), including 13 in the Ahrena group. The real Claude history was ingested into the isolated database. Browser inspection confirmed the Ahrena filter and corrected a clipped action button.

Focused tests cover source immutability, archived/invalid-id exclusion, shell quoting, grouping, provider filtering, unknown state/cost, missing source and incompatible schema. The ordinary Sessions/attention tests and repository English-internals guard also pass.

Validation totals: 1,999 core tests and 22 repository checks passed.
