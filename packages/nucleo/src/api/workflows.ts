// Workflows (#96, tela C14) e a aba Workflow do detalhe da sessão (#97, tela C7).
//
// | Rota                              | O quê                                                        |
// | --------------------------------- | ------------------------------------------------------------ |
// | `GET /api/workflows`              | KPIs, runs do Workflow tool e o grafo de orquestração         |
// | `GET /api/sessions/<id>/workflow` | O grafo dos agentes da sessão, o laço e a linha do tempo (404 sem a sessão) |
//
// `GET /api/workflows?filter=all|active|completed&node=<id do nó>`: o filtro vale para a tela inteira
// (`filtro=` and `no=` with the old values `todas|ativas|concluidas` and node ids, and
// `/api/sessoes/<id>/workflow`, are aliases: src/api/legacy-routes.ts).
// `active` são as sessões com status `active`; `completed`, as que terminaram (`completed`, `error`,
// `abandoned`). `node` é o clique num nó do grafo e é aplicado aqui, no núcleo: só ficam as sessões que
// passam por aquele nó (`main` passa por todas), e os KPIs, os runs e o próprio grafo saem delas.
// A resposta devolve o `node` aplicado, para a tela destacar. Lê as 500 sessões mais recentes no máximo;
// `truncated: true` diz que o teto cortou.
//
// O modelo não tem "run do Workflow tool" nem "rodada de review". A representação é derivada do que
// já existe, sem tabela nova:
//
// - Papel de um subagente: `Agent.metadata.workflow.role` ou `Agent.metadata.role`, quando há; senão,
//   pelo tipo: `subagentType` com "review"/"revis" (ex.: `code-reviewer`) é `review`, `general-purpose`
//   é `dev`, e os outros ficam com o próprio tipo (`Explore`, `Plan`, `test-runner`...).
// - Rodada: o n-ésimo review da sessão, na ordem em que começaram, é a rodada n; um dev é da rodada
//   seguinte à do último review que começou antes dele (dev r1, review r1, dev r2...).
// - Ajustes pedidos por um review: `metadata.workflow.adjustments` ou `metadata.adjustments` (número); senão, a
//   última mensagem do subagente (`AssistantMessage` com o `agentId` dele): o último número logo antes de
//   "ajustes"/"mudanças" (até duas palavras no meio: "3 pequenos ajustes" dá 3; "revisei 12 changes e
//   peço 2 ajustes" dá 2), ou de "changes"/"issues" sem eles; "sem ajustes"/"nenhum ajuste" dá 0;
//   "aprovado"/"LGTM" dá 0, mas não negado ("não aprovado", "reprovado" ficam `null`). Sem nada, `null`.
// - O laço (grafo da sessão): cada subagente tem uma aresta de entrada. Plan concluído antes do dev r1
//   dá `plano → dev r1` (`delivered`, "plano"); o dev mais recente que terminou antes de um review dá
//   `dev → review` (`delivered`, "diff" na rodada 1, "v<n>" depois); um review seguido de um dev da
//   rodada seguinte dá `review → dev` (`changes-requested`) quando o review terminou antes de o dev começar e não
//   pediu 0 ajustes (um review ainda rodando não conta); o
//   test-runner que começa depois de um dev terminar sai desse dev (`delivered`). Os demais saem de quem
//   os disparou (`opened`): o subagente pai (`subagentesDe`, #146) ou o principal.
// - Run do Workflow tool: os subagentes agrupados pelo id da chamada da ferramenta `Workflow`. O id vem de
//   `Agent.metadata.workflow.run` (simulador) ou, nos dados reais, de `Agent.metadata.toolUseId` (o
//   importer grava o id da chamada que abriu o subagente) quando esse id é de um evento `ToolUse`/
//   `PreToolUse` com `toolName` `Workflow` da sessão. A chamada dá o início e, se o `tool_input` estiver
//   gravado, o nome (`name`/`workflow`), as fases (`phases`), a volta (`loop`) e o modelo
//   (`model`); o `PostToolUse` ou o `ToolResult` com o mesmo id dá o fim (`PostToolUseFailure` ou
//   `isError`: erro). Sem o `tool_input` (o importer hoje não guarda o da `Workflow`), o nome é
//   `metadata.workflow.name` ou "workflow", as fases são as distintas dos agentes (`metadata.workflow.phase`,
//   ou nenhuma) e o modelo é o da sessão. ATENÇÃO: o formato do Workflow tool no journal (nome da
//   ferramenta, campos da entrada, como o subagente aponta para a chamada) não foi conferido contra dados
//   reais; segue o que o importer grava para qualquer ferramenta.
//   Tokens de um agente: `Agent.metadata.tokens` (já deduplicado pelo importer), input + output + escrita
//   de cache; sem ele, das mensagens do agente, uma por `usage.messageId` (o streaming repete a mesma
//   mensagem; vale a de mais saída, como em ingest/history/usage.ts). A leitura de cache fica de fora,
//   para não contar o mesmo contexto várias vezes. Ferramentas: as chamadas dele (o maior entre hooks
//   `PreToolUse` e transcript `ToolUse`).
// - Compactação de uma sessão: algum medidor de contexto com compactação (automática ou manual), ou o
//   `metadata.context.overflows` do simulador.
// - Origem: `Session.source` `resume` é "Retomada"; o resto, "Prompt novo".
//
// Grafo de orquestração: o volume de origem, principal, compactação e resultado é em sessões; o de um
// tipo de subagente, em subagentes. Arestas: origem → principal (sessões), principal → tipo
// (subagentes), tipo → compactação (sessões que tiveram o tipo), principal → compactação (sessões sem
// subagente) e compactação → resultado (sessões). Nó com volume zero não aparece. Resultado: Concluída
// (`completed`), Com erro (`error`), Em andamento (`active`) e Abandonada (`abandoned`).
//
// As funções de montagem (`workflowDaSessao`, `montarWorkflows`) são puras; a rota só lê a porta.

