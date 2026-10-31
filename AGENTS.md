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

## Tests

- The proof that a PR passes the core is CI: `.github/workflows/repo-tests.yml` runs all of `packages/nucleo/test` in 6 parallel shards on every PR (#395).
- Locally, run only the file you touched, with `--test-concurrency=1`: `node --test --test-concurrency=1 packages/nucleo/test/<file>.test.ts`. Do not run the whole suite on a laptop; it exhausts memory.
- A failing test is fixed or gets an issue. Never hide it behind a silent skip.
- This is the quality gate the framework's `gates` rule asks for before review: the touched file passes locally, and CI on the head is the full run. Do not reproduce CI on the laptop.

## Session economy

The 5-hour limit is spent by context size, not by work done: every call re-reads the whole conversation. Audit of 2026-10-21: 63% of a window went to calls above 300k tokens, and 43% to re-reading long sessions after an account switch. Issues #292 and #293.

- **Child sessions start on Sonnet.** Every `start_session` passes `model: "sonnet"`. Use Opus only when the piece is design-heavy or needs judgment (architecture, a decision record, a hard review), and say why in the brief. Subagents (`Agent`) default to Sonnet through `CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json`.
- **Compact at 200k.** `.claude/settings.json` sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=20`, which is 200k on the 1M window. Do not raise it.
- **Renew long sessions, do not resume them.** A coordinating session (the round's PM, a tech lead) that passes 200k of context or a day of age writes its work context (goal, decisions, PRs and branches, child sessions, next step, blockers) and proposes a fresh session started from it. It archives the old one only with the person's yes.
- **Switching accounts is a renewal.** The prompt cache belongs to the account, so a session resumed on another account re-reads its whole context at full price. Before switching, each long session writes its work context; after switching, start fresh sessions from it instead of resuming the old ones.
- **Archive what is done.** A child session whose PR merged gets offered for archiving; an idle session still wakes on every notification.

## Precedence

Where the Ahrena Framework — the index below, the agency directive in CLAUDE.md, or any plugin agent or skill — differs from a rule above, the rule above wins.

<!-- ahrena:framework:start -->
## Ahrena Framework

Plugins: `ahrena-foundation`, `ahrena-contributing`, `ahrena-engineering-fundamentals`, `ahrena-engineering-typescript`, `ahrena-engineering-frontend` (marketplace `ahrena`).

Judgment rules, one line each; the full text is behind the link:

- **The aggregate boundary and the event that leaves it.** An invariant holds inside one aggregate, a transaction changes one root, aggregates refer to each other by identity, and an event names its root and time. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/aggregates.md))
- **Backstage in English, the user's language on screen.** Names behind the scenes are English — code, paths, routes, keys, env vars, CLI options, tests, commits; the user's language is only in what they read. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/backstage-language.md))
- **Platform code holds no client logic.** No client logic in platform code: a client's rule is a declaration in its installation, checked by a platform schema; its code enters only by a platform port. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/client-logic.md))
- **The contract is the source.** The contract is authored, the code is derived from it or validated against it, and every operation it declares has a test that exercises it. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/contract-first.md))
- **Concerns belong at a boundary.** Retry, transaction control, idempotency and metrics are declared once at a boundary; a hand-rolled one inside a body is the defect. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/cross-cutting-concerns.md))
- **The domain owns its vocabulary.** A domain module imports no mechanism and names no vendor, an aggregate root declares identity and an audit stamp, and no client datum is a literal. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/domain-model.md))
- **Behaviour that belongs to no aggregate.** Behaviour whose terms name two aggregates is a stateless domain service under domain/; work that only loads, calls and saves is application, not domain. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/domain-services.md))
- **Which pattern, and when.** A pattern ships only when the situation its catalog entry names is present in the tree and the cheaper alternative in that entry has been ruled out. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/pattern-selection.md))
- **SOLID as detectable conditions.** SOLID conditions that remove structure always apply; the ones that add it apply only when the abstraction trigger in rules/yagni.md is met. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/solid.md))
- **The project's language wins.** Before naming or creating anything, read the project's ubiquitous language and conventions; the framework default applies only where the project is silent. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/ubiquitous-language.md))
- **The abstraction trigger.** An abstraction ships only with a second real consumer in the tree or a test that requires the seam; an anticipated consumer is not a consumer. ([ahrena-engineering-fundamentals](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/fundamentals/rules/yagni.md))
- **The wireframe is the first layer.** No component is coded before its wireframe is approved as the first layer; code built against an unvalidated design is defective. ([ahrena-engineering-frontend](https://github.com/ahrenatechnology/ahrena-framework/blob/main/engineering/frontend/rules/wireframe-first.md))
- **Two gates, and a review lands the change.** An agent starts an issue only when asked, asks for review only after the quality gate passes, and lands a change only after a review approved it. ([ahrena-contributing](https://github.com/ahrenatechnology/ahrena-framework/blob/main/contributing/rules/gates.md))
- **What an issue carries.** An issue states what is wrong or missing with the evidence for it, what done looks like, and what it leaves to other issues. ([ahrena-contributing](https://github.com/ahrenatechnology/ahrena-framework/blob/main/contributing/rules/issue-quality.md))
<!-- ahrena:framework:end -->
