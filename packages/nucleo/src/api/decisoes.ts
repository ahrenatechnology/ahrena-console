// As decisões da sessão no painel (issue #102, wireframes P9 e P10): a contagem da linha
// "N decisões vigentes", a lista por escopo e o Confirmar e o Descartar de uma sugerida.
// Lê e escreve só pela porta das decisões (src/decisoes); as regras de estado e da cadeia são de lá.
//
// Conta (decisão 0006): uma decisão de outra sessão só entra quando a conta dela é a desta,
// ou quando uma das duas não tem conta conhecida. A família quase sempre é de uma conta só;
// o branch não, e é ele que este filtro protege.

import type { Page, StoragePort } from '../storage-port.ts';
import type { Decision, DecisionState } from '../decisoes/modelo.ts';
import type { DecisionPort, ListDecisionsQuery } from '../decisoes/porta.ts';
import { confirmDecision, decisionLabel, discardDecision, familyOf } from '../decisoes/registro.ts';
import type { DecisaoDoPainel, DecisoesDoPainel, EscopoDasDecisoes, ListaDeDecisoes } from './tipos.ts';

export const ESCOPOS_DAS_DECISOES: readonly EscopoDasDecisoes[] = ['sessao', 'familia', 'branch'];
/** O que a lista mostra; descartada e revertida ficam no histórico. */
const NA_LISTA: readonly DecisionState[] = ['vigente', 'a_confirmar', 'substituida'];
/** Cards na lista: o largo mostra até 4 linhas de 3; o estreito, menos. */
const MAX_ITENS = 12;

/** A sessão a que as decisões se referem: o id, o branch, a pasta e a conta. */
export interface AlvoDasDecisoes {
  sessionId: string;
  branch: string | null;
  repo: string | null;
  /** `<accountUuid>/<organizationUuid>` da sessão, ou `null` ("sem conta"). */
  contaId: string | null;
}

export type AcaoNaDecisao = 'confirmar' | 'descartar';

/** Quem decidiu pelo painel e quando: fica em `metadata.painel` da decisão. */
export interface RegistroDoPainel {
  acao: AcaoNaDecisao;
  por: 'usuario';
  sessao: string;
  conta: string | null;
  em: string;
}

export class ErroDaDecisao extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'ErroDaDecisao';
    this.status = status;
  }
}

