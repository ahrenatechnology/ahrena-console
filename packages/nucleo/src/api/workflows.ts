// Workflows (#96, tela C14) e a aba Workflow do detalhe da sessão (#97, tela C7).
//
// | Rota                              | O quê                                                        |
// | --------------------------------- | ------------------------------------------------------------ |
// | `GET /api/workflows`              | KPIs, runs do Workflow tool e o grafo de orquestração         |
// | `GET /api/sessions/<id>/workflow` | O grafo dos agentes da sessão, o laço e a linha do tempo (404 sem a sessão) |
//
// `GET /api/workflows?filter=todas|ativas|concluidas&node=<id do nó>`: o filtro vale para a tela inteira
// (`filtro=` and `no=`, and `/api/sessoes/<id>/workflow`, are aliases: src/api/legacy-routes.ts).
// `ativas` são as sessões com status `active`; `concluidas`, as que terminaram (`completed`, `error`,
// `abandoned`). `no` é o clique num nó do grafo e é aplicado aqui, no núcleo: só ficam as sessões que
// passam por aquele nó (`principal` passa por todas), e os KPIs, os runs e o próprio grafo saem delas.
// A resposta devolve o `no` aplicado, para a tela destacar. Lê as 500 sessões mais recentes no máximo;
// `truncado: true` diz que o teto cortou.
//
// O modelo não tem "run do Workflow tool" nem "rodada de review". A representação é derivada do que
// já existe, sem tabela nova:
//
// - Papel de um subagente: `Agent.metadata.workflow.papel` ou `Agent.metadata.papel`, quando há; senão,
//   pelo tipo: `subagentType` com "review"/"revis" (ex.: `code-reviewer`) é `review`, `general-purpose`
//   é `dev`, e os outros ficam com o próprio tipo (`Explore`, `Plan`, `test-runner`...).
// - Rodada: o n-ésimo review da sessão, na ordem em que começaram, é a rodada n; um dev é da rodada
//   seguinte à do último review que começou antes dele (dev r1, review r1, dev r2...).
// - Ajustes pedidos por um review: `metadata.workflow.ajustes` ou `metadata.ajustes` (número); senão, a
//   última mensagem do subagente (`AssistantMessage` com o `agentId` dele): o último número logo antes de
//   "ajustes"/"mudanças" (até duas palavras no meio: "3 pequenos ajustes" dá 3; "revisei 12 changes e
//   peço 2 ajustes" dá 2), ou de "changes"/"issues" sem eles; "sem ajustes"/"nenhum ajuste" dá 0;
//   "aprovado"/"LGTM" dá 0, mas não negado ("não aprovado", "reprovado" ficam `null`). Sem nada, `null`.
// - O laço (grafo da sessão): cada subagente tem uma aresta de entrada. Plan concluído antes do dev r1
//   dá `plano → dev r1` (`entregou`, "plano"); o dev mais recente que terminou antes de um review dá
//   `dev → review` (`entregou`, "diff" na rodada 1, "v<n>" depois); um review seguido de um dev da
//   rodada seguinte dá `review → dev` (`ajustes`) quando o review terminou antes de o dev começar e não
//   pediu 0 ajustes (um review ainda rodando não conta); o
//   test-runner que começa depois de um dev terminar sai desse dev (`entregou`). Os demais saem de quem
//   os disparou (`abriu`): o subagente pai (`subagentesDe`, #146) ou o principal.
// - Run do Workflow tool: os subagentes agrupados pelo id da chamada da ferramenta `Workflow`. O id vem de
//   `Agent.metadata.workflow.run` (simulador) ou, nos dados reais, de `Agent.metadata.toolUseId` (o
//   importer grava o id da chamada que abriu o subagente) quando esse id é de um evento `ToolUse`/
//   `PreToolUse` com `toolName` `Workflow` da sessão. A chamada dá o início e, se o `tool_input` estiver
//   gravado, o nome (`name`/`workflow`), as fases (`fases`/`phases`), a volta (`volta`) e o modelo
//   (`model`); o `PostToolUse` ou o `ToolResult` com o mesmo id dá o fim (`PostToolUseFailure` ou
//   `isError`: erro). Sem o `tool_input` (o importer hoje não guarda o da `Workflow`), o nome é
//   `metadata.workflow.nome` ou "workflow", as fases são as distintas dos agentes (`metadata.workflow.fase`,
//   ou nenhuma) e o modelo é o da sessão. ATENÇÃO: o formato do Workflow tool no journal (nome da
//   ferramenta, campos da entrada, como o subagente aponta para a chamada) não foi conferido contra dados
//   reais; segue o que o importer grava para qualquer ferramenta.
//   Tokens de um agente: `Agent.metadata.tokens` (já deduplicado pelo importer), input + output + escrita
//   de cache; sem ele, das mensagens do agente, uma por `usage.messageId` (o streaming repete a mesma
//   mensagem; vale a de mais saída, como em ingest/historico/usage.ts). A leitura de cache fica de fora,
//   para não contar o mesmo contexto várias vezes. Ferramentas: as chamadas dele (o maior entre hooks
//   `PreToolUse` e transcript `ToolUse`).
// - Compactação de uma sessão: algum medidor de contexto com compactação (automática ou manual), ou o
//   `metadata.contexto.estouros` do simulador.
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
import { dedupeByMessage, type UsageSample } from '../ingest/historico/usage.ts';
import type { MessageUsage } from '../ingest/historico/transcript.ts';
import { send } from '../ingest/hooks/receiver.ts';
import type { Agent, Session, SessionEvent, SessionStatus } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { subagentesDe } from './painel.ts';
import type { TrabalhoPorBranch } from './trabalho.ts';

