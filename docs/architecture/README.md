# Architecture registers

The console's answer to "what is this folder, which strategy do we use, how does this table behave".
Written for issue 657; the reasoning is in [decision 0026](../decisoes/0026-result-and-route-error-format.md).

| File | What it holds | Checked by |
| --- | --- | --- |
| [layers.json](layers.json) | every folder and top-level file under `packages/*/src` in one of `domain`, `application`, `edge`, `composition-root`, with the evidence and, where a folder is mixed, the exceptions | `test/architecture-layers.test.mjs` |
| [strategies.json](strategies.json) | one row per problem (result, error-format, http-client, validation, test, date-time, persistence, events): the decision and a reference implementation | `test/architecture-registers.test.mjs` |
| [table-modes.json](table-modes.json) | every SQLite table the sources create, with its mode: `append-only`, `upsert-with-history` or `upsert` (no history, flagged legacy) | `test/architecture-registers.test.mjs` |

Adding a folder or file under `packages/*/src`, a `CREATE TABLE`, or removing one: edit the matching file in the same change, or the root test suite fails and names the entry.
The ratchet applies: new code follows the registers, legacy does not block.
