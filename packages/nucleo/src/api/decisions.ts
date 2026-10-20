// The session's decisions in the panel (issue #102, wireframes P9 and P10): the count on the
// "N decisões vigentes" line, the list by scope, Confirm and Dismiss of a suggested one, and (#131)
// Adjust (the right version, written by the person) and Undo of any of the three.
// Reads and writes only through the decisions port (src/decisions); the state and chain rules live there.
//
// Account (decision 0006): a decision from another session only comes in when its account is this
// one's, or when one of the two has no known account. The family is almost always a single account;
// the branch is not, and it is what this filter protects.

import type { Page, StoragePort } from '../storage-port.ts';
import type { Decision, DecisionOrigin, DecisionScope, DecisionState, Decider } from '../decisions/model.ts';
import type { DecisionPort, ListDecisionsQuery } from '../decisions/port.ts';
import { confirmDecision, decisionId, decisionLabel, discardDecision, familyOf, registerDecision, reopenDecision, revertDecision } from '../decisions/registry.ts';
import { cleanText, shortChoice } from '../decisions/text.ts';
import type { PanelDecision, PanelDecisions, PanelDecisionScope, PanelDecisionList } from './types.ts';

export const ESCOPOS_DAS_DECISOES: readonly PanelDecisionScope[] = ['session', 'family', 'branch'];

// The decision model (src/decisions) and its database keep the Portuguese values; the API answers
// English ones since #173 phase 2b. These tables are the only crossing.

/** The scope of a decision in the model → the API's (the item's `scope`, the list's, the counts). */
export const API_SCOPE: Readonly<Record<DecisionScope, PanelDecisionScope>> = { sessao: 'session', familia: 'family', branch: 'branch' };
const API_ORIGIN: Readonly<Record<DecisionOrigin, PanelDecision['origin']>> = {
  pergunta: 'question',
  plano: 'plan',
  permissao: 'permission',
  correcao: 'correction',
  sugerida: 'suggested',
};
const API_STATE = { vigente: 'current', substituida: 'superseded', a_confirmar: 'to_confirm', descartada: 'dismissed' } as const satisfies Partial<Record<DecisionState, PanelDecision['state']>>;
const API_DECIDER: Readonly<Record<Decider, PanelDecision['decidedBy']>> = { usuario: 'user', agente: 'agent' };
const API_ACTION: Readonly<Record<Exclude<AcaoNaDecisao, 'desfazer'>, NonNullable<PanelDecision['undo']>>> = { confirmar: 'confirm', descartar: 'dismiss', ajustar: 'adjust' };
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

export type AcaoNaDecisao = 'confirmar' | 'descartar' | 'ajustar' | 'desfazer';

/** Quem decidiu pelo painel e quando: fica em `metadata.painel` da decisão. */
export interface RegistroDoPainel {
  acao: Exclude<AcaoNaDecisao, 'desfazer'>;
  por: 'usuario';
  sessao: string;
  conta: string | null;
  em: string;
  /** O estado antes da ação, para o Desfazer voltar a ele. */
  antes?: Decision['state'];
  /** No Ajustar: a decisão nova, com o texto da pessoa. */
  nova?: string;
}

export class ErroDaDecisao extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
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

/** Vigentes e a confirmar: o que as contagens por escopo somam. */
const CONTAVEIS: readonly DecisionState[] = ['vigente', 'a_confirmar'];
const contaveis = (ds: readonly Decision[]) => ds.filter((d) => CONTAVEIS.includes(d.state)).length;

