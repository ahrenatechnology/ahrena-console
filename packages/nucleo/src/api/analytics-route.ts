// The Analytics screen (#95 and #32): `GET /api/analytics` (Overview, C12), `GET /api/analytics/cost` (Cost, C13)
// and `GET /api/analytics/delivery` (Delivery, C54 to C56, #266: `?days=7|30|90&groupBy=repo|project&key=&tz=`;
// the definitions are in src/api/delivery.ts, the GitHub read in src/api/delivery-github.ts).
//
// Everything comes from the storage port, read-only:
// - cost and tokens from the slices and the cost report (src/cost/aggregation.ts), with the table
//   in force; what has no price stays `null` and the list of unpriced models goes along;
// - days by `dayOf` in the requested time zone (`?tz=<IANA>`, UTC by default);
// - add up only what adds up (decision 0006): cost and counts add up, always with the split by account beside them.
//
// Definitions:
// - session with activity on a day: it has an event or a usage slice on that day;
// - active session: persisted status `active` (not ended; includes the ones waiting for someone);
// - active agent: status `working`;
// - tool call: a `PreToolUse` (hook) or `ToolUse` (transcript) event, deduplicated by the call id
//   (`tool_use_id`/`toolUseId`), so the hook and the transcript of the same call count once.
//   `PostToolUse` does not count (it would be the same call again);
// - project: the last segment of the session's `cwd`; with no `cwd`, `(sem pasta)`.
//
// The read can be heavy (52 weeks of events):
// - the events are read in pages, from a few sessions in parallel; those outside the 30-day window
//   only go into the heatmap's per-day count and are not kept in memory;
// - the response is kept in memory per (route, parameters, today): 30 s for the Overview, 10 s for Cost.
//   With `versao` (the position of the changes cursor), it holds while nothing changes, up to 5 min.

import type { Session, SessionEvent } from '../model.ts';
import { dayOf, sessionCostSlices, costReport, type CostLine, type CostSlice } from '../cost/aggregation.ts';
import { currentPrices } from '../cost/table.ts';
import type { StoragePort } from '../storage-port.ts';
import type { Accounts } from './accounts.ts';
import {
  activeHoursPerDay,
  byDelivery,
  DELIVERY_MAX_REPOS,
  DELIVERY_ROUTE,
  deliveryNumbers,
  deliveryRow,
  GROUP_BY_ERROR,
  GROUP_BYS,
  KEY_ERROR,
  openItemsOf,
  repoActivity,
  validKey,
  type DeliveryGithubRead,
  type DeliveryGroup,
  type GroupBy,
  type RepoActivity,
  type SessionEffort,
} from './delivery.ts';
import { chaveDoRepo } from './repos-sessions.ts';

export const ANALYTICS_ROUTE = '/api/analytics';
export const COST_ROUTE = '/api/analytics/cost';
export { DELIVERY_ROUTE };
export const DIAS_DO_CUSTO = [7, 30, 90] as const;
/** Janela dos números da Visão geral. */
export const DIAS_DA_VISAO = 30;
export const SEMANAS_DO_HEATMAP = 52;
const SEM_CONTA = 'Sem conta';
const SEM_PASTA = '(sem pasta)';
/** The weekday keys of `weekday[].day`, Monday first; the /ui writes them in pt-BR. */
const DIAS_DA_SEMANA = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const FUSO = /^[A-Za-z0-9_+\-/]{1,64}$/;
const isGroupBy = (v: string): v is GroupBy => (GROUP_BYS as readonly string[]).includes(v);
/** The 400 of a bad `?tz=`. */
export const TZ_ERROR = 'tz: um fuso IANA, como America/Sao_Paulo';
/** The 400 of a bad `?days=`. */
export const DAYS_ERROR = `days: ${DIAS_DO_CUSTO.slice(0, -1).join(', ')} ou ${DIAS_DO_CUSTO.at(-1)}`;

type Porta = Pick<StoragePort, 'listSessions' | 'listAgents' | 'listEvents' | 'listTokenUsage' | 'listModelPricing'>;

