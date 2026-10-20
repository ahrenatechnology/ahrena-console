// De onde vêm as mudanças: as gravações pelas portas e a máquina de estados.
//
// - `comMudancas(storage, cursor)` embrulha a porta (Proxy): `putSession`, `putPlan` e `putAccount`
//   registram uma mudança depois de gravar; o resto passa direto (inclusive `db` do SQLite).
//   `putSession` só registra quando muda um campo que as telas mostram (`camposVisiveis`): todo hook
//   grava a sessão para avançar o `updatedAt`, e isso sozinho não acorda ninguém. Atividade nova
//   (eventos) não é mudança: estado, plano e decisões têm os seus tipos.
// - `putAgent` registra `session` (da sessão do agente) quando muda o que o Kanban mostra do agente
//   (`camposVisiveisDoAgente`): um subagente que começa ou termina mexe na visão Agentes (#31).
// - `decisoesComMudancas(porta, cursor, contaDe)` faz o mesmo com `putDecision`.
// - `aoMudarDaMaquina(cursor, contaDe)` vai no `aoMudar` da máquina: registra `state` e, quando
//   entra ou sai do inbox, `needs-you`.
//
// A conta de cada sessão vem de `ContasDasSessoes`: aprendida em cada `putSession`, e só lida da porta
// quando a sessão ainda não passou por aqui.

import type { Mudanca as MudancaDaMaquina } from '../estados/maquina.ts';
import type { EstadoDoInbox } from '../estados/leitura.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import type { Agent, Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { CursorDeMudancas } from './cursor.ts';

/** O que as telas mostram da sessão. Fica de fora o que muda a cada hook: `updatedAt` e `metadata`. */
export function camposVisiveis(s: Session): string {
  return JSON.stringify([s.name, s.status, s.cwd, s.model, s.endedAt, s.awaitingInputSince, s.awaitingReason, s.accountId]);
}

/** O que as telas mostram do agente: entra, muda de status ou termina. */
export function camposVisiveisDoAgente(a: Agent): string {
  return JSON.stringify([a.type, a.status, a.name, a.subagentType, a.task, a.endedAt]);
}

export class ContasDasSessoes {
  private readonly contas = new Map<string, string | null>();
  /** `camposVisiveis` da última gravação de cada sessão, para saber se a próxima muda algo. */
  readonly vistas = new Map<string, string>();
  /** O mesmo para os agentes, pela chave `<sessão>\0<agente>`. */
  readonly agentesVistos = new Map<string, string>();
  private readonly storage: Pick<StoragePort, 'getSession'>;

  constructor(storage: Pick<StoragePort, 'getSession'>) {
    this.storage = storage;
  }

  aprender(sessionId: string, accountId: string | null): void {
    this.contas.set(sessionId, accountId);
  }

  async de(sessionId: string): Promise<string | null> {
    if (this.contas.has(sessionId)) return this.contas.get(sessionId) ?? null;
    const s = await this.storage.getSession(sessionId).catch(() => null);
    const conta = s?.accountId ?? null;
    if (s) this.contas.set(sessionId, conta);
    return conta;
  }
}

export function comMudancas<T extends StoragePort>(storage: T, cursor: CursorDeMudancas, contas = new ContasDasSessoes(storage)): T {
  const embrulhos: Partial<StoragePort> = {
    async putSession(session) {
      await storage.putSession(session);
      contas.aprender(session.id, session.accountId);
      const visivel = camposVisiveis(session);
      if (contas.vistas.get(session.id) === visivel) return;
      contas.vistas.set(session.id, visivel);
      cursor.registrar({ type: 'session', key: session.id, sessionId: session.id, accountId: session.accountId });
    },
    async putAgent(agent) {
      await storage.putAgent(agent);
      const chave = `${agent.sessionId}\0${agent.id}`;
      const visivel = camposVisiveisDoAgente(agent);
      if (contas.agentesVistos.get(chave) === visivel) return;
      contas.agentesVistos.set(chave, visivel);
      const accountId = await contas.de(agent.sessionId);
      cursor.registrar({ type: 'session', key: agent.sessionId, sessionId: agent.sessionId, accountId });
    },
    async putPlan(plan) {
      await storage.putPlan(plan);
      const accountId = await contas.de(plan.sessionId);
      cursor.registrar({ type: 'plan', key: plan.sessionId, sessionId: plan.sessionId, accountId });
    },
    async putAccount(account) {
      await storage.putAccount(account);
      cursor.registrar({ type: 'account', key: account.id, sessionId: null, accountId: account.id });
    },
  };
  return new Proxy(storage, {
    get(alvo, prop, receptor) {
      if (typeof prop === 'string' && Object.hasOwn(embrulhos, prop)) return embrulhos[prop as keyof StoragePort];
      const v = Reflect.get(alvo, prop, receptor);
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
}

export function decisoesComMudancas<T extends DecisionPort>(porta: T, cursor: CursorDeMudancas, contas: ContasDasSessoes): T {
  const putDecision: DecisionPort['putDecision'] = async (d) => {
    await porta.putDecision(d);
    const accountId = await contas.de(d.sessionId);
    cursor.registrar({ type: 'decision', key: d.id, sessionId: d.sessionId, accountId });
  };
  return new Proxy(porta, {
    get(alvo, prop, receptor) {
      if (prop === 'putDecision') return putDecision;
      const v = Reflect.get(alvo, prop, receptor);
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
}

/** Entra no inbox: esperando você, ou em erro (o mesmo de `lerInbox().precisaDeVoce`). */
const noInbox = (e: EstadoDoInbox) => e === 'waiting' || e === 'error';

export function aoMudarDaMaquina(cursor: CursorDeMudancas, contas: ContasDasSessoes): (m: MudancaDaMaquina) => void {
  return (m) => {
    // A máquina chama de forma síncrona; a conta quase sempre já está no mapa (a máquina acabou de gravar).
    void contas.de(m.sessionId).then((accountId) => {
      cursor.registrar({ type: 'state', key: m.sessionId, sessionId: m.sessionId, accountId });
      if (noInbox(m.antes) !== noInbox(m.depois)) {
        cursor.registrar({ type: 'needs-you', key: m.sessionId, sessionId: m.sessionId, accountId });
      }
    });
  };
}