// ---------- Contrato ----------

export const FILTROS_DOS_WORKFLOWS = ['todas', 'ativas', 'concluidas'] as const;
export type FiltroDosWorkflows = (typeof FILTROS_DOS_WORKFLOWS)[number];

export interface KpisDosWorkflows {
  /** Níveis de agente por sessão, em média: só o principal é 1; com subagente, 2; aninhado, 3... */
  profundidadeMedia: number | null;
  subagentesPorSessao: number | null;
  /** Concluídos sobre os que terminaram (concluídos e com erro), de 0 a 1. */
  sucessoSubagentes: number | null;
  /** O par de papéis seguidos mais comum (`dev → review`) e a fração das sessões que o têm. */
  fluxoComum: { rotulo: string; fracao: number } | null;
  /** Rodadas de review por sessão que teve review (a sessão faz as vezes do PR). */
  rodadasPorPr: number | null;
  duracaoMediaMs: number | null;
}

export type EstadoDoRun = 'ativa' | 'concluida' | 'erro';
export type EstadoDoAgenteDoRun = 'concluido' | 'rodando' | 'ajustes' | 'erro';

export interface AgenteDoRun {
  id: string;
  /** `dev:r1`, `review:r2`, `test-runner`. */
  rotulo: string;
  /** `subagentType` (`general-purpose`, `code-reviewer`...). */
  tipo: string | null;
  fase: string | null;
  estado: EstadoDoAgenteDoRun;
  ajustes: number | null;
  tokens: number;
  ferramentas: number;
  duracaoMs: number;
}

export interface RunDoWorkflow {
  /** O `tool_use_id` da chamada do Workflow tool. */
  id: string;
  nome: string;
  estado: EstadoDoRun;
  /** Id do modelo (`claude-opus-5-5`); a tela escreve "Opus 5.5". */
  modelo: string | null;
  projeto: string | null;
  sessaoId: string;
  /** Soma dos agentes do run. O número de agentes é `agentes.length`. */
  ferramentas: number;
  tokens: number;
  duracaoMs: number;
  inicio: string;
  fim: string | null;
  fases: { nome: string }[];
  /** "volta para Corrigir enquanto o review pedir ajustes"; `null` sem volta conhecida. */
  volta: string | null;
  agentes: AgenteDoRun[];
}

export type ColunaDoGrafo = 'origem' | 'principal' | 'subagente' | 'compactacao' | 'resultado';

