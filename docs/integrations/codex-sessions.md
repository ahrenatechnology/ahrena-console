# Local Codex discovery and native opening (#300)

The Sessions table combines stored Claude sessions and metadata-only Codex user threads. The wall adds recently updated Codex threads within its existing recent window and preserves Claude attention priority. The provider column/filter, detail and cards use readable Claude/Codex labels. Local metadata refreshes every 30 seconds while the screen is visible; no model or transcript is read for discovery.

## Source contract

Adapter v1 reads `state_5.sqlite`, SQLite `user_version=0`, through `DatabaseSync` with `readOnly: true`. Required thread columns are checked; the optional `name` column overrides `title`. Additive columns are ignored. Missing, locked, inaccessible and incompatible sources surface a bounded pt-BR error without paths or exception contents. The adapter never migrates the source or writes indexes. Known user source encodings are allowlisted; archived, invalid-ID, subagent and unknown source records are excluded. Sidebar groups are outside this delivery.

`CODEX_HOME` selects the discovery directory. The canonical directory hash forms the profile identity; no current account is inferred. `providerSessionKey` includes provider, provider ID, profile, local machine and unknown environment. Same UUIDs in Claude or another profile cannot resolve through the Codex route. The index is not persisted into the core database. Demo mode does not read it.

## Availability and opening

Runtime state, duration, agent count, cost, history and account are unavailable. A recent timestamp proves only recorded activity. Codex rows never query the Claude messaging adapter. Their capabilities are external, with send/interrupt/approve unavailable.

`POST /api/codex/sessions/<encoded internal ID>/open` rechecks the source and dispatches only its fixed `codex://threads/<provider UUID>` link. The request body cannot supply a target. The existing Claude route additionally checks legacy Claude identity. Both use same-origin handling and the central owner-auth gate from #302/#391; no credential is embedded in a URL. Custom Codex profiles cannot open in the default app because the native deep link has no profile selector. The UI reports dispatch requested, not confirmed navigation.

Remote access remains governed by #388 and fails closed. This work does not implement ingestion (#378), runtime state (#379), or execution/billing eligibility. No inference is needed for any acceptance check here.

## Validation record

Automated cases and the PR record cover immutable source reads, failure propagation, provider/profile isolation, native route validation, demo isolation, and Claude regression. Real native-app navigation is a separate acceptance requirement and remains pending until recorded in the PR; launcher mocks do not satisfy it. Earlier PR #299 test counts are historical and are not evidence for this revised diff.
