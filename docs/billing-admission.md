# Subscription-only admission — #382

Status: implemented **refusal boundary and read-only diagnostics**, not permission to run models.
Investigation date: 2026-10-31. Applies only to the user's own local installation/accounts.
Commercial hosting, credential intermediation and remote execution require a separate decision.

## Current result

There is no supported provider-enforced proof of “extras disabled” implemented here. Consequently
`eligible` is reserved vocabulary, **unreachable** in this release. `allowed` is literally `false`.
Subscription login, a checkbox, zero balance, a token estimate or a screenshot cannot unlock it.
The absence of a documented proof is an investigation result, not a claim that no such mechanism
could ever exist. Discovery, historical import and existing external-session observation are unchanged.

## Official sources reviewed

| Source | Finding and limit |
| --- | --- |
| [Claude authentication](https://code.claude.com/docs/en/authentication) | Cloud credentials, auth token, API key and helper can supersede subscription login. An empty child environment does not resolve settings or managed configuration. |
| [Claude CLI](https://code.claude.com/docs/en/cli-reference) | `claude auth status` is JSON by default (not `--json`); `authMethod` distinguishes modes. `configDirectory` requires v2.1.268+. This is authentication evidence, not extras enforcement. |
| [Claude costs](https://code.claude.com/docs/en/costs) | Subscription usage credits can extend usage. Personal users can manage them in Settings > Usage. `/usage` is a diagnostic UI; it does not establish a stable machine-readable, account-bound no-overage guarantee. |
| [Claude legal](https://code.claude.com/docs/en/legal-and-compliance) | Own-account sign-in to the unmodified binary and third-party credential intermediation are distinct. This implementation neither offers login nor changes the binary/auth methods. Hosting is not authorized by this investigation. |
| [OpenAI authentication](https://learn.chatgpt.com/docs/auth) | `codex login status` reports authentication method. API-key use is billed separately. `forced_login_method="chatgpt"` constrains login, not additional credits. |
| [OpenAI pricing](https://learn.chatgpt.com/docs/pricing) | Extra credits and API-key usage are separate ways to continue beyond plan limits. The docs also allow an active turn to continue at the limit, subject to fair use. Local usage polling cannot enforce a zero-overage guarantee mid-turn. |
| [Codex app-server](https://learn.chatgpt.com/docs/app-server) | `account/read` with `refreshToken:false`, and `account/rateLimits/read`, are documented non-inference candidates. Auth modes, quota windows, credits/reset credits and usage are not a documented extras-disabled attestation. Do not call credit-consumption, purchase/nudge, login or turn methods for diagnostics. |

These are living documentation pages, not a pinned protocol release. No installed provider CLI
was invoked or version-qualified by this change. The earlier ADR's Claude 2.1.302/SDK 0.3.302
fake-API experiment is historical evidence only. The CLI reference's explicit v2.1.268 field
minimum is not an assertion that other versions are certified. Actual version qualification and
schema fixtures belong to #123/#384 before enabling their non-inference transports.

## Implemented diagnostic

From `packages/nucleo`:

```sh
node src/runtime/billing-diagnostic-cli.ts claude /absolute/profile /absolute/project
node src/runtime/billing-diagnostic-cli.ts codex /absolute/profile /absolute/project
```

Exit 1 means refused, including unknown; exit 2 means invalid arguments. Output contains only
reason codes, state, timestamps and refusal/queue flags. No path, e-mail, raw status, credential,
config content or env value is printed. Nothing is persisted.

The implementation reads only known settings files: Claude profile `settings.json`, project
`.claude/settings.json` and `.claude/settings.local.json`; Codex profile and project `config.toml`.
It rejects leaf symlinks, non-regular and oversized files and bounds reads. It never opens
`auth.json`, `.credentials.json`, keychains or session tokens, executes a helper, or invokes a
provider process. Credential-looking configuration is classified without echoing it or hashing
its contents. Environment values are not hashed. The revision is a scoped metadata change detector,
not a cryptographic snapshot of effective configuration.

Unknown settings are ambiguous. Even empty known files retain `effective_config_unverified`:
managed/server layers, parent project layers, includes, active profiles and launch arguments are
not fully resolved here. #295 owns that work. Safe environment construction is an allowlist;
conflicts are reported **before** dropping them. Caller-provided HOME/PATH still need the runtime's
trusted binary/home validation; the returned environment alone is not launch authorization.

The exported auth parsers accept already-obtained official status output and return only allowlisted
mode/source fields. They do not run the commands and do not establish account ownership. A live
Claude status probe is intentionally not implemented while unresolved configuration might execute
`apiKeyHelper`. Codex app-server transport remains #384. Failures remain unknown/refused.

## Integration contract

Import `src/runtime/index.ts`. No model, storage, migration or HTTP-auth change is included.
`BillingScope` uses provider, opaque profile/account identity, config directory and project. #377's
identity capabilities are not billing proof. A null/unknown account never becomes an eligibility grant.

`diagnoseBilling` returns a local observation with origin, timestamps, 30-second diagnostic lifetime
and scope. `evaluateBillingAdmission` checks scope/freshness and always requires extras proof.
API/helper/gateway/environment conflicts are blocked; missing evidence is unknown. Both refuse.

`BillingAdmissionGate.admit('launch' | 'resume' | 'turn', scope, {pauseQueue})` re-reads before each
operation, compares scoped revisions and pauses the owning queue before throwing
`BillingAdmissionError`. It has no launch callback or permit that can be replayed. No cached result
may authorize a later operation. A quota-exhausted event latches refusal for that profile/account;
`invalidate` clears only the latch, never resumes or grants. The adapter must pause/interrupt its
own active queue immediately on that event and use `admit` for every subsequent operation.

#383/#123/#384 must wire this boundary immediately before spawn/resume/input write; #385 owns the
durable queue and event-driven interruption. Those runtimes do not exist in this base. This change
therefore does not claim an end-to-end running adapter or durable queue integration. There is no
new launch path to bypass the gate here. #382 stays open for integration evidence.

Two reads detect ordinary account/config changes during diagnostics. They cannot eliminate all
filesystem races or enforce the provider's billing policy after admission. A future eligible path
requires trusted complete effective config, bound identity/version, provider-enforced extras-off
proof with validity/revocation semantics, and an atomic runtime boundary. It must not simply change
`allowed` to true. Config/account events invalidate observations. In-flight turns can only be
interrupted best-effort; polling, estimated tokens and local spending limits do not replace a
provider-side no-charge control.

## User action and remaining gate

The unresolved enforcement work is tracked in [#387](https://github.com/ahrenatechnology/ahrena-console/issues/387) (P1), with dependencies, steps and acceptance criteria.

The user may inspect/disable usage credits using each provider's own account UI and wait for quota
reset. The Console neither purchases nor consumes credits, changes accounts, nor falls back to API.
Manual UI action is necessary where applicable, but is not sufficient proof for this integration.
Until a supported verifiable enforcement mechanism is established and adapters are reviewed,
managed execution remains refused. No real “small test” is permitted to discover billing behavior.

Tests use temporary files and synthetic status text only. They cover overrides despite clean env,
ambiguous/unreadable config, safe output, two-profile isolation, expiry, configuration/account race,
quota latch, probe failure and all three refused operations, plus the real diagnostic CLI process.