import type { ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { dedupeByMessage, type UsageSample } from '../ingest/history/usage.ts';
import type { MessageUsage } from '../ingest/history/transcript.ts';
import { send } from '../ingest/hooks/receiver.ts';
import type { Agent, Session, SessionEvent, SessionStatus } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { subagentesDe } from './panel.ts';
import type { TrabalhoPorBranch } from './work.ts';

// ---------- Contrato ----------
//
// The JSON keys and fixed values are English (issue #173, phase 2b, layer 5): `GET /api/workflows` has no
// old alias, and the old `/api/sessoes/<id>/workflow` answers its old body through src/api/legacy-routes.ts.
// The labels shown on the screen (`label`, the edge labels `plano`/`diff`/`ajustes`, the node names) stay pt-BR.

export const FILTROS_DOS_WORKFLOWS = ['all', 'active', 'completed'] as const;
export type FiltroDosWorkflows = (typeof FILTROS_DOS_WORKFLOWS)[number];

export interface KpisDosWorkflows {
  /** Níveis de agente por sessão, em média: só o principal é 1; com subagente, 2; aninhado, 3... */
  averageDepth: number | null;
  subagentsPerSession: number | null;
  /** Concluídos sobre os que terminaram (concluídos e com erro), de 0 a 1. */
  subagentSuccess: number | null;
  /** O par de papéis seguidos mais comum (`dev → review`) e a fração das sessões que o têm. */
  commonFlow: { label: string; fraction: number } | null;
  /** Rodadas de review por sessão que teve review (a sessão faz as vezes do PR). */
  roundsPerPr: number | null;
  averageDurationMs: number | null;
}

export const RUN_STATES = ['active', 'completed', 'error'] as const;
export type EstadoDoRun = (typeof RUN_STATES)[number];
export const RUN_AGENT_STATES = ['completed', 'running', 'changes-requested', 'error'] as const;
export type EstadoDoAgenteDoRun = (typeof RUN_AGENT_STATES)[number];

export interface AgenteDoRun {
  id: string;
  /** `dev:r1`, `review:r2`, `test-runner`. */
  label: string;
  /** `subagentType` (`general-purpose`, `code-reviewer`...). */
  type: string | null;
  phase: string | null;
  state: EstadoDoAgenteDoRun;
  changesRequested: number | null;
  tokens: number;
  tools: number;
  durationMs: number;
}

export interface RunDoWorkflow {
  /** O `tool_use_id` da chamada do Workflow tool. */
  id: string;
  name: string;
  state: EstadoDoRun;
  /** Id do modelo (`claude-opus-5-5`); a tela escreve "Opus 5.5". */
  model: string | null;
  project: string | null;
  sessionId: string;
  /** Soma dos agentes do run. O número de agentes é `agents.length`. */
  tools: number;
  tokens: number;
  durationMs: number;
  start: string;
  end: string | null;
  phases: { name: string }[];
  /** "volta para Corrigir enquanto o review pedir ajustes"; `null` sem volta conhecida. */
  loop: string | null;
  agents: AgenteDoRun[];
}

export const GRAPH_COLUMNS = ['origin', 'main', 'subagent', 'compaction', 'outcome'] as const;
export type ColunaDoGrafo = (typeof GRAPH_COLUMNS)[number];

export interface GrafoDeOrquestracao {
  columns: { id: ColunaDoGrafo; label: string }[];
  /** Ids: `origin:prompt`, `origin:resume`, `main`, `subagent:<tipo>`, `compaction:none`, `compaction:compacted`, `outcome:completed|error|active|abandoned`. */
  nodes: { id: string; column: ColunaDoGrafo; label: string; volume: number }[];
  edges: { from: string; to: string; volume: number }[];
}

export interface RespostaDosWorkflows {
  filter: FiltroDosWorkflows;
  node: string | null;
  generatedAt: string;
  /** Quantas sessões entraram na conta (depois do filtro e do nó). */
  sessions: number;
  /** O teto de sessões lidas (`MAXIMO_DE_SESSOES`) cortou: a conta não cobre todas. */
  truncated: boolean;
  /** O teto de sessões lidas efetivamente usado; a tela o cita quando `truncated`. */
  max: number;
  kpis: KpisDosWorkflows;
  runs: RunDoWorkflow[];
  graph: GrafoDeOrquestracao;
}

export const NODE_STATES = ['active', 'completed', 'error'] as const;
export type EstadoDoNo = (typeof NODE_STATES)[number];

export interface NoDoWorkflow {
  /** O id do agente. */
  id: string;
  /** `Principal`, `dev`, `review`, `Explore`, `Plan`, `test-runner`... */
  name: string;
  /** `subagentType`; `null` no principal. */
  type: string | null;
  round: number | null;
  task: string | null;
  /** Só no principal: o modelo da sessão. */
  model: string | null;
  durationMs: number;
  state: EstadoDoNo;
  /** Só nos reviews: quantos ajustes pediu (`null`: não sabemos). */
  changesRequested: number | null;
  start: string;
  end: string | null;
}

export const EDGE_TYPES = ['opened', 'delivered', 'changes-requested'] as const;
export type TipoDaAresta = (typeof EDGE_TYPES)[number];

export interface ArestaDoWorkflow {
  from: string;
  to: string;
  type: TipoDaAresta;
  /** `plano`, `diff`, `v2`, `ajustes` (screen text); `null` sem rótulo. */
  label: string | null;
}

export interface TrechoDaFaixa {
  nodeId: string;
  start: string;
  end: string | null;
  state: EstadoDoNo;
}

export interface WorkflowDaSessao {
  sessionId: string;
  start: string;
  end: string | null;
  durationMs: number;
  /** "dev → review até aprovar · termina no PR #90"; `null` sem review. */
  summary: string | null;
  nodes: NoDoWorkflow[];
  edges: ArestaDoWorkflow[];
  reviewRounds: number;
  changesRequested: number;
  timeline: {
    start: string;
    /** O fim da sessão, ou agora enquanto ela roda. */
    end: string;
    /** Uma faixa por rótulo (`Agente principal`, `dev · r1`, `Explore`): o mesmo rótulo junta os trechos. */
    lanes: { nodeId: string; label: string; spans: TrechoDaFaixa[] }[];
  };
}

// ---------- Leitura dos dados ----------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const inteiro = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const ms = (iso: string) => Date.parse(iso);
const duracao = (inicio: string, fim: string | null, agora: number) => Math.max(0, (fim ? ms(fim) : agora) - ms(inicio));

const wf = (a: Agent): Json | null => obj(a.metadata?.workflow);
const REVIEW = /review|revis/i;

/** O papel do subagente no laço: `dev`, `review` ou o próprio tipo. */
export function papelDe(a: Agent): string {
  const m = str(wf(a)?.role) ?? str(a.metadata?.role);
  if (m) return m;
  const t = a.subagentType ?? '';
  if (REVIEW.test(t)) return 'review';
  if (t === 'general-purpose') return 'dev';
  return t || 'subagente';
}

const AJUSTES = /(\d+)(?:\s+[\p{L}-]+){0,2}\s+(ajustes?|mudan[cç]as?|changes?|issues?)(?![\p{L}])/giu;
const EM_PORTUGUES = /^(?:ajustes?|mudan[cç]as?)$/iu;

/** O número dos ajustes pedidos: o último antes de "ajustes"/"mudanças"; sem eles, o último antes de "changes"/"issues". */
function numeroDeAjustes(texto: string): number | null {
  const achados = [...texto.matchAll(AJUSTES)];
  const m = achados.filter((x) => EM_PORTUGUES.test(x[2])).at(-1) ?? achados.at(-1);
  return m ? Number(m[1]) : null;
}
const SEM_AJUSTES = /(?<![\p{L}])(?:sem\s+ajustes|nenhum\s+ajuste|no\s+changes)(?![\p{L}])/iu;
const NEGADO = /(?<![\p{L}])(?:n[aã]o\s+(?:foi\s+|est[aá]\s+)?aprovad[oa]|not\s+approved|reprovad[oa]|rejeitad[oa])(?![\p{L}])/iu;
const APROVADO = /(?<![\p{L}])(?:aprovad[oa]|approved|lgtm)(?![\p{L}])/iu;

/** Ajustes pedidos por um review: dos metadados, ou da última mensagem dele. `null` sem como saber. */
export function ajustesDe(a: Agent, eventos: readonly SessionEvent[] = []): number | null {
  const m = inteiro(wf(a)?.adjustments) ?? inteiro(a.metadata?.adjustments);
  if (m !== null) return m;
  let ultima: string | null = null;
  for (const e of eventos) if (e.agentId === a.id && e.type === 'AssistantMessage' && e.summary) ultima = e.summary;
  if (!ultima) return null;
  const n = numeroDeAjustes(ultima);
  if (n !== null) return n;
  if (NEGADO.test(ultima)) return null;
  if (SEM_AJUSTES.test(ultima)) return 0;
  return APROVADO.test(ultima) ? 0 : null;
}

const estadoDoAgente = (a: Agent): EstadoDoNo => (a.status === 'error' ? 'error' : a.status === 'completed' ? 'completed' : 'active');
const estadoDaSessao = (s: SessionStatus): EstadoDoNo => (s === 'error' ? 'error' : s === 'active' ? 'active' : 'completed');
const porInicio = (a: Agent, b: Agent) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);

