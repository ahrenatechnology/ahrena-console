// `GET /api/dashboard`: o que o Dashboard (C1, #27) desenha além do "precisam de você", que vem
// de `GET /api/atencao` (#87). Os seis números, os agentes ativos com os subagentes e a atividade
// recente, num pedido.
//
// Tudo pela porta e por caches em memória (decisão 0004): nenhum transcript é lido.
// - Sessões vivas e o estado delas: a `LeituraDaFrota` do MCP, a mesma da bandeja.
// - Eventos: cada sessão é lida uma vez e, depois, só do cursor em diante quando o `updatedAt`
//   muda. A cada `releituraMs` a sessão é relida inteira, para pegar o evento que chegou atrasado.
// - Custo: `agregarCusto` dos últimos 30 dias e o das sessões vivas, no máximo a cada `custoMs`.
// - A resposta inteira vale `cacheMs`: uma rajada de mudanças não refaz a conta a cada pedido.
//
// Texto da conversa: só o resumo de uma linha que o núcleo já guarda (o prompt, cortado), nas
// duas últimas mensagens do card, como o C1 pede. Nunca a resposta do agente.

import { agregarCusto, diaDe, type RelatorioDeCusto } from '../custo/agregacao.ts';
import type { EstadoDoInbox } from '../estados/leitura.ts';
import type { Agent, AgentStatus, SessionEvent } from '../model.ts';
import { minutosDesde, projetoDe, type LeituraDaFrota, type SessaoDaFrota } from '../mcp/frota.ts';
import type { StoragePort } from '../storage-port.ts';

export const ROTA_DO_DASHBOARD = '/api/dashboard';

/** O status que o badge mostra (os cinco do wireframe). */
export type StatusDoBadge = 'active' | 'waiting' | 'completed' | 'error' | 'abandoned';

export interface NumerosDoDashboard {
  /** Todas as sessões do banco; as vivas por estado. */
  sessoes: { total: number; ativas: number; esperando: number; comErro: number };
  /** Agentes principais trabalhando, e em quantas sessões. */
  agentes: { ativos: number; sessoes: number };
  subagentes: { ativos: number; sessoes: number };
  eventos: { hoje: number; ultimaHora: number; total: number };
  /** Estimativa: `null` quando houve uso e nada dele tem preço na tabela. */
  custo: { usd: number | null; dias: number; semPreco: string[] };
}

export interface SubagenteDoDashboard {
  id: string;
  tipo: string | null;
  tarefa: string | null;
  status: AgentStatus;
  desde: string;
  ate: string | null;
}

export interface AgenteDoDashboard {
  sessao: string;
  titulo: string;
  projeto: string | null;
  status: StatusDoBadge;
  estado: EstadoDoInbox;
  modelo: string | null;
  custoUsd: number | null;
  ultimaAtividade: string;
  minutos: number;
  turnos: number;
  /** As duas últimas mensagens da pessoa, já cortadas. */
  mensagens: string[];
  /** O que o agente faz agora: o passo do plano, o pedido ou a última ferramenta. */
  tarefa: string | null;
  subagentes: SubagenteDoDashboard[];
}

export interface AtividadeDoDashboard {
  sessao: string;
  projeto: string | null;
  status: StatusDoBadge;
  texto: string;
  em: string;
}

export interface RespostaDoDashboard {
  geradoEm: string;
  dia: string;
  fusoHorario: string;
  numeros: NumerosDoDashboard;
  agentes: AgenteDoDashboard[];
  atividade: AtividadeDoDashboard[];
}

export interface OpcoesDoDashboard {
  frota: LeituraDaFrota;
  cacheMs?: number;
  custoMs?: number;
  releituraMs?: number;
  /** Quantas linhas de atividade. Padrão 8, como no C1. */
  linhas?: number;
}

const HORA = 3_600_000;
const DIAS_DO_CUSTO = 30;
const MAX_MENSAGEM = 140;
const MAX_TEXTO = 120;
/** Eventos com hora guardada, por sessão: o bastante para "hoje" em qualquer fuso. */
const JANELA_RECENTE = 36 * HORA;
const MAX_ATIVIDADE_POR_SESSAO = 8;
const MAX_SUBAGENTES = 20;
const SESSOES_NA_ATIVIDADE = 24;