export interface GrafoDeOrquestracao {
  colunas: { id: ColunaDoGrafo; rotulo: string }[];
  /** Ids: `origem:prompt`, `origem:retomada`, `principal`, `subagente:<tipo>`, `compactacao:sem`, `compactacao:compactou`, `resultado:concluida|erro|andamento|abandonada`. */
  nos: { id: string; coluna: ColunaDoGrafo; rotulo: string; volume: number }[];
  arestas: { de: string; para: string; volume: number }[];
}

export interface RespostaDosWorkflows {
  filtro: FiltroDosWorkflows;
  no: string | null;
  geradoEm: string;
  /** Quantas sessões entraram na conta (depois do filtro e do nó). */
  sessoes: number;
  /** O teto de sessões lidas (`MAXIMO_DE_SESSOES`) cortou: a conta não cobre todas. */
  truncado: boolean;
  /** O teto de sessões lidas efetivamente usado; a tela o cita quando `truncado`. */
  maximo: number;
  kpis: KpisDosWorkflows;
  runs: RunDoWorkflow[];
  grafo: GrafoDeOrquestracao;
}

export type EstadoDoNo = 'ativo' | 'concluido' | 'erro';

export interface NoDoWorkflow {
  /** O id do agente. */
  id: string;
  /** `Principal`, `dev`, `review`, `Explore`, `Plan`, `test-runner`... */
  nome: string;
  /** `subagentType`; `null` no principal. */
  tipo: string | null;
  rodada: number | null;
  tarefa: string | null;
  /** Só no principal: o modelo da sessão. */
  modelo: string | null;
  duracaoMs: number;
  estado: EstadoDoNo;
  /** Só nos reviews: quantos ajustes pediu (`null`: não sabemos). */
  ajustes: number | null;
  inicio: string;
  fim: string | null;
}

export type TipoDaAresta = 'abriu' | 'entregou' | 'ajustes';

export interface ArestaDoWorkflow {
  de: string;
  para: string;
  tipo: TipoDaAresta;
  /** `plano`, `diff`, `v2`, `ajustes`; `null` sem rótulo. */
  rotulo: string | null;
}

export interface TrechoDaFaixa {
  noId: string;
  inicio: string;
  fim: string | null;
  estado: EstadoDoNo;
}

export interface WorkflowDaSessao {
  sessaoId: string;
  inicio: string;
  fim: string | null;
  duracaoMs: number;
  /** "dev → review até aprovar · termina no PR #90"; `null` sem review. */
  resumo: string | null;
  nos: NoDoWorkflow[];
  arestas: ArestaDoWorkflow[];
  rodadasDeReview: number;
  ajustes: number;
  linhaDoTempo: {
    inicio: string;
    /** O fim da sessão, ou agora enquanto ela roda. */
    fim: string;
    /** Uma faixa por rótulo (`Agente principal`, `dev · r1`, `Explore`): o mesmo rótulo junta os trechos. */
    faixas: { noId: string; rotulo: string; trechos: TrechoDaFaixa[] }[];
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
  const m = str(wf(a)?.papel) ?? str(a.metadata?.papel);
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
  const m = inteiro(wf(a)?.ajustes) ?? inteiro(a.metadata?.ajustes);
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

const estadoDoAgente = (a: Agent): EstadoDoNo => (a.status === 'error' ? 'erro' : a.status === 'completed' ? 'concluido' : 'ativo');
const estadoDaSessao = (s: SessionStatus): EstadoDoNo => (s === 'error' ? 'erro' : s === 'active' ? 'ativo' : 'concluido');
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
    nome: 'Principal',
    tipo: null,
    rodada: null,
    tarefa: null,
    modelo: session.model,
    duracaoMs: duracao(session.startedAt, fimDaSessao, agora),
    estado: estadoDaSessao(session.status),
    ajustes: null,
    inicio: session.startedAt,
    fim: fimDaSessao,
  };