interface Classificado {
  a: Agent;
  papel: string;
  rodada: number | null;
}

/** Os subagentes na ordem em que começaram, com papel e rodada. */
function classificar(agentes: readonly Agent[]): Classificado[] {
  let reviews = 0;
  return agentes
    .filter((a) => a.type === 'subagent')
    .sort(porInicio)
    .map((a) => {
      const papel = papelDe(a);
      if (papel === 'review') return { a, papel, rodada: ++reviews };
      if (papel === 'dev') return { a, papel, rodada: reviews + 1 };
      return { a, papel, rodada: null };
    });
}

// ---------- #97: o grafo de uma sessão ----------

const rotuloDoNo = (nome: string, rodada: number | null) => (rodada === null ? nome : `${nome} · r${rodada}`);

export interface OpcoesDoWorkflowDaSessao {
  agora: number;
  /** O PR do branch da sessão, quando o trabalho por branch sabe; vai no resumo. */
  pr?: number | null;
}

export function workflowDaSessao(session: Session, agentes: readonly Agent[], eventos: readonly SessionEvent[], { agora, pr = null }: OpcoesDoWorkflowDaSessao): WorkflowDaSessao {
  const main = agentes.find((a) => a.type === 'main') ?? null;
  const principalId = main?.id ?? `${session.id}:main`;
  const fimDaSessao = session.status === 'active' ? null : (session.endedAt ?? main?.endedAt ?? session.updatedAt);
  const principal: NoDoWorkflow = {
    id: principalId,
    name: 'Principal',
    type: null,
    round: null,
    task: null,
    model: session.model,
    durationMs: duracao(session.startedAt, fimDaSessao, agora),
    state: estadoDaSessao(session.status),
    changesRequested: null,
    start: session.startedAt,
    end: fimDaSessao,
  };

  const subs = classificar(agentes);
  const pais = new Map(subagentesDe([...agentes]).items.map((i) => [i.id, i.parent]));
  const nos: NoDoWorkflow[] = [principal];
  for (const { a, papel, rodada } of subs) {
    nos.push({
      id: a.id,
      name: papel,
      type: a.subagentType,
      round: rodada,
      task: a.name ?? a.task,
      model: null,
      durationMs: duracao(a.startedAt, a.endedAt, agora),
      state: estadoDoAgente(a),
      changesRequested: papel === 'review' ? ajustesDe(a, eventos) : null,
      start: a.startedAt,
      end: a.endedAt,
    });
  }
  const noDe = new Map(nos.map((n) => [n.id, n]));

  // O de antes no laço: o mais recente de um papel que terminou até `t` (e começou antes do alvo).
  const terminouAntes = (papel: string, alvo: Classificado) =>
    subs.filter((x) => x.papel === papel && x.a.endedAt !== null && x.a.endedAt <= alvo.a.startedAt && x.a !== alvo.a).at(-1) ?? null;

  const arestas: ArestaDoWorkflow[] = [];
  for (const c of subs) {
    let aresta: ArestaDoWorkflow | null = null;
    if (c.papel === 'dev' && c.rodada === 1) {
      const plano = subs.filter((x) => x.papel === 'Plan' && x.a.status === 'completed' && x.a.endedAt !== null && x.a.endedAt <= c.a.startedAt).at(-1);
      if (plano) aresta = { from: plano.a.id, to: c.a.id, type: 'delivered', label: 'plano' };
    } else if (c.papel === 'dev' && c.rodada !== null && c.rodada > 1) {
      const review = subs.find((x) => x.papel === 'review' && x.rodada === c.rodada! - 1);
      // Só a volta de um review que já terminou quando o dev começou, e que não aprovou (0 ajustes).
      const terminou = !!review && review.a.endedAt !== null && review.a.endedAt <= c.a.startedAt;
      if (review && terminou && noDe.get(review.a.id)!.changesRequested !== 0) aresta = { from: review.a.id, to: c.a.id, type: 'changes-requested', label: 'ajustes' };
    } else if (c.papel === 'review') {
      const dev = terminouAntes('dev', c);
      if (dev) aresta = { from: dev.a.id, to: c.a.id, type: 'delivered', label: dev.rodada === 1 ? 'diff' : `v${dev.rodada}` };
    } else if (c.papel === 'test-runner') {
      const dev = terminouAntes('dev', c);
      if (dev) aresta = { from: dev.a.id, to: c.a.id, type: 'delivered', label: null };
    }
    aresta ??= { from: pais.get(c.a.id) ?? principalId, to: c.a.id, type: 'opened', label: null };
    arestas.push(aresta);
  }

  const reviews = nos.filter((n) => n.name === 'review');
  const ajustes = reviews.reduce((t, n) => t + (n.changesRequested ?? 0), 0);
  const laco = reviews.length > 1 || arestas.some((e) => e.type === 'changes-requested');
  const resumo = reviews.length === 0 ? null : `dev → review${laco ? ' até aprovar' : ''}${pr !== null ? ` · termina no PR #${pr}` : ''}`;

  const faixas: WorkflowDaSessao['timeline']['lanes'] = [];
  const porRotulo = new Map<string, (typeof faixas)[number]>();
  for (const n of nos) {
    const rotulo = n === principal ? 'Agente principal' : rotuloDoNo(n.name, n.round);
    let f = porRotulo.get(rotulo);
    if (!f) {
      f = { nodeId: n.id, label: rotulo, spans: [] };
      porRotulo.set(rotulo, f);
      faixas.push(f);
    }
    f.spans.push({ nodeId: n.id, start: n.start, end: n.end, state: n.state });
  }

  return {
    sessionId: session.id,
    start: session.startedAt,
    end: fimDaSessao,
    durationMs: principal.durationMs,
    summary: resumo,
    nodes: nos,
    edges: arestas,
    reviewRounds: reviews.length,
    changesRequested: ajustes,
    timeline: { start: session.startedAt, end: fimDaSessao ?? new Date(agora).toISOString(), lanes: faixas },
  };
}

