# Permission requests contract (#618)

The routes between the plugin's `PermissionRequest` hook, the core and the `/ui`. Authored first (decision [0025](../decisoes/0025-permission-requests-from-the-console.md), `contract-first`): `packages/nucleo/src/api/permissions.ts` is validated against this file, and `packages/nucleo/test/api/permission-requests-contract.test.ts` exercises every operation below, and `permission-window-scenarios.test.ts` holds the acceptance scenarios of the window credential and the switch (#619/AC-1 to AC-6). The domain, the use cases and the SQLite adapter are `packages/nucleo/src/permissions/`.

The operations below are also declared in [`core-api.openapi.json`](core-api.openapi.json) (tag `Permissions`: `registerPermissionRequest`, `getPermissionDecision`, `withdrawPermissionRequest`, `listPermissionRequests`, `answerPermissionRequest`, `getPermissionSwitch`, `setPermissionSwitch`, with the `Permission*` schemas), and `pendingPermissions` is described on `getAttention` and `getSession`; the change event is [`events/permission.changed.v1.schema.json`](events/permission.changed.v1.schema.json). The two files are kept in step: a change to an operation here is a change to its entry there, and the parity test (`packages/nucleo/test/api/contract-parity.test.ts`) fails on a route one declares and the other does not.

Every route needs the owner bearer (`Authorization: Bearer <owner token>`, #302). A request without it never reaches the handler (403). Errors reach the caller as `{ "error": "<code>" }`, a closed code and never the text of an exception, a dependency or the request.

## When the capability is off

The capability is on when the core holds a live window credential and the Controle switch is on; the switch is on when nothing is stored (#619). It is off while the core runs without a window credential (a core the desktop app did not start, an adopted one, a peer the native check refused) or while the switch is off.

## The window credential and the switch (#619)

- The credential is 256 random bits the desktop app issues in memory and hands to the core it started, over an inherited Unix socket (`--window-channel <fd>`), one line of 64 lowercase hex characters per credential; a new line replaces the previous one (rotation), and the end of the stream or an error revokes it. Before each line the core checks the process at the other end natively (its code hash against the installed app's, at the constant path `/Applications/Ahrena Console.app/Contents/MacOS/<exe>`); on `mismatch` or `unavailable` it holds no credential and closes the channel. No credential is accepted through an argument, an environment variable or a file, and it is never written to disk, a log, a URL, a page or a GET response.
- The switch is the installation setting `permissions.answerFromConsole` (a boolean, absent is on). It persists across restarts. Off, the core refuses registration (`503 off`) and the answer (`403 window_only`).

### 6. Switch state (`/ui`)

`GET /api/permissions/answer-from-console`

- Caller: the `/ui` (a same-origin `GET` with the bearer) or any bearer client. `403` for another `Origin`, a `Sec-Fetch-Site` of `cross-site` or `same-site`, or no owner bearer.
- `200 { "enabled": boolean, "available": boolean }` and nothing else. `enabled` is the setting; `available` is a live window credential. The credential is never in the answer.

### 7. Set the switch (`/ui`)

`PUT /api/permissions/answer-from-console`

- Body (`application/json`, at most 256 bytes): `{ "enabled": boolean }` and nothing else (`400 { "error": "invalid_request" }`; `413 too_large`; `415 use application/json`).
- Turning it **off**: the owner bearer, from a plain client or from the `/ui` (same-origin `PUT` of the exact raw path with JSON and a declared length).
- Turning it **on**: also the `Origin` of the `/ui` window and `Ahrena-Window: <window credential>`; otherwise `403 { "error": "window_only" }`. What the person turned off, an agent holding only the owner token cannot turn on.
- `200 { "enabled": boolean, "available": boolean }` after storing. `403` when the origin or owner proof fails.

| Operation | Answer while off |
| --- | --- |
| the three hook routes | `503 { "error": "off" }` |
| `GET …/permission-requests` | `200 { "available": false, "reason": "off", "requests": [] }` |
| `POST …/answer` | `403 { "error": "window_only" }` |

When in doubt, only the Desktop: off means off. The hook's decision route checks the capability (the switch and the window credential) when the wait starts, at each read of the wait, and right before the read that delivers. A decision the owner gave is never delivered while off: the hook gets `503 { "error": "off" }` and exits without stdout, so the Desktop card decides. The request stays `answered`, not delivered; if the core restarts it is closed as `core_restarted`, as always.

## Operations

### 1. Register (hook)

`POST /api/sessions/:sid/permission-requests`

- Caller: the plugin's hook. Refuses any request that carries `Origin` or `Sec-Fetch-Site` (`403 { "error": "hook_only" }`): a page never registers.
- Body (`application/json`, at most 64 KiB): `{ "toolName": string, "toolInput": any JSON, "cwd": string, "permissionMode": string | null, "digest": string }`. The core recomputes the digest of `{ sessionId, toolName, toolInput, cwd }`; it keeps only the redacted `summary` and the `terminalOnly` flag, never the raw `toolInput`.
- `201 { "requestId": string, "expiresAt": ISO string }`.
- `400 { "error": "digest_mismatch" }` (also `invalid_request`, `invalid_session_id`, `input_too_deep`), `413 { "error": "too_large" }`, `415 { "error": "use application/json" }`, `503 { "error": "off" }`.

### 2. Decision (hook)

`GET /api/sessions/:sid/permission-requests/:rid/decision?wait=25`

- Caller: the hook. Same `Origin` and `Sec-Fetch-Site` refusal as operation 1. `wait` is seconds, at most 25 (default 0).
- `200 { "requestId", "digest", "decision": "allow" | "deny", "reason": string | null, "answeredBy", "channel": "ui" }`, **once**. A request that was handed to a reader that already left is not handed again.
- `204` no answer yet when the slice ends.
- `409 { "error": "already_delivered" }` the decision was already read.
- `410 { "error": "gone" }` expired, withdrawn, answered elsewhere or open before a core restart. A decision is never delivered with a `410`.
- `404 { "error": "not_found" }` unknown id, or an id of another session.
- `503 { "error": "off" }`.
- A hook that disconnects while it waits is not handed the decision: the wait is a loop of non-delivering reads, and the delivery happens only while the connection is open.

### 3. Withdraw (hook)

`POST /api/sessions/:sid/permission-requests/:rid/withdraw`

- Caller: the hook, at its own deadline. Same `Origin` and `Sec-Fetch-Site` refusal. No body is read.
- `200 { "ok": true }`; `410 { "error": "gone" }` if it already closed; `409 { "error": "already_delivered" }`; `404`; `503 { "error": "off" }`.

### 4. List (`/ui`)

`GET /api/sessions/:sid/permission-requests`

- Caller: the `/ui` (a same-origin `GET` with the bearer) or any bearer client; only the answer needs more.
- `200 { "available": boolean, "reason": string | null, "requests": [ { "id", "state", "tool", "summary", "folder", "requestedAt", "expiresAt", "terminalOnly", "decision", "reason", "answeredAt" } ] }`: the pending requests and the ones closed in the last 10 minutes, oldest first. `summary` is redacted. `state` is one of `pending`, `answered`, `delivered`, `expired`, `withdrawn`, `answered_elsewhere`, `core_restarted`.
- The first listing after the window also nulls the deny reason of an older request (#618/AC-7).

### 5. Answer (`/ui` window only)

`POST /api/sessions/:sid/permission-requests/:rid/answer`

Three proofs, all required, checked before the body is read:

1. the owner bearer;
2. `permissionAnswerFromSameOrigin`: `POST`, the exact raw path (no query, no dot segment), `Origin` exactly `http://<Host>`, our `Host`, no `Sec-Fetch-Site` of `cross-site` or `same-site`, `Content-Type: application/json`, a declared `Content-Length` of at most 2048 bytes (a missing one is refused);
3. `Ahrena-Window: <window credential>`, compared in constant time with the credential the core holds in memory.

- Body: `{ "decision": "allow" | "deny", "reason"?: string }`; the reason is only for `deny`, one line, at most 500 characters.
- `200 { "ok": true }`.
- `403 { "error": "window_only" }` no or wrong window credential, or the capability off; `403 { "error": "forbidden_origin" }` the same-origin proof failed.
- `409 { "error": "already_answered" }`; `410 { "error": "gone" }`; `404 { "error": "not_found" }` (an id of another session is not found); `422 { "error": "terminal_only" }` `allow` on a `terminalOnly` request (a `deny` is accepted); `400 { "error": "invalid_decision" | "invalid_reason" | "invalid_request" }`. The body carries only `decision` and `reason`: one that names a session, a request or a digest of its own is `400 invalid_request`. A body over 2048 bytes or a content type other than JSON fails the same-origin proof (`403 forbidden_origin`) before it is read.
- The answer carries no session or digest of its own: the core uses the stored ones, so an answer cannot name another session's call.

## Hook events

Each hook event the receiver stores is also read by the permission use case `settleFromHookEvent`, from the raw payload (the stored one is cut at 4000 characters, which breaks the digest):

- `PreToolUse` pairs a request of the same session, tool and digest with its `tool_use_id`.
- `PostToolUse` and `PostToolUseFailure` of that id close it as `answered_elsewhere`.
- `Stop`, `UserPromptSubmit` and `SessionEnd` close every open request of the session as `answered_elsewhere`.

## Where the request shows

- `GET /api/attention` carries `pendingPermissions` and `GET /api/sessions/:id` carries it too, **only when the permission routes are wired** (a core without them keeps the old shape): `[ { "session", "requestId", "tool", "terminalOnly", "requestedAt", "expiresAt" } ]` for the requests still pending. No summary and no folder: both routes are open to the `AhrenaRemote` proof (decision 0020), the list route is not.
- `GET /api/changes` records `{ "type": "permission", "key": "<requestId>", "sessionId" }` on every opening and every change of state. The type is screen-only: the MCP `wait_for_changes` does not expose it.
- Not open to `AhrenaRemote`: none of the operations is on the closed list of routes (decision 0020), so a signed remote request gets `403`.

## Audit

`<dataDir>/permission-audit.jsonl` records the registration, the answer, the delivery, the closing and every refusal, including those the API makes (`window_only`, `forbidden_origin`, `hook_only`, and the same on the switch route; the `off` answer is the capability's state, not a refusal of a request, and is not audited), never the tool input, the summary or a reason in clear, nor the window credential or the bearer.

## Expiry

`expiresAt` is the registration plus 9 min 30 s. A request is expired wherever it is first seen (a read, an answer, a listing) and by a sweep every 30 s, which also nulls the old deny reasons; a core start closes the open ones as `core_restarted`.