export interface OpcoesDoAnalytics {
  storage: Porta;
  /** Rótulo e cor das contas, as mesmas do painel. Sem ela, "conta 1", "conta 2"… sem cor. */
  contas?: Pick<Accounts, 'refresh' | 'ofSession'> | null;
  agora?: () => number;
  /** Quanto a resposta da Visão geral fica em memória mesmo com mudanças. Padrão 30 s. */
  cacheMsDaVisao?: number;
  /** O mesmo para o Custo. Padrão 10 s. */
  cacheMsDoCusto?: number;
  /** A posição do cursor de mudanças (`ChangeCursor.current`): sem mudança, a resposta vale até 5 min. */
  versao?: () => string;
  /** The Delivery tab's sources (#266). Without them, the tab answers as with GitHub not connected. */
  delivery?: DeliveryOptions | null;
  /** How long the Delivery answer stays in memory even with changes. Default 5 s. */
  deliveryCacheMs?: number;
}

/** Where the Delivery tab (#266) reads from, besides the storage. */
export interface DeliveryOptions {
  /** The GitHub side, from the cache (src/api/delivery-github.ts). */
  github: { read(repos: readonly string[]): Promise<DeliveryGithubRead> };
  /** The repository (`owner/name`) of a session's cwd: `null` with none, `undefined` while unknown (src/api/repos-sessions.ts). */
  repoOfCwd: (cwd: string) => string | null | undefined;
  /** The GitHub Projects the console reads, each with the repositories that have items in it (key `owner/number`). */
  /** `pending`: the first read has not landed yet, so no Projects is not yet known to mean none. */
  projects?: () => Promise<{ projects: DeliveryGroup[]; error: string | null; pending?: boolean }>;
  /** The account's repositories (the Repositories screen's list), so a repository with no session shows too. */
  accountRepos?: () => Promise<{ fullName: string; lastPush: string | null }[]>;
}

/** Quanto a resposta vale, sem mudança no cursor. */
const CACHE_MAXIMO_MS = 5 * 60_000;
/** Sessões lidas em paralelo. */
const LEITURAS_EM_PARALELO = 6;

export interface ContaDoAnalytics {
  id: string | null;
  label: string;
  color: string | null;
}

export interface RespostaDoAnalytics {
  status: number;
  corpo: unknown;
}

class ParametroInvalido extends Error {}

// ---- dias -------------------------------------------------------------------------------------

