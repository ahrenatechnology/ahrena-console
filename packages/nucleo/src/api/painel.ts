// Monta a resposta de `GET /api/painel/<sessão>` (4.1, 4.2, 4.3 e 4.8): esta sessão, o que roda
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
import { lerInbox, type LeituraDoInbox } from '../estados/leitura.ts';
import { lerMemoria, principalDe } from '../estados/regras.ts';
import type { Agent, Session } from '../model.ts';
import { effectiveTokens } from '../pricing.ts';
import type { PlanOwner, PlanRecord, SessionPlan } from '../plano/modelo.ts';
import { JANELA_LONGA, JANELA_PADRAO } from '../contexto/janela.ts';
import { alertaDeContexto, pctDoContexto, rotuloDoContexto, type ContextMeter } from '../contexto/modelo.ts';
import type { ListSessionsQuery, StoragePort } from '../storage-port.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import type { Contas } from './contas.ts';
import { DecisoesDaSessao, type AcaoNaDecisao, type AlvoDasDecisoes } from './decisoes.ts';
import type { IndiceDoDesktop, SessaoDoDesktop } from './indice-desktop.ts';
import { ResumosDeSessao, iniciosDosTurnos, type ResumoDosEventos } from './resumo.ts';
import { atencaoDe } from './atencao.ts';
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

export const LIMITE_PADRAO_DE_CONTEXTO = JANELA_PADRAO;
const LIMITE_LONGO_DE_CONTEXTO = JANELA_LONGA;
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
  /** A API abre a sessão no Claude Desktop (`POST /abrir/<local_…>`): no macOS. */
  abreSessao?: boolean;
}

type Porta = StoragePort;
interface Candidata {
  session: Session;
  agentes: Agent[];
  inbox: LeituraDoInbox;
  desktop: SessaoDoDesktop | null;
}

const UM_MIN = 60_000;

