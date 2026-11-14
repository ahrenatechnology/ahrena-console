# Agent view contract (#529)

The read behind the agent view of #521 (wireframe screen 521-10, gaps G1 to G5, G7 and G8). Read-only, from the database: no migration, no storage change, and the importer is untouched. The reason an agent failed (G6) is #530 and is not here. The projection is `packages/nucleo/src/api/agent-view.ts`; the route and its HTTP statuses belong to the next layer of #529.

## Operation

`GET /api/sessions/:id/agents/:agentId`

- `:id` is the session id, with the same pattern as the other detail routes.
- `:agentId` is the part of `Agent.id` after the `<sessionId>:` prefix (the id has a `:`, the route carries only the tail). `main` is the main agent. A raw id the hooks send (no prefix) resolves to the same agent.
- Only the agent's own events are read: an event belongs to an agent by `SessionEvent.agentId`, resolved as the Detail does (`main`, a prefixed id, or a raw id).

## Response `200`

```json
{
  "agentId": "a1b2",
  "agentType": "Explore",
  "description": "Find the cost code",
  "brief": "first prompt, line breaks kept",
  "briefTruncated": false,
  "spawnedByToolUseId": "toolu_T1",
  "steps": [
    { "id": "toolu_R1", "kind": "tool", "name": "Read", "summary": "src/cost.ts", "state": "ok", "start": "2026-11-01T10:00:01.000Z", "end": "2026-11-01T10:00:02.000Z", "childAgentId": null },
    { "id": "toolu_A1", "kind": "agent", "name": "Agent", "summary": "Check the table", "state": "running", "start": "2026-11-01T10:00:03.000Z", "end": null, "childAgentId": "c3d4" }
  ],
  "result": "last assistant message, or null while running",
  "resultTruncated": false,
  "costUsd": 0.42,
  "costNote": null,
  "totalCostUsd": 0.9,
  "state": "completed",
  "start": "2026-11-01T10:00:00.000Z",
  "end": "2026-11-01T10:05:00.000Z"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `agentId` | string | The id as the route takes it (after the session prefix). |
| `agentType` | string or null | `Agent.subagentType` (`meta.agentType`, for example `Explore` or `plugin:agent`). `null` for the main agent and when the transcript gave none. Kept apart from the description (G1). |
| `description` | string or null | The short description the parent gave the agent (`meta.description`). See "Description". |
| `brief` | string or null | The text of the agent's first prompt (`UserPrompt`, or `UserPromptSubmit`), line breaks kept, outer whitespace trimmed, at most 32,000 characters (G2). `null` when the agent has no prompt event. |
| `briefTruncated` | boolean | `true` when the prompt had more than 32,000 characters and `brief` holds the first 32,000. |
| `spawnedByToolUseId` | string or null | `metadata.toolUseId` of the agent: the id of the `Agent` call, in the parent's conversation, that created it (G3). `null` for the main agent and when the transcript did not say. |
| `steps` | array | The agent's tool calls in the order they were made (G4). See "Steps". |
| `result` | string or null | The text of the agent's last `AssistantMessage`, at most 32,000 characters (G5). `null` while the agent runs (`state` `working` or `waiting`) and when it has no assistant text. |
| `resultTruncated` | boolean | `true` when the last message had more than 32,000 characters. |
| `costUsd` | number or null | The agent's own cost. For the main agent it includes the usage with no agent (the compaction floor), as the Agents tab does. |
| `costNote` | `"no_usage"`, `"unpriced"` or null | Why `costUsd` is `null`. `null` when `costUsd` is a number. |
| `totalCostUsd` | number or null | `costUsd` plus the cost of every descendant (the agents whose `parent` chain reaches this one). `null` when neither the agent nor any descendant has a priced cost. |
| `state` | `"working"`, `"waiting"`, `"completed"` or `"error"` | `Agent.status`. For the main agent, the main `Agent` row when there is one, else derived from the session as the Agents tab does. |
| `start` | ISO string | `Agent.startedAt` (the session's `startedAt` for a main agent with no row). |
| `end` | ISO string or null | `Agent.endedAt`. For the main agent, its row's `endedAt`, else the session's `endedAt` (also when it has no row), as the session-detail agent list does. |

### Cost: absent is never zero

`costNote` separates the two reasons a number is missing and neither becomes `0`:

- `no_usage`: the agent has no measured usage at all.
- `unpriced`: the agent has usage and none of it has a price in the table.

With usage priced for only part of it, `costUsd` is the sum of the priced part and `costNote` is `null`, as `costReport` does for `CostLine.costUsd`.

### Steps

One step per tool call (`ToolUse` or `PreToolUse` with a tool name), counted once when the hook and the transcript both carry it (same tool use id). Fields:

- `id`: the tool use id (the event id when the call has none).
- `kind`: `agent` for a call that spawns an agent (`Agent`, and `Task`, its former name), `tool` for every other.
- `name`: the tool name.
- `summary`: the event summary (the target or command, cut at ingest), or `null`.
- `state`: `ok` or `error` once a result arrived (`ToolResult`, `PostToolUse`, `PostToolUseFailure`); `running` with no result while the agent is `working` or `waiting`; `unknown` with no result once the agent ended.
- `start`: when the call was made. `end`: when its result arrived, `null` with none.
- `childAgentId`: only on `kind` `agent`: the `agentId` of the child whose `metadata.toolUseId` is this step's `id`; `null` otherwise or when the child was not read.

### Description

The stored `Agent.name` of a subagent is `meta.description`, or the task cut at 80 characters when the transcript had no description (`importer.ts`). The two cannot always be told apart, so the rule is: `description` is `Agent.name`, except when it equals the task cut at 80 characters the way the importer does it, which is the fallback and not a description, and then it is `null`. A short description that equals its own task is read as the fallback: an accepted loss. The main agent has no description.

## Errors

| Status | `code` | When |
| --- | --- | --- |
| 404 | `session_not_found` | The core does not know the session. |
| 404 | `agent_not_found` | The session has no agent with that `agentId`. |
| 400 | `invalid_session_id` | The session id does not match the route pattern. |

The body is `{ "error": "<message>", "code": "<code>" }`; `code` is the contract, `error` is a message for a person. The projection returns `null` for an unknown agent and the route maps it.

## Caps

`brief` and `result` hold at most 32,000 characters (`MESSAGE_TEXT_MAX`, the same ceiling as the Conversation), cut with `slice` and no ellipsis, so the flags carry the truncation. Steps are not capped.

## Additive fields on the session-detail agent list

`GET /api/sessions/:id/agents` returns `agents: AgenteDoDetalhe[]`. Two fields are added, with the same meaning as above, and every existing field (`id`, `type`, `name`, `task`, `model`, `turns`, `status`, `start`, `end`, `costUsd`, `parent`) stays as it is:

- `agentType`: string or null (`null` for the main agent).
- `description`: string or null (`null` for the main agent).

Old consumers ignore them. `parent` is already served (the main id when the owner of the call was not read).

## Compatibility

New route, new fields; API version 1 stays. A client that predates it does not call the route.
