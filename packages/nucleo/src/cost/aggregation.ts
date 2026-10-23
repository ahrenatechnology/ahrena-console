// Cost aggregations by session, agent, model and day: what the MCP and the screens consume.
//
// Where each number comes from:
// - The usage buckets (`listTokenUsage`) are the session's total per model and price dimension, floor included.
// - The events with `data.usage` (the assistant messages in the transcript) say which agent and which day
//   each part came from. Deduplicated by `message.id`, as in the import.
// - What the bucket has beyond the events (the compaction floor, usage written without an event, as in the
//   simulator) goes in as a slice with no agent, on the day of the bucket's last update.
// So every grouping adds up to the same total. Everything is an estimate.

import { dedupeByMessage, bucketKey, addCounts, type UsageSample } from '../ingest/history/usage.ts';
import type { MessageUsage } from '../ingest/history/transcript.ts';
import { emptyTokenCounts, type ModelPricing, type SessionEvent, type TokenCounts, type TokenUsage } from '../model.ts';
import { contextSizeFor, estimateCost, type CostEstimate } from '../pricing.ts';
import type { StoragePort } from '../storage-port.ts';
import { currentPrices } from './table.ts';

const KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

/** A piece of usage with agent, day and price dimensions, with its cost already estimated. */
export interface CostSlice {
  sessionId: string;
  /** `null` when it cannot be assigned to an agent (compaction floor, usage without an event). */
  agentId: string | null;
  /** `YYYY-MM-DD` in the requested time zone (UTC by default). */
  day: string;
  model: string;
  speed: string;
  inferenceGeo: string;
  serviceTier: string;
  contextSize: string;
  tokens: TokenCounts;
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
  cost: CostEstimate;
}

export interface CostLine {
  key: string;
  tokens: TokenCounts;
  /** Sum of the five categories. */
  totalTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
  /**
   * Sum of what has a price. `null` when there is usage and none of it has a price: it shows as "unpriced", never as zero.
   * With a price for only part of it, it is the sum of that part and `unpriced` says what was left out.
   */
  costUsd: number | null;
  unpriced: { models: string[]; totalTokens: number };
  estimate: true;
}

export interface AgentCostLine extends CostLine {
  sessionId: string;
  agentId: string | null;
}

export interface CostReport {
  estimate: true;
  currency: 'USD';
  /** Time zone of the days. */
  timeZone: string;
  total: CostLine;
  bySession: CostLine[];
  byAgent: AgentCostLine[];
  byModel: CostLine[];
  /** In chronological order. */
  byDay: CostLine[];
}

export interface CostOptions {
  /** Only these sessions. Without it, all of them. */
  sessionIds?: readonly string[];
  /** First day included, `YYYY-MM-DD`. */
  since?: string;
  /** Last day included, `YYYY-MM-DD`. */
  until?: string;
  /** IANA time zone for the days (e.g. `America/Sao_Paulo`). UTC by default. */
  timeZone?: string;
  /** Price table. Without it, the one in force (defaults plus overrides). */
  prices?: readonly ModelPricing[];
}

type CostStorage = Pick<StoragePort, 'listSessions' | 'listEvents' | 'listTokenUsage' | 'listModelPricing'>;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Day (`YYYY-MM-DD`) of an ISO date in the given time zone. */
export function dayOf(iso: string, timeZone = 'UTC'): string {
  if (timeZone === 'UTC') return iso.slice(0, 10);
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f.format(new Date(iso));
}

function isCounts(v: unknown): v is TokenCounts {
  return typeof v === 'object' && v !== null && KEYS.every((k) => Number.isInteger((v as Record<string, unknown>)[k]));
}

/** Message usage stored in an event (the `parseUsage` shape), read defensively. */
function eventUsage(data: unknown): MessageUsage | null {
  const u = (data as { usage?: unknown } | null)?.usage as Partial<MessageUsage> | undefined;
  if (!u || typeof u.model !== 'string' || !isCounts(u.tokens)) return null;
  return {
    messageId: typeof u.messageId === 'string' ? u.messageId : null,
    requestId: typeof u.requestId === 'string' ? u.requestId : null,
    model: u.model,
    speed: typeof u.speed === 'string' ? u.speed : 'standard',
    inferenceGeo: typeof u.inferenceGeo === 'string' ? u.inferenceGeo : '',
    serviceTier: typeof u.serviceTier === 'string' ? u.serviceTier : 'standard',
    contextSize: typeof u.contextSize === 'string' ? u.contextSize : '',
    tokens: u.tokens,
    webSearchRequests: Number.isInteger(u.webSearchRequests) ? (u.webSearchRequests as number) : 0,
    webFetchRequests: Number.isInteger(u.webFetchRequests) ? (u.webFetchRequests as number) : 0,
    codeExecutionRequests: Number.isInteger(u.codeExecutionRequests) ? (u.codeExecutionRequests as number) : 0,
  };
}

