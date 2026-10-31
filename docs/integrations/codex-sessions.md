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

## Human QA artifact (#394)

The `app-ci` run uploads `ahrena-console-qa-<full source SHA>-arm64` for one day. This is a public Actions artifact of public code, not a release or deployment. Download it from the final PR head's successful run (GitHub sign-in may be required). Verify `manifest.json` matches that head and run URL; `SHA256SUMS` covers the inner `ahrena-console-qa-arm64.tar.gz`. From the extracted artifact directory, `shasum -a 256 -c SHA256SUMS` must pass before extracting the tar archive. The tar preserves executable permissions and symlinks; the outer Actions ZIP is only transport.

This debug app is Apple Silicon only, ad-hoc signed and **not notarized**. Keep it in a separate directory named `Ahrena Console QA <short SHA>`; never replace `/Applications/Ahrena Console.app`. Do not remove quarantine, change Gatekeeper, or override an OS refusal. If macOS blocks it, stop and record the message in #394: a properly signed/notarized build is then required.

Before launching, the operator must prepare the isolated authenticated QA core and native-app environment described in [the acceptance preparation record](https://github.com/ahrenatechnology/ahrena-console/issues/394#issuecomment-6549420661), using this artifact's source SHA. The artifact alone is not a ready authenticated QA environment. Do not double-click it against the normal data directory. A real local Claude Desktop session must be available as a target; do not invent IDs or seed credentials. No build is needed on the Mac. Quit only the regular Ahrena Console via its menu before starting the QA copy: both use `dev.ahrena.console`, so they cannot run side by side. Keep Claude and Codex open. Do not activate login startup or install an updater from the QA copy.

Once the operator supplies the isolated QA window, Fernando performs these human clicks:

1. Open **Sessões**, filter **Origem: Codex**, select the agreed default-profile thread, and click **Abrir no Codex**. Observe the matching existing chat in Codex; a Console toast is not evidence.
2. Return to the QA window, filter **Origem: Claude**, select the agreed real Desktop session, and click **Abrir no Claude Desktop**. Observe that exact existing chat in Claude. If only terminal opening is offered, stop: it is the wrong target.
3. Record source SHA, local time, app versions and expected/observed title or short ID for each provider, with a cropped header screenshot or explicit human report. Do not expose private messages, owner proofs or credentials. Do not send prompts, resume execution, approve tools, create chats or switch accounts.
4. Close only the QA app/core, remove its temporary owner-proof file, and reopen the regular Console. Keep acceptance pending for either failed/missing observation.

PR #299 remains draft until both observations are recorded. CI and archive integrity do not establish native-navigation acceptance.
