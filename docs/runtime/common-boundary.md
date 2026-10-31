# Common runtime boundary (#383)

This stage supplies durable lifecycle primitives and an integrated **refusal-only** production boundary. It does not complete #383's real-adapter acceptance. #387 still has no provider-enforced extras-disabled proof; #123 and #384 own real adapters. No runtime adapter registry, admission override, environment flag or fake transport is available in production.

## HTTP and identity

`GET /api/runtime?sessionId=<internal-id>` exposes read-only capabilities and the latest 100 runs. `POST /api/runtime/commands` accepts `sessionId`, `operation`, and (except start) `runId`. Send adds `message`; respond adds `requestId` and either `{kind: "approval", decision: "approve" | "deny"}` or `{kind: "question", answer: string}`. Unknown body fields are rejected. Provider/account/profile/configuration paths are never accepted from the client.

Both endpoints sit behind the existing #302 owner authentication and Host/Origin checks. Writes additionally require same-origin JSON and a bounded body. The owner context is rechecked after asynchronous reads/diagnostics and before persistence. The server derives scope from the stored session/account identity, requiring matching provider/profile/machine/environment, confirmed account evidence and an unambiguous absolute configuration directory. Those persisted hints do **not** prove current login or extras policy: billing still refuses. A discovered or legacy external session cannot be taken over. Existing external messaging routes are unchanged and separate.

All managed operations use #382 BillingAdmissionGate, including responses, interrupt and close. A refused start produces a blocked run; other refused commands append an event correlated to the target run/turn/request and operation, without changing its state. No refusal claims a pending request, calls a transport or schedules a retry. Unsupported/unknown identity and stale runs are rejected earlier. Capabilities currently advertise every execution operation as unsupported. Starting a new managed session and linking a real adapter remain unavailable; no route marks an external session managed.

## Durability and concurrency

Migration 15 adds `runtime_runs` and `runtime_requests` to the existing SQLite database. An execution run is separate from the provider session and carries its current turn ID. At most one prepared/running run exists per session. Requests are typed approval or question, carry expiration and are bound to a run/turn. Messages cannot serve as approvals.

State changes, request claims and corresponding events commit in one `BEGIN IMMEDIATE` transaction. The shared events feed carries provider/account/profile/session/run/turn/request correlation. Events contain lifecycle metadata only, not prompts, answers, credentials or raw errors. The existing change cursor receives a state change after commit. Request claims use a conditional update: concurrent connections cannot accept the same response twice. Different scope/run, obsolete turn, expired, invalidated and repeated replies fail closed. Closing/interruption/transport failure invalidates pending requests. Restart recovery marks prepared/running runs as transport errors and invalidates pending requests; it does not reconnect, replay, resend or approve.

The store is an internal persistence primitive, not an execution authorization API. Test-only adapters exercise the structural contract for Claude and Codex. No synthetic adapter result establishes real runtime availability or billing permission.

## Verification and outstanding acceptance

Remote CI runs the contract/store tests, HTTP owner/billing cases, migration/identity/storage/change-feed regressions and existing billing/owner suites. Tests include file reopening, separate SQLite connections, event-write rollback, stale turns and startup recovery. Local builds/tests are intentionally not run on the constrained workstation.

Still blocked on #387 + #123/#384: real managed session creation, adapter capability negotiation, approved dispatch, real provider event ingestion and native disconnection validation. #385 owns scheduling. #383 must remain open until those integrations prove the acceptance criteria; this foundation and fake tests alone are not closure evidence.
