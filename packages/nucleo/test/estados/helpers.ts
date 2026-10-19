import type { Agent, Session, SessionEvent } from '../../src/model.ts';
import type { EstadoDaSessao } from '../../src/estados/index.ts';
import { agent, at, session } from '../fixtures.ts';

export const SID = 's1';
export const MAIN = `${SID}:main`;

export function principal(over: Partial<Agent> = {}): Agent {
  return agent({ id: MAIN, sessionId: SID, type: 'main', status: 'working', ...over });
}

export function sub(id: string, over: Partial<Agent> = {}): Agent {
  return agent({ id: `${SID}:${id}`, sessionId: SID, type: 'subagent', name: id, parentAgentId: MAIN, status: 'working', ...over });
}

export function estado(s: Partial<Session> = {}, agentes: Agent[] = [principal()]): EstadoDaSessao {
  return { session: session({ id: SID, ...s }), agentes };
}

let seq = 0;
/** Evento de hook (ou do transcript, pelo tipo) no minuto `min` depois de T0. */
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

export function main(e: EstadoDaSessao): Agent {
  const p = e.agentes.find((a) => a.type === 'main');
  if (!p) throw new Error('sem agente principal');
  return p;
}