// ---------- #96: várias sessões ----------

export interface SessaoDosWorkflows {
  session: Session;
  agentes: Agent[];
  compactou: boolean;
  /** Os eventos da sessão; só fazem falta nas que têm run do Workflow tool. */
  eventos?: readonly SessionEvent[] | null;
}

export interface OpcoesDosWorkflows {
  filtro?: FiltroDosWorkflows;
  no?: string | null;
  agora: number;
  /** A leitura parou no teto de sessões. */
  truncado?: boolean;
  /** O teto de sessões usado na leitura; padrão `MAXIMO_DE_SESSOES`. */
  maximo?: number;
}

export const NO_DO_GRAFO = /^(?:main|origin:(?:prompt|resume)|compaction:(?:none|compacted)|outcome:(?:completed|error|active|abandoned)|subagent:[A-Za-z0-9_.:-]{1,64})$/;

const COLUNAS: GrafoDeOrquestracao['columns'] = [
  { id: 'origin', label: 'Origem' },
  { id: 'main', label: 'Agente principal' },
  { id: 'subagent', label: 'Tipos de subagente' },
  { id: 'compaction', label: 'Compactação' },
  { id: 'outcome', label: 'Resultado' },
];
/** The fixed node ids of the graph (a subagent type's node, `subagent:<type>`, is the only other). */
export const GRAPH_NODE_LABELS: Readonly<Record<string, string>> = {
  'origin:prompt': 'Prompt novo',
  'origin:resume': 'Retomada',
  main: 'Agente principal',
  'compaction:none': 'Sem compactação',
  'compaction:compacted': 'Compactou',
  'outcome:completed': 'Concluída',
  'outcome:error': 'Com erro',
  'outcome:active': 'Em andamento',
  'outcome:abandoned': 'Abandonada',
};
const RESULTADO: Record<SessionStatus, string> = { completed: 'outcome:completed', error: 'outcome:error', active: 'outcome:active', abandoned: 'outcome:abandoned' };
/** The node of a subagent with no type: its label stays the screen's "subagente". */
// A subagent with no type and one whose type is literally `subagent` share the node `subagent:subagent` (accepted edge; before it was `subagente`).
const UNTYPED_SUBAGENT = 'subagent';