interface Leitura {
  updatedAt: string;
  cursor: string | null;
  lidoEm: number;
  total: number;
  /** Horas (ms) dos eventos das últimas `JANELA_RECENTE`, na ordem do banco. */
  recentes: number[];
  promptsHook: number;
  promptsTranscript: number;
  mensagens: string[];
  ultimoPrompt: number | null;
  ultimaFerramenta: { nome: string | null; resumo: string | null } | null;
  atividade: { texto: string; status: StatusDoBadge; em: string }[];
}

const novaLeitura = (updatedAt: string, agora: number): Leitura => ({
  updatedAt,
  cursor: null,
  lidoEm: agora,
  total: 0,
  recentes: [],
  promptsHook: 0,
  promptsTranscript: 0,
  mensagens: [],
  ultimoPrompt: null,
  ultimaFerramenta: null,
  atividade: [],
});

export class MontadorDoDashboard {
  private readonly frota: LeituraDaFrota;
  private readonly storage: StoragePort;
  private readonly cacheMs: number;
  private readonly custoMs: number;
  private readonly releituraMs: number;
  private readonly linhas: number;
  private readonly leituras = new Map<string, Leitura>();
  private resposta: { em: number; corpo: RespostaDoDashboard } | null = null;
  private rodando: Promise<RespostaDoDashboard> | null = null;
  private custo: { em: number; chave: string; mes: RelatorioDeCusto; vivas: RelatorioDeCusto } | null = null;

  constructor({ frota, cacheMs = 2_000, custoMs = 30_000, releituraMs = 10 * 60_000, linhas = 8 }: OpcoesDoDashboard) {
    this.frota = frota;
    this.storage = frota.storage;
    this.cacheMs = cacheMs;
    this.custoMs = custoMs;
    this.releituraMs = releituraMs;
    this.linhas = linhas;
  }

  async montar(): Promise<RespostaDoDashboard> {
    if (this.resposta && this.frota.agora() - this.resposta.em < this.cacheMs) return this.resposta.corpo;
    this.rodando ??= this.montarAgora()
      .then((corpo) => {
        this.resposta = { em: this.frota.agora(), corpo };
        return corpo;
      })
      .finally(() => {
        this.rodando = null;
      });
    return this.rodando;
  }

