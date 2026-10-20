// A tela Analytics (#95 e #32): `GET /api/analytics` (Visão geral, C12) e `GET /api/analytics/cost` (Custo, C13).
//
// Tudo sai da porta de armazenamento, só leitura:
// - custo e tokens pelas parcelas e pelo relatório de custo (src/custo/agregacao.ts), com a tabela
//   vigente; o que não tem preço fica `null` e a lista dos modelos sem preço vai junto;
// - dias pelo `diaDe` no fuso pedido (`?tz=<IANA>`, padrão UTC);
// - somar só o que soma (decisão 0006): custo e contagens somam, sempre com a divisão por conta ao lado.
//
// Definições:
// - sessão com atividade num dia: tem evento ou parcela de uso nesse dia;
// - sessão ativa: status persistido `active` (não encerrada; inclui as que esperam alguém);
// - agente ativo: status `working`;
// - chamada de ferramenta: evento `PreToolUse` (hook) ou `ToolUse` (transcript), deduplicado pelo id
//   da chamada (`tool_use_id`/`toolUseId`), para o hook e o transcript da mesma chamada contarem uma vez.
//   `PostToolUse` não conta (seria a mesma chamada de novo);
// - projeto: o último segmento do `cwd` da sessão; sem `cwd`, `(sem pasta)`.
//
// A leitura pode ser pesada (os eventos de 52 semanas):
// - os eventos são lidos em páginas, de algumas sessões em paralelo; os de fora da janela de 30 dias
//   só entram na contagem por dia do heatmap e não ficam em memória;
// - a resposta fica em memória por (rota, parâmetros, dia de hoje): 30 s na Visão geral, 10 s no Custo.
//   Com `versao` (a posição do cursor de mudanças), fica enquanto nada mudar, até 5 min.

import type { Session, SessionEvent } from '../model.ts';
import { diaDe, parcelasDaSessao, relatorioDeCusto, type LinhaDeCusto, type Parcela } from '../custo/agregacao.ts';
import { precosVigentes } from '../custo/tabela.ts';
import type { StoragePort } from '../storage-port.ts';
import type { Contas } from './contas.ts';

export const ROTA_DO_ANALYTICS = '/api/analytics';
export const COST_ROUTE = '/api/analytics/cost';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DO_CUSTO = '/api/analytics/custo';
export const DIAS_DO_CUSTO = [7, 30, 90] as const;
/** Janela dos números da Visão geral. */
export const DIAS_DA_VISAO = 30;
export const SEMANAS_DO_HEATMAP = 52;
const SEM_CONTA = 'Sem conta';
const SEM_PASTA = '(sem pasta)';
/** The weekday keys of `weekday[].day`, Monday first; the /ui writes them in pt-BR. */
const DIAS_DA_SEMANA = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const FUSO = /^[A-Za-z0-9_+\-/]{1,64}$/;
/** The 400 of a bad `?tz=` (the old route answers it with `fuso:`, src/api/legacy-routes.ts). */
export const TZ_ERROR = 'tz: um fuso IANA, como America/Sao_Paulo';
/** The 400 of a bad `?days=` (the old route answers it with `dias:`). */
export const DAYS_ERROR = `days: ${DIAS_DO_CUSTO.slice(0, -1).join(', ')} ou ${DIAS_DO_CUSTO.at(-1)}`;

type Porta = Pick<StoragePort, 'listSessions' | 'listAgents' | 'listEvents' | 'listTokenUsage' | 'listModelPricing'>;

