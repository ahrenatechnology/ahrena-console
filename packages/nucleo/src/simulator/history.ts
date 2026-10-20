// Simulated history for the Analytics screen demo (#95, #32): ended sessions spread over the last
// ~90 days, sparser up to 52 weeks, on the simulator's two accounts. Deterministic from the seed and
// `now`. Only for --demo: nothing here is real data.
//
// Each drawn day becomes a simulator scenario (generateScenario) of a few sessions, at a time of day.
// Without chaos mode, and whatever the scenario leaves running is ended at the last written instant:
// the seeded sessions are all completed and in the past (yesterday and before), with no wait or
// error, so they do not show in the panel as "needs you" nor compete with the panel scenario's.

import type { Agent, ClaudeAccount, Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { SeededRandom } from './random.ts';
import { generateScenario } from './scenario.ts';

export interface HistorySeedOptions {
  seed?: string | number;
  /** Clock in ms. The history ends yesterday. */
  now?: number;
  /** How many days back at most. Default 364. */
  days?: number;
}

export interface HistorySeedSummary {
  days: number;
  sessions: number;
  events: number;
}

const MIN = 60_000;
const DAY = 1440 * MIN;

/** Chance of a day having sessions: high in the last 90 days, sparse before; weekends calmer. */
function dayChance(daysAgo: number, weekend: boolean): number {
  const base = daysAgo <= 90 ? 0.85 - (daysAgo / 90) * 0.25 : 0.18;
  return weekend ? base * 0.35 : base;
}

/** A session with an error also counts as "needs you" in the panel: in the history, everything ends completed. */
function endSession(s: Session): Session {
  return { ...s, status: 'completed', endedAt: s.endedAt ?? s.updatedAt, awaitingInputSince: null, awaitingReason: null };
}

function endAgent(a: Agent): Agent {
  if (a.status === 'completed' || a.status === 'error') return a;
  return { ...a, status: 'completed', endedAt: a.endedAt ?? a.updatedAt, currentTool: null };
}

export async function seedHistory(storage: StoragePort, options: HistorySeedOptions = {}): Promise<HistorySeedSummary> {
  const seed = options.seed ?? 'analytics';
  const now = options.now ?? Date.now();
  const total = options.days ?? 364;
  // The seed strings (`:historico`, `:dia:`) stay as they were: they decide the generated data.
  const rng = new SeededRandom(`${seed}:historico`);
  const todayUtc = Math.floor(now / DAY) * DAY;
  const summary: HistorySeedSummary = { days: 0, sessions: 0, events: 0 };
  const accounts = new Map<string, ClaudeAccount>();

  for (let ago = total; ago >= 1; ago--) {
    const dayStart = todayUtc - ago * DAY;
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay());
    if (!rng.chance(dayChance(ago, weekend))) continue;
    const sessions = ago <= 90 ? rng.int(1, 4) : 1;
    // Starts between 11h and 15h UTC (morning in Brazil) and lasts up to 6 h: it stays on the same day.
    const start = dayStart + rng.int(11 * 60, 15 * 60) * MIN;
    const scenario = generateScenario({
      seed: `${seed}:dia:${ago}`,
      sessions,
      durationMin: 300,
      clock: (ms) => new Date(start + ms).toISOString(),
    });
    summary.days++;
    for (const c of scenario.accounts) {
      const seen = accounts.get(c.id);
      accounts.set(c.id, seen ? { ...seen, lastSeenAt: c.lastSeenAt } : c);
    }
    // The last record of each session and each agent, already ended; events and usages as they came.
    const lastSession = new Map<string, Session>();
    const lastAgent = new Map<string, Agent>();
    for (const op of scenario.operations) {
      if (op.kind === 'session') lastSession.set(op.record.id, op.record);
      else if (op.kind === 'agent') lastAgent.set(op.record.id, op.record);
      else if (op.kind === 'event') {
        if (await storage.appendEvent(op.record)) summary.events++;
      } else await storage.putTokenUsage(op.record);
    }
    for (const s of lastSession.values()) await storage.putSession(endSession(s));
    for (const a of lastAgent.values()) await storage.putAgent(endAgent(a));
    summary.sessions += lastSession.size;
  }
  for (const c of accounts.values()) await storage.putAccount(c);
  return summary;
}
