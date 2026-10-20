// The session's decisions in the panel (issue #102, wireframes P9 and P10): the count on the
// "N decisões vigentes" line, the list by scope, Confirm and Dismiss of a suggested one, and (#131)
// Adjust (the right version, written by the person) and Undo of any of the three.
// Reads and writes only through the decisions port (src/decisions); the state and chain rules live there.
//
// Account (decision 0006): a decision from another session only comes in when its account is this
// one's, or when one of the two has no known account. The family is almost always a single account;
// the branch is not, and it is what this filter protects.

import type { Page, StoragePort } from '../storage-port.ts';
import type { Decision, DecisionState } from '../decisions/model.ts';
import type { DecisionPort, ListDecisionsQuery } from '../decisions/port.ts';
import { confirmDecision, decisionId, decisionLabel, discardDecision, familyOf, registerDecision, reopenDecision, revertDecision } from '../decisions/registry.ts';
import { cleanText, shortChoice } from '../decisions/text.ts';
import type { PanelDecision, PanelDecisions, PanelDecisionScope, PanelDecisionList } from './types.ts';

export const ESCOPOS_DAS_DECISOES: readonly PanelDecisionScope[] = ['session', 'family', 'branch'];

// The decision model (src/decisions), its database and the API share the English values since #173
// phase 5. The one difference: a reverted decision is shown as `current` (it never reaches the list).

/** The state of a decision as the API shows it. */
const apiState = (s: DecisionState): PanelDecision['state'] => (s === 'reverted' ? 'current' : s);
/** O que a lista mostra; descartada e revertida ficam no histórico. */
const NA_LISTA: readonly DecisionState[] = ['current', 'to_confirm', 'superseded'];
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

export type AcaoNaDecisao = 'confirm' | 'dismiss' | 'adjust' | 'undo';

