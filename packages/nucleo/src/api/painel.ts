// Monta a resposta de `GET /api/panel/<session>` (4.1, 4.2, 4.3 e 4.8): esta sessão, o que roda
// dentro dela, o trabalho pelo branch, a conta e quem precisa de você em todas as contas.
//
// Tudo sai do banco e de caches em memória: nenhum pedido varre transcripts (decisão 0004).
// - os eventos de cada sessão são lidos de forma incremental (resumo.ts);
// - custo e tokens são recalculados no máximo a cada `custoMs` por sessão;
// - "precisam de você" é uma consulta por índice (espera e erro), guardada por `precisamMs` e
//   dividida entre todos os painéis abertos;
// - o índice do Desktop e o arquivo de rótulos são conferidos no máximo a cada 30 s;
// - o GitHub e o git respondem por trás, nunca no caminho do pedido (trabalho.ts).

import { basename } from 'node:path';
import { parcelasDaSessao, relatorioDeCusto } from '../custo/agregacao.ts';
import { precosVigentes } from '../custo/tabela.ts';
import { readInbox, type InboxReading } from '../states/inbox.ts';
import { readMemory, mainAgentOf } from '../states/rules.ts';
import type { Agent, Session } from '../model.ts';
import { effectiveTokens } from '../pricing.ts';
import type { PlanOwner, PlanRecord, SessionPlan } from '../plano/modelo.ts';
import { LONG_WINDOW, DEFAULT_WINDOW } from '../context/window.ts';
import { contextAlert, contextPct, contextLabel, type ContextMeter } from '../context/model.ts';
import type { ListSessionsQuery, StoragePort } from '../storage-port.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import type { Contas } from './contas.ts';
import { DecisoesDaSessao, type AcaoNaDecisao, type AlvoDasDecisoes } from './decisoes.ts';
import type { IndiceDoDesktop, SessaoDoDesktop } from './indice-desktop.ts';
import { ResumosDeSessao, iniciosDosTurnos, type ResumoDosEventos } from './resumo.ts';
import { atencaoDe, type MotivoDaAtencao, type NivelDeAtencao } from './atencao.ts';
import type {
  AtividadeDaSessao,
  ContaDoPainel,
  ContextoDoPainel,
  DonoDoPasso,
  CustoDoPainel,
  DecisaoDoPainel,
  EscopoDasDecisoes,
  FaixaDaSessao,
  FilhaDoPainel,
  ListaDeDecisoes,
  Painel,
  PlanoDaSessao,
  PlanoDoPainel,
  PrecisaDeVoce,
  PrecisamDoPainel,
  PrAguardando,
  PrsDoPainel,
  SessaoDoPainel,
  SubagenteDoPainel,
} from './tipos.ts';
import type { TrabalhoPorBranch } from './trabalho.ts';
import { VERSAO_DA_API } from './versao.ts';

export const LIMITE_PADRAO_DE_CONTEXTO = DEFAULT_WINDOW;
const LIMITE_LONGO_DE_CONTEXTO = LONG_WINDOW;
const MAX_MAQUINA = 12;
const MAX_SESSOES_DOS_PRS = 30;
const PONTOS_DA_SERIE = 16;

/** O que o painel manda junto com o id: o que ele lê do ambiente da própria sessão. */
export interface PedidoDoPainel {
  sessionId: string;
  /** `CLAUDE_CODE_HOST_SESSION_ID` (`local_…`), para achar a sessão no índice do Desktop. */
  local?: string | null;
  conta?: string | null;
  org?: string | null;
  /** A pasta da sessão, para o trabalho de uma sessão que o núcleo ainda não viu. */
  cwd?: string | null;
  /** O modelo da sessão, para a sessão que o núcleo ainda não viu. */
  modelo?: string | null;
  /** A lista de decisões aberta no painel, neste escopo (P9). */
  decisoes?: EscopoDasDecisoes | null;
}

export interface OpcoesDoPainel {
  storage: StoragePort;
  contas: Contas;
  desktop: IndiceDoDesktop | null;
  trabalho: TrabalhoPorBranch | null;
  /** A porta das decisões (#99); sem ela, o painel não traz decisões. */
  decisoes?: DecisionPort | null;
  agora?: () => number;
  custoMs?: number;
  precisamMs?: number;
  /** Troca o id pedido por outro (a demonstração usa a sessão do cenário). */
  apelido?: (sessionId: string) => string;
  /** O commit do código que a API carregou ao subir, para o rodapé do painel. */
  commit?: string | null;
  /** O commit da pasta agora: diferente do `commit`, a pasta mudou e a API precisa reiniciar. */
  commitDaPasta?: () => string | null;
  /** A API abre a sessão no Claude Desktop (`POST /open/<local_…>`): no macOS. */
  abreSessao?: boolean;
}

type Porta = StoragePort;
interface Candidata {
  session: Session;
  agentes: Agent[];
  inbox: InboxReading;
  desktop: SessaoDoDesktop | null;
}

const UM_MIN = 60_000;

