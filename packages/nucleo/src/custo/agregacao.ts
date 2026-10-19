// Agregações de custo por sessão, agente, modelo e dia: o que o MCP e as telas consomem.
//
// De onde vem cada número:
// - Os buckets de uso (`listTokenUsage`) são o total da sessão por modelo e dimensão de preço, piso incluído.
// - Os eventos com `data.usage` (as mensagens do assistente no transcript) dizem de qual agente e de que dia
//   veio cada parte. Deduplicados por `message.id`, como na importação.
// - O que o bucket tem além dos eventos (o piso da compactação, uso gravado sem evento, como no simulador)
//   entra como parcela sem agente, no dia da última atualização do bucket.
// Assim cada agrupamento soma o mesmo total. Tudo é estimativa.

import { dedupeByMessage, bucketKey, addCounts, type UsageSample } from '../ingest/historico/usage.ts';
import type { MessageUsage } from '../ingest/historico/transcript.ts';
import { emptyTokenCounts, type ModelPricing, type TokenCounts, type TokenUsage } from '../model.ts';
import { contextSizeFor, estimateCost, type CostEstimate } from '../pricing.ts';
import type { StoragePort } from '../storage-port.ts';
import { precosVigentes } from './tabela.ts';

const CHAVES = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

/** Um pedaço de uso com agente, dia e dimensões de preço, já com o custo estimado. */
export interface Parcela {
  sessionId: string;
  /** `null` quando não dá para atribuir a um agente (piso da compactação, uso sem evento). */
  agentId: string | null;
  /** `AAAA-MM-DD` no fuso pedido (UTC por padrão). */
  dia: string;
  model: string;
  speed: string;
  inferenceGeo: string;
  serviceTier: string;
  contextSize: string;
  tokens: TokenCounts;
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
  custo: CostEstimate;
}

export interface LinhaDeCusto {
  chave: string;
  tokens: TokenCounts;
  /** Soma das cinco categorias. */
  totalDeTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
  /**
   * Soma do que tem preço. `null` quando há uso e nada dele tem preço: aparece como "sem preço", nunca como zero.
   * Com preço só em parte, é a soma dessa parte e `semPreco` diz o que ficou de fora.
   */
  custoUsd: number | null;
  semPreco: { modelos: string[]; totalDeTokens: number };
  estimativa: true;
}

export interface LinhaPorAgente extends LinhaDeCusto {
  sessionId: string;
  agentId: string | null;
}

export interface RelatorioDeCusto {
  estimativa: true;
  moeda: 'USD';
  /** Fuso dos dias. */
  fusoHorario: string;
  total: LinhaDeCusto;
  porSessao: LinhaDeCusto[];
  porAgente: LinhaPorAgente[];
  porModelo: LinhaDeCusto[];
  /** Em ordem cronológica. */
  porDia: LinhaDeCusto[];
}

export interface OpcoesDeCusto {
  /** Só estas sessões. Sem isto, todas. */
  sessionIds?: readonly string[];
  /** Primeiro dia incluído, `AAAA-MM-DD`. */
  desde?: string;
  /** Último dia incluído, `AAAA-MM-DD`. */
  ate?: string;
  /** Fuso IANA para os dias (ex.: `America/Sao_Paulo`). Padrão UTC. */
  fusoHorario?: string;
  /** Tabela de preços. Sem isto, a vigente (padrão mais sobrescritas). */
  precos?: readonly ModelPricing[];
}

type PortaDeLeitura = Pick<StoragePort, 'listSessions' | 'listEvents' | 'listTokenUsage' | 'listModelPricing'>;

const formatadores = new Map<string, Intl.DateTimeFormat>();

/** Dia (`AAAA-MM-DD`) de uma data ISO no fuso dado. */
export function diaDe(iso: string, fusoHorario = 'UTC'): string {
  if (fusoHorario === 'UTC') return iso.slice(0, 10);
  let f = formatadores.get(fusoHorario);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: fusoHorario, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatadores.set(fusoHorario, f);
  }
  return f.format(new Date(iso));
}

function isCounts(v: unknown): v is TokenCounts {
  return typeof v === 'object' && v !== null && CHAVES.every((k) => Number.isInteger((v as Record<string, unknown>)[k]));
}