const origemDe = (s: Session) => (s.source === 'resume' ? 'origin:resume' : 'origin:prompt');
const compactacaoDe = (x: SessaoDosWorkflows) => (x.compactou ? 'compaction:compacted' : 'compaction:none');
const tipoDe = (a: Agent) => `subagent:${a.subagentType ?? UNTYPED_SUBAGENT}`;

/** Os nós do grafo por onde a sessão passa. */
export function nosDaSessao(x: SessaoDosWorkflows): Set<string> {
  const nos = new Set([origemDe(x.session), 'main', compactacaoDe(x), RESULTADO[x.session.status]]);
  for (const a of x.agentes) if (a.type === 'subagent') nos.add(tipoDe(a));
  return nos;
}

export function passaNoFiltro(s: Session, filtro: FiltroDosWorkflows): boolean {
  if (filtro === 'active') return s.status === 'active';
  if (filtro === 'completed') return s.status !== 'active';
  return true;
}

const media = (xs: number[]) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);

/** Níveis de agente da sessão: o principal é 1, cada subagente pendurado soma um. */
function profundidade(agentes: Agent[]): number {
  const itens = subagentesDe(agentes).items;
  const pai = new Map(itens.map((i) => [i.id, i.parent]));
  let max = 1;
  for (const i of itens) {
    let n = 2;
    for (let p = i.parent; p && n < 34; p = pai.get(p) ?? null) n++;
    max = Math.max(max, n);
  }
  return max;
}

export function kpisDe(sessoes: readonly SessaoDosWorkflows[], agora: number): KpisDosWorkflows {
  const subs = sessoes.flatMap((x) => x.agentes.filter((a) => a.type === 'subagent'));
  const ok = subs.filter((a) => a.status === 'completed').length;
  const erro = subs.filter((a) => a.status === 'error').length;

  const pares = new Map<string, number>();
  const rodadas: number[] = [];
  for (const x of sessoes) {
    const c = classificar(x.agentes);
    const daSessao = new Set<string>();
    for (let i = 1; i < c.length; i++) if (c[i - 1].papel !== c[i].papel) daSessao.add(`${c[i - 1].papel} → ${c[i].papel}`);
    for (const p of daSessao) pares.set(p, (pares.get(p) ?? 0) + 1);
    const reviews = c.filter((k) => k.papel === 'review').length;
    if (reviews > 0) rodadas.push(reviews);
  }
  const [rotulo, n] = [...pares].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null, 0];

  return {
    averageDepth: media(sessoes.map((x) => profundidade(x.agentes))),
    subagentsPerSession: sessoes.length ? subs.length / sessoes.length : null,
    subagentSuccess: ok + erro ? ok / (ok + erro) : null,
    commonFlow: rotulo ? { label: rotulo, fraction: n / sessoes.length } : null,
    roundsPerPr: media(rodadas),
    averageDurationMs: media(sessoes.map((x) => duracao(x.session.startedAt, x.session.status === 'active' ? null : (x.session.endedAt ?? x.session.updatedAt), agora))),
  };
}

const CHAMADA = new Set(['PreToolUse', 'ToolUse']);
const FIM = new Set(['PostToolUse', 'PostToolUseFailure', 'ToolResult']);
const idDaChamada = (e: SessionEvent) => {
  const d = obj(e.data);
  return str(d?.tool_use_id) ?? str(d?.toolUseId);
};

