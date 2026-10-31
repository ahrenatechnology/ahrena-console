# Provider identity contract (#377)

Session and account identity is independent of billing eligibility and HTTP authentication. This contract makes no inference call and grants no execution authority. #382 and #302 own those gates; #383 consumes them before any managed execution. Discovery can store unknown capabilities.

## IDs and scope

`Session.id` is the internal routing/foreign-key identifier. Existing Claude IDs remain unchanged. New producers pass a complete `Session.identity` with `provider` (`claude` or `codex`), `providerSessionId`, and nullable `profileId`, `machineId`, `environmentId`. Null means unknown, never the current global login. Do not change identity when updating a session.

Use `providerSessionKey(identity)` for a new scoped session. It hashes the canonical tuple into a fixed-size, URL-safe ID (within the existing 128-character route limit). Resolve by the full tuple using `getSessionByIdentity`; never resolve by provider UUID alone. `scopedEntityId(sessionId, 'event'|'agent', providerId)` gives each provider event/agent a session-specific internal ID. Foreign keys always contain internal IDs.

`ProviderAccount` adds `identity` (`providerAccountId`, nullable `organizationId`, and the same scope) and `confidence` (`confirmed`, `inferred`, `unknown`). `providerAccountKey` generates scoped account IDs. The legacy `ClaudeAccount` name remains compatible. A session stores `accountId`, `accountSource`, and `accountConfidence`; an unidentified account remains null/unknown. No current global account lookup occurs. Identity fields are whitelisted and must never contain credentials.

## Capabilities

`Session.capabilities` has `mode` (`external`, `managed`, `unknown`) and `history`, `nativeOpen`, `sendInput`, `interrupt`, `approve` (`available`, `unavailable`, `unknown`). Missing capabilities normalize to unknown. External/unknown sessions cannot advertise managed controls. Even an available capability is not authorization or evidence of subscription-only billing.

New scoped identities cannot use the legacy Claude opener. #300 owns native opening/discovery; it must use the full identity and a provider-specific adapter. The common opener returns `none` until such an adapter is implemented.

## Storage and wire compatibility

Migration 14 adds identity, confidence and capability columns and unique identity indexes. It backfills Claude identity while preserving IDs, account links, agents, events, event sequence and other tables. Legacy producers may omit identity; their identity normalizes to Claude with unknown scope. Existing evidence source is preserved, but confidence is unknown until explicitly established. Repeated migration execution is a no-op.

Session list, panel, wall and event-feed session descriptors add identity; list/panel/wall add capabilities. Existing fields and API version 1 remain. Plugin declarations include optional fields so older core responses still type-check; old consumers ignore the additive fields. Provider/profile filters are accepted by `/api/sessions`; storage additionally accepts machine/environment and null scope filters. Events reference internal session IDs, and the feed projects identity from that session rather than trusting event payload metadata.

The three parallel work streams must not reuse migration 14. Billing/authentication schemas, if needed, require a later migration after rebasing. Codex ingestion, management, billing probes and authenticated control are intentionally separate issues in #376.