  const subs = classificar(agentes);
  const pais = new Map(subagentesDe([...agentes]).items.map((i) => [i.id, i.parent]));
  const nos: NoDoWorkflow[] = [principal];
  for (const { a, papel, rodada } of subs) {
    nos.push({
      id: a.id,
      nome: papel,
      tipo: a.subagentType,
      rodada,
      tarefa: a.name ?? a.task,
      modelo: null,
      duracaoMs: duracao(a.startedAt, a.endedAt, agora),
      estado: estadoDoAgente(a),
      ajustes: papel === 'review' ? ajustesDe(a, eventos) : null,
      inicio: a.startedAt,
      fim: a.endedAt,
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
      if (plano) aresta = { de: plano.a.id, para: c.a.id, tipo: 'entregou', rotulo: 'plano' };
    } else if (c.papel === 'dev' && c.rodada !== null && c.rodada > 1) {
      const review = subs.find((x) => x.papel === 'review' && x.rodada === c.rodada! - 1);
      // Só a volta de um review que já terminou quando o dev começou, e que não aprovou (0 ajustes).
      const terminou = !!review && review.a.endedAt !== null && review.a.endedAt <= c.a.startedAt;
      if (review && terminou && noDe.get(review.a.id)!.ajustes !== 0) aresta = { de: review.a.id, para: c.a.id, tipo: 'ajustes', rotulo: 'ajustes' };
    } else if (c.papel === 'review') {
      const dev = terminouAntes('dev', c);
      if (dev) aresta = { de: dev.a.id, para: c.a.id, tipo: 'entregou', rotulo: dev.rodada === 1 ? 'diff' : `v${dev.rodada}` };
    } else if (c.papel === 'test-runner') {
      const dev = terminouAntes('dev', c);
      if (dev) aresta = { de: dev.a.id, para: c.a.id, tipo: 'entregou', rotulo: null };
    }
    aresta ??= { de: pais.get(c.a.id) ?? principalId, para: c.a.id, tipo: 'abriu', rotulo: null };
    arestas.push(aresta);
  }

  const reviews = nos.filter((n) => n.nome === 'review');
  const ajustes = reviews.reduce((t, n) => t + (n.ajustes ?? 0), 0);
  const laco = reviews.length > 1 || arestas.some((e) => e.tipo === 'ajustes');
  const resumo = reviews.length === 0 ? null : `dev → review${laco ? ' até aprovar' : ''}${pr !== null ? ` · termina no PR #${pr}` : ''}`;

  const faixas: WorkflowDaSessao['linhaDoTempo']['faixas'] = [];
  const porRotulo = new Map<string, (typeof faixas)[number]>();
  for (const n of nos) {
    const rotulo = n === principal ? 'Agente principal' : rotuloDoNo(n.nome, n.rodada);
    let f = porRotulo.get(rotulo);
    if (!f) {
      f = { noId: n.id, rotulo, trechos: [] };
      porRotulo.set(rotulo, f);
      faixas.push(f);
    }
    f.trechos.push({ noId: n.id, inicio: n.inicio, fim: n.fim, estado: n.estado });
  }

  return {
    sessaoId: session.id,
    inicio: session.startedAt,
    fim: fimDaSessao,
    duracaoMs: principal.duracaoMs,
    resumo,
    nos,
    arestas,
    rodadasDeReview: reviews.length,
    ajustes,
    linhaDoTempo: { inicio: session.startedAt, fim: fimDaSessao ?? new Date(agora).toISOString(), faixas },
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

export const NO_DO_GRAFO = /^(?:principal|origem:(?:prompt|retomada)|compactacao:(?:sem|compactou)|resultado:(?:concluida|erro|andamento|abandonada)|subagente:[A-Za-z0-9_.:-]{1,64})$/;

const COLUNAS: GrafoDeOrquestracao['colunas'] = [
  { id: 'origem', rotulo: 'Origem' },
  { id: 'principal', rotulo: 'Agente principal' },
  { id: 'subagente', rotulo: 'Tipos de subagente' },
  { id: 'compactacao', rotulo: 'Compactação' },
  { id: 'resultado', rotulo: 'Resultado' },
];
const ROTULOS: Record<string, string> = {
  'origem:prompt': 'Prompt novo',
  'origem:retomada': 'Retomada',
  principal: 'Agente principal',
  'compactacao:sem': 'Sem compactação',
  'compactacao:compactou': 'Compactou',
  'resultado:concluida': 'Concluída',
  'resultado:erro': 'Com erro',
  'resultado:andamento': 'Em andamento',
  'resultado:abandonada': 'Abandonada',
};
const RESULTADO: Record<SessionStatus, string> = { completed: 'resultado:concluida', error: 'resultado:erro', active: 'resultado:andamento', abandoned: 'resultado:abandonada' };

const origemDe = (s: Session) => (s.source === 'resume' ? 'origem:retomada' : 'origem:prompt');
const compactacaoDe = (x: SessaoDosWorkflows) => (x.compactou ? 'compactacao:compactou' : 'compactacao:sem');
const tipoDe = (a: Agent) => `subagente:${a.subagentType ?? 'subagente'}`;

/** Os nós do grafo por onde a sessão passa. */
export function nosDaSessao(x: SessaoDosWorkflows): Set<string> {
  const nos = new Set([origemDe(x.session), 'principal', compactacaoDe(x), RESULTADO[x.session.status]]);
  for (const a of x.agentes) if (a.type === 'subagent') nos.add(tipoDe(a));
  return nos;
}

export function passaNoFiltro(s: Session, filtro: FiltroDosWorkflows): boolean {
  if (filtro === 'ativas') return s.status === 'active';
  if (filtro === 'concluidas') return s.status !== 'active';
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
    profundidadeMedia: media(sessoes.map((x) => profundidade(x.agentes))),
    subagentesPorSessao: sessoes.length ? subs.length / sessoes.length : null,
    sucessoSubagentes: ok + erro ? ok / (ok + erro) : null,
    fluxoComum: rotulo ? { rotulo, fracao: n / sessoes.length } : null,
    rodadasPorPr: media(rodadas),
    duracaoMediaMs: media(sessoes.map((x) => duracao(x.session.startedAt, x.session.status === 'active' ? null : (x.session.endedAt ?? x.session.updatedAt), agora))),
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
  const fases = v.map((f) => str(f) ?? str(obj(f)?.nome) ?? str(obj(f)?.name)).filter((f): f is string => f !== null);
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
      const estado: EstadoDoAgenteDoRun = a.status === 'error' ? 'erro' : a.status !== 'completed' ? 'rodando' : ajustes ? 'ajustes' : 'concluido';
      return {
        id: a.id,
        rotulo: str(wf(a)?.rotulo) ?? (rodada === null ? papel : `${papel}:r${rodada}`),
        tipo: a.subagentType,
        fase: str(wf(a)?.fase),
        estado,
        ajustes,
        tokens: tokensDe(a, eventos),
        ferramentas: ferramentasDe(a.id, eventos),
        duracaoMs: duracao(a.startedAt, a.endedAt, agora),
      };
    });
    const vistas = [...new Set(agentes.map((a) => a.fase).filter((f): f is string => f !== null))];
    const fases = fasesDa(entrada?.fases) ?? fasesDa(entrada?.phases) ?? vistas;
    const inicio = chamada?.createdAt ?? membros[0].a.startedAt;
    const algumErro = membros.some((m) => m.a.status === 'error');
    const rodando = membros.some((m) => m.a.status === 'working' || m.a.status === 'waiting');
    let estado: EstadoDoRun;
    let termino: string | null;
    if (fim) {
      estado = fim.type === 'PostToolUseFailure' || obj(fim.data)?.isError === true || algumErro ? 'erro' : 'concluida';
      termino = fim.createdAt;
    } else if (x.session.status === 'active') {
      // Sem o fim da chamada, a sessão viva ainda pode abrir a próxima fase.
      estado = !rodando && algumErro ? 'erro' : 'ativa';
      termino = null;
    } else {
      estado = algumErro ? 'erro' : 'concluida';
      termino = membros.map((m) => m.a.endedAt).filter((t): t is string => t !== null).sort().at(-1) ?? x.session.endedAt;
    }
    runs.push({
      id,
      nome: str(entrada?.name) ?? str(entrada?.workflow) ?? str(wf(membros[0].a)?.nome) ?? 'workflow',
      estado,
      modelo: str(entrada?.model) ?? x.session.model,
      projeto: x.session.cwd ? basename(x.session.cwd) : null,
      sessaoId: x.session.id,
      ferramentas: agentes.reduce((t, a) => t + a.ferramentas, 0),
      tokens: agentes.reduce((t, a) => t + a.tokens, 0),
      duracaoMs: duracao(inicio, termino, agora),
      inicio,
      fim: termino,
      fases: fases.map((nome) => ({ nome })),
      volta: str(entrada?.volta) ?? voltaDe(agentes),
      agentes,
    });
  }
  return runs;
}

