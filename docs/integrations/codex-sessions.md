# Claude and Codex session origins and opening

The Sessions screen and wall combine Claude sessions already indexed by the core with non-archived user threads from the installed Codex `state_5.sqlite`. It reads only thread metadata and section names using a read-only SQLite connection; it does not read credentials, modify the Codex database, import conversation turns, or execute resume commands. Internal subagent threads are excluded.

The adapter is isolated because the desktop SQLite schema is private and versioned. Missing databases produce no Codex rows; incompatible databases produce a visible source error. `CODEX_HOME` selects the Codex data directory. Demo mode never reads the real Codex index.

Origin and group filters apply before pagination. Codex groups are its actual sidebar sections; Claude fallback groups explicitly say `Pasta:` and identify a directory, not a sidebar section. The group filter sends a stable key (`section:<name>`, `folder:<name>`, `none`), never the screen label. Title, directory, id, and group are searchable. The list has an Origin column and origin/group filters; wall cards and session detail use a readable origin label. List and wall refresh every 30 seconds. The wall includes Codex conversations updated within the same 180-minute recent window, and sorts across providers while retaining Claude attention priority. Runtime state, duration, agent count, and cost are not inferred from metadata: Codex state is unavailable, and unknown metrics are displayed without invented values.

## Supported operations and boundaries

- List/search/filter real local Codex threads alongside Claude: implemented.
- Open Claude: existing `/api/sessions/<UUID>/open` flow is preserved.
- Open Codex: `/api/codex/sessions/<UUID>/open` resolves a current local non-archived user thread, then dispatches its fixed `codex://threads/<UUID>` URI through the existing macOS launcher. No URL or provider supplied in a request body is trusted. Source failure returns 503; removed/archived threads return 404. Separate routes and UI state keys prevent cross-provider UUID collisions.
- The UI says “Abertura solicitada ao Codex” after dispatch, rather than claiming the target conversation was verified. Native opening is implemented and tested with a simulated launcher, but actual application navigation remains unverified: browser automation blocked the earlier deep-link test, and no alternate execution route was used to bypass it. The temporary CLI-command dialog was removed in favor of the requested native button.
- Send messages, start/stop turns, live status, remote Codex machines, Codex dashboard and history integration: outside this read integration. Existing Claude operations remain unchanged; their dashboard cards also carry an origin label.
- The supported Codex app-server protocol documents thread lifecycle operations: https://learn.chatgpt.com/docs/app-server . A future live adapter should use that protocol with explicit ownership of turns and approval handling, rather than writing this SQLite database.

## Validation on 2026-10-21

Based on main `24e5b8f`. Isolated clone, independent core database and localhost port; existing Claude worktrees and installed app preserved. Read 60 non-archived Codex user chats (239 index records before excluding internal agents), including 13 in the Ahrena group. The real Claude history was ingested into the isolated database. Browser inspection confirmed the Ahrena filter and corrected a clipped action button.

Focused tests cover source immutability, archived/invalid-id exclusion, shell quoting, grouping, provider filtering, unknown state/cost, missing source and incompatible schema. The ordinary Sessions/attention tests and repository English-internals guard also pass.

Additional independent reviews covered provider collisions, source errors, wall ordering, unknown metric tooltips and layout. Their actionable findings were addressed; final validation totals are recorded in the PR.

Final validation for origin column, labels and wall: 2,001 core tests and 22 repository checks passed; the final wall-only visual regression run also passed. Native app dispatch is covered by stubs and remains pending user confirmation in the running UI.