/** Uso de mensagem gravado num evento (formato de `parseUsage`), lido de forma defensiva. */
function usoDoEvento(data: unknown): MessageUsage | null {
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

function subtrair(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out = emptyTokenCounts();
  for (const k of CHAVES) out[k] = Math.max(a[k] - b[k], 0);
  return out;
}

const somaDe = (t: TokenCounts): number => CHAVES.reduce((s, k) => s + t[k], 0);

/** Parcelas de uma sessão: uma por mensagem do assistente, mais o resto de cada bucket. */
export async function parcelasDaSessao(
  porta: Pick<StoragePort, 'listEvents' | 'listTokenUsage'>,
  sessionId: string,
  precos: readonly ModelPricing[],
  fusoHorario = 'UTC',
): Promise<Parcela[]> {
  const samples: UsageSample[] = [];
  const quando = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const page = await porta.listEvents(sessionId, { limit: 500, cursor });
    for (const e of page.items) {
      const usage = usoDoEvento(e.data);
      if (!usage) continue;
      samples.push({ eventId: e.id, agentId: e.agentId ?? '', usage });
      quando.set(e.id, e.createdAt);
    }
    cursor = page.nextCursor;
  } while (cursor);

  const buckets = await porta.listTokenUsage(sessionId);
  // O que os eventos já explicam de cada bucket.
  const explicado = new Map<string, { tokens: TokenCounts; web: [number, number, number] }>();
  const parcelas: Parcela[] = [];

  for (const s of dedupeByMessage(samples)) {
    const u = s.usage;
    const chave = bucketKey({ sessionId, ...u });
    const e = explicado.get(chave) ?? { tokens: emptyTokenCounts(), web: [0, 0, 0] };
    e.tokens = addCounts(e.tokens, u.tokens);
    e.web = [e.web[0] + u.webSearchRequests, e.web[1] + u.webFetchRequests, e.web[2] + u.codeExecutionRequests];
    explicado.set(chave, e);

    // A faixa de contexto longo é por requisição: só a mensagem sabe o tamanho do prompt.
    const contextSize = u.contextSize || contextSizeFor(u.model, u.tokens);
    const dims = { model: u.model, speed: u.speed, inferenceGeo: u.inferenceGeo, serviceTier: u.serviceTier, contextSize };
    parcelas.push({
      sessionId,
      agentId: s.agentId || null,
      dia: diaDe(quando.get(s.eventId)!, fusoHorario),
      ...dims,
      tokens: u.tokens,
      webSearchRequests: u.webSearchRequests,
      webFetchRequests: u.webFetchRequests,
      codeExecutionRequests: u.codeExecutionRequests,
      custo: estimateCost({ ...dims, tokens: u.tokens, baseline: emptyTokenCounts(), webSearchRequests: u.webSearchRequests }, precos),
    });
  }

  for (const b of buckets) parcelas.push(...restoDoBucket(b, explicado.get(bucketKey(b)), precos, fusoHorario));
  return parcelas;
}

function restoDoBucket(
  b: TokenUsage,
  explicado: { tokens: TokenCounts; web: [number, number, number] } | undefined,
  precos: readonly ModelPricing[],
  fusoHorario: string,
): Parcela[] {
  const tokens = addCounts(subtrair(b.tokens, explicado?.tokens ?? emptyTokenCounts()), b.baseline);
  const web = explicado?.web ?? [0, 0, 0];
  const webSearchRequests = Math.max(b.webSearchRequests - web[0], 0);
  const webFetchRequests = Math.max(b.webFetchRequests - web[1], 0);
  const codeExecutionRequests = Math.max(b.codeExecutionRequests - web[2], 0);
  if (somaDe(tokens) + webSearchRequests + webFetchRequests + codeExecutionRequests === 0) return [];
  const dims = { model: b.model, speed: b.speed, inferenceGeo: b.inferenceGeo, serviceTier: b.serviceTier, contextSize: b.contextSize };
  return [
    {
      sessionId: b.sessionId,
      agentId: null,
      dia: diaDe(b.updatedAt, fusoHorario),
      ...dims,
      tokens,
      webSearchRequests,
      webFetchRequests,
      codeExecutionRequests,
      custo: estimateCost({ ...dims, tokens, baseline: emptyTokenCounts(), webSearchRequests }, precos),
    },
  ];
}

class Acumulador {
  tokens = emptyTokenCounts();
  web = [0, 0, 0];
  custo = 0;
  temPreco = false;
  semPreco = new Set<string>();
  tokensSemPreco = 0;

