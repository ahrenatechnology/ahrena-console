// Generates the simulation script: the ordered list of writes (session, agent, event, usage) the
// runner applies through the port. A pure function of the seed and the options: no clock and no
// Math.random in here.
//
// States are written as data, the way the state machine (item 1.5) would write them; the simulator
// does not decide transitions, it only stages plausible scripts.

import {
  claudeAccountId,
  emptyTokenCounts,
  type AccountSource,
  type Agent,
  type ClaudeAccount,
  type AwaitingReason,
  type Session,
  type SessionEvent,
  type TokenCounts,
  type TokenUsage,
} from '../model.ts';
import { SeededRandom, hash32 } from './random.ts';
import * as V from './vocabulary.ts';

export const CHAOS_KINDS = ['stuck', 'error', 'abandonment', 'overflow', 'swarm'] as const;
/**
 * Failures chaos mode injects:
 * - `stuck`: stops waiting for input (permission or interrupted turn) and never leaves it;
 * - `error`: a tool fails and the session ends in `error`;
 * - `abandonment`: stops answering and, 180 min later, becomes `abandoned`;
 * - `overflow`: token spikes that overflow the context more than once;
 * - `swarm`: many subagents in parallel in the same turn.
 */
export type ChaosKind = (typeof CHAOS_KINDS)[number];
export type Script = 'normal' | ChaosKind;

/**
 * The value each script is stored with in `metadata.roteiro` of a simulated session: persisted, so it
 * keeps the old Portuguese value (phase 5 renames stored values).
 */
export const STORED_SCRIPT: Readonly<Record<Script, string>> = {
  normal: 'normal',
  stuck: 'travada',
  error: 'erro',
  abandonment: 'abandono',
  overflow: 'estouro',
  swarm: 'enxame',
};

export const CONTEXT_LIMIT = 200_000;
export const MINUTES_UNTIL_ABANDONED = 180;

export interface ScenarioOptions {
  /** Seed: the same seed with the same options generates exactly the same script. */
  seed: string | number;
  /** Number of sessions. Default 12. */
  sessions?: number;
  /** Simulated window, in minutes. Default 360 (abandonment needs at least ~240). */
  durationMin?: number;
  /** Turns chaos mode on. */
  chaos?: boolean;
  /** Fraction of the sessions that gets a failure in chaos mode, besides the guaranteed one of each. Default 0.4. */
  chaosIntensity?: number;
  /** Turns the simulated offset (ms since the start) into an ISO date. */
  clock: (offsetMs: number) => string;
}

export type StorageWrite =
  | { kind: 'session'; record: Session }
  | { kind: 'agent'; record: Agent }
  | { kind: 'event'; record: SessionEvent }
  | { kind: 'usage'; record: TokenUsage };

export type Operation = StorageWrite & {
  /** Simulated offset in ms since the start; the runner uses it for the pace. */
  offsetMs: number;
  /** Index of the session in the scenario. */
  sessionIndex: number;
  /** Order inside the session; breaks ties between operations at the same instant. */
  seq: number;
};

