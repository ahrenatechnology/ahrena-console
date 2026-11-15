# Published events contract (#663)

Every event the core publishes is a CloudEvents 1.0 event (framework conditions EVT-1 and EVT-2). The core has one publication channel, the change cursor (`packages/nucleo/src/changes/cursor.ts`); each recorded change is delivered as an event beside the legacy `changes` list. The mapper is `packages/nucleo/src/changes/cloud-event.ts` (pure, no IO); the schemas are in `docs/contracts/events/` and are authored, not generated; the acceptance test (`#663/AC-1`) is `packages/nucleo/test/changes/cloud-events.test.ts`, which validates every delivered event against the envelope schema and the schema of its type, and fails when a change type has no schema file or a schema file names no change type.

## Delivery

- `GET /api/changes`: the `200` body gains `events` beside `changes`, one event per change, same order.
- `GET /api/stream`: the `changes` message data gains `events` the same way.
- MCP `wait_for_changes` is not an event channel: it keeps its privacy-filtered projection and carries no events.

## Envelope (`events/cloudevents-1.0.schema.json`)

```json
{
  "specversion": "1.0",
  "id": "k3f9a2.41",
  "source": "/ahrena-console/core",
  "type": "com.github.ahrenatechnology.console.core.session.changed.v1",
  "subject": "s1",
  "time": "2026-11-14T12:00:00.000Z",
  "datacontenttype": "application/json",
  "dataschema": "https://github.com/ahrenatechnology/ahrena-console/blob/main/docs/contracts/events/session.changed.v1.schema.json",
  "data": { "sessionId": "s1", "accountId": "conta-a" }
}
```

- `id` is the change's cursor, `<generation>.<seq>`: unique per core start, the same value the cursor carries.
- `subject` is the identity of the root that changed (the change's key, see the table).
- `time` is the occurrence time, stamped when the change is recorded.
- `data` is `{ sessionId, accountId }`, each a string or `null` as the schema of the type says.

## Type naming and versioning

`com.github.ahrenatechnology.console.core.<change-type>.changed.v<N>`, one type per change type, one domain fact each. Its schema is `events/<change-type>.changed.v<N>.schema.json`. A breaking change to `data` (a field removed, retyped or made required) is a new `.v2` type and a new schema file; `v1` stays, with its schema. Adding a change type adds its schema file in the same change, or the test fails.

## Types

| Change type | Subject | `sessionId` | `accountId` |
| --- | --- | --- | --- |
| `session`, `state`, `plan`, `activity` | the session id | string | string or null |
| `decision` | the decision id | string | string or null |
| `needs-you` | the session id, or `<machine>:<session>` from a remote machine | string, null from a remote machine | string or null |
| `account` | the account id | null | string |
| `repos` | `list`, `delivery` or `<owner>/<repo>` | null | null |
| `alert` | `<machine>:<alert>` | null | null |
| `agent-instructions`, `framework-install` | `<owner>/<repo>` | null | null |
| `adrs` | `list` or `<owner>/<repo>` | null | null |
| `connections` | `github` | null | null |
| `tools` | the machine id | null | null |
| `connector` | the connector (`aws`) | null | null |
| `app-update` | `app` | null | null |