const semLeitura = (k: Json) => num(k.input) + num(k.output) + num(k.cacheWrite5m) + num(k.cacheWrite1h);

/** Tokens do agente: os do importer (`metadata.tokens`); sem eles, das mensagens, uma por `messageId`. */
export function tokensDe(a: Agent, eventos: readonly SessionEvent[]): number {
  const gravados = obj(a.metadata?.tokens);
  if (gravados) return semLeitura(gravados);
  const amostras: UsageSample[] = [];
  for (const e of eventos) {
    if (e.agentId !== a.id) continue;
    const u = obj(obj(e.data)?.usage);
    const k = obj(u?.tokens);
    if (!u || !k) continue;
    const tokens = { input: num(k.input), output: num(k.output), cacheRead: num(k.cacheRead), cacheWrite5m: num(k.cacheWrite5m), cacheWrite1h: num(k.cacheWrite1h) };
    amostras.push({ eventId: e.id, agentId: a.id, usage: { ...(u as unknown as MessageUsage), messageId: str(u.messageId), requestId: str(u.requestId), tokens } });
  }
  return dedupeByMessage(amostras).reduce((t, s) => t + semLeitura(s.usage.tokens as unknown as Json), 0);
}

function ferramentasDe(agentId: string, eventos: readonly SessionEvent[]): number {
  let hook = 0;
  let transcript = 0;
  for (const e of eventos) {
    if (e.agentId !== agentId) continue;
    if (e.type === 'PreToolUse') hook++;
    else if (e.type === 'ToolUse') transcript++;
  }
  return Math.max(hook, transcript);
}

const fasesDa = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const fases = v.map((f) => str(f) ?? str(obj(f)?.name)).filter((f): f is string => f !== null);
  return fases.length ? fases : null;
};

/** Os ids das chamadas da ferramenta `Workflow` na sessão. */
export function idsDasChamadasDeWorkflow(eventos: readonly SessionEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of eventos) {
    const id = e.toolName === 'Workflow' && CHAMADA.has(e.type) ? idDaChamada(e) : null;
    if (id) ids.add(id);
  }
  return ids;
}

/** O run do subagente: `metadata.workflow.run`, ou o `metadata.toolUseId` quando é de uma chamada `Workflow`. */
function runDe(a: Agent, chamadas: ReadonlySet<string>): string | null {
  const marcado = str(wf(a)?.run);
  if (marcado) return marcado;
  const id = str(a.metadata?.toolUseId);
  return id && chamadas.has(id) ? id : null;
}

/** Os runs do Workflow tool de uma sessão (ver o topo do arquivo). */
export function runsDaSessao(x: SessaoDosWorkflows, agora: number): RunDoWorkflow[] {
  const eventos = x.eventos ?? [];
  const classificados = classificar(x.agentes);
  const chamadas = idsDasChamadasDeWorkflow(eventos);
  const porRun = new Map<string, Classificado[]>();
  for (const c of classificados) {
    const run = runDe(c.a, chamadas);
    if (!run) continue;
    porRun.set(run, [...(porRun.get(run) ?? []), c]);
  }
  const runs: RunDoWorkflow[] = [];
  for (const [id, membros] of porRun) {
    const chamada = eventos.find((e) => CHAMADA.has(e.type) && e.toolName === 'Workflow' && idDaChamada(e) === id) ?? null;
    const fim = eventos.find((e) => FIM.has(e.type) && idDaChamada(e) === id) ?? null;
    const entrada = obj(obj(chamada?.data)?.tool_input);
    const agentes: AgenteDoRun[] = membros.map(({ a, papel, rodada }) => {
      const ajustes = papel === 'review' ? ajustesDe(a, eventos) : null;
      const estado: EstadoDoAgenteDoRun = a.status === 'error' ? 'error' : a.status !== 'completed' ? 'running' : ajustes ? 'changes-requested' : 'completed';
      return {
        id: a.id,
        label: str(wf(a)?.label) ?? (rodada === null ? papel : `${papel}:r${rodada}`),
        type: a.subagentType,
        phase: str(wf(a)?.phase),
        state: estado,
        changesRequested: ajustes,
        tokens: tokensDe(a, eventos),
        tools: ferramentasDe(a.id, eventos),
        durationMs: duracao(a.startedAt, a.endedAt, agora),
      };
    });
    const vistas = [...new Set(agentes.map((a) => a.phase).filter((f): f is string => f !== null))];
    const fases = fasesDa(entrada?.phases) ?? vistas;
    const inicio = chamada?.createdAt ?? membros[0].a.startedAt;
    const algumErro = membros.some((m) => m.a.status === 'error');
    const rodando = membros.some((m) => m.a.status === 'working' || m.a.status === 'waiting');
    let estado: EstadoDoRun;
    let termino: string | null;
    if (fim) {
      estado = fim.type === 'PostToolUseFailure' || obj(fim.data)?.isError === true || algumErro ? 'error' : 'completed';
      termino = fim.createdAt;
    } else if (x.session.status === 'active') {
      // Sem o fim da chamada, a sessão viva ainda pode abrir a próxima fase.
      estado = !rodando && algumErro ? 'error' : 'active';
      termino = null;
    } else {
      estado = algumErro ? 'error' : 'completed';
      termino = membros.map((m) => m.a.endedAt).filter((t): t is string => t !== null).sort().at(-1) ?? x.session.endedAt;
    }
    runs.push({
      id,
      name: str(entrada?.name) ?? str(entrada?.workflow) ?? str(wf(membros[0].a)?.name) ?? 'workflow',
      state: estado,
      model: str(entrada?.model) ?? x.session.model,
      project: x.session.cwd ? basename(x.session.cwd) : null,
      sessionId: x.session.id,
      tools: agentes.reduce((t, a) => t + a.tools, 0),
      tokens: agentes.reduce((t, a) => t + a.tokens, 0),
      durationMs: duracao(inicio, termino, agora),
      start: inicio,
      end: termino,
      phases: fases.map((name) => ({ name })),
      loop: str(entrada?.loop) ?? voltaDe(agentes),
      agents: agentes,
    });
  }
  return runs;
}

