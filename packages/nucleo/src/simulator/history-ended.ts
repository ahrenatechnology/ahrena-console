// P4's history (#33, C15): sessions ended over several days, one with an error and one abandoned,
// and a link after /clear (yesterday's continued in another). All synthetic, with the simulator's
// vocabulary. Only P4 has it: the other scenarios get nothing, so their panels do not change.

import { emptyTokenCounts, type Session, type SessionStatus } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { DecisionPort } from '../decisions/port.ts';
import { linkSession } from '../decisions/registry.ts';
import type { PanelScenario } from './panel.ts';
import { ROOT } from './vocabulary.ts';

const MIN = 60_000;
const DAY = 24 * 60;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

interface EndedSession {
  slug: string;
  title: string;
  project: string;
  model: string;
  status: Extract<SessionStatus, 'completed' | 'error' | 'abandoned'>;
  /** How many minutes ago it ended. */
  endMin: number;
  durationMin: number;
  /** Approximate cost in US$, at the default price; without it, the session has no usage written. */
  cost?: number;
}

/** The session before /clear and the one that continued after it, yesterday. */
export const BEFORE_CLEAR = 'sim-history-map-payments';
export const AFTER_CLEAR = 'sim-history-extract-billing';

const ENDED: EndedSession[] = [
  { slug: 'map-payments', title: 'Mapear o módulo de pagamentos', project: 'vitrine-demo', model: OPUS, status: 'completed', endMin: DAY + 180, durationMin: 50, cost: 2.1 },
  { slug: 'extract-billing', title: 'Extrair a cobrança', project: 'vitrine-demo', model: OPUS, status: 'completed', endMin: DAY + 60, durationMin: 110, cost: 1.3 },
  { slug: 'monthly-report', title: 'Relatório mensal mais rápido', project: 'painel-de-metricas', model: OPUS, status: 'error', endMin: 2 * DAY, durationMin: 35, cost: 0.8 },
  { slug: 'recipe-search', title: 'Busca de receitas', project: 'app-receitas', model: SONNET, status: 'completed', endMin: 3 * DAY + 30, durationMin: 20 },
  { slug: 'discount-rules', title: 'Regras de desconto', project: 'motor-de-regras', model: SONNET, status: 'abandoned', endMin: 5 * DAY, durationMin: 240, cost: 0.4 },
  { slug: 'markdown-notes', title: 'Notas em Markdown', project: 'cli-de-notas', model: SONNET, status: 'completed', endMin: 6 * DAY, durationMin: 15, cost: 0.2 },
  { slug: 'weekly-agenda', title: 'Agenda semanal', project: 'agenda-ficticia', model: OPUS, status: 'completed', endMin: 8 * DAY, durationMin: 45, cost: 1.1 },
  { slug: 'gateway-limits', title: 'Limites do gateway', project: 'gateway-sandbox', model: OPUS, status: 'completed', endMin: 9 * DAY, durationMin: 70, cost: 2.6 },
];

// Default price (US$ per million): Opus 5.5 4/20, Sonnet 5.5 2/10. Half the cost in input, half in output.
function tokensFor(model: string, cost: number) {
  const [pin, pout] = model === OPUS ? [4, 20] : [2, 10];
  return { ...emptyTokenCounts(), input: Math.round(((cost / 2) * 1e6) / pin), output: Math.round(((cost / 2) * 1e6) / pout) };
}

/** Writes P4's ended sessions and links yesterday's to the one that came after /clear. */
export async function seedPanelHistory(storage: StoragePort, decisions: DecisionPort | null, scenario: PanelScenario = 'p4', now = Date.now()): Promise<void> {
  if (scenario !== 'p4') return;
  const iso = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  for (const e of ENDED) {
    const id = `sim-history-${e.slug}`;
    const end = iso(e.endMin);
    const s: Session = {
      id, name: e.title, status: e.status, cwd: `${ROOT}/${e.project}`, model: e.model, source: 'startup',
      startedAt: iso(e.endMin + e.durationMin), endedAt: end, awaitingInputSince: null, awaitingReason: null, updatedAt: end,
      accountId: null, accountSource: null, metadata: { simulated: true },
    };
    await storage.putSession(s);
    if (e.cost) {
      await storage.putTokenUsage({
        sessionId: id, model: e.model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '',
        tokens: tokensFor(e.model, e.cost), webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0, baseline: emptyTokenCounts(), updatedAt: end,
      });
    }
  }
  const after = ENDED.find((e) => `sim-history-${e.slug}` === AFTER_CLEAR)!;
  if (decisions) await linkSession(decisions, { sessionId: AFTER_CLEAR, parentSessionId: BEFORE_CLEAR, reason: 'clear', linkedAt: iso(after.endMin + after.durationMin) }, iso(0));
}
