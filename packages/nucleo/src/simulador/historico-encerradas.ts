// O histórico do P4 (#33, C15): sessões encerradas em vários dias, uma com erro e uma abandonada,
// e uma ligação depois do /clear (a de ontem continuou em outra). Tudo sintético, com o vocabulário
// do simulador. Só o P4 tem: nos outros cenários, nada, para os painéis deles não mudarem.

import { emptyTokenCounts, type Session, type SessionStatus } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import { linkSession } from '../decisoes/registro.ts';
import type { CenarioDoPainel } from './painel.ts';
import { RAIZ } from './vocabulario.ts';

const MIN = 60_000;
const DIA = 24 * 60;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

interface Encerrada {
  slug: string;
  titulo: string;
  projeto: string;
  modelo: string;
  status: Extract<SessionStatus, 'completed' | 'error' | 'abandoned'>;
  /** Há quantos minutos terminou. */
  fimMin: number;
  duracaoMin: number;
  /** Custo aproximado em US$, pelo preço padrão; sem ele, a sessão não tem uso gravado. */
  custo?: number;
}

/** A sessão de antes do /clear e a que continuou depois dele, ontem. */
export const ANTES_DO_CLEAR = 'sim-historico-mapear-pagamentos';
export const DEPOIS_DO_CLEAR = 'sim-historico-extrair-cobranca';

const ENCERRADAS: Encerrada[] = [
  { slug: 'mapear-pagamentos', titulo: 'Mapear o módulo de pagamentos', projeto: 'vitrine-demo', modelo: OPUS, status: 'completed', fimMin: DIA + 180, duracaoMin: 50, custo: 2.1 },
  { slug: 'extrair-cobranca', titulo: 'Extrair a cobrança', projeto: 'vitrine-demo', modelo: OPUS, status: 'completed', fimMin: DIA + 60, duracaoMin: 110, custo: 1.3 },
  { slug: 'relatorio-mensal', titulo: 'Relatório mensal mais rápido', projeto: 'painel-de-metricas', modelo: OPUS, status: 'error', fimMin: 2 * DIA, duracaoMin: 35, custo: 0.8 },
  { slug: 'busca-de-receitas', titulo: 'Busca de receitas', projeto: 'app-receitas', modelo: SONNET, status: 'completed', fimMin: 3 * DIA + 30, duracaoMin: 20 },
  { slug: 'regras-de-desconto', titulo: 'Regras de desconto', projeto: 'motor-de-regras', modelo: SONNET, status: 'abandoned', fimMin: 5 * DIA, duracaoMin: 240, custo: 0.4 },
  { slug: 'notas-em-markdown', titulo: 'Notas em Markdown', projeto: 'cli-de-notas', modelo: SONNET, status: 'completed', fimMin: 6 * DIA, duracaoMin: 15, custo: 0.2 },
  { slug: 'agenda-semanal', titulo: 'Agenda semanal', projeto: 'agenda-ficticia', modelo: OPUS, status: 'completed', fimMin: 8 * DIA, duracaoMin: 45, custo: 1.1 },
  { slug: 'limites-do-gateway', titulo: 'Limites do gateway', projeto: 'gateway-sandbox', modelo: OPUS, status: 'completed', fimMin: 9 * DIA, duracaoMin: 70, custo: 2.6 },
];

// Preço padrão (US$ por milhão): Opus 5.5 4/20, Sonnet 5.5 2/10. Metade do custo em entrada, metade em saída.
function tokensDe(modelo: string, custo: number) {
  const [pin, pout] = modelo === OPUS ? [4, 20] : [2, 10];
  return { ...emptyTokenCounts(), input: Math.round(((custo / 2) * 1e6) / pin), output: Math.round(((custo / 2) * 1e6) / pout) };
}

/** Grava as sessões encerradas do P4 e liga a de ontem à que veio depois do /clear. */
export async function semearHistoricoDoPainel(porta: StoragePort, decisoes: DecisionPort | null, cenario: CenarioDoPainel = 'p4', agora = Date.now()): Promise<void> {
  if (cenario !== 'p4') return;
  const iso = (minAtras: number) => new Date(agora - minAtras * MIN).toISOString();
  for (const e of ENCERRADAS) {
    const id = `sim-historico-${e.slug}`;
    const fim = iso(e.fimMin);
    const s: Session = {
      id, name: e.titulo, status: e.status, cwd: `${RAIZ}/${e.projeto}`, model: e.modelo, source: 'startup',
      startedAt: iso(e.fimMin + e.duracaoMin), endedAt: fim, awaitingInputSince: null, awaitingReason: null, updatedAt: fim,
      accountId: null, accountSource: null, metadata: { simulado: true },
    };
    await porta.putSession(s);
    if (e.custo) {
      await porta.putTokenUsage({
        sessionId: id, model: e.modelo, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '',
        tokens: tokensDe(e.modelo, e.custo), webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0, baseline: emptyTokenCounts(), updatedAt: fim,
      });
    }
  }
  const depois = ENCERRADAS.find((e) => `sim-historico-${e.slug}` === DEPOIS_DO_CLEAR)!;
  if (decisoes) await linkSession(decisoes, { sessionId: DEPOIS_DO_CLEAR, parentSessionId: ANTES_DO_CLEAR, reason: 'clear', linkedAt: iso(depois.fimMin + depois.duracaoMin) }, iso(0));
}