  private async montarAgora(): Promise<RespostaDoDashboard> {
    const agora = this.frota.agora();
    const fuso = this.frota.fusoHorario;
    const hoje = this.frota.hoje();
    const vivas = await this.frota.vivas();

    // Todas as sessões, mais recentes primeiro: os eventos de cada uma e a atividade das últimas.
    let totalDeSessoes = 0;
    const recentes: { id: string; projeto: string | null; status: StatusDoBadge }[] = [];
    const vistas = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        totalDeSessoes++;
        vistas.add(s.id);
        await this.ler(s.id, s.updatedAt, agora);
        if (recentes.length < SESSOES_NA_ATIVIDADE) recentes.push({ id: s.id, projeto: projetoDe(s), status: s.status === 'completed' ? 'completed' : s.status === 'abandoned' ? 'abandoned' : 'active' });
      }
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of this.leituras.keys()) if (!vistas.has(id)) this.leituras.delete(id);

    const inicioDoDia = inicioDoDiaEm(hoje, agora, fuso);
    const eventos = { hoje: 0, ultimaHora: 0, total: 0 };
    for (const l of this.leituras.values()) {
      eventos.total += l.total;
      for (const t of l.recentes) {
        if (t >= inicioDoDia) eventos.hoje++;
        if (t > agora - HORA) eventos.ultimaHora++;
      }
    }

    const { mes, vivas: custoDasVivas } = await this.custos(vivas.map((v) => v.session.id), hoje);
    const custoPorSessao = new Map(custoDasVivas.porSessao.map((l) => [l.chave, l.custoUsd]));

    const sessoes = { total: totalDeSessoes, ativas: 0, esperando: 0, comErro: 0 };
    const agentes = { ativos: 0, sessoes: 0 };
    const subagentes = { ativos: 0, sessoes: 0 };
    const cards: AgenteDoDashboard[] = [];
    for (const v of vivas) {
      const estado = v.inbox.estado;
      if (estado === 'waiting') sessoes.esperando++;
      else if (estado === 'error') sessoes.comErro++;
      else sessoes.ativas++;
      const lista = await this.storage.listAgents(v.session.id);
      const principais = lista.filter((a) => a.type === 'main' && a.status === 'working').length;
      if (principais > 0 && estado !== 'waiting' && estado !== 'error') {
        agentes.ativos += principais;
        agentes.sessoes++;
      }
      if (v.inbox.subagentesAtivos > 0) {
        subagentes.ativos += v.inbox.subagentesAtivos;
        subagentes.sessoes++;
      }
      cards.push(await this.card(v, lista, custoPorSessao.has(v.session.id) ? (custoPorSessao.get(v.session.id) ?? null) : 0, agora));
    }
    // Trabalhando primeiro, depois quem espera, depois os erros; dentro, a atividade mais recente.
    const ordem: Record<StatusDoBadge, number> = { active: 0, waiting: 1, error: 2, completed: 3, abandoned: 4 };
    cards.sort((a, b) => ordem[a.status] - ordem[b.status] || b.ultimaAtividade.localeCompare(a.ultimaAtividade));

    const atividade: AtividadeDoDashboard[] = [];
    for (const r of recentes) {
      const l = this.leituras.get(r.id);
      for (const a of l?.atividade ?? []) atividade.push({ sessao: r.id, projeto: r.projeto, status: a.status, texto: a.texto, em: a.em });
    }
    // A interrupção (Esc) não deixa evento: ela vem do estado da sessão viva.
    for (const v of vivas) {
      if (v.session.awaitingReason === 'interrupted' && v.session.awaitingInputSince) {
        atividade.push({ sessao: v.session.id, projeto: projetoDe(v.session), status: 'waiting', texto: 'Interrompida (Esc)', em: v.session.awaitingInputSince });
      }
    }
    atividade.sort((a, b) => b.em.localeCompare(a.em));

    const custoDoMes = mes.total.custoUsd;
    return {
      geradoEm: new Date(agora).toISOString(),
      dia: hoje,
      fusoHorario: fuso,
      numeros: {
        sessoes,
        agentes,
        subagentes,
        eventos,
        custo: { usd: custoDoMes === null ? null : Math.round(custoDoMes * 100) / 100, dias: DIAS_DO_CUSTO, semPreco: [...mes.total.semPreco.modelos].sort() },
      },
      agentes: cards,
      atividade: atividade.slice(0, this.linhas),
    };
  }

  private async card(v: SessaoDaFrota, lista: Agent[], custoUsd: number | null, agora: number): Promise<AgenteDoDashboard> {
    const s = v.session;
    const l = this.leituras.get(s.id);
    const status = badgeDe(v.inbox.estado);
    const subs = lista
      .filter((a) => a.type === 'subagent')
      .sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working') || b.startedAt.localeCompare(a.startedAt))
      .slice(0, MAX_SUBAGENTES)
      .map((a): SubagenteDoDashboard => ({ id: a.id, tipo: a.subagentType, tarefa: cortar(a.name ?? a.task, MAX_TEXTO), status: a.status, desde: a.startedAt, ate: a.endedAt }));
    return {
      sessao: s.id,
      titulo: v.titulo,
      projeto: projetoDe(s),
      status,
      estado: v.inbox.estado,
      modelo: s.model,
      custoUsd: custoUsd === null ? null : Math.round(custoUsd * 100) / 100,
      ultimaAtividade: s.updatedAt,
      minutos: minutosDesde(s.updatedAt, agora),
      turnos: l ? Math.max(l.promptsHook, l.promptsTranscript) : 0,
      mensagens: l?.mensagens ?? [],
      tarefa: await this.tarefa(v, l),
      subagentes: subs,
    };
  }

  private async tarefa(v: SessaoDaFrota, l: Leitura | undefined): Promise<string | null> {
    const f = l?.ultimaFerramenta;
    const ferramenta = f?.nome ? cortar(f.resumo && f.resumo !== f.nome ? `${f.nome}: ${f.resumo}` : f.nome, MAX_TEXTO) : null;
    if (v.inbox.estado === 'waiting' && v.session.awaitingReason === 'notification') return ferramenta;
    const plano = await this.storage.getPlan(v.session.id);
    const passo = plano?.steps.find((p) => p.id === plano.currentStepId);
    return cortar(passo?.text ?? null, MAX_TEXTO) ?? ferramenta;
  }

  /** Lê os eventos novos da sessão, se ela mudou desde a última leitura. */
  private async ler(id: string, updatedAt: string, agora: number): Promise<void> {
    let l = this.leituras.get(id);
    if (l && l.updatedAt === updatedAt) return;
    if (!l || agora - l.lidoEm >= this.releituraMs) l = novaLeitura(updatedAt, agora);
    l.updatedAt = updatedAt;
    let cursor = l.cursor;
    for (;;) {
      let page;
      try {
        page = await this.storage.listEvents(id, { limit: 500, cursor });
      } catch (err) {
        // Cursor que o adaptador não reconhece: relê do início.
        if (!(err instanceof RangeError) || cursor === null) throw err;
        l = novaLeitura(updatedAt, agora);
        cursor = null;
        continue;
      }
      for (const e of page.items) aplicar(l, e, agora);
      if (page.items.length > 0) cursor = page.nextCursor ?? cursorDe(page.items.at(-1)!);
      if (!page.nextCursor) break;
    }
    l.cursor = cursor;
    this.leituras.set(id, l);
  }

  private async custos(vivas: string[], hoje: string): Promise<{ mes: RelatorioDeCusto; vivas: RelatorioDeCusto }> {
    const chave = `${hoje}|${[...vivas].sort().join(',')}`;
    const c = this.custo;
    if (c && c.chave === chave && this.frota.agora() - c.em < this.custoMs) return c;
    const fusoHorario = this.frota.fusoHorario;
    const desde = diaDe(new Date(Date.parse(`${hoje}T12:00:00Z`) - (DIAS_DO_CUSTO - 1) * 24 * HORA).toISOString(), 'UTC');
    const [mes, dasVivas] = await Promise.all([
      agregarCusto(this.storage, { desde, ate: hoje, fusoHorario }),
      agregarCusto(this.storage, { sessionIds: vivas, fusoHorario }),
    ]);
    this.custo = { em: this.frota.agora(), chave, mes, vivas: dasVivas };
    return this.custo;
  }
}

