// Transition rules of the state machine, as pure functions: session state + event → new state.
// Copies the rules of Claude Code Agent Monitor (Agent Monitor internal benchmark, section 3),
// not the code, and adds two from Podium: "delegating" and "waiting on a background process".
//
// The machine (machine.ts) is what saves; nothing here reads the port or the clock.

import { mainAgentId, subagentId } from '../ingest/history/importer.ts';
import type { Agent, AwaitingReason, Session, SessionEvent } from '../model.ts';

/**
 * Where the machine keeps what it must remember between events, inside `session.metadata`.
 * Persisted: the value and the field names of `MachineMemory` stay in Portuguese.
 */
export const MEMORY_KEY = 'estados';

/**
 * An `Agent`/`Task` call in progress on the main agent (foreground subagent).
 * Its fields are the persisted shape in session metadata (`MachineMemory.delegacoes`): do not rename them.
 */
export interface Delegation {
  desde: string;
  descricao: string | null;
}

/** A `Bash` with `run_in_background` that is still running. Persisted fields. */
export interface BackgroundProcess {
  desde: string;
  comando: string | null;
}

/** What the machine remembers, saved under `metadata[MEMORY_KEY]`. The field names are persisted data. */
export interface MachineMemory {
  /** Time of the last applied event. An event older than this arrived late and does not change the state. */
  ultimoEvento: string | null;
  /** Ids already applied at the `ultimoEvento` time, so the same event is not applied twice. */
  idsNoUltimoInstante: string[];
  /** When the session went into `error`; activity after that heals the error. */
  erroEm: string | null;
  /** By `tool_use_id`. */
  delegacoes: Record<string, Delegation>;
  /** By the process id Claude Code returns (`backgroundTaskId`, `shellId`). */
  background: Record<string, BackgroundProcess>;
}

/** A session and its agents: what the rules read and return. */
export interface SessionState {
  session: Session;
  agents: Agent[];
}

/** Tools that launch a subagent. */
export const DELEGATION_TOOLS: readonly string[] = ['Agent', 'Task'];