/** A volta vista nos dados: um review que pediu ajustes seguido de um agente de outra fase. */
function voltaDe(agentes: AgenteDoRun[]): string | null {
  const i = agentes.findIndex((a) => a.estado === 'ajustes' || (a.ajustes ?? 0) > 0);
  const depois = i >= 0 ? agentes.slice(i + 1).find((a) => a.fase !== null && a.fase !== agentes[i].fase) : undefined;
  return depois?.fase ? `volta para ${depois.fase} enquanto o review pedir ajustes` : null;
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
    for (const k of [origem, 'principal', compactacao, resultado]) somar(volume, k);
    ligar(origem, 'principal');
    const tipos = new Map<string, number>();
    for (const a of x.agentes) if (a.type === 'subagent') somar(tipos, tipoDe(a));
    for (const [t, n] of tipos) {
      somar(volume, t, n);
      ligar('principal', t, n);
      ligar(t, compactacao);
    }
    if (tipos.size === 0) ligar('principal', compactacao);
    ligar(compactacao, resultado);
  }
  const ordem = Object.keys(ROTULOS);
  const coluna = (id: string): ColunaDoGrafo => (id === 'principal' ? 'principal' : (id.split(':')[0] as ColunaDoGrafo));
  const pos = (id: string) => COLUNAS.findIndex((c) => c.id === coluna(id));
  const nos = [...volume]
    .map(([id, v]) => ({ id, coluna: coluna(id), rotulo: ROTULOS[id] ?? id.slice('subagente:'.length), volume: v }))
    .sort((a, b) => pos(a.id) - pos(b.id) || (a.coluna === 'subagente' ? b.volume - a.volume || a.rotulo.localeCompare(b.rotulo) : ordem.indexOf(a.id) - ordem.indexOf(b.id)));
  return {
    colunas: COLUNAS.map((c) => ({ ...c })),
    nos,
    arestas: [...arestas].map(([k, v]) => {
      const [de, para] = k.split('\u0000');
      return { de, para, volume: v };
    }),
  };
}

