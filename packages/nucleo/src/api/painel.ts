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
import type { ListSessionsQuery, StoragePort } from '../storage-port.ts';
import type { Contas } from './contas.ts';
import type { IndiceDoDesktop, SessaoDoDesktop } from './indice-desktop.ts';
import { ResumosDeSessao, type ResumoDosEventos } from './resumo.ts';
import type {
  AtividadeDaSessao,
  ContaDoPainel,
  ContextoDoPainel,
  CustoDoPainel,
  FaixaDaSessao,
  FilhaDoPainel,
  Painel,
  PlanoDoPainel,
  PrecisaDeVoce,
  PrecisamDoPainel,
  SessaoDoPainel,
  SubagenteDoPainel,
} from './tipos.ts';
import type { TrabalhoPorBranch } from './trabalho.ts';

export const LIMITE_PADRAO_DE_CONTEXTO = 200_000;
const LIMITE_LONGO_DE_CONTEXTO = 1_000_000;
const MAX_MAQUINA = 12;
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
}

export interface OpcoesDoPainel {
  storage: StoragePort;
  contas: Contas;
  desktop: IndiceDoDesktop | null;
  trabalho: TrabalhoPorBranch | null;
  agora?: () => number;
  custoMs?: number;
  precisamMs?: number;
  /** Troca o id pedido por outro (a demonstração usa a sessão do cenário). */
  apelido?: (sessionId: string) => string;
}

type Porta = StoragePort;
interface Candidata {
  session: Session;
  agentes: Agent[];
  inbox: LeituraDoInbox;
  desktop: SessaoDoDesktop | null;
}

const UM_MIN = 60_000;

function minutos(desde: string, agora: number): string {
  const m = Math.max(0, Math.round((agora - Date.parse(desde)) / UM_MIN));
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

export class MontadorDoPainel {
  private readonly storage: Porta;
  private readonly contas: Contas;
  private readonly desktop: IndiceDoDesktop | null;
  private readonly trabalho: TrabalhoPorBranch | null;
  private readonly agora: () => number;
  private readonly custoMs: number;
  private readonly precisamMs: number;
  private readonly apelido: (sessionId: string) => string;
  readonly resumos: ResumosDeSessao;
  private readonly custos = new Map<string, { em: number; updatedAt: string; custo: CustoDoPainel; tokens: Painel['tokens'] }>();
  private precisamCache: { em: number; candidatas: Candidata[] } | null = null;
  private precisamRodando: Promise<Candidata[]> | null = null;

  constructor({ storage, contas, desktop, trabalho, agora = Date.now, custoMs = 30_000, precisamMs = 4_000, apelido = (id) => id }: OpcoesDoPainel) {
    this.apelido = apelido;
    this.storage = storage;
    this.contas = contas;
    this.desktop = desktop;
    this.trabalho = trabalho;
    this.agora = agora;
    this.custoMs = custoMs;
    this.precisamMs = precisamMs;
    this.resumos = new ResumosDeSessao(storage, { agora });
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
    const conta = this.contas.daSessao({ id: pedido.sessionId, metadata: session?.metadata ?? {} }, desktop);

    const sessao = session
      ? this.sessaoDe(session, agentes, resumo!, desktop, conta, agora)
      : this.sessaoNova(pedido, desktop, conta, agora);
    const { custo, tokens } = session ? await this.custoDe(session) : { custo: null, tokens: null };
    const memoria = session ? lerMemoria(session) : null;
    const bg = memoria ? Object.values(memoria.background) : [];

    return {
      versao: 1,
      geradoEm: new Date(agora).toISOString(),
      sessao,
      contexto: session ? contextoDe(session, resumo!) : null,
      custo,
      tokens,
      background: { total: bg.length, primeiro: bg[0]?.comando ?? null },
      plano: resumo ? planoDe(resumo) : null,
      subagentes: subagentesDe(agentes),
      filhas: await this.filhasDe(session, desktop),
      trabalho: this.trabalho?.ler(session?.cwd ?? pedido.cwd ?? desktop?.cwd ?? null, desktop?.branch ?? null) ?? null,
      precisam: await this.precisamDe(pedido.sessionId, session, desktop),
    };
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
    const ids = new Map<string, string | null>();
    for (const f of desktop ? (this.desktop?.filhasDe(desktop.localId) ?? []) : []) if (f.cliSessionId) ids.set(f.cliSessionId, f.titulo);
    const familia = session?.metadata?.familia as { filhas?: unknown } | undefined;
    if (Array.isArray(familia?.filhas)) for (const id of familia.filhas) if (typeof id === 'string' && !ids.has(id)) ids.set(id, null);
    const out: FilhaDoPainel[] = [];
    for (const [id, titulo] of ids) {
      const s = await this.storage.getSession(id);
      if (!s) {
        out.push({ id, titulo: titulo ?? id.slice(0, 8), estado: 'desconhecido', motivo: null, desde: null });
        continue;
      }
      const inbox = lerInbox(s, await this.storage.listAgents(id));
      out.push({ id, titulo: titulo ?? s.name ?? (s.cwd ? basename(s.cwd) : id.slice(0, 8)), estado: inbox.estado, motivo: inbox.motivo, desde: s.awaitingInputSince ?? s.updatedAt });
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
      itens.push({
        id: c.session.id,
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
    // Urgentes primeiro; dentro de cada grupo, o pedido mais recente, que é o que a pessoa lembra.
    itens.sort((a, b) => Number(b.urgente) - Number(a.urgente) || b.desde.localeCompare(a.desde));
    const porConta = new Map<string, { conta: ContaDoPainel | null; n: number }>();
    for (const i of itens) {
      const k = i.conta?.id ?? '';
      porConta.set(k, { conta: i.conta, n: (porConta.get(k)?.n ?? 0) + 1 });
    }
    return {
      total: itens.length,
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

function contextoDe(session: Session, r: ResumoDosEventos): ContextoDoPainel | null {
  const sim = session.metadata?.contexto as { usados?: unknown; limite?: unknown } | undefined;
  let usados = typeof sim?.usados === 'number' ? sim.usados : r.contexto;
  if (usados === null) return null;
  const limite = typeof sim?.limite === 'number' && sim.limite > 0 ? sim.limite : usados > LIMITE_PADRAO_DE_CONTEXTO ? LIMITE_LONGO_DE_CONTEXTO : LIMITE_PADRAO_DE_CONTEXTO;
  usados = Math.max(0, usados);
  return { usados, limite, pct: Math.min(100, Math.round((usados / limite) * 100)) };
}

function planoDe(r: ResumoDosEventos): PlanoDoPainel | null {
  if (!r.plano || r.plano.length === 0) return null;
  const feitos = r.plano.filter((i) => i.status === 'completed').length;
  const atual = r.plano.find((i) => i.status === 'in_progress')?.texto ?? null;
  const pendentes = r.plano.filter((i) => i.status === 'pending');
  return { feitos, total: r.plano.length, atual, proximo: pendentes[0]?.texto ?? null, restantes: Math.max(0, pendentes.length - 1) };
}

function subagentesDe(agentes: Agent[]): { ativos: number; itens: SubagenteDoPainel[] } {
  const subs = agentes.filter((a) => a.type === 'subagent');
  const ordem = { working: 0, waiting: 1, error: 2, completed: 3 } as const;
  const itens = subs
    .map((a) => ({
      id: a.id,
      nome: a.subagentType ?? 'subagente',
      tarefa: a.name ?? a.task,
      status: a.status,
      desde: a.startedAt,
      ate: a.endedAt,
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
