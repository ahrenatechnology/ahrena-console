# Ahrena Console

## Internals in English, pt-BR only on screen

Decision [0009](docs/decisoes/0009-english-internals.md), issue #173.

- **English:** code, identifiers, file and folder names, API routes and query parameters, /ui URLs and screen ids, CSS classes, JSON keys, SQLite tables and columns, CLI options, test names.
- **Environment variables:** English, prefixed `AHRENA_CONSOLE_` (`AHRENA_CONSOLE_CORE_PORT`, `AHRENA_CONSOLE_DATA_DIR`).
- **pt-BR:** what the person sees: on-screen text, labels, titles, user-facing messages and notifications.
- New code follows the rule even inside a folder or file that still has a Portuguese name; do not add to the legacy.
- `node --test 'test/*.test.mjs'` runs a guard that refuses new Portuguese routes, /ui URLs, file names, CSS classes and environment variables. The names that existed before the rule are frozen in `test/english-internals.legacy.json`: a rename removes its entry; never add one.
- The old Portuguese routes, /ui URLs, CLI options and environment variables were aliases until phase 6 of #173 and are gone: do not bring them back.
- Comments, docs/, README, commit and PR messages: proposal in decision 0009, pending confirmation.

## Session economy

The 5-hour limit is spent by context size, not by work done: every call re-reads the whole conversation. Audit of 2026-10-21: 63% of a window went to calls above 300k tokens, and 43% to re-reading long sessions after an account switch. Issues #292 and #293.

- **Child sessions start on Sonnet.** Every `start_session` passes `model: "sonnet"`. Use Opus only when the piece is design-heavy or needs judgment (architecture, a decision record, a hard review), and say why in the brief. Subagents (`Agent`) default to Sonnet through `CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json`.
- **Compact at 200k.** `.claude/settings.json` sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=20`, which is 200k on the 1M window. Do not raise it.
- **Renew long sessions, do not resume them.** A coordinating session (the round's PM, a tech lead) that passes 200k of context or a day of age writes its work context (goal, decisions, PRs and branches, child sessions, next step, blockers) and proposes a fresh session started from it. It archives the old one only with the person's yes.
- **Switching accounts is a renewal.** The prompt cache belongs to the account, so a session resumed on another account re-reads its whole context at full price. Before switching, each long session writes its work context; after switching, start fresh sessions from it instead of resuming the old ones.
- **Archive what is done.** A child session whose PR merged gets offered for archiving; an idle session still wakes on every notification.
