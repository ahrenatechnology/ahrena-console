/*
 * Readers for what the bridge's `memory_handoff_list` answers (#734/AC-2). Each builds a new object from the
 * fields it names: the body (summary, open_questions, next_steps, files_touched) and everything else in the
 * input is dropped, and an input that does not fit is an error that carries a code, never the input.
 */

import { checks, parseJson } from './readers.ts';

const HANDOFF_STATES = ['open', 'accepted', 'expired'] as const;

/** One handoff of the bridge's list, without its body, its cwd and the two personal fields (#734/AC-2, #734/D1, #735/D2). */
export interface MemorySessionHandoff {
  id: string;
  from_session_id: string | null;
  from_agent: string;
  to_agent: string | null;
  state: (typeof HANDOFF_STATES)[number];
  created_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  accepted_by_session: string | null;
}

/**
 * The local part of a bridge handoff, by handoff id: the cwd is a local path and owner_user and accepted_by_user are personal
 * data, so none of the three may reach MCP, an exporter, the hub or the remote contract (#734/D1, #735/D2).
 */
export interface MemorySessionHandoffLocal {
  id: string;
  cwd: string | null;
  owner_user: string | null;
  accepted_by_user: string | null;
}

/** What `readBridgeHandoffs` returns: the shareable handoffs and the local-only part, held apart (#734/D1, #735/D2). */
export interface MemoryBridgeHandoffsReading {
  handoffs: MemorySessionHandoff[];
  local: MemorySessionHandoffLocal[];
}

/** The handoffs a session opened; the accepted side is #737 (#734). */
export interface MemorySessionHandoffs {
  opened: MemorySessionHandoff[];
}

/** Reprojects the text of a `memory_handoff_list` result; a malformed one throws a code (#734/AC-2). */
export function readBridgeHandoffs(text: string): MemoryBridgeHandoffsReading {
  const check = checks('malformed-bridge');
  const rows = check.array(check.record(parseJson(text, 'malformed-bridge')).handoffs).map((item) => {
    const raw = check.record(item);
    const id = check.string(raw.id);
    return {
      handoff: {
        id,
        from_session_id: check.nullableString(raw.from_session_id),
        from_agent: check.string(raw.from_agent),
        to_agent: check.nullableString(raw.to_agent),
        state: check.oneOf(raw.state, HANDOFF_STATES),
        created_at: check.string(raw.created_at),
        accepted_by: check.nullableString(raw.accepted_by),
        accepted_at: check.nullableString(raw.accepted_at),
        accepted_by_session: check.nullableString(raw.accepted_by_session),
      },
      local: { id, cwd: check.nullableString(raw.cwd), owner_user: check.nullableString(raw.owner_user), accepted_by_user: check.nullableString(raw.accepted_by_user) },
    };
  });
  return { handoffs: rows.map((row) => row.handoff), local: rows.map((row) => row.local) };
}

/** The handoffs a session opened, matched by `from_session_id` only (#734/#719/AC-8). */
export function matchSession(handoffs: readonly MemorySessionHandoff[], sessionId: string): MemorySessionHandoffs {
  return { opened: handoffs.filter((handoff) => handoff.from_session_id === sessionId) };
}