export interface Scenario {
  /** Prefix of this seed's ids (`sim-<hash>`); applying the same seed again overwrites, it does not duplicate. */
  prefix: string;
  scripts: Script[];
  /** The two synthetic accounts; the sessions alternate between them. */
  accounts: ClaudeAccount[];
  operations: Operation[];
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export function generateScenario(options: ScenarioOptions): Scenario {
  const total = options.sessions ?? 12;
  const durationMs = (options.durationMin ?? 360) * MINUTE;
  if (!Number.isInteger(total) || total < 1) throw new RangeError(`invalid sessions: ${total}`);
  if (!(durationMs > 0)) throw new RangeError(`invalid durationMin: ${options.durationMin}`);

  const prefix = `sim-${hash32(String(options.seed)).toString(36)}`;
  // The seed strings (`:mestre`, `:sessao:`) stay as they were: they decide the generated data.
  const master = new SeededRandom(`${options.seed}:mestre`);
  const scripts = assignScripts(master, total, options.chaos ?? false, options.chaosIntensity ?? 0.4);

  const accounts: ClaudeAccount[] = V.ACCOUNTS.map((c) => ({
    id: claudeAccountId(c.accountUuid, c.organizationUuid),
    accountUuid: c.accountUuid,
    organizationUuid: c.organizationUuid,
    organizationName: c.organizationName,
    organizationType: c.organizationType,
    label: c.label,
    color: c.color,
    configDirs: [c.configDir],
    firstSeenAt: options.clock(0),
    lastSeenAt: options.clock(0),
    metadata: { simulado: true },
  }));

  const operations: Operation[] = [];
  scripts.forEach((script, i) => {
    const rng = new SeededRandom(`${options.seed}:sessao:${i}`);
    // Abandonment starts early so the 180 min fit in the window; the other failures, before the last
    // third, so they reach the failure point; the normal ones, at any time (the late ones stay running).
    const fraction = script === 'abandonment' ? 0.15 : script === 'normal' ? 0.85 : 0.6;
    const start = rng.int(0, Math.floor(durationMs * fraction));
    // Alternates the accounts by index, without consuming the draw: both always have sessions (from 2 on).
    const k = i % accounts.length;
    const account = { id: accounts[k].id, source: V.ACCOUNTS[k].source };
    const session = new SimulatedSession(rng, options.clock, `${prefix}-s${String(i + 1).padStart(3, '0')}`, i, script, account);
    session.stage(start);
    for (const op of session.operations) if (op.offsetMs <= durationMs) operations.push(op);
  });

  operations.sort((a, b) => a.offsetMs - b.offsetMs || a.sessionIndex - b.sessionIndex || a.seq - b.seq);
  return { prefix, scripts, accounts, operations };
}

/** Without chaos, everything normal. With chaos, guarantees one session of each failure and draws more by the intensity. */
function assignScripts(rng: SeededRandom, total: number, chaos: boolean, intensity: number): Script[] {
  const scripts: Script[] = Array.from({ length: total }, () => 'normal');
  if (!chaos) return scripts;
  const order = rng.shuffle(scripts.map((_, i) => i));
  order.forEach((index, k) => {
    if (k < CHAOS_KINDS.length) scripts[index] = CHAOS_KINDS[k];
    else if (rng.chance(intensity)) scripts[index] = rng.pick(CHAOS_KINDS);
  });
  return scripts;
}

function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

function pickWeighted(rng: SeededRandom, items: readonly (readonly [string, number])[]): string {
  const sum = items.reduce((s, [, w]) => s + w, 0);
  let target = rng.next() * sum;
  for (const [item, weight] of items) {
    target -= weight;
    if (target < 0) return item;
  }
  return items[items.length - 1][0];
}

/** One session staged from start to end, collecting the operations with its own time cursor. */
class SimulatedSession {
  readonly operations: Operation[] = [];
  private seq = 0;
  private eventCount = 0;
  private readonly session: Session;
  private readonly main: Agent;
  private readonly usages = new Map<string, TokenUsage>();
  private context = 0;
  private overflows = 0;
  private subagentCount = 0;
  private readonly project: string;
  private readonly rng: SeededRandom;
  private readonly clock: (ms: number) => string;
  private readonly id: string;
  private readonly index: number;
  private readonly script: Script;

  constructor(
    rng: SeededRandom,
    clock: (ms: number) => string,
    id: string,
    index: number,
    script: Script,
    account: { id: string; source: AccountSource },
  ) {
    this.rng = rng;
    this.clock = clock;
    this.id = id;
    this.index = index;
    this.script = script;
    this.project = rng.pick(V.PROJECTS);
    const model = rng.pick(V.MODELS.main);
    const t = clock(0);
    this.session = {
      id,
      name: rng.pick(V.TASKS),
      status: 'active',
      cwd: `${V.ROOT}/${this.project}`,
      model,
      source: 'startup',
      startedAt: t,
      endedAt: null,
      awaitingInputSince: null,
      awaitingReason: null,
      updatedAt: t,
      accountId: account.id,
      accountSource: account.source,
      metadata: {},
    };
    this.main = {
      id: `${id}-a0`,
      sessionId: id,
      name: 'principal',
      type: 'main',
      subagentType: null,
      status: 'waiting',
      task: this.session.name,
      currentTool: null,
      parentAgentId: null,
      startedAt: t,
      endedAt: null,
      updatedAt: t,
      metadata: { simulado: true },
    };
  }