const MS_DIA = 86_400_000;
const somarDias = (dia: string, n: number): string => new Date(Date.parse(`${dia}T00:00:00Z`) + n * MS_DIA).toISOString().slice(0, 10);
/** 0 = segunda … 6 = domingo. */
const indiceDaSemana = (dia: string): number => (new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7;
function diasEntre(desde: string, ate: string): string[] {
  const out: string[] = [];
  for (let d = desde; d <= ate; d = somarDias(d, 1)) out.push(d);
  return out;
}

export function validarFuso(v: string | null): string {
  if (v === null || v === '') return 'UTC';
  if (!FUSO.test(v)) throw new ParametroInvalido(TZ_ERROR);
  try {
    // A forma canônica: `america/sao_paulo` vira `America/Sao_Paulo`.
    return new Intl.DateTimeFormat('en-CA', { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    throw new ParametroInvalido(TZ_ERROR);
  }
}

const arredondar = (v: number | null, casas = 4): number | null => (v === null ? null : Math.round(v * 10 ** casas) / 10 ** casas);
const pct = (parte: number, todo: number): number | null => (todo > 0 ? arredondar((parte / todo) * 100, 1) : null);
const entradaDe = (l: CostLine) => l.tokens.input + l.tokens.cacheRead + l.tokens.cacheWrite5m + l.tokens.cacheWrite1h;
const cachePctDe = (l: CostLine) => pct(l.tokens.cacheRead, entradaDe(l));
const projetoDe = (cwd: string | null): string => (cwd ? cwd.replace(/\/+$/, '').split('/').pop() || SEM_PASTA : SEM_PASTA);

function pico<T extends { day: string }>(dias: readonly T[], valor: (d: T) => number | null): T | null {
  let melhor: T | null = null;
  for (const d of dias) if ((valor(d) ?? 0) > 0 && (!melhor || (valor(d) ?? 0) > (valor(melhor) ?? 0))) melhor = d;
  return melhor;
}

// ---- leitura ----------------------------------------------------------------------------------

interface SessaoLida {
  sessao: Session;
  /** Todos os eventos da sessão, só quando ela teve atividade na janela guardada; senão vazio. */
  eventos: SessionEvent[];
}

/** `fn` para cada item, com no máximo `limite` em andamento; a ordem do resultado é a dos itens. */
async function emParalelo<T, R>(itens: readonly T[], limite: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(itens.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      out[i] = await fn(itens[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, trabalhador));
  return out;
}

async function sessoesDesde(porta: Porta, desde: string, fuso: string): Promise<Session[]> {
  const out: Session[] = [];
  let cursor: string | null = null;
  do {
    const page = await porta.listSessions({ limit: 500, cursor });
    for (const s of page.items) {
      // Mais recentes primeiro: sessão parada antes do primeiro dia não tem nada no período.
      if (dayOf(s.updatedAt, fuso) < desde) return out;
      out.push(s);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** Pagina os eventos da sessão, chamando `aoLer` em cada um; guarda a lista só se `guardar`. */
async function eventosDa(porta: Porta, sessionId: string, guardar: boolean, aoLer: ((e: SessionEvent) => void) | null): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await porta.listEvents(sessionId, { limit: 500, cursor });
    for (const e of page.items) {
      aoLer?.(e);
      if (guardar) out.push(e);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** As parcelas da sessão sem reler os eventos: a porta das parcelas devolve os já lidos. */
function parcelasDe(porta: Porta, lida: SessaoLida, precos: Parameters<typeof sessionCostSlices>[2], fuso: string): Promise<CostSlice[]> {
  return sessionCostSlices(
    { listEvents: async () => ({ items: lida.eventos, nextCursor: null }), listTokenUsage: (id) => porta.listTokenUsage(id) },
    lida.sessao.id,
    precos,
    fuso,
  );
}

function idDaChamada(e: SessionEvent): string | null {
  const d = e.data as { tool_use_id?: unknown; toolUseId?: unknown } | null;
  const id = d?.tool_use_id ?? d?.toolUseId;
  return typeof id === 'string' && id ? id : null;
}

// ---- a rota -----------------------------------------------------------------------------------

export class RotaAnalytics {
  private readonly porta: Porta;
  private readonly contas: Pick<Accounts, 'refresh' | 'ofSession'> | null;
  private readonly agora: () => number;
  private readonly cacheMs: { visao: number; custo: number; delivery: number };
  private readonly deliverySources: DeliveryOptions | null;
  private readonly versao: (() => string) | null;
  private readonly cache = new Map<string, { em: number; versao: string | null; ttl: number; corpo: Promise<unknown> }>();

  constructor({ storage, contas = null, agora = Date.now, cacheMsDaVisao = 30_000, cacheMsDoCusto = 10_000, versao, delivery = null, deliveryCacheMs = 5_000 }: OpcoesDoAnalytics) {
    this.porta = storage;
    this.contas = contas;
    this.agora = agora;
    this.cacheMs = { visao: cacheMsDaVisao, custo: cacheMsDoCusto, delivery: deliveryCacheMs };
    this.deliverySources = delivery;
    this.versao = versao ?? null;
  }

  /** `true` quando o caminho é desta rota. */
  static atende(pathname: string): boolean {
    return pathname === ANALYTICS_ROUTE || pathname.startsWith(`${ANALYTICS_ROUTE}/`);
  }

  async responder(url: URL): Promise<RespostaDoAnalytics> {
    try {
      const fuso = validarFuso(url.searchParams.get('tz'));
      const hoje = dayOf(new Date(this.agora()).toISOString(), fuso);
      if (url.pathname === ANALYTICS_ROUTE) return { status: 200, corpo: await this.emCache(`visao?${fuso}&${hoje}`, this.cacheMs.visao, () => this.visaoGeral(fuso)) };
      if (url.pathname === COST_ROUTE) {
        const dias = Number(url.searchParams.get('days') ?? 30);
        if (!DIAS_DO_CUSTO.includes(dias as (typeof DIAS_DO_CUSTO)[number])) throw new ParametroInvalido(DAYS_ERROR);
        return { status: 200, corpo: await this.emCache(`custo?${dias}&${fuso}&${hoje}`, this.cacheMs.custo, () => this.custo(dias, fuso)) };
      }
      if (url.pathname === DELIVERY_ROUTE) {
        // The same period rule as the cost route.
        const days = Number(url.searchParams.get('days') ?? 30);
        if (!DIAS_DO_CUSTO.includes(days as (typeof DIAS_DO_CUSTO)[number])) throw new ParametroInvalido(DAYS_ERROR);
        const groupBy = url.searchParams.get('groupBy') ?? 'repo';
        if (!isGroupBy(groupBy)) throw new ParametroInvalido(GROUP_BY_ERROR);
        const key = validKey(groupBy, url.searchParams.get('key'));
        if (key === undefined) throw new ParametroInvalido(KEY_ERROR);
        return { status: 200, corpo: await this.emCache(`delivery?${days}&${fuso}&${groupBy}&${key}&${hoje}`, this.cacheMs.delivery, () => this.delivery(days, fuso, groupBy, key)) };
      }
      return { status: 404, corpo: { error: 'não encontrado' } };
    } catch (err) {
      if (err instanceof ParametroInvalido) return { status: 400, corpo: { error: err.message } };
      throw err;
    }
  }

  // Vale enquanto é nova (`ttl`) ou, com o cursor, enquanto nada mudou (até `CACHE_MAXIMO_MS`).
  private emCache(chave: string, ttl: number, calcular: () => Promise<unknown>): Promise<unknown> {
    const agora = this.agora();
    const versao = this.versao?.() ?? null;
    const vale = (v: { em: number; versao: string | null; ttl: number }) =>
      agora - v.em < v.ttl || (versao !== null && v.versao === versao && agora - v.em < CACHE_MAXIMO_MS);
    for (const [k, v] of this.cache) if (!vale(v)) this.cache.delete(k);
    const tem = this.cache.get(chave);
    if (tem) return tem.corpo;
    const corpo = calcular();
    this.cache.set(chave, { em: agora, versao, ttl, corpo });
    corpo.catch(() => this.cache.delete(chave));
    return corpo;
  }

  private contaDe(s: Session): ContaDoAnalytics {
    if (!this.contas) return s.accountId ? { id: s.accountId, label: s.accountId, color: null } : { id: null, label: SEM_CONTA, color: null };
    const c = this.contas.ofSession(s, null);
    return c ? { id: c.id, label: c.label, color: c.color } : { id: null, label: SEM_CONTA, color: null };
  }

  /**
   * As sessões com `updatedAt` desde `desde`, com os eventos guardados só das que têm `updatedAt` desde
   * `guardarDesde`. `aoLer` vê todo evento lido, guardado ou não (o heatmap conta por ele).
   */
  private async lerJanela(desde: string, guardarDesde: string, fuso: string, aoLer: ((e: SessionEvent) => void) | null = null): Promise<SessaoLida[]> {
    await this.contas?.refresh();
    const sessoes = await sessoesDesde(this.porta, desde, fuso);
    return emParalelo(sessoes, LEITURAS_EM_PARALELO, async (sessao) => {
      const guardar = dayOf(sessao.updatedAt, fuso) >= guardarDesde;
      return { sessao, eventos: await eventosDa(this.porta, sessao.id, guardar, aoLer) };
    });
  }

  /** Parcelas de cada sessão dentro de [desde, ate], com a conta de cada sessão. */
  private async parcelasDaJanela(lidas: readonly SessaoLida[], desde: string, ate: string, fuso: string) {
    const precos = await currentPrices(this.porta);
    const porSessao = new Map<string, CostSlice[]>();
    const contaDaSessao = new Map<string, ContaDoAnalytics>();
    for (const l of lidas) {
      if (dayOf(l.sessao.updatedAt, fuso) < desde) continue;
      const ps = (await parcelasDe(this.porta, l, precos, fuso)).filter((p) => p.day >= desde && p.day <= ate);
      porSessao.set(l.sessao.id, ps);
      contaDaSessao.set(l.sessao.id, this.contaDe(l.sessao));
    }
    return { porSessao, contaDaSessao, todas: [...porSessao.values()].flat() };
  }

  /** As contas na ordem em que aparecem, sem repetir; "Sem conta" por último. */
  private static contasDistintas(contas: Iterable<ContaDoAnalytics>): ContaDoAnalytics[] {
    const m = new Map<string | null, ContaDoAnalytics>();
    for (const c of contas) if (!m.has(c.id)) m.set(c.id, c);
    return [...m.values()].sort((a, b) => Number(a.id === null) - Number(b.id === null));
  }

  // ---- Visão geral ----------------------------------------------------------------------------

  async visaoGeral(fuso: string) {
    const geradoEm = new Date(this.agora()).toISOString();
    const hoje = dayOf(geradoEm, fuso);
    const desde = somarDias(hoje, -(DIAS_DA_VISAO - 1));
    // 52 semanas alinhadas à segunda: começa na segunda de 51 semanas antes da semana de hoje.
    const desdeHeatmap = somarDias(hoje, -indiceDaSemana(hoje) - 7 * (SEMANAS_DO_HEATMAP - 1));
    const eventosPorDia = new Map<string, number>();
    const contarNoHeatmap = (e: SessionEvent) => {
      const dia = dayOf(e.createdAt, fuso);
      if (dia >= desdeHeatmap && dia <= hoje) eventosPorDia.set(dia, (eventosPorDia.get(dia) ?? 0) + 1);
    };
    const lidas = await this.lerJanela(desdeHeatmap, desde, fuso, contarNoHeatmap);
    const { porSessao, contaDaSessao, todas } = await this.parcelasDaJanela(lidas, desde, hoje, fuso);

    const sessoesPorDia = new Map<string, Set<string>>();
    const marcar = (dia: string, id: string) => {
      if (dia < desde || dia > hoje) return;
      const s = sessoesPorDia.get(dia) ?? new Set<string>();
      s.add(id);
      sessoesPorDia.set(dia, s);
    };
    const ferramentas = new Map<string, number>();
    const chamadasVistas = new Set<string>();
    let eventosNaJanela = 0;
    const comAtividade: Session[] = [];

    for (const { sessao, eventos } of lidas) {
      let ativa = false;
      for (const e of eventos) {
        const dia = dayOf(e.createdAt, fuso);
        if (dia < desde || dia > hoje) continue;
        ativa = true;
        eventosNaJanela++;
        marcar(dia, sessao.id);
        if ((e.type === 'PreToolUse' || e.type === 'ToolUse') && e.toolName) {
          const id = idDaChamada(e);
          if (id) {
            const chave = `${sessao.id}\0${id}`;
            if (chamadasVistas.has(chave)) continue;
            chamadasVistas.add(chave);
          }
          ferramentas.set(e.toolName, (ferramentas.get(e.toolName) ?? 0) + 1);
        }
      }
      for (const p of porSessao.get(sessao.id) ?? []) {
        ativa = true;
        marcar(p.day, sessao.id);
      }
      if (ativa) comAtividade.push(sessao);
    }

    let agentes = 0;
    let agentesAtivos = 0;
    for (const s of comAtividade) {
      for (const a of await this.porta.listAgents(s.id)) {
        agentes++;
        if (a.status === 'working') agentesAtivos++;
      }
    }

    const relatorio = costReport(todas, fuso);
    const contas = RotaAnalytics.contasDistintas(comAtividade.map((s) => contaDaSessao.get(s.id) ?? this.contaDe(s)));
    const porConta = contas.map((c) => {
      const ps = todas.filter((p) => (contaDaSessao.get(p.sessionId)?.id ?? null) === c.id);
      const total = costReport(ps, fuso).total;
      return { account: c.id, usd: arredondar(total.costUsd), unpriced: total.unpriced.models };
    });

    const ultimos = diasEntre(desde, hoje).map((day) => ({ day, sessions: sessoesPorDia.get(day)?.size ?? 0 }));
    const porDiaDaSemana = DIAS_DA_SEMANA.map((day) => ({ day, sessions: 0 }));
    for (const d of ultimos) porDiaDaSemana[indiceDaSemana(d.day)].sessions += d.sessions;
    const picoDosDias = pico(ultimos, (d) => d.sessions);

    return {
      generatedAt: geradoEm,
      timeZone: fuso,
      today: hoje,
      since: desde,
      until: hoje,
      accounts: contas,
      numbers: {
        sessions: { total: comAtividade.length, active: comAtividade.filter((s) => s.status === 'active').length },
        agents: { total: agentes, active: agentesAtivos },
        tokens: { total: relatorio.total.totalTokens, cachePct: cachePctDe(relatorio.total) },
        cost: { usd: arredondar(relatorio.total.costUsd), days: DIAS_DA_VISAO, unpriced: relatorio.total.unpriced.models, byAccount: porConta },
        events: { total: eventosNaJanela, perSession: comAtividade.length ? arredondar(eventosNaJanela / comAtividade.length, 1) : null },
      },
      activity: {
        weeks: SEMANAS_DO_HEATMAP,
        since: desdeHeatmap,
        days: diasEntre(desdeHeatmap, hoje).map((day) => ({ day, events: eventosPorDia.get(day) ?? 0 })),
      },
      last30: {
        days: ultimos,
        peak: picoDosDias ? { day: picoDosDias.day, sessions: picoDosDias.sessions } : null,
        total: ultimos.reduce((s, d) => s + d.sessions, 0),
      },
      tokensByModel: relatorio.byModel
        .map((l) => ({ model: l.key, tokens: l.totalTokens }))
        .filter((l) => l.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
      tools: [...ferramentas]
        .map(([name, uses]) => ({ name, uses }))
        .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
        .slice(0, 5),
      weekday: porDiaDaSemana,
    };
  }

  // ---- Custo ----------------------------------------------------------------------------------

  async custo(dias: number, fuso: string) {
    const geradoEm = new Date(this.agora()).toISOString();
    const hoje = dayOf(geradoEm, fuso);
    const desde = somarDias(hoje, -(dias - 1));
    const lidas = await this.lerJanela(desde, desde, fuso);
    const { porSessao, contaDaSessao, todas } = await this.parcelasDaJanela(lidas, desde, hoje, fuso);
    const relatorio = costReport(todas, fuso);
    const calendario = diasEntre(desde, hoje);

    const porDiaDe = (r: ReturnType<typeof costReport>) => {
      const m = new Map(r.byDay.map((l) => [l.key, l.costUsd]));
      return calendario.map((day) => ({ day, usd: m.has(day) ? arredondar(m.get(day)!) : 0 }));
    };
    const porDia = porDiaDe(relatorio);
    const linhaDeHoje = relatorio.byDay.find((l) => l.key === hoje);
    const picoDoCusto = pico(porDia, (d) => d.usd);

    const somaComPreco = relatorio.byModel.reduce((s, l) => s + (l.costUsd ?? 0), 0);
    const projetos = new Map<string, CostSlice[]>();
    const cwdDe = new Map(lidas.map((l) => [l.sessao.id, l.sessao.cwd]));
    for (const p of todas) {
      const k = projetoDe(cwdDe.get(p.sessionId) ?? null);
      const lista = projetos.get(k) ?? [];
      lista.push(p);
      projetos.set(k, lista);
    }

    const sessoesComUso = [...porSessao].filter(([, ps]) => ps.length > 0).map(([id]) => id);
    const contas = RotaAnalytics.contasDistintas(sessoesComUso.map((id) => contaDaSessao.get(id)!));
    const porConta = contas.map((c) => ({ c, r: costReport(todas.filter((p) => (contaDaSessao.get(p.sessionId)?.id ?? null) === c.id), fuso) }));

    return {
      generatedAt: geradoEm,
      timeZone: fuso,
      days: dias,
      today: hoje,
      since: desde,
      until: hoje,
      estimate: true as const,
      currency: 'USD' as const,
      accounts: contas,
      todaySummary: {
        usd: linhaDeHoje ? arredondar(linhaDeHoje.costUsd) : 0,
        sessions: new Set(todas.filter((p) => p.day === hoje).map((p) => p.sessionId)).size,
        // A divisão por conta (decisão 0006), do dia de hoje de cada uma; conta sem uso hoje vale 0.
        byAccount: porConta.map(({ c, r }) => {
          const l = r.byDay.find((d) => d.key === hoje);
          return { account: c.id, label: c.label, color: c.color, usd: l ? arredondar(l.costUsd) : 0, unpriced: l?.unpriced.models ?? [] };
        }),
      },
      period: {
        usd: arredondar(relatorio.total.costUsd),
        dailyAverage: relatorio.total.costUsd === null ? null : arredondar(relatorio.total.costUsd / dias),
      },
      cache: { pct: cachePctDe(relatorio.total) },
      unpriced: { models: relatorio.total.unpriced.models, totalTokens: relatorio.total.unpriced.totalTokens },
      byDay: porDia,
      peak: picoDoCusto ? { day: picoDoCusto.day, usd: picoDoCusto.usd } : null,
      byModel: relatorio.byModel.map((l) => ({
        model: l.key,
        usd: arredondar(l.costUsd),
        pct: l.costUsd === null ? null : pct(l.costUsd, somaComPreco),
        totalTokens: l.totalTokens,
      })),
      byProject: [...projetos]
        .map(([project, ps]) => ({ project, usd: arredondar(costReport(ps, fuso).total.costUsd) }))
        .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || a.project.localeCompare(b.project)),
      byAccount: porConta.map(({ c, r }) => ({
        account: c.id,
        label: c.label,
        color: c.color,
        usd: arredondar(r.total.costUsd),
        unpriced: r.total.unpriced.models,
        byDay: porDiaDe(r),
      })),
    };
  }
  // ---- Delivery (#266) ------------------------------------------------------------------------

  async delivery(days: number, timeZone: string, groupBy: GroupBy, key: string | null) {
    const generatedAt = new Date(this.agora()).toISOString();
    const today = dayOf(generatedAt, timeZone);
    const since = somarDias(today, -(days - 1));
    const calendar = diasEntre(since, today);
    const head = { generatedAt, timeZone, days, today, since, until: today, calendar, groupBy, key };
    const sources = this.deliverySources;
    const disconnected = (projectsError: string | null = null, projectsPending = false) => ({
      ...head,
      github: { status: 'disconnected' as const, readAt: null, error: null, pending: 0, truncated: [] as string[] },
      totals: emptyDeliveryTotals(),
      rows: [],
      openItems: [],
      openItemsTotal: 0,
      openItemsTruncated: false,
      options: { repos: [], projects: [] },
      projectsError,
      projectsPending,
    });
    if (!sources) return disconnected();

    // The Claude side: the sessions of the period, by the repository of their cwd.
    const read = await this.lerJanela(since, since, timeZone);
    const { porSessao } = await this.parcelasDaJanela(read, since, today, timeZone);
    const efforts: SessionEffort[] = [];
    for (const { sessao, eventos } of read) {
      const repo = sessao.cwd ? sources.repoOfCwd(sessao.cwd) : null;
      if (!repo) continue;
      const times = eventos.map((e) => e.createdAt).filter((t) => {
        const d = dayOf(t, timeZone);
        return d >= since && d <= today;
      });
      const slices = porSessao.get(sessao.id) ?? [];
      if (times.length === 0 && slices.length === 0) continue;
      efforts.push({ repo: chaveDoRepo(repo), hoursPerDay: activeHoursPerDay(times, calendar, timeZone), slices });
    }

    // The projects and the repositories to read: with sessions first, then the projects', then the latest pushed.
    let projectsError: string | null = null;
    const projects = sources.projects
      ? await sources.projects().catch((err: unknown) => ({ projects: [] as DeliveryGroup[], error: err instanceof Error ? err.message : String(err) }))
      : { projects: [] as DeliveryGroup[], error: null };
    projectsError = projects.error;
    const projectsPending = 'pending' in projects && projects.pending === true;
    const projectGroups = projects.projects.map((p) => ({ key: p.key, label: p.label, repos: [...new Set(p.repos.map(chaveDoRepo))] }));
    const hours = new Map<string, number>();
    for (const e of efforts) hours.set(e.repo, (hours.get(e.repo) ?? 0) + e.hoursPerDay.reduce((s, h) => s + h, 0));
    const pushed = sources.accountRepos ? await sources.accountRepos().catch(() => []) : [];
    const candidates = [
      ...[...hours].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r),
      ...projectGroups.flatMap((p) => p.repos),
      ...pushed
        .filter((r) => r.lastPush && dayOf(r.lastPush, timeZone) >= since)
        .sort((a, b) => Date.parse(b.lastPush!) - Date.parse(a.lastPush!))
        .map((r) => chaveDoRepo(r.fullName)),
    ];
    const unique = [...new Set(candidates)];
    const repos = unique.slice(0, DELIVERY_MAX_REPOS);
    const github = await sources.github.read(repos);
    if (unique.length > repos.length) github.truncated.push(`${unique.length - repos.length} repositórios de fora: o teto é ${DELIVERY_MAX_REPOS}`);
    if (github.status === 'disconnected') return disconnected(projectsError, projectsPending);

    const now = this.agora();
    const activities = new Map<string, RepoActivity>();
    for (const [k, raw] of github.repos) activities.set(k, repoActivity(raw, calendar, timeZone, now));
    const repoGroups = [...activities.values()].map((a) => ({ key: a.key, label: a.repo, repos: [a.key] })).sort((a, b) => a.label.localeCompare(b.label));
    const shownProjects = projectGroups.filter((p) => p.repos.some((r) => activities.has(r)));
    const groups = groupBy === 'repo' ? repoGroups : shownProjects;
    const selected = key === null ? groups : groups.filter((g) => g.key.toLowerCase() === key.toLowerCase());
    const rows = selected.map((g) => deliveryRow(g, activities, efforts, days, timeZone)).sort(byDelivery);
    const { reposWithClaude, repoCount, ...totals } = deliveryNumbers(
      selected.flatMap((g) => g.repos),
      activities,
      efforts,
      days,
      timeZone,
    );
    const open = openItemsOf(selected, activities);
    return {
      ...head,
      github: { status: github.status, readAt: github.readAt === null ? null : new Date(github.readAt).toISOString(), error: github.error, pending: github.pending, truncated: github.truncated },
      totals: {
        mergedPrs: totals.mergedPrs,
        medianLeadTimeMs: totals.medianLeadTimeMs,
        openPrs: totals.openPrs,
        openIssues: totals.openIssues,
        claudeHours: totals.claudeHours,
        costUsd: totals.costUsd,
        costPartial: totals.costPartial,
        costPerMergedPr: totals.costPerMergedPr,
        repos: repoCount,
        reposWithClaude,
      },
      rows,
      openItems: open.items,
      openItemsTotal: open.total,
      openItemsTruncated: open.total > open.items.length,
      options: { repos: repoGroups.map((g) => ({ key: g.key, label: g.label })), projects: shownProjects.map((p) => ({ key: p.key, label: p.label, repos: p.repos })) },
      projectsError,
      projectsPending,
    };
  }
}

/** The Delivery totals with nothing known: GitHub not connected (#266 AC-8). */
function emptyDeliveryTotals() {
  return {
    mergedPrs: null,
    medianLeadTimeMs: null,
    openPrs: null,
    openIssues: null,
    claudeHours: null,
    costUsd: null,
    costPartial: false,
    costPerMergedPr: null,
    repos: 0,
    reposWithClaude: 0,
  };
}