// A porta só devolve cursor quando há outra página. Para continuar depois do último evento lido,
// o cursor sai no formato do adaptador SQLite, como em `resumo.ts`; outro adaptador que não o
// reconheça lança RangeError, e `ler` volta a ler do início.
function cursorDe(ev: SessionEvent): string {
  return Buffer.from(JSON.stringify([ev.createdAt, ev.id])).toString('base64url');
}

function aplicar(l: Leitura, e: SessionEvent, agora: number): void {
  l.total++;
  const t = Date.parse(e.createdAt);
  if (Number.isFinite(t) && t > agora - JANELA_RECENTE) l.recentes.push(t);
  const d = obj(e.data);
  const principal = e.agentId === null || e.agentId.endsWith(':main');
  switch (e.type) {
    case 'UserPromptSubmit':
      l.promptsHook++;
      l.ultimoPrompt = t;
      guardarMensagem(l, e.summary);
      return;
    case 'UserPrompt':
      if (!principal) return;
      l.promptsTranscript++;
      l.ultimoPrompt = t;
      guardarMensagem(l, e.summary);
      return;
    case 'PreToolUse':
    case 'ToolUse': {
      if (!principal) return;
      l.ultimaFerramenta = { nome: e.toolName, resumo: e.summary };
      if (e.toolName === 'Agent' || e.toolName === 'Task') {
        const tipo = str(obj(d?.tool_input)?.subagent_type);
        anotar(l, `Subagente ${tipo ?? ''} iniciado`.replace(/\s+/g, ' '), 'active', e.createdAt);
      }
      return;
    }
    case 'SubagentStop':
      anotar(l, `Subagente ${e.summary ?? ''} terminou`.replace(/\s+/g, ' '), 'active', e.createdAt);
      return;
    case 'Notification': {
      const tipo = str(d?.notification_type);
      if (tipo === 'elicitation_dialog') anotar(l, 'Fez uma pergunta', 'waiting', e.createdAt);
      else if (tipo === 'permission_prompt') {
        const f = l.ultimaFerramenta;
        const qual = f?.nome ? [f.nome, f.resumo && f.resumo !== f.nome ? f.resumo : null].filter(Boolean).join(' ') : null;
        anotar(l, qual ? `Pede permissão: ${qual}` : 'Pede permissão', 'waiting', e.createdAt);
      }
      return;
    }
    case 'Stop': {
      const s = l.ultimoPrompt !== null && Number.isFinite(t) ? (t - l.ultimoPrompt) / 1000 : null;
      anotar(l, s !== null && s >= 0 && s < 24 * 3600 ? `Turno concluído em ${duracao(s)}` : 'Turno concluído', 'active', e.createdAt);
      return;
    }
    case 'APIError':
    case 'StopFailure': {
      const codigo = codigoDoErro(e.summary ?? str(d?.error) ?? str(d?.message));
      anotar(l, codigo ? `Erro de API ${codigo}` : 'Erro de API', 'error', e.createdAt);
      return;
    }
    case 'SessionStart':
      anotar(l, e.summary === 'resume' ? 'Sessão retomada' : e.summary === 'compact' ? 'Contexto compactado' : 'Sessão iniciada', 'active', e.createdAt);
      return;
    case 'SessionEnd':
      anotar(l, 'Sessão encerrada', 'completed', e.createdAt);
      return;
  }
}

