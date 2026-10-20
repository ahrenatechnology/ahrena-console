// As decisões da sessão no painel (issue #102, wireframes P9 e P10): a contagem da linha
// "N decisões vigentes", a lista por escopo, o Confirmar e o Descartar de uma sugerida, e (#131)
// o Ajustar (a versão certa, escrita pela pessoa) e o Desfazer de qualquer um dos três.
// Lê e escreve só pela porta das decisões (src/decisoes); as regras de estado e da cadeia são de lá.
//
// Conta (decisão 0006): uma decisão de outra sessão só entra quando a conta dela é a desta,
// ou quando uma das duas não tem conta conhecida. A família quase sempre é de uma conta só;
// o branch não, e é ele que este filtro protege.

import type { Page, StoragePort } from '../storage-port.ts';
import type { Decision, DecisionState } from '../decisoes/modelo.ts';
import type { DecisionPort, ListDecisionsQuery } from '../decisoes/porta.ts';
import { confirmDecision, decisionId, decisionLabel, discardDecision, familyOf, registerDecision, reopenDecision, revertDecision } from '../decisoes/registro.ts';
import { cleanText, shortChoice } from '../decisoes/texto.ts';
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
    const porEscopo = {} as Record<EscopoDasDecisoes, number>;
    for (const e of ['sessao', 'familia', 'branch'] as const) {
      porEscopo[e] = e === escopo ? todasDoEscopo.filter((d) => d.state === 'vigente' || d.state === 'a_confirmar').length : (await this.doEscopo(alvo, e, ['vigente', 'a_confirmar'])).length;
    }
    return {
      escopo,
      vigentes: todasDoEscopo.filter((d) => d.state === 'vigente').length,
      aConfirmar: todasDoEscopo.filter((d) => d.state === 'a_confirmar').length,
      itens,
      porEscopo,
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
  async decidir(alvo: AlvoDasDecisoes, id: string, acao: AcaoNaDecisao, agora: string, texto: string | null = null): Promise<DecisaoDoPainel> {
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

  private async paraOPainel(alvo: AlvoDasDecisoes, d: Decision): Promise<DecisaoDoPainel> {
    const familyId = await familyOf(this.port, alvo.sessionId);
    const mae = (await this.port.getSessionLink(alvo.sessionId))?.parentSessionId ?? null;
    const nova = d.supersededBy ? await this.port.getDecision(d.supersededBy) : null;
    return paraOPainel(d, alvo.sessionId, familyId, mae, nova ? decisionLabel(nova) : null);
  }

  private async ajustar(alvo: AlvoDasDecisoes, d: Decision, texto: string | null, agora: string): Promise<Decision> {
    const escrito = cleanText(texto);
    if (!escrito) throw new ErroDaDecisao(400, 'escreva o ajuste: { "texto": "…" }');
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

function paraOPainel(d: Decision, sessionId: string, familyId: string, mae: string | null, substituidaPor: string | null): DecisaoDoPainel {
  const painel = d.metadata?.painel as Partial<RegistroDoPainel> | undefined;
  return {
    id: d.id,
    rotulo: decisionLabel(d),
    origem: d.origin,
    estado: d.state === 'substituida' || d.state === 'a_confirmar' || d.state === 'descartada' ? d.state : 'vigente',
    titulo: d.choice,
    texto: typeof d.metadata?.texto === 'string' ? d.metadata.texto : d.choice,
    contexto: d.context,
    desfazer: painel?.acao ?? null,
    nao: d.alternatives,
    decididaPor: d.decidedBy,
    decididaEm: d.decidedAt,
    confirmadaEm: painel?.acao === 'confirmar' && typeof painel.em === 'string' ? painel.em : null,
    substituidaPor,
    sessao: d.sessionId === sessionId ? 'esta' : d.sessionId === mae ? 'mae' : d.familyId === familyId ? 'familia' : 'branch',
    toolUseId: d.sessionId === sessionId ? d.message.toolUseId : null,
  };
}
