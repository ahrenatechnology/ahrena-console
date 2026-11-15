// A hook event of the session that closes a request as answered_elsewhere: the card or the terminal answered first, or (#618)
// the session moved on (decision 0025, "Respondido em outro lugar", #618/AC-4).
//
// A PreToolUse of the same session, tool and digest teaches a request its `tool_use_id`, pairing in arrival order. A (#618)
// PostToolUse or PostToolUseFailure of that id closes it. With no pair, it closes the oldest open request of the same (#618)
// session, tool and digest; a call of another digest closes nothing. Stop, UserPromptSubmit and SessionEnd close every (#618)
// open request of the session, an answered one not yet delivered included. (#618)
import { digestOf } from './digest.ts';
import { recordChange } from './internal.ts';
import { PermissionRefusal, type PermissionRequest } from './model.ts';
import type { PermissionDeps } from './ports.ts';

export type HookEvent =
  | { name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'; sessionId: string; toolName: string; toolInput: unknown; cwd: string; toolUseId: string }
  | { name: 'Stop' | 'UserPromptSubmit' | 'SessionEnd'; sessionId: string };

export async function settleFromHookEvent(deps: PermissionDeps, event: HookEvent): Promise<{ closed: string[] }> {
  // The only `await` comes first: from the load to the last save nothing is awaited, so a delivery cannot land between them and be overwritten (ports.ts, decision 0025 "Entrega única", #618/AC-4).
  const digest = event.name === 'Stop' || event.name === 'UserPromptSubmit' || event.name === 'SessionEnd' ? null : await digestOfEvent(event);
  const requests = deps.repository.listBySession(event.sessionId);
  if (event.name === 'Stop' || event.name === 'UserPromptSubmit' || event.name === 'SessionEnd') {
    return { closed: requests.filter((r) => r.isOpen).map((r) => close(deps, r)) };
  }
  if (digest === null) return { closed: [] };
  const sameCall = (r: PermissionRequest) => r.isOpen && r.toolName === event.toolName && r.digest === digest;
  if (event.name === 'PreToolUse') {
    const taken = requests.some((r) => deps.repository.toolUseOf(r.id) === event.toolUseId);
    const unpaired = requests.find((r) => sameCall(r) && deps.repository.toolUseOf(r.id) === null);
    if (!taken && unpaired !== undefined) deps.repository.linkToolUse(unpaired.id, event.toolUseId);
    return { closed: [] };
  }
  const owner = requests.find((r) => deps.repository.toolUseOf(r.id) === event.toolUseId);
  if (owner !== undefined) return { closed: owner.isOpen ? [close(deps, owner)] : [] };
  // Decision 0025: "sem par certo, um fechamento fecha o mais antigo aberto". Narrower here on purpose: only the oldest open request (#618)
  // of the same session, tool and digest, never any open request of the session, because a wrong pair takes the card off the screen (#618)
  // early and a Post of another call must close nothing (#618/AC-4).
  const oldest = requests.find((r) => sameCall(r) && deps.repository.toolUseOf(r.id) === null);
  return { closed: oldest === undefined ? [] : [close(deps, oldest)] };
}

/** The digest of the call an event names; `null` when its input nests too deep to digest, which no request can match. (#618) */
async function digestOfEvent(event: { sessionId: string; toolName: string; toolInput: unknown; cwd: string }): Promise<string | null> {
  try {
    return await digestOf({ sessionId: event.sessionId, toolName: event.toolName, toolInput: event.toolInput, cwd: event.cwd });
  } catch (error) {
    if (error instanceof PermissionRefusal && error.code === 'input_too_deep') return null;
    throw error;
  }
}

function close(deps: PermissionDeps, request: PermissionRequest): string {
  request.closeElsewhere(deps.clock.now());
  recordChange(deps, request, 'closed');
  return request.id;
}
