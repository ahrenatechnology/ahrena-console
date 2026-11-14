# Diagnosis contract (#565)

The read behind the diagnosis of a saturation alert (epic #563; wireframe screens 566-4 to 566-18, gaps D1 to D6). Read-only: every collector runs a fixed command of the catalog (`packages/nucleo/src/diagnosis/adapters/catalog.ts`), and nothing in the request reaches a command. The vocabulary is `packages/nucleo/src/diagnosis/model.ts`; the route is `packages/nucleo/src/api/diagnosis.ts`; the acceptance test is `packages/nucleo/test/api/diagnosis-api.test.ts`, which also checks that the statuses below are exactly the ones the route answers.

## Operation

`GET /api/diagnosis?machine=<id>&alert=<alertId>`

- `machine` and `alert` are each required, exactly once. `machine` is a machine id (`local`, or a remote machine of machines.json). `alert` is the id of an alert open on that machine, as `GET /api/telemetry` lists it in `alerts`, URL-encoded in the query (`volume-full%3A%2F`); the server decodes it once, never twice.
- The `machine` must be known and the `alert` must be open on it before anything runs. This route reads the open alerts; it does not decide them.
- For a remote machine, the núcleo of this machine asks the núcleo there the same route through the tunnel (as `machine=local`) and answers with its sections, under the requested `machine`.

## Response `200`

```json
{
  "machine": "local",
  "alertId": "swap-high",
  "kind": "swap-high",
  "takenAt": "2026-11-14T12:00:00.000Z",
  "sections": [
    { "id": "processes-by-rss", "status": "ok", "items": [{ "pid": 412, "name": "next-server", "rssBytes": 2147483648, "cpuPct": 56, "startedAt": "2026-11-14T08:00:00.000Z" }] },
    { "id": "swap", "status": "unavailable", "items": [], "reason": "short reason" }
  ]
}
```

- `kind` is the alert's kind: `load-high`, `memory-high`, `swap-high` or `volume-full`.
- A section is `{ id, status, items }` plus `reason` (a short text, at most 120 characters) when `status` is not `ok`, and `partial` (`{ reason }`) when the section is `ok` but was read only in part.
- `status` is `ok`, `unavailable` (the tool is missing or failed) or `timeout` (the collection passed its limit). An `unavailable` or `timeout` section has no items and never fails the others.

### Sections

The ids are fixed. Each alert kind gets its own, in this order:

| Alert kind | Sections |
| --- | --- |
| `load-high` | `processes-by-cpu` |
| `memory-high`, `swap-high` | `processes-by-rss`, `processes-by-cpu`, `swap` |
| `volume-full` | `largest-folders`, `docker-df`, `known-caches`, and `journal` on Linux only |

| Section id | Items |
| --- | --- |
| `processes-by-rss`, `processes-by-cpu` | up to 10 of `{ pid, name, rssBytes, cpuPct, startedAt }`, sorted by RSS or by CPU, highest first |
| `swap` | `[{ usedBytes, totalBytes }]` |
| `largest-folders` | `{ path, bytes }`, largest first, under the volume's mount |
| `docker-df` | `{ type, usedBytes, reclaimableBytes }`, one per row of `docker system df` |
| `known-caches` | `{ id, path, bytes, actionId }` with `actionId` one of `npm-cache`, `pip-cache`, `xcode-derived-data` (the cleanup actions of #569); each old worktree is its own item `{ id: "worktree", path, bytes, lastUsedAt, hasUncommitted, hasUnpushed, actionId: null }` |
| `journal` | `[{ bytes }]` |

## Statuses

| Status | When |
| --- | --- |
| `200` | The diagnosis, with the sections above. A section that did not come back is inside it, not an error. |
| `400` | `machine` or `alert` missing, repeated, empty, too long (200 characters for `alert`) or not a valid id. `{ error }`. |
| `404` | `{ error, reason }` with `reason` `unknown-machine` or `alert-not-open` (the alert is not open on that machine, or has closed since). |
| `405` | A method other than `GET`. |
| `422` | `{ error, reason: "not-diagnosable" }`: the alert is open but its kind has no diagnosis (`port-exposed`, `tunnel-busy`, `machine-unreachable`, `terminal-stuck`). |
| `501` | `{ "error": "diagnosis-unsupported" }`, stable: this núcleo cannot diagnose (no collector for its platform, or not wired), or the núcleo of the remote machine does not have the route (an old núcleo). The screen tells it from a failure by the `error` value. |
| `502` | `{ error, reason }`: the remote machine did not answer (`reason` `unreachable`, the tunnel is down or the núcleo there did not respond), or answered something that is not a diagnosis (`bad-response`). |

The remote núcleo's own `501 diagnosis-unsupported`, and its `404` that carries no `reason` (a núcleo without the route), come through as `501 diagnosis-unsupported`. Its `404` with `reason` `alert-not-open` comes through as that `404`.