/** `notification_type` values that block the agent until someone answers. */
export const BLOCKING_NOTIFICATIONS: readonly string[] = [
  'permission_prompt',
  'elicitation_dialog',
  'agent_needs_input',
  'plan_approval',
  'question',
];
/** Without `notification_type`, decide by the text. */
const BLOCKING_TEXT = /permiss|approv|aprova|needs your (input|attention|approval)|precisa da sua/i;
const INTERRUPTION_TEXT = /^\[Request interrupted by user/;

/** Progress events: they prove the session moved on and heal an earlier error. */
const PROGRESS_EVENTS = new Set([
  'UserPromptSubmit',
  'UserPrompt',
  'PreToolUse',
  'ToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'ToolResult',
  'AssistantMessage',
]);
/** Events only the transcript produces. They never reopen an ended session: they are the past, not a sign of life. */
const HISTORY_ONLY_EVENTS = new Set(['UserPrompt', 'ToolUse', 'ToolResult', 'AssistantMessage', 'APIError', 'TurnDuration', 'Compaction']);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const maxIso = (a: string, b: string): string => (a > b ? a : b);

/** A memory with nothing in it. */
export function emptyMemory(): MachineMemory {
  return { ultimoEvento: null, idsNoUltimoInstante: [], erroEm: null, delegacoes: {}, background: {} };
}

/** Reads the memory saved in `metadata`, tolerating its absence and an old format. */
export function readMemory(session: Pick<Session, 'metadata'>): MachineMemory {
  const m = obj(session.metadata?.[MEMORY_KEY]);
  const ids = Array.isArray(m.idsNoUltimoInstante) ? m.idsNoUltimoInstante.filter((x): x is string => typeof x === 'string') : [];
  return {
    ultimoEvento: str(m.ultimoEvento),
    idsNoUltimoInstante: ids,
    erroEm: str(m.erroEm),
    delegacoes: { ...(obj(m.delegacoes) as Record<string, Delegation>) },
    background: { ...(obj(m.background) as Record<string, BackgroundProcess>) },
  };
}

/** Synthetic event: produced by the machine itself (watcher, probe), not by Claude Code. */
export function isSynthetic(event: Pick<SessionEvent, 'data'>): boolean {
  return obj(event.data).sintetico === true;
}

/** `true` when the event is older than the last applied one, or was already applied. */
export function isStale(memory: MachineMemory, event: Pick<SessionEvent, 'id' | 'createdAt'>): boolean {
  if (!memory.ultimoEvento) return false;
  if (event.createdAt < memory.ultimoEvento) return true;
  return event.createdAt === memory.ultimoEvento && memory.idsNoUltimoInstante.includes(event.id);
}

/** The main agent: the one of type `main`, or `<session>:main` when it does not exist yet. */
export function mainAgentOf(state: SessionState): Agent | undefined {
  return state.agents.find((a) => a.type === 'main') ?? state.agents.find((a) => a.id === mainAgentId(state.session.id));
}

/** The subagents still working. */
export function workingSubagents(state: SessionState): Agent[] {
  return state.agents.filter((a) => a.type === 'subagent' && a.status === 'working');
}

/** Last real activity: hooks and transcript. Synthetic events do not count. */
export function lastActivity(state: SessionState): string {
  return state.agents.reduce((acc, a) => maxIso(acc, a.updatedAt), state.session.updatedAt);
}

/** Applies an event. Returns a new state; the input one is not changed. */
export function transition(state: SessionState, event: SessionEvent): SessionState {
  if (event.sessionId !== state.session.id) return state;
  const memory = readMemory(state.session);
  if (isStale(memory, event)) return state;
  const t = new Transition(state, memory, event);
  t.apply();
  return t.result();
}

/** One event applied to one session state. */
class Transition {
  private readonly s: Session;
  private readonly agents: Agent[];
  private readonly m: MachineMemory;
  private readonly e: SessionEvent;
  private readonly d: Json;
  private readonly at: string;
  private readonly synthetic: boolean;

  constructor(state: SessionState, memory: MachineMemory, event: SessionEvent) {
    this.s = structuredClone(state.session);
    this.agents = structuredClone(state.agents);
    this.m = memory;
    this.e = event;
    this.d = obj(event.data);
    this.at = event.createdAt;
    this.synthetic = isSynthetic(event);
  }

  result(): SessionState {
    if (this.m.ultimoEvento === null || this.at > this.m.ultimoEvento) {
      this.m.ultimoEvento = this.at;
      this.m.idsNoUltimoInstante = [this.e.id];
    } else if (!this.m.idsNoUltimoInstante.includes(this.e.id)) {
      this.m.idsNoUltimoInstante.push(this.e.id);
    }
    if (!this.synthetic) this.s.updatedAt = maxIso(this.s.updatedAt, this.at);
    this.s.metadata = { ...this.s.metadata, [MEMORY_KEY]: this.m };
    return { session: this.s, agents: this.agents };
  }

  apply(): void {
    const type = this.e.type;
    if (PROGRESS_EVENTS.has(type)) this.heal();
    if (!HISTORY_ONLY_EVENTS.has(type) && !this.synthetic && type !== 'SessionEnd') this.reopen();

    switch (type) {
      case 'SessionStart':
        return this.sessionStart();
      case 'UserPromptSubmit':
        return this.prompt();
      case 'UserPrompt':
        // The transcript records Esc as a user message.
        if (INTERRUPTION_TEXT.test(this.e.summary ?? '')) return this.interruption();
        return this.prompt();
      case 'PreToolUse':
      case 'ToolUse':
        return this.toolStarts();
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'ToolResult':
        return this.toolEnds();
      case 'AssistantMessage':
        return this.message();
      case 'Notification':
        return this.notification();
      case 'Stop':
        if (this.d.stop_reason === 'error' || str(this.d.error)) return this.error();
        return this.turnEnd();
      case 'StopFailure':
      case 'APIError':
        return this.error();
      case 'TurnDuration':
        if (!this.s.awaitingInputSince && this.s.status === 'active') this.turnEnd();
        return;
      case 'SubagentStop':
        return this.subagentEnds();
      case 'Interrupted':
        return this.interruption();
      case 'Abandoned':
        return this.end('abandoned');
      case 'SessionEnd':
        return this.end(this.s.status === 'error' ? 'error' : 'completed');
      default:
        // Event with no rule (Compaction, PreCompact, new ones): only counts as the agent's activity.
        this.touch(this.actor());
    }
  }

  // --- rules per event ---

  private sessionStart(): void {
    // Compaction fires a SessionStart in the middle of work: the state stays as it is.
    if (this.d.source === 'compact') return;
    this.s.status = 'active';
    this.s.endedAt = null;
    this.m.erroEm = null;
    // New process: what the previous one left running is no longer its own.
    this.m.delegacoes = {};
    this.m.background = {};
    const p = this.main();
    p.status = 'waiting';
    p.currentTool = null;
    p.endedAt = null;
    this.touch(p);
    this.startWait('session_start');
  }

  private prompt(): void {
    const p = this.main();
    p.status = 'working';
    p.currentTool = null;
    p.endedAt = null;
    this.touch(p);
    this.clearWait();
  }

  private toolStarts(): void {
    const a = this.actor();
    a.status = 'working';
    a.currentTool = this.e.toolName;
    this.touch(a);
    if (a.type === 'subagent') {
      // Actor rule: a working subagent does not answer a permission request of the main agent.
      this.clearWait(['interrupted']);
      return;
    }
    this.clearWait();
    const toolUseId = this.toolUseId();
    if (this.e.toolName && DELEGATION_TOOLS.includes(this.e.toolName) && toolUseId) {
      const input = obj(this.d.tool_input);
      this.m.delegacoes[toolUseId] = { desde: this.at, descricao: str(input.description) ?? str(input.subagent_type) };
    }
  }

  private toolEnds(): void {
    const a = this.actor();
    a.status = 'working';
    a.currentTool = null;
    this.touch(a);
    if (a.type === 'subagent') {
      this.clearWait(['interrupted']);
      return;
    }
    // The tool ran: the permission, if there was one, was answered.
    this.clearWait();
    const toolUseId = this.toolUseId();
    if (toolUseId) delete this.m.delegacoes[toolUseId];
    this.backgroundProcesses();
  }

  private message(): void {
    const a = this.actor();
    this.touch(a);
    // The transcript moved on: the turn the watcher took as dead was alive.
    if (this.s.awaitingReason === 'interrupted' || this.s.awaitingReason === 'session_start') {
      this.clearWait();
      a.status = 'working';
    }
  }

  private notification(): void {
    if (!this.blocking()) return;
    const a = this.actor();
    a.status = 'waiting';
    this.touch(a);
    this.startWait('notification');
  }

  private turnEnd(): void {
    const p = this.main();
    p.status = 'waiting';
    p.currentTool = null;
    this.touch(p);
    // A foreground subagent call does not survive the end of the turn.
    this.m.delegacoes = {};
    this.startWait('stop');
  }

  private interruption(): void {
    const p = this.main();
    p.status = 'waiting';
    p.currentTool = null;
    this.touch(p);
    this.m.delegacoes = {};
    this.startWait('interrupted');
  }

  private error(): void {
    this.s.status = 'error';
    this.m.erroEm = this.at;
    const p = this.main();
    p.status = 'error';
    p.currentTool = null;
    this.touch(p);
    this.clearWait();
  }

  private subagentEnds(): void {
    const id = str(this.d.agent_id) ?? this.e.agentId;
    let sub = id ? this.find(id) : undefined;
    if (!sub || sub.type !== 'subagent') {
      // No matching id: the oldest working subagent.
      sub = this.agents
        .filter((a) => a.type === 'subagent' && a.status === 'working')
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    }
    if (!sub) return;
    sub.status = 'completed';
    sub.currentTool = null;
    sub.endedAt = this.at;
    this.touch(sub);
  }

  private end(status: 'completed' | 'abandoned' | 'error'): void {
    this.s.status = status;
    this.s.endedAt = this.at;
    this.clearWait();
    this.m.delegacoes = {};
    this.m.background = {};
    for (const a of this.agents) {
      if (a.status === 'completed' || a.status === 'error') continue;
      a.status = 'completed';
      a.currentTool = null;
      a.endedAt = this.at;
      this.touch(a);
    }
  }

  // --- pieces ---

  /** Heals an error already overcome: progress after the error takes the session back to `active`. */
  private heal(): void {
    if (this.s.status !== 'error' || this.s.endedAt) return;
    if (this.m.erroEm && this.at <= this.m.erroEm) return;
    this.s.status = 'active';
    this.m.erroEm = null;
    const p = mainAgentOf({ session: this.s, agents: this.agents });
    if (p?.status === 'error') p.status = 'working';
  }

  /** A live signal on an ended session: it came back (resume, or the probe was wrong). */
  private reopen(): void {
    if (this.s.status !== 'completed' && this.s.status !== 'abandoned') return;
    this.s.status = 'active';
    this.s.endedAt = null;
  }

  private startWait(reason: AwaitingReason): void {
    if (this.s.awaitingReason !== reason || !this.s.awaitingInputSince) this.s.awaitingInputSince = this.at;
    this.s.awaitingReason = reason;
  }

  /** Clears the wait; with `only`, only if the reason is one of those. */
  private clearWait(only?: readonly AwaitingReason[]): void {
    if (!this.s.awaitingReason) return;
    if (only && !only.includes(this.s.awaitingReason)) return;
    this.s.awaitingInputSince = null;
    this.s.awaitingReason = null;
  }

  private blocking(): boolean {
    const type = str(this.d.notification_type);
    if (type) return BLOCKING_NOTIFICATIONS.includes(type);
    return BLOCKING_TEXT.test(str(this.d.message) ?? this.e.summary ?? '');
  }

  private toolUseId(): string | null {
    return str(this.d.tool_use_id) ?? str(this.d.toolUseId);
  }

  /** A background `Bash` comes in; `KillShell` and `BashOutput` with the process finished take it out. */
  private backgroundProcesses(): void {
    const input = obj(this.d.tool_input);
    const response = obj(this.d.tool_response);
    const tool = this.e.toolName;
    if (tool === 'Bash' && input.run_in_background === true && this.e.type !== 'PostToolUseFailure') {
      const id = str(response.backgroundTaskId) ?? str(response.shellId) ?? str(response.bash_id) ?? this.toolUseId();
      if (id) this.m.background[id] = { desde: this.at, comando: str(input.command) };
      return;
    }
    const target = str(input.shell_id) ?? str(input.bash_id) ?? str(input.task_id);
    if (!target) return;
    if (tool === 'KillShell' || tool === 'KillBash') delete this.m.background[target];
    if (tool === 'BashOutput' || tool === 'TaskOutput') {
      const status = str(response.status);
      if (status && status !== 'running') delete this.m.background[target];
    }
  }

  private touch(a: Agent): void {
    if (!this.synthetic) a.updatedAt = maxIso(a.updatedAt, this.at);
  }

  private find(id: string): Agent | undefined {
    const sid = this.s.id;
    return this.agents.find((a) => a.id === id) ?? this.agents.find((a) => a.id === subagentId(sid, id));
  }

  private main(): Agent {
    const existing = mainAgentOf({ session: this.s, agents: this.agents });
    if (existing) return existing;
    const created = this.newAgent(mainAgentId(this.s.id), 'main', null);
    // Saved and shown on screen: stays in Portuguese.
    created.name = 'principal';
    return created;
  }

  /** Who acts: the main agent, or the subagent of `agent_id` (created on its first hook). */
  private actor(): Agent {
    const id = this.e.agentId ?? str(this.d.agent_id);
    if (!id) return this.main();
    const existing = this.find(id);
    if (existing) return existing;
    if (id === mainAgentId(this.s.id)) return this.main();
    const newId = id.startsWith(`${this.s.id}:`) ? id : subagentId(this.s.id, id);
    const sub = this.newAgent(newId, 'subagent', this.main().id);
    sub.subagentType = str(this.d.agent_type);
    sub.name = str(this.d.agent_type);
    return sub;
  }

  private newAgent(id: string, type: Agent['type'], parent: string | null): Agent {
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
      startedAt: type === 'main' ? this.s.startedAt : this.at,
      endedAt: null,
      updatedAt: this.at,
      metadata: {},
    };
    this.agents.push(a);
    return a;
  }
}
