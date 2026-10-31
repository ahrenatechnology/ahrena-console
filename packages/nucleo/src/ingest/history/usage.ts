// Sum of token usage from the imported events, without counting twice.
//
// Streaming writes the same assistant message on several lines (one per content block), each with
// the `usage` of that moment: partial on the first ones, final on the last. So usage is
// deduplicated by `message.id` (or `requestId`, or the event itself) and the entry with the most
// output tokens, the final one, is kept. Recomputing everything from the events makes the sum idempotent.

import { emptyTokenCounts, type TokenCounts, type TokenUsage, type TokenUsageKey } from '../../model.ts';
import type { MessageUsage } from './transcript.ts';

export interface UsageSample {
  eventId: string;
  agentId: string;
  usage: MessageUsage;
}

const COUNT_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

export function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out = emptyTokenCounts();
  for (const k of COUNT_KEYS) out[k] = a[k] + b[k];
  return out;
}

const total = (c: TokenCounts): number => COUNT_KEYS.reduce((s, k) => s + c[k], 0);

/** The key of the message a sample belongs to. */
export const messageKeyOf = (s: UsageSample): string => s.usage.messageId ?? s.usage.requestId ?? s.eventId;

/** Whether `s` should replace `prev` as the sample of its message: more output, then more tokens in all. */
export function isBetterSample(s: UsageSample, prev: UsageSample | undefined): boolean {
  return (
    !prev ||
    s.usage.tokens.output > prev.usage.tokens.output ||
    (s.usage.tokens.output === prev.usage.tokens.output && total(s.usage.tokens) > total(prev.usage.tokens))
  );
}

/** Uma amostra por mensagem: a de mais saída (e, empatando, a de mais tokens no total). */
export function dedupeByMessage(samples: Iterable<UsageSample>): UsageSample[] {
  const best = new Map<string, UsageSample>();
  for (const s of samples) {
    const key = messageKeyOf(s);
    if (isBetterSample(s, best.get(key))) best.set(key, s);
  }
  return [...best.values()];
}

export interface UsageTotals {
  /** Buckets da sessão, sem `baseline` nem `updatedAt` (quem grava decide). */
  buckets: Omit<TokenUsage, 'baseline' | 'updatedAt'>[];
  /** Tokens por agente, somados em todos os modelos. */
  byAgent: Map<string, TokenCounts>;
}

export function bucketKey(k: TokenUsageKey): string {
  return JSON.stringify([k.sessionId, k.model, k.speed, k.inferenceGeo, k.serviceTier, k.contextSize]);
}

export function aggregateUsage(sessionId: string, samples: Iterable<UsageSample>): UsageTotals {
  const buckets = new Map<string, UsageTotals['buckets'][number]>();
  const byAgent = new Map<string, TokenCounts>();
  for (const { agentId, usage: u } of dedupeByMessage(samples)) {
    const key = { sessionId, model: u.model, speed: u.speed, inferenceGeo: u.inferenceGeo, serviceTier: u.serviceTier, contextSize: u.contextSize };
    const id = bucketKey(key);
    const b = buckets.get(id) ?? { ...key, tokens: emptyTokenCounts(), webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0 };
    b.tokens = addCounts(b.tokens, u.tokens);
    b.webSearchRequests += u.webSearchRequests;
    b.webFetchRequests += u.webFetchRequests;
    b.codeExecutionRequests += u.codeExecutionRequests;
    buckets.set(id, b);
    byAgent.set(agentId, addCounts(byAgent.get(agentId) ?? emptyTokenCounts(), u.tokens));
  }
  return { buckets: [...buckets.values()], byAgent };
}