  somar(p: Parcela): void {
    this.tokens = addCounts(this.tokens, p.tokens);
    this.web[0] += p.webSearchRequests;
    this.web[1] += p.webFetchRequests;
    this.web[2] += p.codeExecutionRequests;
    if (p.custo.priced) {
      this.custo += p.custo.costUsd;
      this.temPreco = true;
    } else {
      this.semPreco.add(p.model);
      this.tokensSemPreco += somaDe(p.tokens);
    }
  }

  linha(chave: string): LinhaDeCusto {
    const semUso = this.semPreco.size === 0 || this.tokensSemPreco === 0;
    return {
      chave,
      tokens: this.tokens,
      totalDeTokens: somaDe(this.tokens),
      webSearchRequests: this.web[0],
      webFetchRequests: this.web[1],
      codeExecutionRequests: this.web[2],
      custoUsd: this.temPreco || semUso ? this.custo : null,
      semPreco: { modelos: [...this.semPreco].sort(), totalDeTokens: this.tokensSemPreco },
      estimativa: true,
    };
  }
}

function agrupar(parcelas: readonly Parcela[], chaveDe: (p: Parcela) => string): Map<string, Acumulador> {
  const grupos = new Map<string, Acumulador>();
  for (const p of parcelas) {
    const k = chaveDe(p);
    const a = grupos.get(k) ?? new Acumulador();
    a.somar(p);
    grupos.set(k, a);
  }
  return grupos;
}

/** Maior custo primeiro; "sem preço" por último. */
function porCusto(a: LinhaDeCusto, b: LinhaDeCusto): number {
  return (b.custoUsd ?? -1) - (a.custoUsd ?? -1) || a.chave.localeCompare(b.chave);
}

/** Monta o relatório a partir das parcelas (puro; `agregarCusto` busca as parcelas pela porta). */
export function relatorioDeCusto(parcelas: readonly Parcela[], fusoHorario = 'UTC'): RelatorioDeCusto {
  const total = new Acumulador();
  for (const p of parcelas) total.somar(p);
  const linhas = (g: Map<string, Acumulador>) => [...g].map(([k, a]) => a.linha(k));

  const agentes = agrupar(parcelas, (p) => JSON.stringify([p.sessionId, p.agentId]));
  return {
    estimativa: true,
    moeda: 'USD',
    fusoHorario,
    total: total.linha('total'),
    porSessao: linhas(agrupar(parcelas, (p) => p.sessionId)).sort(porCusto),
    porAgente: [...agentes]
      .map(([k, a]) => {
        const [sessionId, agentId] = JSON.parse(k) as [string, string | null];
        return { ...a.linha(agentId ?? `${sessionId}:sem-agente`), sessionId, agentId };
      })
      .sort(porCusto),
    porModelo: linhas(agrupar(parcelas, (p) => p.model)).sort(porCusto),
    porDia: linhas(agrupar(parcelas, (p) => p.dia)).sort((a, b) => a.chave.localeCompare(b.chave)),
  };
}

async function idsDasSessoes(porta: Pick<StoragePort, 'listSessions'>, desde: string | undefined, fuso: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await porta.listSessions({ limit: 500, cursor });
    for (const s of page.items) {
      // Mais recentes primeiro: sessão sem atividade desde o primeiro dia não tem parcela no período.
      if (desde && diaDe(s.updatedAt, fuso) < desde) return ids;
      ids.push(s.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

/** Custo por sessão, agente, modelo e dia, lido pela porta. */
export async function agregarCusto(porta: PortaDeLeitura, opcoes: OpcoesDeCusto = {}): Promise<RelatorioDeCusto> {
  const fuso = opcoes.fusoHorario ?? 'UTC';
  const precos = opcoes.precos ?? (await precosVigentes(porta));
  const ids = opcoes.sessionIds ?? (await idsDasSessoes(porta, opcoes.desde, fuso));
  const parcelas: Parcela[] = [];
  for (const id of ids) {
    for (const p of await parcelasDaSessao(porta, id, precos, fuso)) {
      if (opcoes.desde && p.dia < opcoes.desde) continue;
      if (opcoes.ate && p.dia > opcoes.ate) continue;
      parcelas.push(p);
    }
  }
  return relatorioDeCusto(parcelas, fuso);
}

/** Atalho para uma sessão. */
export function custoDaSessao(porta: PortaDeLeitura, sessionId: string, opcoes: Omit<OpcoesDeCusto, 'sessionIds'> = {}): Promise<RelatorioDeCusto> {
  return agregarCusto(porta, { ...opcoes, sessionIds: [sessionId] });
}
