import type { Agent, Session, SessionEvent } from '../../src/model.ts';
import type { SessionState } from '../../src/states/index.ts';
import { agent, at, session } from '../fixtures.ts';

export const SID = 's1';
export const MAIN = `${SID}:main`;

export function mainAgent(over: Partial<Agent> = {}): Agent {
  return agent({ id: MAIN, sessionId: SID, type: 'main', status: 'working', ...over });
}

export function sub(id: string, over: Partial<Agent> = {}): Agent {
  return agent({ id: `${SID}:${id}`, sessionId: SID, type: 'subagent', name: id, parentAgentId: MAIN, status: 'working', ...over });
}

export function state(s: Partial<Session> = {}, agents: Agent[] = [mainAgent()]): SessionState {
  return { session: session({ id: SID, ...s }), agents };
}

let seq = 0;
/** Hook event (or transcript event, by its type) at minute `min` after T0. */
export function ev(type: string, min: number, over: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: `hook:${type}-${min}-${++seq}`,
    sessionId: SID,
    agentId: null,
    type,
    toolName: null,
    summary: null,
    data: null,
    createdAt: at(min),
    ...over,
  };
}

export function main(e: SessionState): Agent {
  const p = e.agents.find((a) => a.type === 'main');
  if (!p) throw new Error('no main agent');
  return p;
}
