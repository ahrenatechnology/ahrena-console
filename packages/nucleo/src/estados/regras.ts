// Regras de transição da máquina de estados, como funções puras: estado da sessão + evento → novo estado.
// Copia as regras do Claude Code Agent Monitor (benchmark interno do Agent Monitor, seção 3),
// não o código, e acrescenta duas do Podium: "delegando" e "esperando processo em background".
//
// Quem grava é a máquina (maquina.ts); aqui nada lê a porta nem o relógio.

import { mainAgentId, subagentId } from '../ingest/historico/importer.ts';
import type { Agent, AwaitingReason, Session, SessionEvent } from '../model.ts';

/** Onde a máquina guarda o que precisa lembrar entre eventos, dentro de `session.metadata`. */
export const CHAVE_DA_MEMORIA = 'estados';

/** Chamada de `Agent`/`Task` em andamento no agente principal (subagente em primeiro plano). */
export interface Delegacao {
  desde: string;
  descricao: string | null;
}

/** `Bash` com `run_in_background` que ainda roda. */
export interface ProcessoEmBackground {
  desde: string;
  comando: string | null;
}

export interface MemoriaDaMaquina {
  /** Instante do último evento aplicado. Evento mais antigo que isso chegou atrasado e não muda o estado. */
  ultimoEvento: string | null;
  /** Ids já aplicados no instante `ultimoEvento`, para não aplicar o mesmo evento duas vezes. */
  idsNoUltimoInstante: string[];
  /** Quando a sessão entrou em `error`; atividade depois disso cura o erro. */
  erroEm: string | null;
  /** Por `tool_use_id`. */
  delegacoes: Record<string, Delegacao>;
  /** Pelo id do processo que o Claude Code devolve (`backgroundTaskId`, `shellId`). */
  background: Record<string, ProcessoEmBackground>;
}

export interface EstadoDaSessao {
  session: Session;
  agentes: Agent[];
}

/** Ferramentas que lançam subagente. */
export const FERRAMENTAS_DE_DELEGACAO: readonly string[] = ['Agent', 'Task'];