/** Who decided through the panel and when: kept in the decision's `metadata.panel`. */
export interface RegistroDoPainel {
  action: Exclude<AcaoNaDecisao, 'undo'>;
  by: 'user';
  session: string;
  account: string | null;
  at: string;
  /** The state before the action, for Undo to go back to. */
  before?: Decision['state'];
  /** On Adjust: the new decision, with the person's text. */
  new?: string;
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
const CONTAVEIS: readonly DecisionState[] = ['current', 'to_confirm'];
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
      for (const d of await todas(this.port, { familyId, states })) if (d.scope !== 'session') porId.set(d.id, d);
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
    const familia = await this.doEscopo(alvo, 'family', ['current', 'to_confirm']);
    return {
      current: familia.filter((d) => d.state === 'current').length,
      toConfirm: familia.filter((d) => d.state === 'to_confirm').length,
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
      current: todasDoEscopo.filter((d) => d.state === 'current').length,
      toConfirm: todasDoEscopo.filter((d) => d.state === 'to_confirm').length,
      items: itens,
      byScope: porEscopo,
    };
  }

  /**
   * Confirma, descarta, ajusta ou desfaz, numa decisão que esta sessão enxerga (no escopo branch,
   * o mais largo), e registra quem decidiu e quando em `metadata.panel`:
   * - Confirmar e Descartar: só a sugerida (a confirmar);
   * - Ajustar: a sugerida ou a vigente ganha uma decisão nova, "correção sua", com o texto da pessoa,
   *   que a substitui no mesmo assunto;
   * - Desfazer: volta a decisão ao estado de antes da última ação do painel.
   */
  async decidir(alvo: AlvoDasDecisoes, id: string, acao: AcaoNaDecisao, agora: string, texto: string | null = null): Promise<PanelDecision> {
    const d = await this.port.getDecision(id);
    const visivel = d && (await this.doEscopo(alvo, 'branch', ['to_confirm', d.state])).some((x) => x.id === id);
    if (!d || !visivel) throw new ErroDaDecisao(404, 'decisão não encontrada nesta sessão');
    let feita: Decision;
    if (acao === 'undo') feita = await this.desfazer(d, agora);
    else if (acao === 'adjust') feita = await this.ajustar(alvo, d, texto, agora);
    else {
      if (d.state !== 'to_confirm') throw new ErroDaDecisao(409, `a decisão já não está a confirmar (${d.state})`);
      const registro: RegistroDoPainel = { action: acao, by: 'user', session: alvo.sessionId, account: alvo.contaId, at: agora, before: d.state };
      await this.port.putDecision({ ...d, metadata: { ...d.metadata, panel: registro }, updatedAt: agora });
      feita = acao === 'confirm' ? await confirmDecision(this.port, id, agora) : await discardDecision(this.port, id, agora);
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
    if (d.state !== 'to_confirm' && d.state !== 'current') throw new ErroDaDecisao(409, `só a sugerida ou a vigente é ajustada (${d.state})`);
    // A original e o ajuste ficam no mesmo assunto: o ajuste a substitui, e o Desfazer a devolve.
    const topic = d.topic ?? `adjust:${d.id}`;
    // The `painel:` prefix stays: the source key is hashed into the new decision's id, which the API answers.
    const sourceKey = `painel:${d.id}:${agora}`;
    const registro: RegistroDoPainel = {
      action: 'adjust', by: 'user', session: alvo.sessionId, account: alvo.contaId, at: agora, before: d.state, new: decisionId(alvo.sessionId, sourceKey),
    };
    await this.port.putDecision({ ...d, topic, metadata: { ...d.metadata, panel: registro }, updatedAt: agora });
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
        decidedBy: 'user',
        origin: 'correction',
        inferred: false,
        scope: d.scope,
        message: { uuid: null, toolUseId: null, transcriptPath: null },
        decidedAt: agora,
        metadata: { text: escrito, adjustedFrom: d.id },
      },
      agora,
    );
    // A sugerida entra na cadeia já com o ajuste depois dela: fica substituída por ele.
    if (d.state === 'to_confirm') await confirmDecision(this.port, d.id, agora);
    return (await this.port.getDecision(d.id)) ?? d;
  }

  private async desfazer(d: Decision, agora: string): Promise<Decision> {
    const feito = d.metadata?.panel as RegistroDoPainel | undefined;
    if (!feito?.action) throw new ErroDaDecisao(409, 'nada a desfazer nesta decisão');
    if (feito.action === 'adjust' && feito.new) {
      const nova = await this.port.getDecision(feito.new);
      if (nova?.state === 'current') await revertDecision(this.port, nova.id, agora);
    }
    const atual = (await this.port.getDecision(d.id)) ?? d;
    if (feito.before === 'to_confirm' && atual.state !== 'to_confirm') {
      if (atual.state !== 'current' && atual.state !== 'dismissed') throw new ErroDaDecisao(409, `já não dá para desfazer (${atual.state})`);
      await reopenDecision(this.port, d.id, agora);
    }
    const depois = (await this.port.getDecision(d.id)) ?? atual;
    const { panel: _, ...metadata } = depois.metadata ?? {};
    const desfeita = { ...depois, metadata: { ...metadata, panelUndone: { ...feito, undoneAt: agora } }, updatedAt: agora };
    await this.port.putDecision(desfeita);
    return desfeita;
  }
}

/** A decisão como o card a desenha, relativa à sessão `sessionId` (a aba e a página da /ui também usam). */
export function paraOPainel(d: Decision, sessionId: string, familyId: string, mae: string | null, substituidaPor: string | null): PanelDecision {
  const painel = d.metadata?.panel as Partial<RegistroDoPainel> | undefined;
  return {
    id: d.id,
    label: decisionLabel(d),
    origin: d.origin,
    state: apiState(d.state),
    title: d.choice,
    text: typeof d.metadata?.text === 'string' ? d.metadata.text : d.choice,
    context: d.context,
    undo: painel?.action ?? null,
    rejected: d.alternatives,
    decidedBy: d.decidedBy,
    decidedAt: d.decidedAt,
    confirmedAt: painel?.action === 'confirm' && typeof painel.at === 'string' ? painel.at : null,
    supersededBy: substituidaPor,
    session: d.sessionId === sessionId ? 'this' : d.sessionId === mae ? 'parent' : d.familyId === familyId ? 'family' : 'branch',
    toolUseId: d.sessionId === sessionId ? d.message.toolUseId : null,
  };
}