  stage(start: number): void {
    let t = start;
    this.session.startedAt = this.main.startedAt = this.clock(t);
    this.waitFor(t, 'session_start');
    this.event(t, null, 'SessionStart', null, 'sessão iniciada', { source: 'startup' });
    this.writeAgent(t, this.main);

    const turns = this.rng.int(3, 8);
    // Point of the script where the failure happens (turn, step).
    const failureTurn = this.rng.int(1, Math.max(1, turns - 2));
    const failureStep = this.rng.int(1, 3);
    t += this.rng.int(5, 60) * SECOND;

    for (let turn = 0; turn < turns; turn++) {
      if (this.script === 'abandonment' && turn === failureTurn) {
        this.abandon(t);
        return;
      }
      const prompt = turn === 0 ? this.session.name! : this.rng.pick(V.FOLLOW_UP_PROMPTS);
      this.clearWait();
      this.main.status = 'working';
      this.event(t, this.main.id, 'UserPromptSubmit', null, prompt, { prompt });
      this.writeAgent(t, this.main);

      const steps = this.rng.int(2, 7);
      for (let step = 0; step < steps; step++) {
        t += this.rng.int(2, 25) * SECOND;
        const atFailure = turn === failureTurn && step === Math.min(failureStep, steps - 1);

        if (atFailure && this.script === 'swarm') t = this.delegate(t, this.rng.int(8, 14));
        else if (step === 1 && this.rng.chance(0.2)) t = this.delegate(t, this.rng.int(1, 3));

        if (atFailure && this.script === 'stuck') {
          this.getStuck(t);
          return;
        }
        if (atFailure && this.script === 'error') {
          this.fail(t);
          return;
        }
        if (atFailure && this.script === 'overflow') t = this.overflow(t);

        t = this.runTool(t, this.main);
        this.consume(t, this.session.model!, this.rng.int(1500, 9000), true);
      }

      t += this.rng.int(3, 20) * SECOND;
      this.main.status = 'waiting';
      this.main.currentTool = null;
      this.waitFor(t, 'stop');
      this.event(t, this.main.id, 'Stop', null, 'turno concluído', null);
      this.writeAgent(t, this.main);
      // The user's turn: a few seconds or a few minutes until the next prompt.
      t += this.rng.int(20, 6 * 60) * SECOND;
    }

    // Some of the normal sessions stay open, waiting for the user; the rest end.
    if (this.script !== 'normal' || this.rng.chance(0.7)) this.end(t);
  }

  // --- script pieces ------------------------------------------------------------------

  private runTool(t: number, agent: Agent): number {
    const name = pickWeighted(this.rng, V.TOOLS);
    const { summary, data } = this.toolArgs(name);
    agent.currentTool = name;
    this.event(t, agent.id, 'PreToolUse', name, summary, data);
    this.writeAgent(t, agent);
    t += this.rng.int(1, name === 'Bash' ? 45 : 8) * SECOND;
    agent.currentTool = null;
    this.event(t, agent.id, 'PostToolUse', name, summary, { ok: true });
    this.writeAgent(t, agent);
    return t;
  }

  private toolArgs(name: string): { summary: string; data: unknown } {
    switch (name) {
      case 'Bash': {
        const command = this.rng.pick(V.COMMANDS);
        return { summary: command, data: { command } };
      }
      case 'Grep': {
        const pattern = this.rng.pick(V.SEARCHES);
        return { summary: pattern, data: { pattern } };
      }
      case 'Glob':
        return { summary: 'src/**/*.ts', data: { pattern: 'src/**/*.ts' } };
      case 'WebFetch':
        return { summary: 'https://example.com/docs', data: { url: 'https://example.com/docs' } };
      case 'TodoWrite':
        return { summary: 'plano atualizado', data: { todos: this.rng.int(2, 6) } };
      default: {
        const file_path = `${this.session.cwd}/${this.rng.pick(V.FILES)}`;
        return { summary: file_path, data: { file_path } };
      }
    }
  }