/** A volta vista nos dados: um review que pediu ajustes seguido de um agente de outra fase. */
function voltaDe(agentes: AgenteDoRun[]): string | null {
  const i = agentes.findIndex((a) => a.state === 'changes-requested' || (a.changesRequested ?? 0) > 0);
  const depois = i >= 0 ? agentes.slice(i + 1).find((a) => a.phase !== null && a.phase !== agentes[i].phase) : undefined;
  return depois?.phase ? `volta para ${depois.phase} enquanto o review pedir ajustes` : null;
}

export function grafoDe(sessoes: readonly SessaoDosWorkflows[]): GrafoDeOrquestracao {
  const volume = new Map<string, number>();
  const arestas = new Map<string, number>();
  const somar = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  const ligar = (de: string, para: string, n = 1) => somar(arestas, `${de}\u0000${para}`, n);
  for (const x of sessoes) {
    const origem = origemDe(x.session);
    const compactacao = compactacaoDe(x);
    const resultado = RESULTADO[x.session.status];
    for (const k of [origem, 'main', compactacao, resultado]) somar(volume, k);
    ligar(origem, 'main');
    const tipos = new Map<string, number>();
    for (const a of x.agentes) if (a.type === 'subagent') somar(tipos, tipoDe(a));
    for (const [t, n] of tipos) {
      somar(volume, t, n);
      ligar('main', t, n);
      ligar(t, compactacao);
    }
    if (tipos.size === 0) ligar('main', compactacao);
    ligar(compactacao, resultado);
  }
  const ordem = Object.keys(GRAPH_NODE_LABELS);
  const coluna = (id: string): ColunaDoGrafo => (id === 'main' ? 'main' : (id.split(':')[0] as ColunaDoGrafo));
  const pos = (id: string) => COLUNAS.findIndex((c) => c.id === coluna(id));
  const typeLabel = (id: string) => (id === `subagent:${UNTYPED_SUBAGENT}` ? 'subagente' : id.slice('subagent:'.length));
  const nos = [...volume]
    .map(([id, v]) => ({ id, column: coluna(id), label: GRAPH_NODE_LABELS[id] ?? typeLabel(id), volume: v }))
    .sort((a, b) => pos(a.id) - pos(b.id) || (a.column === 'subagent' ? b.volume - a.volume || a.label.localeCompare(b.label) : ordem.indexOf(a.id) - ordem.indexOf(b.id)));
  return {
    columns: COLUNAS.map((c) => ({ ...c })),
    nodes: nos,
    edges: [...arestas].map(([k, v]) => {
      const [from, to] = k.split('\u0000');
      return { from, to, volume: v };
    }),
  };
}

const PESO_DO_RUN: Record<EstadoDoRun, number> = { active: 0, error: 1, completed: 2 };

export function montarWorkflows(todas: readonly SessaoDosWorkflows[], { filtro = 'all', no = null, agora, truncado = false, maximo = MAXIMO_DE_SESSOES }: OpcoesDosWorkflows): RespostaDosWorkflows {
  let sessoes = todas.filter((x) => passaNoFiltro(x.session, filtro));
  if (no) sessoes = sessoes.filter((x) => nosDaSessao(x).has(no));
  const runs = sessoes.flatMap((x) => runsDaSessao(x, agora)).sort((a, b) => PESO_DO_RUN[a.state] - PESO_DO_RUN[b.state] || b.start.localeCompare(a.start));
  return { filter: filtro, node: no, generatedAt: new Date(agora).toISOString(), sessions: sessoes.length, truncated: truncado, max: maximo, kpis: kpisDe(sessoes, agora), runs, graph: grafoDe(sessoes) };
}

// ---------- Rotas ----------

/** O que a rota lê: a porta, o trabalho por branch (o PR do resumo) e o relógio. O `MontadorDoPainel` serve. */
export interface FontesDosWorkflows {
  storage: StoragePort;
  trabalho?: TrabalhoPorBranch | null;
  agora?: () => number;
  /** O teto de sessões lidas; padrão `MAXIMO_DE_SESSOES` (testes usam menos). */
  maximoDeSessoes?: number;
}

export const ROTA_DOS_WORKFLOWS = '/api/workflows';
const DA_SESSAO = /^\/api\/sessions\/([^/]+)\/workflow$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MAXIMO_DE_SESSOES = 500;