/** O que o painel calcula de uma sessão já gravada, com os mesmos caches: o card do mural (#34) sai daqui. */
export interface LeituraDaSessao {
  sessao: SessaoDoPainel;
  inbox: LeituraDoInbox;
  desktop: SessaoDoDesktop | null;
  /** O branch da sessão: o do Desktop ou da metadata e, sem eles, o do git (só `git branch`, em cache). */
  branch: string | null;
  /** O esforço: o `effort` do índice do Desktop e, sem ele, `metadata.esforco` (o simulador grava). */
  esforco: string | null;
  custo: CustoDoPainel | null;
  plano: PlanoDoPainel | null;
  contexto: ContextoDoPainel | null;
  subagentes: { ativos: number; itens: SubagenteDoPainel[] };
}

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
  private readonly trabalho: TrabalhoPorBranch | null;
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

  /** Confere as contas e o índice do Desktop (cada um respeita o próprio intervalo). */
  /** A sessão no índice do Desktop (para o mural descartar a arquivada antes de ler o resto). */
  desktopDaSessao(sessionId: string): SessaoDoDesktop | null {
    return this.desktop?.sessaoPorCli(sessionId) ?? null;
  }

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
      inbox: lerInbox(session, agentes),
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

  async montar(pedidoOriginal: PedidoDoPainel): Promise<Painel> {
    const pedido = { ...pedidoOriginal, sessionId: this.apelido(pedidoOriginal.sessionId) };
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
    const memoria = session ? lerMemoria(session) : null;
    const planos = session ? await this.storage.listPlanRecords(session.id) : [];
    const bg = memoria ? Object.values(memoria.background) : [];
    const trabalho = this.trabalho?.ler(session?.cwd ?? pedido.cwd ?? desktop?.cwd ?? null, desktop?.branch ?? null) ?? null;

    return {
      versao: 1,
      api: { versao: VERSAO_DA_API, commit: this.commit, pasta: this.commitDaPasta(), abreSessao: this.abreSessao },
      geradoEm: new Date(agora).toISOString(),
      sessao,
      contexto: session ? contextoDe(session, resumo!, await this.storage.listContextMeters(session.id)) : null,
      custo,
      tokens,
      background: { total: bg.length, primeiro: bg[0]?.comando ?? null },
      plano: session ? planoDe(await this.planoAtual(session.id, planos), resumo!, agentes) : null,
      planos: planos.map(planoDaLista),
      subagentes: subagentesDe(agentes, resumo ? iniciosDosTurnos(resumo) : []),
      filhas: await this.filhasDe(session, desktop),
      trabalho,
      precisam: await this.precisamDe(pedido.sessionId, session, desktop),
      prs: await this.prsAguardando(),
      decisoes: this.decisoes
        ? await this.decisoes.doPainel(this.alvo(pedido.sessionId, sessao.cwd ?? pedido.cwd ?? null, sessao.branch ?? trabalho?.branch ?? null, conta), pedido.decisoes ?? null)
        : null,
    };
  }

  /** A sessão das decisões: o branch e a pasta que o painel conhece, e a conta dela. */
  private alvo(sessionId: string, pasta: string | null, branch: string | null, conta: ContaDoPainel | null): AlvoDasDecisoes {
    return { sessionId, branch, repo: pasta, contaId: conta?.id ?? null };
  }

  private async alvoDoPedido(pedidoOriginal: PedidoDoPainel): Promise<AlvoDasDecisoes> {
    const pedido = { ...pedidoOriginal, sessionId: this.apelido(pedidoOriginal.sessionId) };
    this.contas.informar(pedido.sessionId, pedido.conta ?? null, pedido.org ?? null);
    await Promise.all([this.contas.atualizar(), this.desktop?.atualizar()]);
    const session = await this.storage.getSession(pedido.sessionId);
    const desktop = this.doDesktop(pedido.sessionId, pedido.local ?? null);
    const conta = this.contas.daSessao(session ?? { id: pedido.sessionId, accountId: null, accountSource: null }, desktop);
    const pasta = session?.cwd ?? pedido.cwd ?? desktop?.cwd ?? null;
    const branch = desktop?.branch ?? (session?.metadata?.branch as string | undefined) ?? this.trabalho?.ler(pasta, null)?.branch ?? null;
    return this.alvo(pedido.sessionId, pasta, branch, conta);
  }

  /** `GET /api/decisoes/<sessão>`: a lista de um escopo; `null` sem a porta das decisões. */
  async listaDeDecisoes(pedido: PedidoDoPainel, escopo: EscopoDasDecisoes): Promise<ListaDeDecisoes | null> {
    if (!this.decisoes) return null;
    return this.decisoes.lista(await this.alvoDoPedido(pedido), escopo);
  }

  /** `POST /api/decisoes/<id>/confirmar|descartar`, em nome da sessão do painel. */
  async decidir(pedido: PedidoDoPainel, id: string, acao: AcaoNaDecisao, texto: string | null = null): Promise<DecisaoDoPainel | null> {
    if (!this.decisoes) return null;
    return this.decisoes.decidir(await this.alvoDoPedido(pedido), id, acao, new Date(this.agora()).toISOString(), texto);
  }

  /** O plano aberto do histórico (vazio se todos fecharam); sem histórico (antes da #131), o plano gravado. */
  private async planoAtual(sessionId: string, planos: PlanRecord[]): Promise<PlanoGravado | null> {
    if (planos.length) return planos.find((p) => p.result === 'current') ?? { steps: [], total: 0, changedAt: planos[0].changedAt, currentStepId: null };
    return this.storage.getPlan(sessionId);
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
    const inbox = lerInbox(session, agentes);
    const memoria = lerMemoria(session);
    const desde = session.awaitingInputSince ?? (inbox.status === 'error' ? memoria.erroEm : null) ?? session.updatedAt;
    const { atividade, faixa } = atividadeDe(session, agentes, inbox, r, desde, agora);
    return {
      id: session.id,
      titulo: desktop?.titulo ?? session.name ?? (session.cwd ? basename(session.cwd) : 'Sessão sem título'),
      modelo: session.model,
      iniciadaEm: session.startedAt,
      status: inbox.status,
      estado: inbox.estado,
      motivo: inbox.motivo,
      urgente: inbox.urgente,
      desde,
      turno: Math.max(r.promptsHook, r.promptsTranscript),
      atividade,
      faixa,
      conta,
      branch: desktop?.branch ?? (session.metadata?.branch as string | undefined) ?? null,
      cwd: session.cwd,
    };
  }

  // A sessão que o núcleo ainda não viu: aberta agora, sem hook nem transcript (P6).
  private sessaoNova(pedido: PedidoDoPainel, desktop: SessaoDoDesktop | null, conta: ContaDoPainel | null, agora: number): SessaoDoPainel {
    const iso = new Date(agora).toISOString();
    return {
      id: pedido.sessionId,
      titulo: desktop?.titulo ?? 'Sessão nova, sem transcript',
      modelo: pedido.modelo ?? null,
      iniciadaEm: iso,
      status: 'waiting',
      estado: 'waiting',
      motivo: 'session_start',
      urgente: false,
      desde: iso,
      turno: 0,
      atividade: { tipo: 'prompt', texto: 'esperando o primeiro prompt' },
      faixa: null,
      conta,
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
      custo: { usd: relatorio.total.custoUsd ?? (relatorio.total.totalDeTokens === 0 ? 0 : null), serie, estimativa: true as const },
      tokens: buckets.length ? { entrada, saida } : null,
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
        out.push({ id, local, titulo: titulo ?? id.slice(0, 8), estado: 'desconhecido', motivo: null, desde: null, arquivada });
        continue;
      }
      const agentes = await this.storage.listAgents(id);
      const inbox = lerInbox(s, agentes);
      const f = fazendoDa(s, agentes, inbox);
      out.push({
        id,
        local,
        titulo: titulo ?? s.name ?? (s.cwd ? basename(s.cwd) : id.slice(0, 8)),
        estado: inbox.estado,
        motivo: inbox.motivo,
        desde: f ? f.desde : (s.awaitingInputSince ?? s.updatedAt),
        fazendo: f?.texto ?? null,
        arquivada,
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
        const inbox = lerInbox(session, agentes);
        if (inbox.precisaDeVoce) out.push({ session, agentes, inbox, desktop: this.desktop?.sessaoPorCli(session.id) ?? null });
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
    if (!this.trabalho) return { total: 0, itens: [] };
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
      if (!t || !pr || pr.estado !== 'aberto' || pr.review !== 'pendente' || porUrl.has(pr.url)) continue;
      porUrl.set(pr.url, {
        numero: pr.numero,
        url: pr.url,
        repo: t.repo,
        titulo: t.issue ? `#${t.issue.numero} ${t.issue.titulo}` : t.branch,
        sessao: { id: s.id, titulo: d?.titulo ?? s.name ?? (s.cwd ? basename(s.cwd) : s.id.slice(0, 8)), local: d?.localId ?? null },
      });
    }
    const itens = [...porUrl.values()].sort((a, b) => b.numero - a.numero);
    return { total: itens.length, itens };
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
        delas.eu && minhaFamilia.mae === delas.eu ? 'mae' : minhaFamilia.eu && delas.mae === minhaFamilia.eu ? 'filha' : minhaFamilia.mae && delas.mae === minhaFamilia.mae ? 'irma' : null;
      const desde = c.session.awaitingInputSince ?? c.session.updatedAt;
      const { atividade, faixa } = atividadeDe(c.session, c.agentes, c.inbox, r, desde, agora);
      const { nivel, porque } = atencaoDe(c.inbox, r);
      itens.push({
        id: c.session.id,
        nivel,
        porque,
        local: c.desktop?.localId ?? null,
        titulo: c.desktop?.titulo ?? c.session.name ?? (c.session.cwd ? basename(c.session.cwd) : c.session.id.slice(0, 8)),
        estado: c.inbox.status === 'error' ? 'error' : 'waiting',
        motivo: c.inbox.motivo,
        urgente: c.inbox.urgente || c.inbox.status === 'error',
        desde,
        texto: faixa?.tipo === 'erro' ? faixa.texto : atividade.texto,
        modelo: c.session.model,
        relacao,
        mesmoProjeto: !!session?.cwd && c.session.cwd === session.cwd,
        conta: this.contas.daSessao(c.session, c.desktop),
      });
    }
    // Quem precisa de você antes de quem só está na sua vez (#140); dentro de cada nível, as urgentes
    // e, entre elas, o pedido mais recente, que é o que a pessoa lembra.
    const peso = (i: PrecisaDeVoce) => (i.nivel === 'precisa' ? 1 : 0)
    itens.sort((a, b) => peso(b) - peso(a) || Number(b.urgente) - Number(a.urgente) || b.desde.localeCompare(a.desde));
    // A contagem e a divisão por conta são só das que precisam de você: a sua vez não soma.
    const precisam = itens.filter((i) => i.nivel === 'precisa');
    const porConta = new Map<string, { conta: ContaDoPainel | null; n: number }>();
    for (const i of precisam) {
      const k = i.conta?.id ?? '';
      porConta.set(k, { conta: i.conta, n: (porConta.get(k)?.n ?? 0) + 1 });
    }
    return {
      total: precisam.length,
      suaVez: itens.length - precisam.length,
      porConta: [...porConta.values()].sort((a, b) => b.n - a.n),
      familia: itens.filter((i) => i.relacao !== null),
      maquina: itens.slice(0, MAX_MAQUINA),
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
    .map((m) => ({ agenteId: m.agentId!, usados: m.usedTokens, limite: m.windowTokens, pct: pctDoContexto(m), estouros: m.compactions, alerta: alertaDeContexto(m) }));
  // Só o medidor que já mediu: o que nasceu só do PreCompact mostraria "0 / 200k".
  const principal = medidores.find((m) => m.agentId === null && m.measuredAt !== null);
  const sim = session.metadata?.contexto as { usados?: unknown; limite?: unknown; estouros?: unknown } | undefined;
  if (principal && typeof sim?.usados !== 'number') {
    return {
      usados: principal.usedTokens,
      limite: principal.windowTokens,
      pct: pctDoContexto(principal),
      estouros: principal.compactions,
      alerta: alertaDeContexto(principal),
      compactacoesManuais: principal.manualCompactions,
      rotulo: rotuloDoContexto(principal),
      agentes,
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
    usados, limite, pct: pctDoContexto(c), estouros: total, alerta: alertaDeContexto(c),
    compactacoesManuais: contado?.manualCompactions ?? 0, rotulo: rotuloDoContexto(c), agentes,
  };
}

type PlanoGravado = Pick<SessionPlan, 'steps' | 'total' | 'changedAt' | 'currentStepId'>;

const RESULTADO = { current: 'atual', completed: 'concluido', abandoned: 'abandonado' } as const;

function planoDaLista(r: PlanRecord): PlanoDaSessao {
  return {
    numero: r.seq,
    resultado: RESULTADO[r.result],
    resumo: r.steps[0]?.text ?? '',
    feitos: r.done,
    total: r.total,
    atual: r.result === 'current' ? (r.steps.find((s) => s.id === r.currentStepId)?.text ?? null) : null,
    inicio: r.startedAt,
    fim: r.endedAt,
  };
}

/** O plano gravado pela porta (item 1.9); sem ele, o último TodoWrite lido dos eventos. */
function planoDe(plano: PlanoGravado | null, r: ResumoDosEventos, agentes: Agent[]): PlanoDoPainel | null {
  if (plano) {
    if (plano.total === 0) return null;
    const passos = plano.steps.map((s) => ({ id: s.id, texto: s.text, textoAtivo: s.activeText, estado: s.status, dono: donoDe(s.owner, agentes) }));
    return resumirPlano(passos, plano.changedAt, plano.currentStepId);
  }
  if (!r.plano || r.plano.length === 0) return null;
  const principal: DonoDoPasso = { tipo: 'principal', nome: null, agenteId: null };
  const passos = r.plano.map((i, n) => ({ id: String(n + 1), texto: i.texto, textoAtivo: null, estado: i.status, dono: principal }));
  return resumirPlano(passos, null, null);
}

function resumirPlano(passos: PlanoDoPainel['passos'], mudouEm: string | null, atualId: string | null): PlanoDoPainel {
  const atual = passos.find((p) => p.id === atualId) ?? passos.find((p) => p.estado === 'in_progress') ?? null;
  const pendentes = passos.filter((p) => p.estado === 'pending');
  return {
    feitos: passos.filter((p) => p.estado === 'completed').length,
    total: passos.length,
    atual: atual?.texto ?? null,
    proximo: pendentes[0]?.texto ?? null,
    restantes: Math.max(0, pendentes.length - 1),
    atualDono: atual?.dono ?? null,
    mudouEm,
    passos,
  };
}

function donoDe(o: PlanOwner, agentes: Agent[]): DonoDoPasso {
  if (o.kind === 'main') return { tipo: 'principal', nome: null, agenteId: o.agentId };
  if (o.kind === 'session') return { tipo: 'sessao', nome: o.name, agenteId: null };
  const a = o.agentId ? agentes.find((x) => x.id === o.agentId) : undefined;
  return { tipo: 'subagente', nome: o.name ?? a?.subagentType ?? a?.name ?? null, agenteId: o.agentId };
}

/**
 * Os subagentes da sessão, com quem disparou cada um e a onda (#146). O pai é o subagente dono da
 * chamada que o abriu; a sessão principal não conta como pai. A onda é o turno da sessão em que o
 * subagente de cima foi disparado: quantos turnos tinham começado até ele começar.
 */
export function subagentesDe(agentes: Agent[], inicios: readonly string[] = []): { ativos: number; itens: SubagenteDoPainel[] } {
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
      nome: a.subagentType ?? 'subagente',
      tarefa: a.name ?? a.task,
      status: a.status,
      desde: a.startedAt,
      ate: a.endedAt,
      pai: pai(a),
      onda: ondaDe(a),
    }))
    .sort((a, b) => ordem[a.status] - ordem[b.status] || b.desde.localeCompare(a.desde));
  return { ativos: subs.filter((a) => a.status === 'working').length, itens };
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
export function fazendoDa(session: Session, agentes: Agent[], inbox: LeituraDoInbox): { texto: string; desde: string } | null {
  const principal = principalDe({ session, agentes });
  const desde = principal?.updatedAt ?? session.updatedAt;
  switch (inbox.estado) {
    case 'active':
      return { texto: principal?.currentTool ? `rodando ${principal.currentTool}` : 'pensando', desde };
    case 'delegating':
      return { texto: `esperando ${inbox.subagentesAtivos || 1} subagente${inbox.subagentesAtivos > 1 ? 's' : ''}`, desde };
    case 'background':
      return { texto: `${inbox.processosEmBackground} em background`, desde };
    default:
      return null;
  }
}