  /** The main agent calls the Agent tool and `n` subagents work in parallel. Returns when the last one ends. */
  private delegate(t: number, n: number): number {
    this.main.currentTool = 'Agent';
    this.event(t, this.main.id, 'PreToolUse', 'Agent', `${n} subagente(s) em paralelo`, { subagentes: n });
    this.writeAgent(t, this.main);

    let end = t;
    for (let k = 0; k < n; k++) {
      const start = t + this.rng.int(0, 4) * SECOND;
      const sub: Agent = {
        id: `${this.id}-a${++this.subagentCount}`,
        sessionId: this.id,
        name: `subagente ${this.subagentCount}`,
        type: 'subagent',
        subagentType: this.rng.pick(V.SUBAGENT_TYPES),
        status: 'working',
        task: this.rng.pick(V.SUBAGENT_TASKS),
        currentTool: null,
        parentAgentId: this.main.id,
        startedAt: this.clock(start),
        endedAt: null,
        updatedAt: this.clock(start),
        metadata: { simulado: true },
      };
      this.writeAgent(start, sub);
      const model = this.rng.pick(V.MODELS.subagent);
      let ts = start;
      for (let p = this.rng.int(2, 6); p > 0; p--) {
        ts = this.runTool(ts + this.rng.int(2, 15) * SECOND, sub);
        this.consume(ts, model, this.rng.int(1000, 6000), false);
      }
      ts += this.rng.int(2, 10) * SECOND;
      sub.status = 'completed';
      sub.endedAt = this.clock(ts);
      this.event(ts, sub.id, 'SubagentStop', null, `${sub.subagentType}: ${sub.task}`, null);
      this.writeAgent(ts, sub);
      end = Math.max(end, ts);
    }

    end += SECOND;
    // The subagents' usage is written once, at the end: writing it midway would give out-of-order
    // snapshots when two parallel subagents add to the same bucket.
    for (const usage of this.usages.values()) {
      usage.updatedAt = this.clock(end);
      this.emit(end, { kind: 'usage', record: structuredClone(usage) });
    }
    this.main.currentTool = null;
    this.event(end, this.main.id, 'PostToolUse', 'Agent', `${n} subagente(s) concluídos`, { ok: true });
    this.writeAgent(end, this.main);
    return end;
  }

  /** Stops waiting for someone and never leaves: a permission request (the most common) or an interrupted turn. */
  private getStuck(t: number): void {
    const reason: AwaitingReason = this.rng.chance(0.75) ? 'notification' : 'interrupted';
    const tool = this.rng.pick(['Bash', 'Edit', 'Write'] as const);
    this.main.status = 'waiting';
    this.main.currentTool = reason === 'notification' ? tool : null;
    this.waitFor(t, reason);
    if (reason === 'notification') {
      this.event(t, this.main.id, 'Notification', tool, `Claude precisa da sua permissão para usar ${tool}`, {
        notification_type: 'permission_prompt',
      });
    } else {
      this.event(t, this.main.id, 'Interrupted', null, 'turno interrompido sem resposta', null);
    }
    this.writeAgent(t, this.main);
  }

  private fail(t: number): void {
    const tool = this.rng.pick(['Bash', 'WebFetch', 'Edit'] as const);
    const error = this.rng.pick(V.ERRORS);
    this.main.currentTool = tool;
    this.event(t, this.main.id, 'PreToolUse', tool, tool, null);
    t += this.rng.int(2, 30) * SECOND;
    this.event(t, this.main.id, 'PostToolUseFailure', tool, error, { error });
    this.main.status = 'error';
    this.main.currentTool = null;
    this.writeAgent(t, this.main);
    this.clearWait();
    this.session.status = 'error';
    this.writeSession(t);
  }

  /** Stops answering mid-turn; 180 min later the session is written as `abandoned`. */
  private abandon(t: number): void {
    this.clearWait();
    this.main.status = 'working';
    this.event(t, this.main.id, 'UserPromptSubmit', null, this.rng.pick(V.FOLLOW_UP_PROMPTS), null);
    t = this.runTool(t + 5 * SECOND, this.main);
    this.main.currentTool = 'Bash';
    this.event(t, this.main.id, 'PreToolUse', 'Bash', 'npm run dev', { command: 'npm run dev' });
    this.writeAgent(t, this.main);

    const end = t + MINUTES_UNTIL_ABANDONED * MINUTE + this.rng.int(1, 15) * MINUTE;
    this.session.status = 'abandoned';
    this.session.endedAt = this.clock(end);
    this.writeSession(end);
  }

  /** Two token spikes in a row, each one overflowing the context and forcing a compaction. */
  private overflow(t: number): number {
    for (let i = 0; i < 2; i++) {
      t += this.rng.int(5, 30) * SECOND;
      const file_path = `${this.session.cwd}/logs/saida-completa.log`;
      this.event(t, this.main.id, 'PreToolUse', 'Read', file_path, { file_path });
      t += this.rng.int(1, 5) * SECOND;
      this.event(t, this.main.id, 'PostToolUse', 'Read', file_path, { ok: true });
      this.consume(t, this.session.model!, CONTEXT_LIMIT - this.context + this.rng.int(5_000, 40_000), true);
    }
    return t;
  }