async function todosOsEventos(storage: StoragePort, sessionId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await storage.listEvents(sessionId, { limit: 500, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function compactou(storage: StoragePort, s: Session): Promise<boolean> {
  const sim = obj(s.metadata?.context);
  if ((inteiro(sim?.overflows) ?? 0) > 0) return true;
  const medidores = await storage.listContextMeters(s.id);
  return medidores.some((m) => m.compactions > 0 || m.manualCompactions > 0);
}

export interface LeituraDosWorkflows {
  sessoes: SessaoDosWorkflows[];
  /** Havia mais sessões que o teto. */
  truncado: boolean;
}

/**
 * Os eventos das sessões com subagentes que podem ser de um run, guardados pelo `updatedAt`: a sessão
 * que não mudou não é relida. Só ficam os eventos das que têm run; das outras, `null`.
 */
const EVENTOS_DOS_RUNS = new Map<string, { updatedAt: string; eventos: SessionEvent[] | null }>();
const MAXIMO_NO_CACHE = 1_000;

async function eventosDosRuns(storage: StoragePort, session: Session, agentes: Agent[]): Promise<SessionEvent[] | null> {
  const marcado = agentes.some((a) => str(wf(a)?.run));
  const candidato = marcado || agentes.some((a) => a.type === 'subagent' && str(a.metadata?.toolUseId));
  if (!candidato) return null;
  const guardado = EVENTOS_DOS_RUNS.get(session.id);
  if (guardado && guardado.updatedAt === session.updatedAt) return guardado.eventos;
  const todos = await todosOsEventos(storage, session.id);
  const chamadas = idsDasChamadasDeWorkflow(todos);
  const temRun = marcado || agentes.some((a) => runDe(a, chamadas) !== null);
  const eventos = temRun ? todos : null;
  EVENTOS_DOS_RUNS.delete(session.id);
  EVENTOS_DOS_RUNS.set(session.id, { updatedAt: session.updatedAt, eventos });
  if (EVENTOS_DOS_RUNS.size > MAXIMO_NO_CACHE) EVENTOS_DOS_RUNS.delete(EVENTOS_DOS_RUNS.keys().next().value!);
  return eventos;
}

/** As sessões do filtro, com o que a montagem pede; os eventos só das que têm run do Workflow tool. */
export async function lerSessoesDosWorkflows(storage: StoragePort, filtro: FiltroDosWorkflows, maximo = MAXIMO_DE_SESSOES): Promise<LeituraDosWorkflows> {
  const status: SessionStatus[] | undefined = filtro === 'active' ? ['active'] : filtro === 'completed' ? ['completed', 'error', 'abandoned'] : undefined;
  const sessoes: Session[] = [];
  let cursor: string | null = null;
  do {
    const page = await storage.listSessions({ ...(status ? { status } : {}), limit: 200, cursor });
    sessoes.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && sessoes.length < maximo);
  const truncado = sessoes.length > maximo || (sessoes.length === maximo && cursor !== null);
  const out: SessaoDosWorkflows[] = [];
  for (const session of sessoes.slice(0, maximo)) {
    const agentes = await storage.listAgents(session.id);
    out.push({ session, agentes, compactou: await compactou(storage, session), eventos: await eventosDosRuns(storage, session, agentes) });
  }
  return { sessoes: out, truncado };
}

/**
 * Responde as duas rotas, quando o pedido é de uma delas (`GET`); devolve `false` para o resto, e o
 * servidor segue. `/api/sessions/<id>/workflow` não colide com `/api/sessions/<id>` nem com
 * `/api/sessions/<id>/(agents|conversation|events)`.
 */
export async function responderWorkflows(res: ServerResponse, url: URL, fontes: FontesDosWorkflows): Promise<boolean> {
  const agora = (fontes.agora ?? Date.now)();
  if (url.pathname === ROTA_DOS_WORKFLOWS) {
    const filtro = url.searchParams.get('filter') ?? 'all';
    if (!FILTROS_DOS_WORKFLOWS.includes(filtro as FiltroDosWorkflows)) {
      send(res, 400, { error: 'filter: all, active ou completed' });
      return true;
    }
    const no = url.searchParams.get('node');
    if (no !== null && !NO_DO_GRAFO.test(no)) {
      send(res, 400, { error: 'node: um id de nó do grafo (ex.: subagent:Explore)' });
      return true;
    }
    const maximo = fontes.maximoDeSessoes ?? MAXIMO_DE_SESSOES;
    const { sessoes, truncado } = await lerSessoesDosWorkflows(fontes.storage, filtro as FiltroDosWorkflows, maximo);
    send(res, 200, montarWorkflows(sessoes, { filtro: filtro as FiltroDosWorkflows, no, agora, truncado, maximo }));
    return true;
  }
  const m = DA_SESSAO.exec(url.pathname);
  if (!m) return false;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    id = '';
  }
  if (!ID.test(id)) {
    send(res, 400, { error: 'id de sessão inválido' });
    return true;
  }
  const session = await fontes.storage.getSession(id);
  if (!session) {
    send(res, 404, { error: 'sessão não encontrada' });
    return true;
  }
  const [agentes, eventos] = await Promise.all([fontes.storage.listAgents(id), todosOsEventos(fontes.storage, id)]);
  const branch = typeof session.metadata?.branch === 'string' ? session.metadata.branch : null;
  const pr = fontes.trabalho?.ler(session.cwd, branch)?.pr?.number ?? null;
  send(res, 200, workflowDaSessao(session, agentes, eventos, { agora, pr }));
  return true;
}
