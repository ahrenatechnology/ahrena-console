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