  private end(t: number): void {
    t += this.rng.int(5, 60) * SECOND;
    this.clearWait();
    this.session.status = 'completed';
    this.session.endedAt = this.clock(t);
    this.main.status = 'completed';
    this.main.endedAt = this.clock(t);
    this.main.currentTool = null;
    this.event(t, null, 'SessionEnd', null, 'sessão encerrada', { reason: 'other' });
    this.writeAgent(t, this.main);
  }

  // --- tokens -------------------------------------------------------------------------

  /**
   * One model answer: reads the context from the cache, writes what grew. Overflows and compacts when it passes the limit.
   * Only the main agent counts context and writes right away; the subagents' usage goes out at the end of the delegation.
   */
  private consume(t: number, model: string, growth: number, countsContext: boolean): void {
    const usage = this.usages.get(model) ?? {
      sessionId: this.id,
      model,
      speed: 'standard',
      inferenceGeo: '',
      serviceTier: 'standard',
      contextSize: '',
      tokens: emptyTokenCounts(),
      webSearchRequests: 0,
      webFetchRequests: 0,
      codeExecutionRequests: 0,
      baseline: emptyTokenCounts(),
      updatedAt: this.clock(t),
    };
    this.usages.set(model, usage);

    const output = this.rng.int(80, 1800);
    const read = countsContext ? this.context : this.rng.int(8_000, 30_000);
    usage.tokens = addCounts(usage.tokens, {
      input: this.rng.int(20, 2500),
      output,
      cacheRead: read,
      cacheWrite5m: Math.round(growth * 0.8),
      cacheWrite1h: Math.round(growth * 0.2),
    });
    usage.updatedAt = this.clock(t);

    if (countsContext) {
      this.context += growth + output;
      if (this.context > CONTEXT_LIMIT) {
        // Compaction: what the transcript counted becomes the floor, and the context restarts summarized.
        this.overflows++;
        usage.baseline = addCounts(usage.baseline, usage.tokens);
        usage.tokens = emptyTokenCounts();
        this.event(t, this.main.id, 'PreCompact', null, `contexto estourou (${this.overflows}x): compactação automática`, {
          trigger: 'auto',
          contexto: this.context,
          limite: CONTEXT_LIMIT,
        });
        this.context = this.rng.int(18_000, 40_000);
      }
    }
    if (!countsContext) return;
    this.emit(t, { kind: 'usage', record: structuredClone(usage) });
    this.writeSession(t);
  }

  // --- writes -------------------------------------------------------------------------

  private waitFor(t: number, reason: AwaitingReason): void {
    this.session.awaitingInputSince = this.clock(t);
    this.session.awaitingReason = reason;
  }

  private clearWait(): void {
    this.session.awaitingInputSince = null;
    this.session.awaitingReason = null;
  }

  private event(t: number, agentId: string | null, type: string, toolName: string | null, summary: string | null, data: unknown): void {
    this.emit(t, {
      kind: 'event',
      record: {
        id: `${this.id}-e${String(++this.eventCount).padStart(4, '0')}`,
        sessionId: this.id,
        agentId,
        type,
        toolName,
        summary,
        data: data ?? null,
        createdAt: this.clock(t),
      },
    });
    this.writeSession(t);
  }

  private writeSession(t: number): void {
    this.session.updatedAt = this.clock(t);
    // Persisted metadata keys stay as they are (phase 5).
    this.session.metadata = {
      simulado: true,
      roteiro: STORED_SCRIPT[this.script],
      projeto: this.project,
      contexto: { usados: this.context, limite: CONTEXT_LIMIT, estouros: this.overflows },
    };
    this.emit(t, { kind: 'session', record: structuredClone(this.session) });
  }

  private writeAgent(t: number, agent: Agent): void {
    agent.updatedAt = this.clock(t);
    this.emit(t, { kind: 'agent', record: structuredClone(agent) });
  }

  private emit(t: number, write: StorageWrite): void {
    this.operations.push({ ...write, offsetMs: t, sessionIndex: this.index, seq: this.seq++ });
  }
}