/** `notification_type` que bloqueia o agente até alguém responder. */
export const NOTIFICACOES_BLOQUEANTES: readonly string[] = [
  'permission_prompt',
  'elicitation_dialog',
  'agent_needs_input',
  'plan_approval',
  'question',
];
/** Sem `notification_type`, decide pelo texto. */
const TEXTO_BLOQUEANTE = /permiss|approv|aprova|needs your (input|attention|approval)|precisa da sua/i;
const TEXTO_INTERRUPCAO = /^\[Request interrupted by user/;

/** Eventos de progresso: provam que a sessão andou e curam um erro anterior. */
const PROGRESSO = new Set([
  'UserPromptSubmit',
  'UserPrompt',
  'PreToolUse',
  'ToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'ToolResult',
  'AssistantMessage',
]);
/** Eventos que só o transcript produz. Nunca reabrem sessão encerrada: são passado, não sinal de vida. */
const DO_HISTORICO = new Set(['UserPrompt', 'ToolUse', 'ToolResult', 'AssistantMessage', 'APIError', 'TurnDuration', 'Compaction']);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const maxIso = (a: string, b: string): string => (a > b ? a : b);

export function memoriaVazia(): MemoriaDaMaquina {
  return { ultimoEvento: null, idsNoUltimoInstante: [], erroEm: null, delegacoes: {}, background: {} };
}

/** Lê a memória gravada em `metadata`, tolerando ausência e formato velho. */
export function lerMemoria(session: Pick<Session, 'metadata'>): MemoriaDaMaquina {
  const m = obj(session.metadata?.[CHAVE_DA_MEMORIA]);
  const ids = Array.isArray(m.idsNoUltimoInstante) ? m.idsNoUltimoInstante.filter((x): x is string => typeof x === 'string') : [];
  return {
    ultimoEvento: str(m.ultimoEvento),
    idsNoUltimoInstante: ids,
    erroEm: str(m.erroEm),
    delegacoes: { ...(obj(m.delegacoes) as Record<string, Delegacao>) },
    background: { ...(obj(m.background) as Record<string, ProcessoEmBackground>) },
  };
}

/** Evento sintético: produzido pela própria máquina (vigia, sonda), não pelo Claude Code. */
export function ehSintetico(evento: Pick<SessionEvent, 'data'>): boolean {
  return obj(evento.data).sintetico === true;
}

/** `true` quando o evento é anterior ao último aplicado, ou já foi aplicado. */
export function obsoleto(memoria: MemoriaDaMaquina, evento: Pick<SessionEvent, 'id' | 'createdAt'>): boolean {
  if (!memoria.ultimoEvento) return false;
  if (evento.createdAt < memoria.ultimoEvento) return true;
  return evento.createdAt === memoria.ultimoEvento && memoria.idsNoUltimoInstante.includes(evento.id);
}

/** O agente principal: o de tipo `main`, ou `<sessão>:main` quando ainda não existe. */
export function principalDe(estado: EstadoDaSessao): Agent | undefined {
  return estado.agentes.find((a) => a.type === 'main') ?? estado.agentes.find((a) => a.id === mainAgentId(estado.session.id));
}

export function subagentesTrabalhando(estado: EstadoDaSessao): Agent[] {
  return estado.agentes.filter((a) => a.type === 'subagent' && a.status === 'working');
}

/** Última atividade real: hooks e transcript. Eventos sintéticos não contam. */
export function ultimaAtividade(estado: EstadoDaSessao): string {
  return estado.agentes.reduce((acc, a) => maxIso(acc, a.updatedAt), estado.session.updatedAt);
}

/** Aplica um evento. Devolve um estado novo; o de entrada não é alterado. */
export function transicionar(estado: EstadoDaSessao, evento: SessionEvent): EstadoDaSessao {
  if (evento.sessionId !== estado.session.id) return estado;
  const memoria = lerMemoria(estado.session);
  if (obsoleto(memoria, evento)) return estado;
  const t = new Transicao(estado, memoria, evento);
  t.aplicar();
  return t.resultado();
}

class Transicao {
  private readonly s: Session;
  private readonly agentes: Agent[];
  private readonly m: MemoriaDaMaquina;
  private readonly e: SessionEvent;
  private readonly d: Json;
  private readonly em: string;
  private readonly sintetico: boolean;

  constructor(estado: EstadoDaSessao, memoria: MemoriaDaMaquina, evento: SessionEvent) {
    this.s = structuredClone(estado.session);
    this.agentes = structuredClone(estado.agentes);
    this.m = memoria;
    this.e = evento;
    this.d = obj(evento.data);
    this.em = evento.createdAt;
    this.sintetico = ehSintetico(evento);
  }

  resultado(): EstadoDaSessao {
    if (this.m.ultimoEvento === null || this.em > this.m.ultimoEvento) {
      this.m.ultimoEvento = this.em;
      this.m.idsNoUltimoInstante = [this.e.id];
    } else if (!this.m.idsNoUltimoInstante.includes(this.e.id)) {
      this.m.idsNoUltimoInstante.push(this.e.id);
    }
    if (!this.sintetico) this.s.updatedAt = maxIso(this.s.updatedAt, this.em);
    this.s.metadata = { ...this.s.metadata, [CHAVE_DA_MEMORIA]: this.m };
    return { session: this.s, agentes: this.agentes };
  }

  aplicar(): void {
    const tipo = this.e.type;
    if (PROGRESSO.has(tipo)) this.curar();
    if (!DO_HISTORICO.has(tipo) && !this.sintetico && tipo !== 'SessionEnd') this.reabrir();

    switch (tipo) {
      case 'SessionStart':
        return this.inicio();
      case 'UserPromptSubmit':
        return this.prompt();
      case 'UserPrompt':
        // O transcript grava o Esc como uma mensagem do usuário.
        if (TEXTO_INTERRUPCAO.test(this.e.summary ?? '')) return this.interrupcao();
        return this.prompt();
      case 'PreToolUse':
      case 'ToolUse':
        return this.ferramentaComeca();
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'ToolResult':
        return this.ferramentaTermina();
      case 'AssistantMessage':
        return this.mensagem();
      case 'Notification':
        return this.notificacao();
      case 'Stop':
        if (this.d.stop_reason === 'error' || str(this.d.error)) return this.erro();
        return this.fimDoTurno();
      case 'StopFailure':
      case 'APIError':
        return this.erro();
      case 'TurnDuration':
        if (!this.s.awaitingInputSince && this.s.status === 'active') this.fimDoTurno();
        return;
      case 'SubagentStop':
        return this.subagenteTermina();
      case 'Interrupted':
        return this.interrupcao();
      case 'Abandoned':
        return this.encerrar('abandoned');
      case 'SessionEnd':
        return this.encerrar(this.s.status === 'error' ? 'error' : 'completed');
      default:
        // Evento sem regra (Compaction, PreCompact, novos): só conta como atividade do agente.
        this.tocar(this.ator());
    }
  }

  // --- regras por evento ---

  private inicio(): void {
    // A compactação dispara um SessionStart no meio do trabalho: o estado fica como está.
    if (this.d.source === 'compact') return;
    this.s.status = 'active';
    this.s.endedAt = null;
    this.m.erroEm = null;
    // Processo novo: o que o anterior deixou rodando não é mais dele.
    this.m.delegacoes = {};
    this.m.background = {};
    const p = this.principal();
    p.status = 'waiting';
    p.currentTool = null;
    p.endedAt = null;
    this.tocar(p);
    this.esperar('session_start');
  }

  private prompt(): void {
    const p = this.principal();
    p.status = 'working';
    p.currentTool = null;
    p.endedAt = null;
    this.tocar(p);
    this.limparEspera();
  }

  private ferramentaComeca(): void {
    const a = this.ator();
    a.status = 'working';
    a.currentTool = this.e.toolName;
    this.tocar(a);
    if (a.type === 'subagent') {
      // Regra de ator: o subagente trabalhando não responde a um pedido de permissão do principal.
      this.limparEspera(['interrupted']);
      return;
    }
    this.limparEspera();
    const toolUseId = this.toolUseId();
    if (this.e.toolName && FERRAMENTAS_DE_DELEGACAO.includes(this.e.toolName) && toolUseId) {
      const input = obj(this.d.tool_input);
      this.m.delegacoes[toolUseId] = { desde: this.em, descricao: str(input.description) ?? str(input.subagent_type) };
    }
  }

  private ferramentaTermina(): void {
    const a = this.ator();
    a.status = 'working';
    a.currentTool = null;
    this.tocar(a);
    if (a.type === 'subagent') {
      this.limparEspera(['interrupted']);
      return;
    }
    // A ferramenta rodou: a permissão, se havia, foi respondida.
    this.limparEspera();
    const toolUseId = this.toolUseId();
    if (toolUseId) delete this.m.delegacoes[toolUseId];
    this.processosEmBackground();
  }

  private mensagem(): void {
    const a = this.ator();
    this.tocar(a);
    // O transcript andou: o turno que o vigia deu por morto estava vivo.
    if (this.s.awaitingReason === 'interrupted' || this.s.awaitingReason === 'session_start') {
      this.limparEspera();
      a.status = 'working';
    }
  }

  private notificacao(): void {
    if (!this.bloqueante()) return;
    const a = this.ator();
    a.status = 'waiting';
    this.tocar(a);
    this.esperar('notification');
  }

  private fimDoTurno(): void {
    const p = this.principal();
    p.status = 'waiting';
    p.currentTool = null;
    this.tocar(p);
    // Chamada de subagente em primeiro plano não sobrevive ao fim do turno.
    this.m.delegacoes = {};
    this.esperar('stop');
  }

  private interrupcao(): void {
    const p = this.principal();
    p.status = 'waiting';
    p.currentTool = null;
    this.tocar(p);
    this.m.delegacoes = {};
    this.esperar('interrupted');
  }

  private erro(): void {
    this.s.status = 'error';
    this.m.erroEm = this.em;
    const p = this.principal();
    p.status = 'error';
    p.currentTool = null;
    this.tocar(p);
    this.limparEspera();
  }

  private subagenteTermina(): void {
    const id = str(this.d.agent_id) ?? this.e.agentId;
    let sub = id ? this.buscar(id) : undefined;
    if (!sub || sub.type !== 'subagent') {
      // Sem id que bata: o subagente trabalhando mais antigo.
      sub = this.agentes
        .filter((a) => a.type === 'subagent' && a.status === 'working')
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    }
    if (!sub) return;
    sub.status = 'completed';
    sub.currentTool = null;
    sub.endedAt = this.em;
    this.tocar(sub);
  }

  private encerrar(status: 'completed' | 'abandoned' | 'error'): void {
    this.s.status = status;
    this.s.endedAt = this.em;
    this.limparEspera();
    this.m.delegacoes = {};
    this.m.background = {};
    for (const a of this.agentes) {
      if (a.status === 'completed' || a.status === 'error') continue;
      a.status = 'completed';
      a.currentTool = null;
      a.endedAt = this.em;
      this.tocar(a);
    }
  }

  // --- peças ---

  /** Cura de erro já superado: progresso depois do erro devolve a sessão a `active`. */
  private curar(): void {
    if (this.s.status !== 'error' || this.s.endedAt) return;
    if (this.m.erroEm && this.em <= this.m.erroEm) return;
    this.s.status = 'active';
    this.m.erroEm = null;
    const p = principalDe({ session: this.s, agentes: this.agentes });
    if (p?.status === 'error') p.status = 'working';
  }

  /** Sinal ao vivo numa sessão encerrada: ela voltou (resume, ou a sonda errou). */
  private reabrir(): void {
    if (this.s.status !== 'completed' && this.s.status !== 'abandoned') return;
    this.s.status = 'active';
    this.s.endedAt = null;
  }

  private esperar(motivo: AwaitingReason): void {
    if (this.s.awaitingReason !== motivo || !this.s.awaitingInputSince) this.s.awaitingInputSince = this.em;
    this.s.awaitingReason = motivo;
  }

  /** Limpa a espera; com `so`, só se o motivo for um desses. */
  private limparEspera(so?: readonly AwaitingReason[]): void {
    if (!this.s.awaitingReason) return;
    if (so && !so.includes(this.s.awaitingReason)) return;
    this.s.awaitingInputSince = null;
    this.s.awaitingReason = null;
  }

  private bloqueante(): boolean {
    const tipo = str(this.d.notification_type);
    if (tipo) return NOTIFICACOES_BLOQUEANTES.includes(tipo);
    return TEXTO_BLOQUEANTE.test(str(this.d.message) ?? this.e.summary ?? '');
  }

  private toolUseId(): string | null {
    return str(this.d.tool_use_id) ?? str(this.d.toolUseId);
  }

  /** `Bash` em background entra; `KillShell` e `BashOutput` com o processo terminado saem. */
  private processosEmBackground(): void {
    const input = obj(this.d.tool_input);
    const resposta = obj(this.d.tool_response);
    const ferramenta = this.e.toolName;
    if (ferramenta === 'Bash' && input.run_in_background === true && this.e.type !== 'PostToolUseFailure') {
      const id = str(resposta.backgroundTaskId) ?? str(resposta.shellId) ?? str(resposta.bash_id) ?? this.toolUseId();
      if (id) this.m.background[id] = { desde: this.em, comando: str(input.command) };
      return;
    }
    const alvo = str(input.shell_id) ?? str(input.bash_id) ?? str(input.task_id);
    if (!alvo) return;
    if (ferramenta === 'KillShell' || ferramenta === 'KillBash') delete this.m.background[alvo];
    if (ferramenta === 'BashOutput' || ferramenta === 'TaskOutput') {
      const status = str(resposta.status);
      if (status && status !== 'running') delete this.m.background[alvo];
    }
  }

  private tocar(a: Agent): void {
    if (!this.sintetico) a.updatedAt = maxIso(a.updatedAt, this.em);
  }

  private buscar(id: string): Agent | undefined {
    const sid = this.s.id;
    return this.agentes.find((a) => a.id === id) ?? this.agentes.find((a) => a.id === subagentId(sid, id));
  }

  private principal(): Agent {
    const existente = principalDe({ session: this.s, agentes: this.agentes });
    if (existente) return existente;
    const novo = this.novoAgente(mainAgentId(this.s.id), 'main', null);
    novo.name = 'principal';
    return novo;
  }

  /** Quem age: o principal, ou o subagente do `agent_id` (criado no primeiro hook dele). */
  private ator(): Agent {
    const id = this.e.agentId ?? str(this.d.agent_id);
    if (!id) return this.principal();
    const existente = this.buscar(id);
    if (existente) return existente;
    if (id === mainAgentId(this.s.id)) return this.principal();
    const novoId = id.startsWith(`${this.s.id}:`) ? id : subagentId(this.s.id, id);
    const sub = this.novoAgente(novoId, 'subagent', this.principal().id);
    sub.subagentType = str(this.d.agent_type);
    sub.name = str(this.d.agent_type);
    return sub;
  }

  private novoAgente(id: string, type: Agent['type'], parent: string | null): Agent {
    const a: Agent = {
      id,
      sessionId: this.s.id,
      name: null,
      type,
      subagentType: null,
      status: 'working',
      task: null,
      currentTool: null,
      parentAgentId: parent,
      startedAt: type === 'main' ? this.s.startedAt : this.em,
      endedAt: null,
      updatedAt: this.em,
      metadata: {},
    };
    this.agentes.push(a);
    return a;
  }
}