/** O que o painel calcula de uma sessão já gravada, com os mesmos caches: o card do mural (#34) sai daqui. */
export interface LeituraDaSessao {
  sessao: SessaoDoPainel;
  inbox: InboxReading;
  desktop: SessaoDoDesktop | null;
  /** O branch da sessão: o do Desktop ou da metadata e, sem eles, o do git (só `git branch`, em cache). */
  branch: string | null;
  /** O esforço: o `effort` do índice do Desktop e, sem ele, `metadata.esforco` (o simulador grava). */
  esforco: string | null;
  custo: CustoDoPainel | null;
  plano: PlanoDoPainel | null;
  contexto: ContextoDoPainel | null;
  subagentes: { active: number; items: SubagenteDoPainel[] };
}

/** The attention level and reason of `atencaoDe` (still Portuguese inside the core) as the panel answers them. */
const PANEL_LEVEL: Readonly<Record<NivelDeAtencao, PrecisaDeVoce['level']>> = { precisa: 'needs', 'sua-vez': 'your-turn' };
const PANEL_WHY: Readonly<Record<MotivoDaAtencao, PrecisaDeVoce['why']>> = {
  permissao: 'permission',
  pergunta: 'question',
  plano: 'plan',
  decisao: 'decision',
  erro: 'error',
  'sua-vez': 'your-turn',
  interrompida: 'interrupted',
  'no-prompt': 'no-prompt',
};