export function atividadeDe(
  session: Session,
  agentes: Agent[],
  inbox: LeituraDoInbox,
  r: ResumoDosEventos,
  desde: string,
  agora: number,
): { atividade: AtividadeDaSessao; faixa: FaixaDaSessao | null } {
  const principal = principalDe({ session, agentes });
  const ferramenta = r.ultimaFerramenta;
  switch (inbox.estado) {
    case 'waiting': {
      if (inbox.motivo === 'notification') {
        const pergunta = r.ultimaPergunta && (ferramenta?.nome === 'AskUserQuestion' || r.ultimoPedido?.tipo === 'elicitation_dialog');
        if (pergunta && r.ultimaPergunta) {
          const n = r.ultimaPergunta.opcoes;
          return {
            atividade: { tipo: 'pergunta', texto: 'pergunta pendente' },
            faixa: { tipo: 'pergunta', texto: r.ultimaPergunta.texto, rodape: `${n ? `${n} opções · ` : ''}responda na conversa ao lado`, desde },
          };
        }
        const texto = ferramenta?.nome && ferramenta.resumo ? `${ferramenta.nome}: ${ferramenta.resumo}` : (r.ultimoPedido?.texto ?? 'pedido de permissão');
        return {
          atividade: { tipo: 'permissao', texto },
          faixa: { tipo: 'permissao', texto: pedidoDePermissao(r, session.cwd), rodape: 'permitir ou negar na conversa ao lado', desde },
        };
      }
      if (inbox.motivo === 'interrupted') return { atividade: { tipo: 'interrompida', texto: 'Esc no meio do turno' }, faixa: null };
      if (inbox.motivo === 'session_start') return { atividade: { tipo: 'prompt', texto: 'esperando o primeiro prompt' }, faixa: null };
      return { atividade: { tipo: 'sua-vez', texto: r.ultimaMensagem ? `"${r.ultimaMensagem}"` : 'o turno terminou' }, faixa: null };
    }
    case 'error': {
      const erro = r.ultimoErro?.texto ?? 'a sessão parou num erro';
      return {
        atividade: { tipo: 'erro', texto: erro },
        faixa: { tipo: 'erro', texto: erro, rodape: 'mande uma mensagem na conversa para retomar', desde },
      };
    }
    case 'delegating':
      return { atividade: { tipo: 'delegando', texto: `esperando ${inbox.subagentesAtivos || 1} subagente${inbox.subagentesAtivos === 1 ? '' : 's'}` }, faixa: null };
    case 'background':
      return { atividade: { tipo: 'ferramenta', texto: `${inbox.processosEmBackground} em background` }, faixa: null };
    case 'completed':
      return { atividade: { tipo: 'concluida', texto: 'terminou sem erro' }, faixa: null };
    case 'abandoned':
      return { atividade: { tipo: 'abandonada', texto: `${minutos(session.updatedAt, agora)} sem sinal` }, faixa: null };
    default: {
      const tool = principal?.currentTool ?? null;
      if (tool) return { atividade: { tipo: 'ferramenta', texto: `rodando ${tool}${ferramenta?.nome === tool && ferramenta.resumo ? ` · ${ferramenta.resumo}` : ''}` }, faixa: null };
      return { atividade: { tipo: 'ferramenta', texto: 'pensando' }, faixa: null };
    }
  }
}
