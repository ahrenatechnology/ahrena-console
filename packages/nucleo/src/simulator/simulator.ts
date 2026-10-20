// Runner: applies the script through the storage port, all at once (batch) or at the pace of the
// clock (real time). Clock and wait are injectable for the tests.

import type { ModelPricing } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { generateScenario, type Operation, type Script } from './scenario.ts';

/** `batch` writes everything at once; `real-time` writes at the pace of the clock. */
export type RunMode = 'batch' | 'real-time';

export interface SimulationOptions {
  seed: string | number;
  sessions?: number;
  durationMin?: number;
  chaos?: boolean;
  chaosIntensity?: number;
  /**
   * `batch`: writes everything at once, with the window ending now (the sessions already happened).
   * `real-time`: starts now and writes each operation at its time. Default `batch`.
   */
  mode?: RunMode;
  /** Real time only: how many simulated minutes pass per clock minute. Default 30. */
  speed?: number;
  /** Writes illustrative prices for the simulated models that have no price yet. */
  prices?: boolean;
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
  /** Wait in ms. Default `setTimeout`, cancellable by the `signal`. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Interrupts the real-time simulation; what was already written stays. */
  signal?: AbortSignal;
  /** Called after each write. */
  onWrite?: (op: Operation) => void;
}

export interface SimulationSummary {
  seed: string;
  prefix: string;
  mode: RunMode;
  start: string;
  scripts: Record<Script, number>;
  written: { accounts: number; sessions: number; agents: number; events: number; usages: number; prices: number };
  /** `true` when the `signal` stopped the simulation before the end. */
  interrupted: boolean;
}

/**
 * Illustrative prices, in US$ per million tokens, only so the cost shows up in the demo.
 * They are not the official table: whoever uses the console for real edits their own table (item 1.6).
 */
export const ILLUSTRATIVE_PRICES: readonly Omit<ModelPricing, 'updatedAt'>[] = [
  { pattern: 'claude-opus-5%', inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: null, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null },
  { pattern: 'claude-sonnet-5%', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: null, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null },
  { pattern: 'claude-haiku-5%', inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: null, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null },
];

function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export async function simulate(storage: StoragePort, options: SimulationOptions): Promise<SimulationSummary> {
  const mode = options.mode ?? 'batch';
  const speed = options.speed ?? 30;
  if (!(speed > 0)) throw new RangeError(`invalid speed: ${speed}`);
  const durationMin = options.durationMin ?? 360;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;

  // In batch the window ends now; in real time it starts now and runs `speed` times faster.
  const scale = mode === 'batch' ? 1 : 1 / speed;
  const start = mode === 'batch' ? now() - durationMin * 60_000 : now();
  const instant = (offsetMs: number) => start + Math.round(offsetMs * scale);

  const scenario = generateScenario({
    seed: options.seed,
    sessions: options.sessions,
    durationMin,
    chaos: options.chaos,
    chaosIntensity: options.chaosIntensity,
    clock: (ms) => new Date(instant(ms)).toISOString(),
  });

  const summary: SimulationSummary = {
    seed: String(options.seed),
    prefix: scenario.prefix,
    mode,
    start: new Date(start).toISOString(),
    scripts: { normal: 0, stuck: 0, error: 0, abandonment: 0, overflow: 0, swarm: 0 },
    written: { accounts: 0, sessions: 0, agents: 0, events: 0, usages: 0, prices: 0 },
    interrupted: false,
  };
  for (const s of scenario.scripts) summary.scripts[s]++;

  if (options.prices) {
    const existing = new Set((await storage.listModelPricing()).map((p) => p.pattern));
    for (const p of ILLUSTRATIVE_PRICES) {
      if (existing.has(p.pattern)) continue;
      await storage.putModelPricing({ ...p, updatedAt: new Date(start).toISOString() });
      summary.written.prices++;
    }
  }

  // Accounts go before sessions; `lastSeenAt` follows each one's last written activity.
  const accounts = new Map(scenario.accounts.map((c) => [c.id, c]));
  for (const c of accounts.values()) await storage.putAccount(c);
  summary.written.accounts = accounts.size;

  const sessions = new Set<string>();
  const agents = new Set<string>();
  for (const op of scenario.operations) {
    if (mode === 'real-time') {
      const remaining = instant(op.offsetMs) - now();
      if (remaining > 0) await wait(remaining, options.signal);
    }
    if (options.signal?.aborted) {
      summary.interrupted = true;
      break;
    }
    switch (op.kind) {
      case 'session': {
        await storage.putSession(op.record);
        sessions.add(op.record.id);
        const account = op.record.accountId ? accounts.get(op.record.accountId) : undefined;
        if (account && op.record.updatedAt > account.lastSeenAt) {
          const seen = { ...account, lastSeenAt: op.record.updatedAt };
          accounts.set(account.id, seen);
          await storage.putAccount(seen);
        }
        break;
      }
      case 'agent':
        await storage.putAgent(op.record);
        agents.add(op.record.id);
        break;
      case 'event':
        if (await storage.appendEvent(op.record)) summary.written.events++;
        break;
      case 'usage':
        await storage.putTokenUsage(op.record);
        summary.written.usages++;
        break;
    }
    options.onWrite?.(op);
  }
  summary.written.sessions = sessions.size;
  summary.written.agents = agents.size;
  return summary;
}