/** O rótulo ("D2") de uma decisão pelo id: das já lidas, ou da porta; `null` sem id ou sem a decisão. */
export async function rotuloPorId(port: DecisionPort, id: string | null, lidas: ReadonlyMap<string, Decision>): Promise<string | null> {
  if (!id) return null;
  const d = lidas.get(id) ?? (await port.getDecision(id));
  return d ? decisionLabel(d) : null;
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
   * - `session`: as desta sessão;
   * - `family`: as desta sessão e as de escopo família ou branch das outras da família;
   * - `branch`: as da família e as de escopo branch de outras famílias no mesmo branch e pasta.
   */
  async doEscopo(alvo: AlvoDasDecisoes, escopo: PanelDecisionScope, states: readonly DecisionState[] = NA_LISTA): Promise<Decision[]> {
    const porId = new Map<string, Decision>();
    for (const d of await todas(this.port, { sessionId: alvo.sessionId, states })) porId.set(d.id, d);
    if (escopo !== 'session') {
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

  /**
   * Vigentes e a confirmar em cada escopo. As do escopo pedido já vieram lidas (`doEscopo`, em
   * qualquer estado) e não são consultadas de novo.
   */
  async porEscopo(alvo: AlvoDasDecisoes, escopo: PanelDecisionScope, doEscopo: readonly Decision[]): Promise<Record<PanelDecisionScope, number>> {
    const out = {} as Record<PanelDecisionScope, number>;
    for (const e of ESCOPOS_DAS_DECISOES) out[e] = e === escopo ? contaveis(doEscopo) : (await this.doEscopo(alvo, e, CONTAVEIS)).length;
    return out;
  }

  /**
   * O branch e a pasta que a captura gravou nas decisões da própria sessão, para quando o ambiente
   * não diz o branch (a sessão que só a porta das decisões conhece, ou sem git à mão).
   */
  async gravadoNasProprias(sessionId: string): Promise<{ branch: string | null; repo: string | null }> {
    const proprias = (await this.port.listDecisions({ sessionId, limit: 50 })).items;
    const comBranch = proprias.find((d) => d.branch);
    return { branch: comBranch?.branch ?? null, repo: comBranch?.repo ?? proprias[0]?.repo ?? null };
  }

  /** A linha do painel e, quando pedida, a lista aberta. */
  async doPainel(alvo: AlvoDasDecisoes, escopo: PanelDecisionScope | null): Promise<PanelDecisions> {
    const familia = await this.doEscopo(alvo, 'family', ['vigente', 'a_confirmar']);
    return {
      current: familia.filter((d) => d.state === 'vigente').length,
      toConfirm: familia.filter((d) => d.state === 'a_confirmar').length,
      // A reinjeição (#100) ainda não grava o que injetou: a faixa do P10 acende com ela.
      resume: null,
      list: escopo ? await this.lista(alvo, escopo) : null,
    };
  }

  async lista(alvo: AlvoDasDecisoes, escopo: PanelDecisionScope): Promise<PanelDecisionList> {
    const todasDoEscopo = await this.doEscopo(alvo, escopo);
    const familyId = await familyOf(this.port, alvo.sessionId);
    const mae = (await this.port.getSessionLink(alvo.sessionId))?.parentSessionId ?? null;
    const lidas = new Map(todasDoEscopo.map((d) => [d.id, d]));
    const itens: PanelDecision[] = [];
    for (const d of todasDoEscopo.slice(0, MAX_ITENS)) itens.push(paraOPainel(d, alvo.sessionId, familyId, mae, await rotuloPorId(this.port, d.supersededBy, lidas)));
    const porEscopo = await this.porEscopo(alvo, escopo, todasDoEscopo);
    return {
      scope: escopo,
      current: todasDoEscopo.filter((d) => d.state === 'vigente').length,
      toConfirm: todasDoEscopo.filter((d) => d.state === 'a_confirmar').length,
      items: itens,
      byScope: porEscopo,
    };
  }

  /**
   * Confirma, descarta, ajusta ou desfaz, numa decisão que esta sessão enxerga (no escopo branch,
   * o mais largo), e registra quem decidiu e quando em `metadata.painel`:
   * - Confirmar e Descartar: só a sugerida (a confirmar);
   * - Ajustar: a sugerida ou a vigente ganha uma decisão nova, "correção sua", com o texto da pessoa,
   *   que a substitui no mesmo assunto;
   * - Desfazer: volta a decisão ao estado de antes da última ação do painel.
   */
  async decidir(alvo: AlvoDasDecisoes, id: string, acao: AcaoNaDecisao, agora: string, texto: string | null = null): Promise<PanelDecision> {
    const d = await this.port.getDecision(id);
    const visivel = d && (await this.doEscopo(alvo, 'branch', ['a_confirmar', d.state])).some((x) => x.id === id);
    if (!d || !visivel) throw new ErroDaDecisao(404, 'decisão não encontrada nesta sessão');
    let feita: Decision;
    if (acao === 'desfazer') feita = await this.desfazer(d, agora);
    else if (acao === 'ajustar') feita = await this.ajustar(alvo, d, texto, agora);
    else {
      if (d.state !== 'a_confirmar') throw new ErroDaDecisao(409, `a decisão já não está a confirmar (${d.state})`);
      const registro: RegistroDoPainel = { acao, por: 'usuario', sessao: alvo.sessionId, conta: alvo.contaId, em: agora, antes: d.state };
      await this.port.putDecision({ ...d, metadata: { ...d.metadata, painel: registro }, updatedAt: agora });
      feita = acao === 'confirmar' ? await confirmDecision(this.port, id, agora) : await discardDecision(this.port, id, agora);
    }
    return this.paraOPainel(alvo, feita);
  }

  private async paraOPainel(alvo: AlvoDasDecisoes, d: Decision): Promise<PanelDecision> {
    const familyId = await familyOf(this.port, alvo.sessionId);
    const mae = (await this.port.getSessionLink(alvo.sessionId))?.parentSessionId ?? null;
    const nova = d.supersededBy ? await this.port.getDecision(d.supersededBy) : null;
    return paraOPainel(d, alvo.sessionId, familyId, mae, nova ? decisionLabel(nova) : null);
  }

  private async ajustar(alvo: AlvoDasDecisoes, d: Decision, texto: string | null, agora: string): Promise<Decision> {
    const escrito = cleanText(texto);
    if (!escrito) throw new ErroDaDecisao(400, 'escreva o ajuste: { "text": "…" }');
    if (d.state !== 'a_confirmar' && d.state !== 'vigente') throw new ErroDaDecisao(409, `só a sugerida ou a vigente é ajustada (${d.state})`);
    // A original e o ajuste ficam no mesmo assunto: o ajuste a substitui, e o Desfazer a devolve.
    const topic = d.topic ?? `ajuste:${d.id}`;
    const sourceKey = `painel:${d.id}:${agora}`;
    const registro: RegistroDoPainel = {
      acao: 'ajustar', por: 'usuario', sessao: alvo.sessionId, conta: alvo.contaId, em: agora, antes: d.state, nova: decisionId(alvo.sessionId, sourceKey),
    };
    await this.port.putDecision({ ...d, topic, metadata: { ...d.metadata, painel: registro }, updatedAt: agora });
    await registerDecision(
      this.port,
      {
        sessionId: alvo.sessionId,
        agentId: null,
        repo: d.repo,
        branch: d.branch,
        sourceKey,
        topic,
        context: d.choice,
        choice: shortChoice(escrito),
        alternatives: [d.choice],
        decidedBy: 'usuario',
        origin: 'correcao',
        inferred: false,
        scope: d.scope,
        message: { uuid: null, toolUseId: null, transcriptPath: null },
        decidedAt: agora,
        metadata: { texto: escrito, ajusteDe: d.id },
      },
      agora,
    );
    // A sugerida entra na cadeia já com o ajuste depois dela: fica substituída por ele.
    if (d.state === 'a_confirmar') await confirmDecision(this.port, d.id, agora);
    return (await this.port.getDecision(d.id)) ?? d;
  }

  private async desfazer(d: Decision, agora: string): Promise<Decision> {
    const feito = d.metadata?.painel as RegistroDoPainel | undefined;
    if (!feito?.acao) throw new ErroDaDecisao(409, 'nada a desfazer nesta decisão');
    if (feito.acao === 'ajustar' && feito.nova) {
      const nova = await this.port.getDecision(feito.nova);
      if (nova?.state === 'vigente') await revertDecision(this.port, nova.id, agora);
    }
    const atual = (await this.port.getDecision(d.id)) ?? d;
    if (feito.antes === 'a_confirmar' && atual.state !== 'a_confirmar') {
      if (atual.state !== 'vigente' && atual.state !== 'descartada') throw new ErroDaDecisao(409, `já não dá para desfazer (${atual.state})`);
      await reopenDecision(this.port, d.id, agora);
    }
    const depois = (await this.port.getDecision(d.id)) ?? atual;
    const { painel: _, ...metadata } = depois.metadata ?? {};
    const desfeita = { ...depois, metadata: { ...metadata, painelDesfeito: { ...feito, desfeitoEm: agora } }, updatedAt: agora };
    await this.port.putDecision(desfeita);
    return desfeita;
  }
}

/** A decisão como o card a desenha, relativa à sessão `sessionId` (a aba e a página da /ui também usam). */
export function paraOPainel(d: Decision, sessionId: string, familyId: string, mae: string | null, substituidaPor: string | null): PanelDecision {
  const painel = d.metadata?.painel as Partial<RegistroDoPainel> | undefined;
  return {
    id: d.id,
    label: decisionLabel(d),
    origin: API_ORIGIN[d.origin],
    state: API_STATE[d.state === 'substituida' || d.state === 'a_confirmar' || d.state === 'descartada' ? d.state : 'vigente'],
    title: d.choice,
    text: typeof d.metadata?.texto === 'string' ? d.metadata.texto : d.choice,
    context: d.context,
    undo: painel?.acao ? API_ACTION[painel.acao] : null,
    rejected: d.alternatives,
    decidedBy: API_DECIDER[d.decidedBy],
    decidedAt: d.decidedAt,
    confirmedAt: painel?.acao === 'confirmar' && typeof painel.em === 'string' ? painel.em : null,
    supersededBy: substituidaPor,
    session: d.sessionId === sessionId ? 'this' : d.sessionId === mae ? 'parent' : d.familyId === familyId ? 'family' : 'branch',
    toolUseId: d.sessionId === sessionId ? d.message.toolUseId : null,
  };
}