export interface OpcoesDoAnalytics {
  storage: Porta;
  /** Rótulo e cor das contas, as mesmas do painel. Sem ela, "conta 1", "conta 2"… sem cor. */
  contas?: Pick<Contas, 'atualizar' | 'daSessao'> | null;
  agora?: () => number;
  /** Quanto a resposta da Visão geral fica em memória mesmo com mudanças. Padrão 30 s. */
  cacheMsDaVisao?: number;
  /** O mesmo para o Custo. Padrão 10 s. */
  cacheMsDoCusto?: number;
  /** A posição do cursor de mudanças (`CursorDeMudancas.atual`): sem mudança, a resposta vale até 5 min. */
  versao?: () => string;
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
const entradaDe = (l: LinhaDeCusto) => l.tokens.input + l.tokens.cacheRead + l.tokens.cacheWrite5m + l.tokens.cacheWrite1h;
const cachePctDe = (l: LinhaDeCusto) => pct(l.tokens.cacheRead, entradaDe(l));
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
      if (diaDe(s.updatedAt, fuso) < desde) return out;
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
function parcelasDe(porta: Porta, lida: SessaoLida, precos: Parameters<typeof parcelasDaSessao>[2], fuso: string): Promise<Parcela[]> {
  return parcelasDaSessao(
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
  private readonly contas: Pick<Contas, 'atualizar' | 'daSessao'> | null;
  private readonly agora: () => number;
  private readonly cacheMs: { visao: number; custo: number };
  private readonly versao: (() => string) | null;
  private readonly cache = new Map<string, { em: number; versao: string | null; ttl: number; corpo: Promise<unknown> }>();

  constructor({ storage, contas = null, agora = Date.now, cacheMsDaVisao = 30_000, cacheMsDoCusto = 10_000, versao }: OpcoesDoAnalytics) {
    this.porta = storage;
    this.contas = contas;
    this.agora = agora;
    this.cacheMs = { visao: cacheMsDaVisao, custo: cacheMsDoCusto };
    this.versao = versao ?? null;
  }

  /** `true` quando o caminho é desta rota. */
  static atende(pathname: string): boolean {
    return pathname === ROTA_DO_ANALYTICS || pathname.startsWith(`${ROTA_DO_ANALYTICS}/`);
  }

  async responder(url: URL): Promise<RespostaDoAnalytics> {
    try {
      const fuso = validarFuso(url.searchParams.get('tz'));
      const hoje = diaDe(new Date(this.agora()).toISOString(), fuso);
      if (url.pathname === ROTA_DO_ANALYTICS) return { status: 200, corpo: await this.emCache(`visao?${fuso}&${hoje}`, this.cacheMs.visao, () => this.visaoGeral(fuso)) };
      if (url.pathname === COST_ROUTE) {
        const dias = Number(url.searchParams.get('days') ?? 30);
        if (!DIAS_DO_CUSTO.includes(dias as (typeof DIAS_DO_CUSTO)[number])) throw new ParametroInvalido(DAYS_ERROR);
        return { status: 200, corpo: await this.emCache(`custo?${dias}&${fuso}&${hoje}`, this.cacheMs.custo, () => this.custo(dias, fuso)) };
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
    const c = this.contas.daSessao(s, null);
    return c ? { id: c.id, label: c.label, color: c.color } : { id: null, label: SEM_CONTA, color: null };
  }

  /**
   * As sessões com `updatedAt` desde `desde`, com os eventos guardados só das que têm `updatedAt` desde
   * `guardarDesde`. `aoLer` vê todo evento lido, guardado ou não (o heatmap conta por ele).
   */
  private async lerJanela(desde: string, guardarDesde: string, fuso: string, aoLer: ((e: SessionEvent) => void) | null = null): Promise<SessaoLida[]> {
    await this.contas?.atualizar();
    const sessoes = await sessoesDesde(this.porta, desde, fuso);
    return emParalelo(sessoes, LEITURAS_EM_PARALELO, async (sessao) => {
      const guardar = diaDe(sessao.updatedAt, fuso) >= guardarDesde;
      return { sessao, eventos: await eventosDa(this.porta, sessao.id, guardar, aoLer) };
    });
  }

  /** Parcelas de cada sessão dentro de [desde, ate], com a conta de cada sessão. */
  private async parcelasDaJanela(lidas: readonly SessaoLida[], desde: string, ate: string, fuso: string) {
    const precos = await precosVigentes(this.porta);
    const porSessao = new Map<string, Parcela[]>();
    const contaDaSessao = new Map<string, ContaDoAnalytics>();
    for (const l of lidas) {
      if (diaDe(l.sessao.updatedAt, fuso) < desde) continue;
      const ps = (await parcelasDe(this.porta, l, precos, fuso)).filter((p) => p.dia >= desde && p.dia <= ate);
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
    const hoje = diaDe(geradoEm, fuso);
    const desde = somarDias(hoje, -(DIAS_DA_VISAO - 1));
    // 52 semanas alinhadas à segunda: começa na segunda de 51 semanas antes da semana de hoje.
    const desdeHeatmap = somarDias(hoje, -indiceDaSemana(hoje) - 7 * (SEMANAS_DO_HEATMAP - 1));
    const eventosPorDia = new Map<string, number>();
    const contarNoHeatmap = (e: SessionEvent) => {
      const dia = diaDe(e.createdAt, fuso);
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
        const dia = diaDe(e.createdAt, fuso);
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
        marcar(p.dia, sessao.id);
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

    const relatorio = relatorioDeCusto(todas, fuso);
    const contas = RotaAnalytics.contasDistintas(comAtividade.map((s) => contaDaSessao.get(s.id) ?? this.contaDe(s)));
    const porConta = contas.map((c) => {
      const ps = todas.filter((p) => (contaDaSessao.get(p.sessionId)?.id ?? null) === c.id);
      const total = relatorioDeCusto(ps, fuso).total;
      return { account: c.id, usd: arredondar(total.custoUsd), unpriced: total.semPreco.modelos };
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
        tokens: { total: relatorio.total.totalDeTokens, cachePct: cachePctDe(relatorio.total) },
        cost: { usd: arredondar(relatorio.total.custoUsd), days: DIAS_DA_VISAO, unpriced: relatorio.total.semPreco.modelos, byAccount: porConta },
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
      tokensByModel: relatorio.porModelo
        .map((l) => ({ model: l.chave, tokens: l.totalDeTokens }))
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
    const hoje = diaDe(geradoEm, fuso);
    const desde = somarDias(hoje, -(dias - 1));
    const lidas = await this.lerJanela(desde, desde, fuso);
    const { porSessao, contaDaSessao, todas } = await this.parcelasDaJanela(lidas, desde, hoje, fuso);
    const relatorio = relatorioDeCusto(todas, fuso);
    const calendario = diasEntre(desde, hoje);

    const porDiaDe = (r: ReturnType<typeof relatorioDeCusto>) => {
      const m = new Map(r.porDia.map((l) => [l.chave, l.custoUsd]));
      return calendario.map((day) => ({ day, usd: m.has(day) ? arredondar(m.get(day)!) : 0 }));
    };
    const porDia = porDiaDe(relatorio);
    const linhaDeHoje = relatorio.porDia.find((l) => l.chave === hoje);
    const picoDoCusto = pico(porDia, (d) => d.usd);

    const somaComPreco = relatorio.porModelo.reduce((s, l) => s + (l.custoUsd ?? 0), 0);
    const projetos = new Map<string, Parcela[]>();
    const cwdDe = new Map(lidas.map((l) => [l.sessao.id, l.sessao.cwd]));
    for (const p of todas) {
      const k = projetoDe(cwdDe.get(p.sessionId) ?? null);
      const lista = projetos.get(k) ?? [];
      lista.push(p);
      projetos.set(k, lista);
    }

    const sessoesComUso = [...porSessao].filter(([, ps]) => ps.length > 0).map(([id]) => id);
    const contas = RotaAnalytics.contasDistintas(sessoesComUso.map((id) => contaDaSessao.get(id)!));
    const porConta = contas.map((c) => ({ c, r: relatorioDeCusto(todas.filter((p) => (contaDaSessao.get(p.sessionId)?.id ?? null) === c.id), fuso) }));

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
        usd: linhaDeHoje ? arredondar(linhaDeHoje.custoUsd) : 0,
        sessions: new Set(todas.filter((p) => p.dia === hoje).map((p) => p.sessionId)).size,
        // A divisão por conta (decisão 0006), do dia de hoje de cada uma; conta sem uso hoje vale 0.
        byAccount: porConta.map(({ c, r }) => {
          const l = r.porDia.find((d) => d.chave === hoje);
          return { account: c.id, label: c.label, color: c.color, usd: l ? arredondar(l.custoUsd) : 0, unpriced: l?.semPreco.modelos ?? [] };
        }),
      },
      period: {
        usd: arredondar(relatorio.total.custoUsd),
        dailyAverage: relatorio.total.custoUsd === null ? null : arredondar(relatorio.total.custoUsd / dias),
      },
      cache: { pct: cachePctDe(relatorio.total) },
      unpriced: { models: relatorio.total.semPreco.modelos, totalTokens: relatorio.total.semPreco.totalDeTokens },
      byDay: porDia,
      peak: picoDoCusto ? { day: picoDoCusto.day, usd: picoDoCusto.usd } : null,
      byModel: relatorio.porModelo.map((l) => ({
        model: l.chave,
        usd: arredondar(l.custoUsd),
        pct: l.custoUsd === null ? null : pct(l.custoUsd, somaComPreco),
        totalTokens: l.totalDeTokens,
      })),
      byProject: [...projetos]
        .map(([project, ps]) => ({ project, usd: arredondar(relatorioDeCusto(ps, fuso).total.custoUsd) }))
        .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || a.project.localeCompare(b.project)),
      byAccount: porConta.map(({ c, r }) => ({
        account: c.id,
        label: c.label,
        color: c.color,
        usd: arredondar(r.total.custoUsd),
        unpriced: r.total.semPreco.modelos,
        byDay: porDiaDe(r),
      })),
    };
  }
}