async function todas(port: DecisionPort, query: ListDecisionsQuery): Promise<Decision[]> {
  const out: Decision[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Decision> = await port.listDecisions({ ...query, limit: 500, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const maisRecentes = (a: Decision, b: Decision) => (a.decidedAt === b.decidedAt ? b.seq - a.seq : a.decidedAt < b.decidedAt ? 1 : -1);

export class DecisoesDaSessao {
  private readonly port: DecisionPort;
  private readonly storage: StoragePort;
  private readonly contasDeSessao = new Map<string, string | null>();

  constructor(opts: { decisions: DecisionPort; storage: StoragePort }) {
    this.port = opts.decisions;
    this.storage = opts.storage;
  }

  /** A conta gravada de outra sessão; guardada, porque a conta de uma sessão não volta atrás. */
  private async contaDe(sessionId: string): Promise<string | null> {
    if (this.contasDeSessao.has(sessionId)) return this.contasDeSessao.get(sessionId)!;
    const conta = (await this.storage.getSession(sessionId))?.accountId ?? null;
    if (conta) this.contasDeSessao.set(sessionId, conta);
    return conta;
  }

  private async mesmaConta(alvo: AlvoDasDecisoes, d: Decision): Promise<boolean> {
    if (d.sessionId === alvo.sessionId || !alvo.contaId) return true;
    const outra = await this.contaDe(d.sessionId);
    return !outra || outra === alvo.contaId;
  }

  /**
   * As decisões do escopo, nos estados pedidos, mais recentes primeiro:
   * - `sessao`: as desta sessão;
   * - `familia`: as desta sessão e as de escopo família ou branch das outras da família;
   * - `branch`: as da família e as de escopo branch de outras famílias no mesmo branch e pasta.
   */
  async doEscopo(alvo: AlvoDasDecisoes, escopo: EscopoDasDecisoes, states: readonly DecisionState[] = NA_LISTA): Promise<Decision[]> {
    const porId = new Map<string, Decision>();
    for (const d of await todas(this.port, { sessionId: alvo.sessionId, states })) porId.set(d.id, d);
    if (escopo !== 'sessao') {
      const familyId = await familyOf(this.port, alvo.sessionId);
      for (const d of await todas(this.port, { familyId, states })) if (d.scope !== 'sessao') porId.set(d.id, d);
    }
    if (escopo === 'branch' && alvo.branch) {
      for (const d of await todas(this.port, { branch: alvo.branch, repo: alvo.repo, states })) if (d.scope === 'branch') porId.set(d.id, d);
    }
    const out: Decision[] = [];
    for (const d of porId.values()) if (await this.mesmaConta(alvo, d)) out.push(d);
    return out.sort(maisRecentes);
  }

  /** A linha do painel e, quando pedida, a lista aberta. */
  async doPainel(alvo: AlvoDasDecisoes, escopo: EscopoDasDecisoes | null): Promise<DecisoesDoPainel> {
    const familia = await this.doEscopo(alvo, 'familia', ['vigente', 'a_confirmar']);
    return {
      vigentes: familia.filter((d) => d.state === 'vigente').length,
      aConfirmar: familia.filter((d) => d.state === 'a_confirmar').length,
      // A reinjeição (#100) ainda não grava o que injetou: a faixa do P10 acende com ela.
      retomada: null,
      lista: escopo ? await this.lista(alvo, escopo) : null,
    };
  }

  async lista(alvo: AlvoDasDecisoes, escopo: EscopoDasDecisoes): Promise<ListaDeDecisoes> {
    const todasDoEscopo = await this.doEscopo(alvo, escopo);
    const familyId = await familyOf(this.port, alvo.sessionId);
    const mae = (await this.port.getSessionLink(alvo.sessionId))?.parentSessionId ?? null;
    const rotulos = new Map(todasDoEscopo.map((d) => [d.id, decisionLabel(d)]));
    const itens: DecisaoDoPainel[] = [];
    for (const d of todasDoEscopo.slice(0, MAX_ITENS)) {
      let substituidaPor: string | null = null;
      if (d.supersededBy) {
        const nova = rotulos.has(d.supersededBy) ? null : await this.port.getDecision(d.supersededBy);
        substituidaPor = rotulos.get(d.supersededBy) ?? (nova ? decisionLabel(nova) : null);
      }
      itens.push(paraOPainel(d, alvo.sessionId, familyId, mae, substituidaPor));
    }
    return {
      escopo,
      vigentes: todasDoEscopo.filter((d) => d.state === 'vigente').length,
      aConfirmar: todasDoEscopo.filter((d) => d.state === 'a_confirmar').length,
      itens,
    };
  }

  /**
   * Confirma ou descarta uma sugerida que esta sessão enxerga (no escopo branch, o mais largo) e
   * registra quem decidiu e quando em `metadata.painel`.
   */
  async decidir(alvo: AlvoDasDecisoes, id: string, acao: AcaoNaDecisao, agora: string): Promise<DecisaoDoPainel> {
    const d = await this.port.getDecision(id);
    const visivel = d && (await this.doEscopo(alvo, 'branch', ['a_confirmar', d.state])).some((x) => x.id === id);
    if (!d || !visivel) throw new ErroDaDecisao(404, 'decisão não encontrada nesta sessão');
    if (d.state !== 'a_confirmar') throw new ErroDaDecisao(409, `a decisão já não está a confirmar (${d.state})`);
    const registro: RegistroDoPainel = { acao, por: 'usuario', sessao: alvo.sessionId, conta: alvo.contaId, em: agora };
    await this.port.putDecision({ ...d, metadata: { ...d.metadata, painel: registro }, updatedAt: agora });
    const feita = acao === 'confirmar' ? await confirmDecision(this.port, id, agora) : await discardDecision(this.port, id, agora);
    const familyId = await familyOf(this.port, alvo.sessionId);
    const mae = (await this.port.getSessionLink(alvo.sessionId))?.parentSessionId ?? null;
    return paraOPainel(feita, alvo.sessionId, familyId, mae, null);
  }
}

function paraOPainel(d: Decision, sessionId: string, familyId: string, mae: string | null, substituidaPor: string | null): DecisaoDoPainel {
  const painel = d.metadata?.painel as Partial<RegistroDoPainel> | undefined;
  return {
    id: d.id,
    rotulo: decisionLabel(d),
    origem: d.origin,
    estado: d.state === 'substituida' || d.state === 'a_confirmar' ? d.state : 'vigente',
    titulo: d.choice,
    nao: d.alternatives,
    decididaPor: d.decidedBy,
    decididaEm: d.decidedAt,
    confirmadaEm: painel?.acao === 'confirmar' && typeof painel.em === 'string' ? painel.em : null,
    substituidaPor,
    sessao: d.sessionId === sessionId ? 'esta' : d.sessionId === mae ? 'mae' : d.familyId === familyId ? 'familia' : 'branch',
    toolUseId: d.sessionId === sessionId ? d.message.toolUseId : null,
  };
}