function anotar(l: Leitura, texto: string, status: StatusDoBadge, em: string): void {
  l.atividade.unshift({ texto: cortar(texto, MAX_TEXTO) ?? texto, status, em });
  if (l.atividade.length > MAX_ATIVIDADE_POR_SESSAO) l.atividade.length = MAX_ATIVIDADE_POR_SESSAO;
}

function guardarMensagem(l: Leitura, texto: string | null): void {
  const m = cortar(texto, MAX_MENSAGEM);
  if (!m || l.mensagens.at(-1) === m) return;
  l.mensagens.push(m);
  if (l.mensagens.length > 2) l.mensagens.shift();
}

export function badgeDe(estado: EstadoDoInbox): StatusDoBadge {
  if (estado === 'waiting') return 'waiting';
  if (estado === 'error') return 'error';
  if (estado === 'completed' || estado === 'abandoned') return estado;
  return 'active';
}

/** Só o código: o status HTTP e o tipo do erro da API, nunca a mensagem. */
function codigoDoErro(texto: string | null): string | null {
  if (!texto) return null;
  const partes = [/\b([45]\d\d)\b/.exec(texto)?.[1], /\b([a-z]+(?:_[a-z]+)*_error)\b/.exec(texto)?.[1]].filter(Boolean);
  return partes.length > 0 ? partes.join(' · ') : null;
}

function duracao(s: number): string {
  if (s < 60) return `${s.toFixed(1).replace('.', ',')} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Uma linha só, sem quebra, cortada com reticências. */
function cortar(texto: string | null | undefined, max: number): string | null {
  const t = texto?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** O instante em que `dia` começa no fuso, perto de `agora`. */
function inicioDoDiaEm(dia: string, agora: number, fuso: string): number {
  // Volta de hora em hora até o dia mudar; depois afina por minuto. No máximo 26 + 60 passos.
  let t = agora - (agora % 60_000);
  while (diaDe(new Date(t - HORA).toISOString(), fuso) === dia) t -= HORA;
  while (diaDe(new Date(t - 60_000).toISOString(), fuso) === dia) t -= 60_000;
  return t;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

const montadores = new WeakMap<LeituraDaFrota, MontadorDoDashboard>();

/** A resposta da rota, com um montador (e os caches dele) por frota. */
export function montarDashboard(frota: LeituraDaFrota): Promise<RespostaDoDashboard> {
  let m = montadores.get(frota);
  if (!m) montadores.set(frota, (m = new MontadorDoDashboard({ frota })));
  return m.montar();
}