function subtract(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out = emptyTokenCounts();
  for (const k of KEYS) out[k] = Math.max(a[k] - b[k], 0);
  return out;
}

const sumOf = (t: TokenCounts): number => KEYS.reduce((s, k) => s + t[k], 0);

/** The usage sample an event carries (an assistant message in the transcript), or `null`. */
export function usageSampleOf(e: SessionEvent): UsageSample | null {
  const usage = eventUsage(e.data);
  return usage ? { eventId: e.id, agentId: e.agentId ?? '', usage } : null;
}

/** A session's slices: one per assistant message, plus each bucket's remainder. */
export async function sessionCostSlices(
  port: Pick<StoragePort, 'listEvents' | 'listTokenUsage'>,
  sessionId: string,
  prices: readonly ModelPricing[],
  timeZone = 'UTC',
): Promise<CostSlice[]> {
  const samples: UsageSample[] = [];
  const when = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const page = await port.listEvents(sessionId, { limit: 500, cursor });
    for (const e of page.items) {
      const sample = usageSampleOf(e);
      if (!sample) continue;
      samples.push(sample);
      when.set(e.id, e.createdAt);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return costSlicesOf(port, sessionId, samples, when, prices, timeZone);
}

/** The same slices from samples already read (`when` is the `createdAt` of each sample's event). */
export async function costSlicesOf(
  port: Pick<StoragePort, 'listTokenUsage'>,
  sessionId: string,
  samples: readonly UsageSample[],
  when: ReadonlyMap<string, string>,
  prices: readonly ModelPricing[],
  timeZone = 'UTC',
): Promise<CostSlice[]> {
  const buckets = await port.listTokenUsage(sessionId);
  // What the events already explain of each bucket.
  const explained = new Map<string, { tokens: TokenCounts; web: [number, number, number] }>();
  const slices: CostSlice[] = [];

  for (const s of dedupeByMessage(samples)) {
    const u = s.usage;
    const key = bucketKey({ sessionId, ...u });
    const e = explained.get(key) ?? { tokens: emptyTokenCounts(), web: [0, 0, 0] };
    e.tokens = addCounts(e.tokens, u.tokens);
    e.web = [e.web[0] + u.webSearchRequests, e.web[1] + u.webFetchRequests, e.web[2] + u.codeExecutionRequests];
    explained.set(key, e);

    // The long context band is per request: only the message knows the prompt size.
    const contextSize = u.contextSize || contextSizeFor(u.model, u.tokens);
    const dims = { model: u.model, speed: u.speed, inferenceGeo: u.inferenceGeo, serviceTier: u.serviceTier, contextSize };
    slices.push({
      sessionId,
      agentId: s.agentId || null,
      day: dayOf(when.get(s.eventId)!, timeZone),
      ...dims,
      tokens: u.tokens,
      webSearchRequests: u.webSearchRequests,
      webFetchRequests: u.webFetchRequests,
      codeExecutionRequests: u.codeExecutionRequests,
      cost: estimateCost({ ...dims, tokens: u.tokens, baseline: emptyTokenCounts(), webSearchRequests: u.webSearchRequests }, prices),
    });
  }

  for (const b of buckets) slices.push(...bucketRemainder(b, explained.get(bucketKey(b)), prices, timeZone));
  return slices;
}

function bucketRemainder(
  b: TokenUsage,
  explained: { tokens: TokenCounts; web: [number, number, number] } | undefined,
  prices: readonly ModelPricing[],
  timeZone: string,
): CostSlice[] {
  const tokens = addCounts(subtract(b.tokens, explained?.tokens ?? emptyTokenCounts()), b.baseline);
  const web = explained?.web ?? [0, 0, 0];
  const webSearchRequests = Math.max(b.webSearchRequests - web[0], 0);
  const webFetchRequests = Math.max(b.webFetchRequests - web[1], 0);
  const codeExecutionRequests = Math.max(b.codeExecutionRequests - web[2], 0);
  if (sumOf(tokens) + webSearchRequests + webFetchRequests + codeExecutionRequests === 0) return [];
  const dims = { model: b.model, speed: b.speed, inferenceGeo: b.inferenceGeo, serviceTier: b.serviceTier, contextSize: b.contextSize };
  return [
    {
      sessionId: b.sessionId,
      agentId: null,
      day: dayOf(b.updatedAt, timeZone),
      ...dims,
      tokens,
      webSearchRequests,
      webFetchRequests,
      codeExecutionRequests,
      cost: estimateCost({ ...dims, tokens, baseline: emptyTokenCounts(), webSearchRequests }, prices),
    },
  ];
}

class Accumulator {
  tokens = emptyTokenCounts();
  web = [0, 0, 0];
  cost = 0;
  hasPrice = false;
  unpriced = new Set<string>();
  unpricedTokens = 0;

  add(p: CostSlice): void {
    this.tokens = addCounts(this.tokens, p.tokens);
    this.web[0] += p.webSearchRequests;
    this.web[1] += p.webFetchRequests;
    this.web[2] += p.codeExecutionRequests;
    if (p.cost.priced) {
      this.cost += p.cost.costUsd;
      this.hasPrice = true;
    } else {
      this.unpriced.add(p.model);
      this.unpricedTokens += sumOf(p.tokens);
    }
  }

  line(key: string): CostLine {
    const noUnpricedUsage = this.unpriced.size === 0 || this.unpricedTokens === 0;
    return {
      key,
      tokens: this.tokens,
      totalTokens: sumOf(this.tokens),
      webSearchRequests: this.web[0],
      webFetchRequests: this.web[1],
      codeExecutionRequests: this.web[2],
      costUsd: this.hasPrice || noUnpricedUsage ? this.cost : null,
      unpriced: { models: [...this.unpriced].sort(), totalTokens: this.unpricedTokens },
      estimate: true,
    };
  }
}

function group(slices: readonly CostSlice[], keyOf: (p: CostSlice) => string): Map<string, Accumulator> {
  const groups = new Map<string, Accumulator>();
  for (const p of slices) {
    const k = keyOf(p);
    const a = groups.get(k) ?? new Accumulator();
    a.add(p);
    groups.set(k, a);
  }
  return groups;
}

/** Highest cost first; "unpriced" last. */
function byCost(a: CostLine, b: CostLine): number {
  return (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.key.localeCompare(b.key);
}

/** Builds the report from the slices (pure; `aggregateCost` fetches the slices through the port). */
export function costReport(slices: readonly CostSlice[], timeZone = 'UTC'): CostReport {
  const total = new Accumulator();
  for (const p of slices) total.add(p);
  const lines = (g: Map<string, Accumulator>) => [...g].map(([k, a]) => a.line(k));

  const agents = group(slices, (p) => JSON.stringify([p.sessionId, p.agentId]));
  return {
    estimate: true,
    currency: 'USD',
    timeZone,
    total: total.line('total'),
    bySession: lines(group(slices, (p) => p.sessionId)).sort(byCost),
    byAgent: [...agents]
      .map(([k, a]) => {
        const [sessionId, agentId] = JSON.parse(k) as [string, string | null];
        return { ...a.line(agentId ?? `${sessionId}:sem-agente`), sessionId, agentId };
      })
      .sort(byCost),
    byModel: lines(group(slices, (p) => p.model)).sort(byCost),
    byDay: lines(group(slices, (p) => p.day)).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

async function sessionIdsSince(port: Pick<StoragePort, 'listSessions'>, since: string | undefined, timeZone: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await port.listSessions({ limit: 500, cursor });
    for (const s of page.items) {
      // Most recent first: a session with no activity since the first day has no slice in the period.
      if (since && dayOf(s.updatedAt, timeZone) < since) return ids;
      ids.push(s.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

/** Cost by session, agent, model and day, read through the port. */
export async function aggregateCost(port: CostStorage, options: CostOptions = {}): Promise<CostReport> {
  const timeZone = options.timeZone ?? 'UTC';
  const prices = options.prices ?? (await currentPrices(port));
  const ids = options.sessionIds ?? (await sessionIdsSince(port, options.since, timeZone));
  const slices: CostSlice[] = [];
  for (const id of ids) {
    for (const p of await sessionCostSlices(port, id, prices, timeZone)) {
      if (options.since && p.day < options.since) continue;
      if (options.until && p.day > options.until) continue;
      slices.push(p);
    }
  }
  return costReport(slices, timeZone);
}

/** Shortcut for one session. */
export function sessionCost(port: CostStorage, sessionId: string, options: Omit<CostOptions, 'sessionIds'> = {}): Promise<CostReport> {
  return aggregateCost(port, { ...options, sessionIds: [sessionId] });
}