const PESO_DO_RUN: Record<EstadoDoRun, number> = { ativa: 0, erro: 1, concluida: 2 };

export function montarWorkflows(todas: readonly SessaoDosWorkflows[], { filtro = 'todas', no = null, agora, truncado = false, maximo = MAXIMO_DE_SESSOES }: OpcoesDosWorkflows): RespostaDosWorkflows {
  let sessoes = todas.filter((x) => passaNoFiltro(x.session, filtro));
  if (no) sessoes = sessoes.filter((x) => nosDaSessao(x).has(no));
  const runs = sessoes.flatMap((x) => runsDaSessao(x, agora)).sort((a, b) => PESO_DO_RUN[a.estado] - PESO_DO_RUN[b.estado] || b.inicio.localeCompare(a.inicio));
  return { filtro, no, geradoEm: new Date(agora).toISOString(), sessoes: sessoes.length, truncado, maximo, kpis: kpisDe(sessoes, agora), runs, grafo: grafoDe(sessoes) };
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
  const sim = obj(s.metadata?.contexto);
  if ((inteiro(sim?.estouros) ?? 0) > 0) return true;
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
  const status: SessionStatus[] | undefined = filtro === 'ativas' ? ['active'] : filtro === 'concluidas' ? ['completed', 'error', 'abandoned'] : undefined;
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
    const filtro = url.searchParams.get('filter') ?? 'todas';
    if (!FILTROS_DOS_WORKFLOWS.includes(filtro as FiltroDosWorkflows)) {
      send(res, 400, { error: 'filtro: todas, ativas ou concluidas' });
      return true;
    }
    const no = url.searchParams.get('node');
    if (no !== null && !NO_DO_GRAFO.test(no)) {
      send(res, 400, { error: 'no: um id de nó do grafo (ex.: subagente:Explore)' });
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