function minutos(desde: string, agora: number): string {
  const m = Math.max(0, Math.round((agora - Date.parse(desde)) / UM_MIN));
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

export class MontadorDoPainel {
  /** Público para o mural (#34), que lista as sessões pela mesma porta. */
  readonly storage: Porta;
  private readonly contas: Contas;
  private readonly desktop: IndiceDoDesktop | null;
  readonly trabalho: TrabalhoPorBranch | null;
  readonly agora: () => number;
  private readonly custoMs: number;
  private readonly precisamMs: number;
  private readonly apelido: (sessionId: string) => string;
  private readonly commit: string | null;
  private readonly commitDaPasta: () => string | null;
  private readonly abreSessao: boolean;
  private readonly decisoes: DecisoesDaSessao | null;
  readonly resumos: ResumosDeSessao;
  private readonly custos = new Map<string, { em: number; updatedAt: string; custo: CustoDoPainel; tokens: Painel['tokens'] }>();
  private precisamCache: { em: number; candidatas: Candidata[] } | null = null;
  private sessoesRecentes: { em: number; sessoes: Session[] } | null = null;
  private precisamRodando: Promise<Candidata[]> | null = null;

  constructor({ storage, contas, desktop, trabalho, decisoes = null, agora = Date.now, custoMs = 30_000, precisamMs = 4_000, apelido = (id) => id, commit = null, commitDaPasta = () => null, abreSessao = false }: OpcoesDoPainel) {
    this.commit = commit;
    this.commitDaPasta = commitDaPasta;
    this.abreSessao = abreSessao;
    this.apelido = apelido;
    this.storage = storage;
    this.contas = contas;
    this.desktop = desktop;
    this.trabalho = trabalho;
    this.agora = agora;
    this.custoMs = custoMs;
    this.precisamMs = precisamMs;
    this.resumos = new ResumosDeSessao(storage, { agora });
    this.decisoes = decisoes ? new DecisoesDaSessao({ decisions: decisoes, storage }) : null;
  }

  /** A sessão no índice do Desktop (para o mural descartar a arquivada antes de ler o resto). */
  desktopDaSessao(sessionId: string): SessaoDoDesktop | null {
    return this.desktop?.sessaoPorCli(sessionId) ?? null;
  }

  /** Confere as contas e o índice do Desktop (cada um respeita o próprio intervalo). */
  async atualizarFontes(): Promise<void> {
    await Promise.all([this.contas.atualizar(), this.desktop?.atualizar()]);
  }

  /**
   * Uma sessão já gravada, como o painel a vê: o card "Esta sessão", o custo (pelo cache `custos`),
   * o plano, o contexto e os subagentes. Para o mural (#34); quem chama faz `atualizarFontes()` antes.
   */
  async leituraDaSessao(session: Session): Promise<LeituraDaSessao> {
    const agora = this.agora();
    const desktop = this.desktopDaSessao(session.id);
    const agentes = await this.storage.listAgents(session.id);
    const resumo = await this.resumos.ler(session.id, session.updatedAt);
    const conta = this.contas.daSessao(session, desktop);
    const planos = await this.storage.listPlanRecords(session.id);
    const sessao = this.sessaoDe(session, agentes, resumo, desktop, conta, agora);
    const pasta = session.cwd ?? desktop?.cwd ?? null;
    return {
      sessao,
      inbox: readInbox(session, agentes),
      desktop,
      // O que o trabalho por branch já sabe e, sem isso, só o `git branch` da pasta (em cache, nunca o
      // GitHub): o mural lê todas as abertas.
      branch: sessao.branch ?? this.trabalho?.espiar(pasta)?.branch ?? this.trabalho?.branchDaPasta(pasta) ?? null,
      esforco: desktop?.esforco ?? (typeof session.metadata?.esforco === 'string' ? session.metadata.esforco : null),
      custo: (await this.custoDe(session)).custo,
      plano: planoDe(await this.planoAtual(session.id, planos), resumo, agentes),
      contexto: contextoDe(session, resumo, await this.storage.listContextMeters(session.id)),
      subagentes: subagentesDe(agentes),
    };
  }

  /** `literal`: o id pedido, sem o apelido da demonstração (o Detalhe da /ui lê qualquer sessão). */
  async montar(pedidoOriginal: PedidoDoPainel, { literal = false }: { literal?: boolean } = {}): Promise<Painel> {
    const pedido = { ...pedidoOriginal, sessionId: literal ? pedidoOriginal.sessionId : this.apelido(pedidoOriginal.sessionId) };
    const agora = this.agora();
    this.contas.informar(pedido.sessionId, pedido.conta ?? null, pedido.org ?? null);
    await Promise.all([this.contas.atualizar(), this.desktop?.atualizar()]);

    const session = await this.storage.getSession(pedido.sessionId);
    const desktop = this.doDesktop(pedido.sessionId, pedido.local ?? null);
    const agentes = session ? await this.storage.listAgents(session.id) : [];
    const resumo = session ? await this.resumos.ler(session.id, session.updatedAt) : null;
    const conta = this.contas.daSessao(session ?? { id: pedido.sessionId, accountId: null, accountSource: null }, desktop);

    const sessao = session
      ? this.sessaoDe(session, agentes, resumo!, desktop, conta, agora)
      : this.sessaoNova(pedido, desktop, conta, agora);
    const { custo, tokens } = session ? await this.custoDe(session) : { custo: null, tokens: null };
    const memoria = session ? readMemory(session) : null;
    const planos = session ? await this.storage.listPlanRecords(session.id) : [];
    const bg = memoria ? Object.values(memoria.background) : [];
    const trabalho = this.trabalho?.ler(session?.cwd ?? pedido.cwd ?? desktop?.cwd ?? null, desktop?.branch ?? null) ?? null;

    return {
      version: 1,
      api: { version: VERSAO_DA_API, commit: this.commit, folder: this.commitDaPasta(), opensSession: this.abreSessao },
      generatedAt: new Date(agora).toISOString(),
      session: sessao,
      context: session ? contextoDe(session, resumo!, await this.storage.listContextMeters(session.id)) : null,
      cost: custo,
      tokens,
      background: { total: bg.length, first: bg[0]?.comando ?? null },
      plan: session ? planoDe(await this.planoAtual(session.id, planos), resumo!, agentes) : null,
      plans: planos.map(planoDaLista),
      subagents: subagentesDe(agentes, resumo ? iniciosDosTurnos(resumo) : []),
      children: await this.filhasDe(session, desktop),
      work: trabalho,
      needYou: await this.precisamDe(pedido.sessionId, session, desktop),
      prs: await this.prsAguardando(),
      decisions: this.decisoes
        ? await this.decisoes.doPainel(await this.alvoDe(pedido.sessionId, session, pedido.cwd ?? null, desktop, conta), pedido.decisoes ?? null)
        : null,
    };
  }

  /** A sessão das decisões: o branch e a pasta que o painel conhece, e a conta dela. */
  private alvo(sessionId: string, pasta: string | null, branch: string | null, conta: ContaDoPainel | null): AlvoDasDecisoes {
    return { sessionId, branch, repo: pasta, contaId: conta?.id ?? null };
  }

  /**
   * A sessão das decisões a partir do pedido: a pasta da porta, do pedido ou do Desktop; o branch do
   * Desktop, dos metadados ou do git da pasta e, sem nenhum deles, o que a captura gravou nas decisões
   * da própria sessão. É a mesma regra no Confirmar do painel e na aba e no Promover da /ui.
   */
  private async alvoDoPedido(pedidoOriginal: PedidoDoPainel): Promise<AlvoDasDecisoes> {
    const pedido = { ...pedidoOriginal, sessionId: this.apelido(pedidoOriginal.sessionId) };
    this.contas.informar(pedido.sessionId, pedido.conta ?? null, pedido.org ?? null);
    await Promise.all([this.contas.atualizar(), this.desktop?.atualizar()]);
    const session = await this.storage.getSession(pedido.sessionId);
    const desktop = this.doDesktop(pedido.sessionId, pedido.local ?? null);
    const conta = this.contas.daSessao(session ?? { id: pedido.sessionId, accountId: null, accountSource: null }, desktop);
    return this.alvoDe(pedido.sessionId, session, pedido.cwd ?? null, desktop, conta);
  }

  /**
   * A pasta, o branch e a conta das decisões, com o que a captura gravou quando o ambiente não diz o
   * branch. Uma regra só, para o painel montado (`montar`) e para a lista, a aba e o Confirmar.
   */
  private async alvoDe(sessionId: string, session: Session | null, cwd: string | null, desktop: SessaoDoDesktop | null, conta: ContaDoPainel | null): Promise<AlvoDasDecisoes> {
    const pasta = session?.cwd ?? cwd ?? desktop?.cwd ?? null;
    const branch = desktop?.branch ?? (session?.metadata?.branch as string | undefined) ?? this.trabalho?.ler(pasta, null)?.branch ?? null;
    if (branch || !this.decisoes) return this.alvo(sessionId, pasta, branch, conta);
    const gravado = await this.decisoes.gravadoNasProprias(sessionId);
    return this.alvo(sessionId, gravado.branch ? (gravado.repo ?? pasta) : (pasta ?? gravado.repo), gravado.branch, conta);
  }

  /** A sessão das decisões só pelo id: a da aba e do Promover da /ui, igual à do Confirmar. */
  alvoDaSessao(sessionId: string): Promise<AlvoDasDecisoes> {
    return this.alvoDoPedido({ sessionId });
  }

  /** `GET /api/decisions/<session>`: a lista de um escopo; `null` sem a porta das decisões. */
  async listaDeDecisoes(pedido: PedidoDoPainel, escopo: EscopoDasDecisoes): Promise<ListaDeDecisoes | null> {
    if (!this.decisoes) return null;
    return this.decisoes.lista(await this.alvoDoPedido(pedido), escopo);
  }

  /** `POST /api/decisions/<id>/confirm|dismiss`, em nome da sessão do painel. */
  async decidir(pedido: PedidoDoPainel, id: string, acao: AcaoNaDecisao, texto: string | null = null): Promise<DecisaoDoPainel | null> {
    if (!this.decisoes) return null;
    return this.decisoes.decidir(await this.alvoDoPedido(pedido), id, acao, new Date(this.agora()).toISOString(), texto);
  }

  /** O plano aberto do histórico (vazio se todos fecharam); sem histórico (antes da #131), o plano gravado. */
  private async planoAtual(sessionId: string, planos: PlanRecord[]): Promise<PlanoGravado | null> {
    if (planos.length) return planos.find((p) => p.result === 'current') ?? { steps: [], total: 0, changedAt: planos[0].changedAt, currentStepId: null };
    return this.storage.getPlan(sessionId);
  }

  /** O `local_…` da sessão no índice do Claude Desktop, para o "Abrir no Claude Desktop". */
  localDe(sessionId: string): string | null {
    return this.desktop?.sessaoPorCli(sessionId)?.localId ?? null;
  }

  private doDesktop(sessionId: string, local: string | null): SessaoDoDesktop | null {
    if (!this.desktop) return null;
    return this.desktop.sessaoPorCli(sessionId) ?? (local ? this.desktop.sessaoPorLocal(local) : null);
  }

  private sessaoDe(
    session: Session,
    agentes: Agent[],
    r: ResumoDosEventos,
    desktop: SessaoDoDesktop | null,
    conta: ContaDoPainel | null,
    agora: number,
  ): SessaoDoPainel {
    const inbox = readInbox(session, agentes);
    const memoria = readMemory(session);
    const desde = session.awaitingInputSince ?? (inbox.status === 'error' ? memoria.erroEm : null) ?? session.updatedAt;
    const { atividade, faixa } = atividadeDe(session, agentes, inbox, r, desde, agora);
    return {
      id: session.id,
      title: desktop?.titulo ?? session.name ?? (session.cwd ? basename(session.cwd) : 'Sessão sem título'),
      model: session.model,
      startedAt: session.startedAt,
      status: inbox.status,
      state: inbox.state,
      reason: inbox.reason,
      urgent: inbox.urgent,
      since: desde,
      turn: Math.max(r.promptsHook, r.promptsTranscript),
      activity: atividade,
      banner: faixa,
      account: conta,
      branch: desktop?.branch ?? (session.metadata?.branch as string | undefined) ?? null,
      cwd: session.cwd,
    };
  }

  // A sessão que o núcleo ainda não viu: aberta agora, sem hook nem transcript (P6).
  private sessaoNova(pedido: PedidoDoPainel, desktop: SessaoDoDesktop | null, conta: ContaDoPainel | null, agora: number): SessaoDoPainel {
    const iso = new Date(agora).toISOString();
    return {
      id: pedido.sessionId,
      title: desktop?.titulo ?? 'Sessão nova, sem transcript',
      model: pedido.modelo ?? null,
      startedAt: iso,
      status: 'waiting',
      state: 'waiting',
      reason: 'session_start',
      urgent: false,
      since: iso,
      turn: 0,
      activity: { type: 'prompt', text: 'esperando o primeiro prompt' },
      banner: null,
      account: conta,
      branch: desktop?.branch ?? null,
      cwd: pedido.cwd ?? desktop?.cwd ?? null,
    };
  }

  private async custoDe(session: Session): Promise<{ custo: CustoDoPainel | null; tokens: Painel['tokens'] }> {
    const c = this.custos.get(session.id);
    const agora = this.agora();
    if (c && (c.updatedAt === session.updatedAt || agora - c.em < this.custoMs)) return c;
    const precos = await precosVigentes(this.storage);
    const [parcelas, buckets] = await Promise.all([parcelasDaSessao(this.storage, session.id, precos), this.storage.listTokenUsage(session.id)]);
    const relatorio = relatorioDeCusto(parcelas);
    let acumulado = 0;
    const pontos = parcelas.map((p) => (acumulado += p.custo.costUsd ?? 0));
    const passo = Math.max(1, Math.ceil(pontos.length / PONTOS_DA_SERIE));
    const serie = [0, ...pontos.filter((_, i) => (i + 1) % passo === 0 || i === pontos.length - 1)];
    let entrada = 0;
    let saida = 0;
    for (const b of buckets) {
      const t = effectiveTokens(b);
      entrada += t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
      saida += t.output;
    }
    const valor = {
      em: agora,
      updatedAt: session.updatedAt,
      custo: { usd: relatorio.total.custoUsd ?? (relatorio.total.totalDeTokens === 0 ? 0 : null), series: serie, estimate: true as const },
      tokens: buckets.length ? { input: entrada, output: saida } : null,
    };
    this.custos.set(session.id, valor);
    return valor;
  }

  private async filhasDe(session: Session | null, desktop: SessaoDoDesktop | null): Promise<FilhaDoPainel[]> {
    const ids = new Map<string, { titulo: string | null; local: string | null; arquivada: boolean }>();
    // As arquivadas no Desktop vêm junto, marcadas (#145): o painel as conta e lista por último.
    for (const f of desktop ? (this.desktop?.filhasDe(desktop.localId) ?? []) : []) if (f.cliSessionId) ids.set(f.cliSessionId, { titulo: f.titulo, local: f.localId, arquivada: f.arquivada });
    const familia = session?.metadata?.familia as { filhas?: unknown } | undefined;
    if (Array.isArray(familia?.filhas)) {
      for (const id of familia.filhas) {
        if (typeof id !== 'string' || ids.has(id)) continue;
        const noDesktop = this.desktop?.sessaoPorCli(id) ?? null;
        ids.set(id, { titulo: null, local: noDesktop?.localId ?? null, arquivada: noDesktop?.arquivada ?? false });
      }
    }
    const out: FilhaDoPainel[] = [];
    for (const [id, { titulo, local, arquivada }] of ids) {
      const s = await this.storage.getSession(id);
      if (!s) {
        out.push({ id, local, title: titulo ?? id.slice(0, 8), state: 'unknown', reason: null, since: null, archived: arquivada });
        continue;
      }
      const agentes = await this.storage.listAgents(id);
      const inbox = readInbox(s, agentes);
      const f = fazendoDa(s, agentes, inbox);
      out.push({
        id,
        local,
        title: titulo ?? s.name ?? (s.cwd ? basename(s.cwd) : id.slice(0, 8)),
        state: inbox.state,
        reason: inbox.reason,
        since: f ? f.desde : (s.awaitingInputSince ?? s.updatedAt),
        doing: f?.texto ?? null,
        archived: arquivada,
      });
    }
    return out;
  }

  // As candidatas a "precisam de você": esperando ou com erro, entre as ativas. Uma consulta por
  // índice para cada caso; guardada por `precisamMs` e dividida entre os painéis abertos.
  private async candidatas(): Promise<Candidata[]> {
    const agora = this.agora();
    if (this.precisamCache && agora - this.precisamCache.em < this.precisamMs) return this.precisamCache.candidatas;
    this.precisamRodando ??= (async () => {
      const vistas = new Map<string, Session>();
      const consultas: ListSessionsQuery[] = [{ awaiting: true, status: ['active', 'error'] }, { status: ['error'] }];
      for (const query of consultas) {
        let cursor: string | null = null;
        do {
          const page = await this.storage.listSessions({ ...query, limit: 200, cursor });
          for (const s of page.items) vistas.set(s.id, s);
          cursor = page.nextCursor;
        } while (cursor);
      }
      const out: Candidata[] = [];
      for (const session of vistas.values()) {
        const agentes = await this.storage.listAgents(session.id);
        const inbox = readInbox(session, agentes);
        if (inbox.needsYou) out.push({ session, agentes, inbox, desktop: this.desktop?.sessaoPorCli(session.id) ?? null });
      }
      this.precisamCache = { em: this.agora(), candidatas: out };
      return out;
    })().finally(() => {
      this.precisamRodando = null;
    });
    return this.precisamRodando;
  }

  /**
   * Os PRs que aguardam a sua aprovação (#140): de cada sessão dos últimos 7 dias, o PR do branch
   * dela, aberto (não rascunho) e com o review pendente no GitHub. O trabalho por branch responde do
   * cache e busca por trás, nunca no caminho do pedido; a lista de sessões é refeita a cada 30 s.
   */
  private async prsAguardando(): Promise<PrsDoPainel> {
    if (!this.trabalho) return { total: 0, items: [] };
    const agora = this.agora();
    if (!this.sessoesRecentes || agora - this.sessoesRecentes.em > 30_000) {
      const page = await this.storage.listSessions({ limit: 200 });
      const desde = new Date(agora - 7 * 24 * 3_600_000).toISOString();
      // As 30 mais recentes: cada uma revalida o trabalho a cada minuto (git e o cache do GitHub).
      this.sessoesRecentes = { em: agora, sessoes: page.items.filter((s) => s.updatedAt >= desde).slice(0, MAX_SESSOES_DOS_PRS) };
    }
    const porUrl = new Map<string, PrAguardando>();
    for (const s of this.sessoesRecentes.sessoes) {
      const d = this.desktop?.sessaoPorCli(s.id) ?? null;
      const t = this.trabalho.ler(s.cwd ?? d?.cwd ?? null, d?.branch ?? (s.metadata?.branch as string | undefined) ?? null);
      const pr = t?.pr;
      if (!t || !pr || pr.state !== 'open' || pr.review !== 'pending' || porUrl.has(pr.url)) continue;
      porUrl.set(pr.url, {
        number: pr.number,
        url: pr.url,
        repo: t.repo,
        title: t.issue ? `#${t.issue.number} ${t.issue.title}` : t.branch,
        session: { id: s.id, title: d?.titulo ?? s.name ?? (s.cwd ? basename(s.cwd) : s.id.slice(0, 8)), local: d?.localId ?? null },
      });
    }
    const items = [...porUrl.values()].sort((a, b) => b.number - a.number);
    return { total: items.length, items };
  }

  private async precisamDe(sessionId: string, session: Session | null, desktop: SessaoDoDesktop | null): Promise<PrecisamDoPainel> {
    const agora = this.agora();
    const minhaFamilia = familiaDe(session, desktop);
    const itens: PrecisaDeVoce[] = [];
    for (const c of await this.candidatas()) {
      if (c.session.id === sessionId) continue;
      const r = await this.resumos.ler(c.session.id, c.session.updatedAt);
      const delas = familiaDe(c.session, c.desktop);
      const relacao =
        delas.eu && minhaFamilia.mae === delas.eu ? 'parent' : minhaFamilia.eu && delas.mae === minhaFamilia.eu ? 'child' : minhaFamilia.mae && delas.mae === minhaFamilia.mae ? 'sibling' : null;
      const desde = c.session.awaitingInputSince ?? c.session.updatedAt;
      const { atividade, faixa } = atividadeDe(c.session, c.agentes, c.inbox, r, desde, agora);
      const { nivel, porque } = atencaoDe(c.inbox, r);
      itens.push({
        id: c.session.id,
        level: PANEL_LEVEL[nivel],
        why: PANEL_WHY[porque],
        local: c.desktop?.localId ?? null,
        title: c.desktop?.titulo ?? c.session.name ?? (c.session.cwd ? basename(c.session.cwd) : c.session.id.slice(0, 8)),
        state: c.inbox.status === 'error' ? 'error' : 'waiting',
        reason: c.inbox.reason,
        urgent: c.inbox.urgent || c.inbox.status === 'error',
        since: desde,
        text: faixa?.type === 'error' ? faixa.text : atividade.text,
        model: c.session.model,
        relation: relacao,
        sameProject: !!session?.cwd && c.session.cwd === session.cwd,
        account: this.contas.daSessao(c.session, c.desktop),
      });
    }
    // Quem precisa de você antes de quem só está na sua vez (#140); dentro de cada nível, as urgentes
    // e, entre elas, o pedido mais recente, que é o que a pessoa lembra.
    const peso = (i: PrecisaDeVoce) => (i.level === 'needs' ? 1 : 0)
    itens.sort((a, b) => peso(b) - peso(a) || Number(b.urgent) - Number(a.urgent) || b.since.localeCompare(a.since));
    // A contagem e a divisão por conta são só das que precisam de você: a sua vez não soma.
    const precisam = itens.filter((i) => i.level === 'needs');
    const porConta = new Map<string, { account: ContaDoPainel | null; n: number }>();
    for (const i of precisam) {
      const k = i.account?.id ?? '';
      porConta.set(k, { account: i.account, n: (porConta.get(k)?.n ?? 0) + 1 });
    }
    return {
      total: precisam.length,
      yourTurn: itens.length - precisam.length,
      byAccount: [...porConta.values()].sort((a, b) => b.n - a.n),
      family: itens.filter((i) => i.relation !== null),
      machine: itens.slice(0, MAX_MAQUINA),
    };
  }
}

/** A sessão na família: o próprio id e o da mãe, pelo Desktop (`local_…`) ou pelo simulador. */
function familiaDe(session: Session | null, desktop: SessaoDoDesktop | null): { eu: string | null; mae: string | null } {
  const f = session?.metadata?.familia as { mae?: unknown } | undefined;
  if (typeof f?.mae === 'string') return { eu: session!.id, mae: f.mae };
  if (desktop) return { eu: desktop.localId, mae: desktop.maeLocalId };
  return { eu: session?.id ?? null, mae: null };
}

/**
 * O medidor gravado pela porta (item 1.7). Sem medidor do principal, o contexto do simulador
 * (`metadata.contexto`) ou o último uso lido dos eventos, sem estouros.
 */
export function contextoDe(
  session: Pick<Session, 'metadata' | 'model'>,
  r: Pick<ResumoDosEventos, 'contexto' | 'janelaLonga'>,
  medidores: ContextMeter[] = [],
): ContextoDoPainel | null {
  const agentes = medidores
    .filter((m) => m.agentId !== null && m.measuredAt !== null)
    .map((m) => ({ agentId: m.agentId!, used: m.usedTokens, limit: m.windowTokens, pct: contextPct(m), overflows: m.compactions, alert: contextAlert(m) }));
  // Só o medidor que já mediu: o que nasceu só do PreCompact mostraria "0 / 200k".
  const principal = medidores.find((m) => m.agentId === null && m.measuredAt !== null);
  const sim = session.metadata?.contexto as { usados?: unknown; limite?: unknown; estouros?: unknown } | undefined;
  if (principal && typeof sim?.usados !== 'number') {
    return {
      used: principal.usedTokens,
      limit: principal.windowTokens,
      pct: contextPct(principal),
      overflows: principal.compactions,
      alert: contextAlert(principal),
      manualCompactions: principal.manualCompactions,
      label: contextLabel(principal),
      agents: agentes,
    };
  }
  let usados = typeof sim?.usados === 'number' ? sim.usados : r.contexto;
  if (usados === null) return null;
  // A janela longa, uma vez vista (ou pedida no modelo, `[1m]`), continua depois de compactar: o uso
  // cai abaixo de 200 mil, mas a janela não muda.
  const longa = r.janelaLonga || usados > LIMITE_PADRAO_DE_CONTEXTO || /\[1m\]/i.test(session.model ?? '');
  const limite = typeof sim?.limite === 'number' && sim.limite > 0 ? sim.limite : longa ? LIMITE_LONGO_DE_CONTEXTO : LIMITE_PADRAO_DE_CONTEXTO;
  usados = Math.max(0, usados);
  const estouros = typeof sim?.estouros === 'number' && Number.isInteger(sim.estouros) && sim.estouros > 0 ? sim.estouros : 0;
  // Sem medição do principal, os estouros que o medidor já contou (pelo PreCompact) continuam valendo.
  const contado = medidores.find((x) => x.agentId === null);
  const total = Math.max(estouros, contado?.compactions ?? 0);
  const c = { usedTokens: usados, windowTokens: limite, compactions: total };
  return {
    used: usados, limit: limite, pct: contextPct(c), overflows: total, alert: contextAlert(c),
    manualCompactions: contado?.manualCompactions ?? 0, label: contextLabel(c), agents: agentes,
  };
}

type PlanoGravado = Pick<SessionPlan, 'steps' | 'total' | 'changedAt' | 'currentStepId'>;

function planoDaLista(r: PlanRecord): PlanoDaSessao {
  return {
    number: r.seq,
    outcome: r.result,
    summary: r.steps[0]?.text ?? '',
    done: r.done,
    total: r.total,
    current: r.result === 'current' ? (r.steps.find((s) => s.id === r.currentStepId)?.text ?? null) : null,
    start: r.startedAt,
    end: r.endedAt,
  };
}

/** O plano gravado pela porta (item 1.9); sem ele, o último TodoWrite lido dos eventos. */
function planoDe(plano: PlanoGravado | null, r: ResumoDosEventos, agentes: Agent[]): PlanoDoPainel | null {
  if (plano) {
    if (plano.total === 0) return null;
    const passos = plano.steps.map((s) => ({ id: s.id, text: s.text, activeText: s.activeText, state: s.status, owner: donoDe(s.owner, agentes) }));
    return resumirPlano(passos, plano.changedAt, plano.currentStepId);
  }
  if (!r.plano || r.plano.length === 0) return null;
  const principal: DonoDoPasso = { type: 'main', name: null, agentId: null };
  const passos = r.plano.map((i, n) => ({ id: String(n + 1), text: i.texto, activeText: null, state: i.status, owner: principal }));
  return resumirPlano(passos, null, null);
}

function resumirPlano(passos: PlanoDoPainel['steps'], mudouEm: string | null, atualId: string | null): PlanoDoPainel {
  const atual = passos.find((p) => p.id === atualId) ?? passos.find((p) => p.state === 'in_progress') ?? null;
  const pendentes = passos.filter((p) => p.state === 'pending');
  return {
    done: passos.filter((p) => p.state === 'completed').length,
    total: passos.length,
    current: atual?.text ?? null,
    next: pendentes[0]?.text ?? null,
    remaining: Math.max(0, pendentes.length - 1),
    currentOwner: atual?.owner ?? null,
    changedAt: mudouEm,
    steps: passos,
  };
}

function donoDe(o: PlanOwner, agentes: Agent[]): DonoDoPasso {
  if (o.kind === 'main') return { type: 'main', name: null, agentId: o.agentId };
  if (o.kind === 'session') return { type: 'session', name: o.name, agentId: null };
  const a = o.agentId ? agentes.find((x) => x.id === o.agentId) : undefined;
  return { type: 'subagent', name: o.name ?? a?.subagentType ?? a?.name ?? null, agentId: o.agentId };
}

/**
 * Os subagentes da sessão, com quem disparou cada um e a onda (#146). O pai é o subagente dono da
 * chamada que o abriu; a sessão principal não conta como pai. A onda é o turno da sessão em que o
 * subagente de cima foi disparado: quantos turnos tinham começado até ele começar.
 */
export function subagentesDe(agentes: Agent[], inicios: readonly string[] = []): { active: number; items: SubagenteDoPainel[] } {
  const subs = agentes.filter((a) => a.type === 'subagent');
  const porId = new Map(subs.map((a) => [a.id, a]));
  const pai = (a: Agent) => (a.parentAgentId && porId.has(a.parentAgentId) ? a.parentAgentId : null);
  // O de cima da cadeia (com um limite, contra um ciclo nos dados).
  const raiz = (a: Agent) => {
    let r = a;
    for (let i = 0; i < 32; i++) {
      const p = pai(r);
      if (!p) break;
      r = porId.get(p)!;
    }
    return r;
  };
  const ordenados = [...inicios].sort();
  const ondaDe = (a: Agent) => {
    if (ordenados.length === 0) return null;
    const desde = raiz(a).startedAt;
    const n = ordenados.filter((t) => t <= desde).length;
    return n > 0 ? n : null;
  };
  const ordem = { working: 0, waiting: 1, error: 2, completed: 3 } as const;
  const itens = subs
    .map((a) => ({
      id: a.id,
      name: a.subagentType ?? 'subagente',
      task: a.name ?? a.task,
      status: a.status,
      since: a.startedAt,
      until: a.endedAt,
      parent: pai(a),
      wave: ondaDe(a),
    }))
    .sort((a, b) => ordem[a.status] - ordem[b.status] || b.since.localeCompare(a.since));
  return { active: subs.filter((a) => a.status === 'working').length, items: itens };
}

/** "Bash quer rodar npm run migrate em /projeto", pela última ferramenta do principal. */
function pedidoDePermissao(r: ResumoDosEventos, cwd: string | null): string {
  const f = r.ultimaFerramenta;
  if (f?.nome === 'Bash' && f.resumo) return `Bash quer rodar ${f.resumo}${cwd ? ` em ${cwd}` : ''}`;
  if (f?.nome && f.resumo) return `${f.nome} quer mexer em ${f.resumo}`;
  return r.ultimoPedido?.texto ?? 'uma ferramenta pediu permissão';
}

/**
 * O que uma filha trabalhando está fazendo, para a lista das filhas: a ferramenta que roda, os
 * subagentes que espera, o background, ou "pensando". `desde` é o último passo do agente principal
 * (o início da ferramenta, ou a última resposta). Parada, `null`.
 */
export function fazendoDa(session: Session, agentes: Agent[], inbox: InboxReading): { texto: string; desde: string } | null {
  const principal = mainAgentOf({ session, agents: agentes });
  const desde = principal?.updatedAt ?? session.updatedAt;
  switch (inbox.state) {
    case 'active':
      return { texto: principal?.currentTool ? `rodando ${principal.currentTool}` : 'pensando', desde };
    case 'delegating':
      return { texto: `esperando ${inbox.activeSubagents || 1} subagente${inbox.activeSubagents > 1 ? 's' : ''}`, desde };
    case 'background':
      return { texto: `${inbox.backgroundProcesses} em background`, desde };
    default:
      return null;
  }
}

export function atividadeDe(
  session: Session,
  agentes: Agent[],
  inbox: InboxReading,
  r: ResumoDosEventos,
  desde: string,
  agora: number,
): { atividade: AtividadeDaSessao; faixa: FaixaDaSessao | null } {
  const principal = mainAgentOf({ session, agents: agentes });
  const ferramenta = r.ultimaFerramenta;
  switch (inbox.state) {
    case 'waiting': {
      if (inbox.reason === 'notification') {
        const pergunta = r.ultimaPergunta && (ferramenta?.nome === 'AskUserQuestion' || r.ultimoPedido?.tipo === 'elicitation_dialog');
        if (pergunta && r.ultimaPergunta) {
          const n = r.ultimaPergunta.opcoes;
          return {
            atividade: { type: 'question', text: 'pergunta pendente' },
            faixa: { type: 'question', text: r.ultimaPergunta.texto, footer: `${n ? `${n} opções · ` : ''}responda na conversa ao lado`, since: desde },
          };
        }
        const texto = ferramenta?.nome && ferramenta.resumo ? `${ferramenta.nome}: ${ferramenta.resumo}` : (r.ultimoPedido?.texto ?? 'pedido de permissão');
        return {
          atividade: { type: 'permission', text: texto },
          faixa: { type: 'permission', text: pedidoDePermissao(r, session.cwd), footer: 'permitir ou negar na conversa ao lado', since: desde },
        };
      }
      if (inbox.reason === 'interrupted') return { atividade: { type: 'interrupted', text: 'Esc no meio do turno' }, faixa: null };
      if (inbox.reason === 'session_start') return { atividade: { type: 'prompt', text: 'esperando o primeiro prompt' }, faixa: null };
      return { atividade: { type: 'your-turn', text: r.ultimaMensagem ? `"${r.ultimaMensagem}"` : 'o turno terminou' }, faixa: null };
    }
    case 'error': {
      const erro = r.ultimoErro?.texto ?? 'a sessão parou num erro';
      return {
        atividade: { type: 'error', text: erro },
        faixa: { type: 'error', text: erro, footer: 'mande uma mensagem na conversa para retomar', since: desde },
      };
    }
    case 'delegating':
      return { atividade: { type: 'delegating', text: `esperando ${inbox.activeSubagents || 1} subagente${inbox.activeSubagents === 1 ? '' : 's'}` }, faixa: null };
    case 'background':
      return { atividade: { type: 'tool', text: `${inbox.backgroundProcesses} em background` }, faixa: null };
    case 'completed':
      return { atividade: { type: 'completed', text: 'terminou sem erro' }, faixa: null };
    case 'abandoned':
      return { atividade: { type: 'abandoned', text: `${minutos(session.updatedAt, agora)} sem sinal` }, faixa: null };
    default: {
      const tool = principal?.currentTool ?? null;
      if (tool) return { atividade: { type: 'tool', text: `rodando ${tool}${ferramenta?.nome === tool && ferramenta.resumo ? ` · ${ferramenta.resumo}` : ''}` }, faixa: null };
      return { atividade: { type: 'tool', text: 'pensando' }, faixa: null };
    }
  }
}
