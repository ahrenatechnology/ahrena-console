// Side panel scenarios (P1 to P7 and P9 of the wireframes, docs/wireframes), to demo and capture
// the panel without real data: `npm run api -- --demo p1`. All synthetic, with the simulator's
// vocabulary: projects under /simulacao, repository `exemplo/simulacao` and two synthetic accounts
// (all-zero UUIDs). The panel's session, whatever id it sends, becomes `sim-panel-current`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSource, Agent, AwaitingReason, Session, SessionStatus, TokenUsage } from '../model.ts';
import { claudeAccountId, emptyTokenCounts } from '../model.ts';
import { paleta } from '../../../marca/gerado/marca.ts';
import { updatePlan } from '../plan/recording.ts';
import type { StoragePort } from '../storage-port.ts';
import type { DecisionPort } from '../decisions/port.ts';
import { linkSession, markPromoted, registerDecision, type DecisionDraft } from '../decisions/registry.ts';
import type { ChildrenResult, WorkSource } from '../github/source.ts';
import type { CiCounts, LinkedPullRequest, WorkDetail, WorkNode } from '../github/work.ts';
import { stageOf } from '../github/work.ts';
import { currentDemoId } from './legacy-ids.ts';
import { ROOT } from './vocabulary.ts';

/** The CI checks as in P1: "CI ✓ 6/6", "CI … 3/7", "CI ✕ 2 falhas". */
const P1_CHECKS: Record<string, CiCounts> = {
  SUCCESS: { total: 6, ok: 6, falhas: 0, rodando: 0 },
  PENDING: { total: 7, ok: 3, falhas: 0, rodando: 4 },
  FAILURE: { total: 7, ok: 5, falhas: 2, rodando: 0 },
};

export const PANEL_SCENARIOS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p9', 'p12', 'p13'] as const;
export type PanelScenario = (typeof PANEL_SCENARIOS)[number];
export const PANEL_SESSION = 'sim-panel-current';
export const SIMULATOR_REPO = 'exemplo/simulacao';

function syntheticAccount(n: string, label: string, color: string, organizationType: string, source: AccountSource) {
  const accountUuid = `00000000-0000-4000-8000-00000000${n}a1`;
  const organizationUuid = `00000000-0000-4000-8000-00000000${n}b1`;
  return { accountUuid, organizationUuid, id: claudeAccountId(accountUuid, organizationUuid), label, color, organizationType, source };
}
// Brand colors (packages/marca): rose and green, which do not get mixed up with the statuses.
export const PANEL_ACCOUNTS = {
  team: syntheticAccount('0e', 'equipe', paleta.rose['500'], 'claude_team', 'env'),
  client: syntheticAccount('0c', 'cliente-exemplo', paleta.green['500'], 'claude_enterprise', 'config'),
} as const;

const MIN = 60_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

interface Issue {
  number: number;
  title: string;
  sub?: [number, number];
  pr?: { number: number; draft?: boolean; ci: LinkedPullRequest['ci']; review: LinkedPullRequest['review'] };
}

type PlanSteps = [string, 'completed' | 'in_progress' | 'pending'][];

/** "This session": the one the panel shows. */
interface ThisSession {
  title: string;
  project: string;
  model: string;
  startMin: number;
  status: SessionStatus;
  wait?: { reason: AwaitingReason; minAgo: number };
  turns: number;
  context: number;
  cost: number;
  tool?: { name: string; summary: string; input?: Record<string, unknown> };
  notification?: string;
  question?: { text: string; options: number };
  error?: { text: string; minAgo: number };
  background?: string[];
  plan?: PlanSteps;
  /** Plans the session already closed before the current one (issue #131), oldest first. */
  previousPlans?: { sinceMin: number; durationMin: number; steps: PlanSteps }[];
  /** `parent`: the index, in this list, of the subagent that started this one (#146); without it, the session did. */
  subagents?: { type: string; task: string; status: Agent['status']; minAgo: number; durationMin?: number; parent?: number }[];
  /** #146: how many minutes ago each turn started; without it, the turns are spread over the session. */
  turnsMin?: number[];
  children?: string[];
  branch: string;
  notPushed?: boolean;
  issue?: Issue;
  /** The session's effort (`low`, `medium`, `high`…); without it, the model's (effortOf). */
  effort?: string;
}

/** Another session of the scenario: the family and the "needs you" list. */
interface OtherSession {
  slug: string;
  title?: string;
  model: string;
  account: keyof typeof PANEL_ACCOUNTS;
  status: SessionStatus;
  wait?: { reason: AwaitingReason; minAgo: number };
  text?: string;
  tool?: { name: string; summary: string };
  error?: string;
  relation?: 'parent' | 'child';
  updatedMin?: number;
  /** The session's branch, as wireframe C2 shows on the wall. */
  branch?: string;
  effort?: string;
}

/** The effort the simulator writes when the scenario does not say: high on Opus, medium on the rest (as in C2). */
const effortOf = (model: string) => (model === OPUS ? 'high' : 'medium');

const PERMISSION: OtherSession = {
  slug: 'motor-de-regras', model: OPUS, account: 'team', status: 'active', wait: { reason: 'notification', minAgo: 2 }, branch: 'feat/58-pedidos',
  tool: { name: 'Bash', summary: 'npm run migrate' }, text: 'Claude needs your permission to use Bash',
};
const INTERRUPTED: OtherSession = { slug: 'app-receitas', model: SONNET, account: 'client', status: 'active', wait: { reason: 'interrupted', minAgo: 6 }, branch: 'feat/12-filtro' };
const WITH_ERROR: OtherSession = { slug: 'painel-de-metricas', model: OPUS, account: 'client', status: 'error', error: 'API 529 · overloaded_error', updatedMin: 3, branch: 'perf/47-relatorio' };
const YOUR_TURN: OtherSession = {
  slug: 'fila-de-tarefas', model: SONNET, account: 'team', status: 'active', wait: { reason: 'stop', minAgo: 1 }, branch: 'feat/9-retry',
  text: 'Terminei a migração. Rodo os testes?',
};

const THIS_SESSION: Record<Exclude<PanelScenario, 'p9' | 'p12' | 'p13'>, ThisSession> = {
  p1: {
    title: 'Kanban de sessões no artefato', project: 'ahrena-demo', model: OPUS, startMin: 12, status: 'active', turns: 18,
    context: 62_000, cost: 1.84, tool: { name: 'Bash', summary: 'npm test' }, background: ['npm run dev', 'npm run watch'],
    plan: [['Ler o artefato', 'completed'], ['Montar as raias', 'completed'], ['Ligar ao núcleo', 'completed'], ['Rodar a bateria', 'in_progress'], ['Abrir o PR', 'pending'], ['Pedir review', 'pending']],
    previousPlans: [
      { sinceMin: 11, durationMin: 3, steps: [['Ler o wireframe do kanban', 'completed'], ['Listar os estados', 'completed'], ['Escolher as raias', 'completed']] },
      { sinceMin: 8, durationMin: 2, steps: [['Prototipar o arrastar', 'completed'], ['Medir a latência', 'in_progress'], ['Trocar a biblioteca', 'pending'], ['Ajustar o tema', 'pending']] },
    ],
    subagents: [{ type: 'Explore', task: 'mapear usos', status: 'working', minAgo: 0.7 }, { type: 'Plan', task: 'plano', status: 'completed', minAgo: 9, durationMin: 2 }],
    branch: 'feat/42-kanban-de-sessoes', issue: { number: 42, title: 'Kanban de sessões', sub: [2, 4], pr: { number: 78, draft: true, ci: 'SUCCESS', review: null } },
  },
  p2: {
    title: 'Testes de integração da API', project: 'gateway-sandbox', model: OPUS, startMin: 26, status: 'active', wait: { reason: 'notification', minAgo: 4 },
    turns: 11, context: 96_000, cost: 0.92, tool: { name: 'AskUserQuestion', summary: 'SQLite ou Postgres' },
    notification: 'Claude needs your input', question: { text: 'Nos testes de integração, sigo com SQLite em memória ou subo um Postgres no Docker?', options: 3 },
    background: ['npm run dev'],
    plan: [['Ler os testes atuais', 'completed'], ['Decidir o banco', 'in_progress'], ['Escrever os casos de borda', 'pending'], ['Rodar no CI', 'pending']],
    subagents: [{ type: 'Explore', task: 'ler testes', status: 'completed', minAgo: 15, durationMin: 1 }],
    branch: 'feat/51-testes-de-integracao', notPushed: true, issue: { number: 51, title: 'Testes de integração', sub: [0, 3] },
  },
  p3: {
    title: 'Migração do esquema de pedidos', project: 'motor-de-regras', model: OPUS, startMin: 34, status: 'active', wait: { reason: 'notification', minAgo: 2 },
    turns: 22, context: 108_000, cost: 2.1, tool: { name: 'Bash', summary: 'npm run migrate' }, notification: 'Claude needs your permission to use Bash',
    plan: [['Mapear as tabelas', 'completed'], ['Escrever a migração', 'completed'], ['Testar a volta', 'completed'], ['Revisar índices', 'completed'], ['Aplicar a migração', 'in_progress'], ['Atualizar o seed', 'pending']],
    subagents: [{ type: 'Explore', task: 'esquema atual', status: 'completed', minAgo: 20, durationMin: 7 }],
    branch: 'feat/58-esquema-de-pedidos', issue: { number: 58, title: 'Esquema de pedidos', sub: [3, 5], pr: { number: 91, ci: 'SUCCESS', review: 'REVIEW_REQUIRED' } },
  },
  p4: {
    title: 'Separar pagamentos em serviços', project: 'vitrine-demo', model: OPUS, startMin: 28, status: 'active', turns: 9, context: 114_000, cost: 3.47,
    tool: { name: 'Agent', summary: '3 subagentes em paralelo' },
    plan: [['Mapear o módulo', 'completed'], ['Desenhar os serviços', 'completed'], ['Extrair a cobrança', 'in_progress'], ['Migrar os testes', 'pending'], ['Ajustar o deploy', 'pending'], ['Remover o código velho', 'pending']],
    previousPlans: [
      { sinceMin: 27, durationMin: 4, steps: [['Ler o módulo de pagamentos', 'completed'], ['Listar os acoplamentos', 'completed']] },
      { sinceMin: 22, durationMin: 6, steps: [['Separar por camadas', 'completed'], ['Mover os adaptadores', 'pending'], ['Trocar as injeções', 'pending']] },
      { sinceMin: 15, durationMin: 5, steps: [['Escrever a decisão de serviços', 'completed'], ['Revisar com o time', 'completed']] },
    ],
    subagents: [
      { type: 'Explore', task: 'achar usos', status: 'working', minAgo: 1 },
      { type: 'code-reviewer', task: 'diff', status: 'working', minAgo: 0.7 },
      { type: 'test-runner', task: 'bateria', status: 'working', minAgo: 0.2 },
      { type: 'Plan', task: 'plano', status: 'completed', minAgo: 20, durationMin: 3 },
    ],
    children: ['fila-de-tarefas', 'catalogo-exemplo', 'blog-estatico'],
    branch: 'feat/63-separar-pagamentos', issue: { number: 63, title: 'Separar pagamentos', sub: [2, 6], pr: { number: 90, ci: 'PENDING', review: 'APPROVED' } },
  },
  p5: {
    title: 'Relatório mensal mais rápido', project: 'painel-de-metricas', model: OPUS, startMin: 58, status: 'error', turns: 23, context: 168_000, cost: 4.1,
    error: { text: 'API 529 · overloaded_error. Parou depois de 3 tentativas, em Edit src/relatorio/consulta.ts', minAgo: 3 },
    tool: { name: 'Edit', summary: 'src/relatorio/consulta.ts' }, background: ['npm test -- --watch'],
    plan: [['Medir a consulta', 'completed'], ['Criar os índices', 'completed'], ['Cachear o total', 'completed'], ['Reescrever a consulta', 'in_progress']],
    subagents: [{ type: 'test-runner', task: 'bateria', status: 'error', minAgo: 5, durationMin: 2 }, { type: 'Explore', task: 'índices', status: 'completed', minAgo: 30, durationMin: 1 }],
    branch: 'feat/47-acelerar-o-relatorio', issue: { number: 47, title: 'Acelerar o relatório', sub: [3, 4], pr: { number: 88, ci: 'FAILURE', review: 'CHANGES_REQUESTED' } },
  },
  p6: {
    title: 'Sessão nova, sem transcript', project: 'cli-de-notas', model: SONNET, startMin: 0, status: 'active', wait: { reason: 'session_start', minAgo: 0 },
    turns: 0, context: 0, cost: 0, branch: 'main',
  },
  p7: {
    title: 'Kanban de sessões no artefato', project: 'ahrena-demo', model: OPUS, startMin: 12, status: 'active', turns: 18,
    context: 62_000, cost: 1.84, tool: { name: 'Bash', summary: 'npm test' }, background: ['npm run dev', 'npm run watch'],
    branch: 'feat/42-kanban-de-sessoes', issue: { number: 42, title: 'Kanban de sessões', sub: [2, 4], pr: { number: 78, draft: true, ci: 'SUCCESS', review: null } },
  },
};

/**
 * #146: a subagent by the session minute it started and ended (`end` null: still running), in the
 * scenario's format (how many minutes ago). `t` is the session's duration.
 */
const atMinute = (t: number) => (type: string, task: string, start: number, end: number | null, status: Agent['status'] = end === null ? 'working' : 'completed', parent?: number) =>
  end === null ? { type, task, status, minAgo: t - start, ...(parent === undefined ? {} : { parent }) } : { type, task, status, minAgo: t - end, durationMin: end - start, ...(parent === undefined ? {} : { parent }) };
const m12 = atMinute(14);
const m52 = atMinute(52);

/** P12 and P13 (#146): the session graph, simple and chaotic, as in the wireframes. */
const GRAPH: Record<'p12' | 'p13', ThisSession> = {
  p12: {
    title: 'Separar pagamentos em serviços', project: 'vitrine-demo', model: OPUS, startMin: 14, status: 'active', turns: 2, turnsMin: [13, 6],
    context: 70_000, cost: 1.2, tool: { name: 'Agent', summary: 'test-runner' },
    subagents: [m12('Plan', 'plano da extração', 2, 4), m12('Explore', 'achar usos', 9, 13), m12('test-runner', 'bateria', 11, null)],
    branch: 'feat/63-separar-pagamentos', issue: { number: 63, title: 'Separar pagamentos', sub: [2, 6], pr: { number: 90, ci: 'PENDING', review: 'APPROVED' } },
  },
  p13: {
    title: 'Separar pagamentos em serviços', project: 'vitrine-demo', model: OPUS, startMin: 52, status: 'active', turns: 5, turnsMin: [51.5, 42.5, 34.5, 19.5, 7.5],
    context: 150_000, cost: 6.3, tool: { name: 'Agent', summary: '4 subagentes em paralelo' },
    subagents: [
      // Wave 1: six Explore, all completed.
      m52('Explore', 'mapear módulos', 1, 9), m52('Explore', 'rotas', 1.5, 6), m52('Explore', 'modelos', 2, 7), m52('Explore', 'eventos', 2.5, 5), m52('Explore', 'filas', 3, 8), m52('Explore', 'configuração', 4, 9),
      // Wave 2: five completed and one with an error.
      m52('code-reviewer', 'diff inicial', 10, 14), m52('test-runner', 'lint e tipos', 11, 15, 'error'), m52('Explore', 'testes', 10, 12), m52('Explore', 'fixtures', 12, 16), m52('Explore', 'mocks', 13, 17), m52('Plan', 'fatias', 11, 16),
      // Wave 3: one Plan.
      m52('Plan', 'plano da migração', 18, 31),
      // Wave 4: the general-purpose one (13) started its own; the contracts one (16), two more.
      m52('general-purpose', 'migrar a cobrança', 33, null), m52('Explore', 'rotas de cobrança', 34, 36, 'completed', 13), m52('Explore', 'webhooks', 34, 37, 'completed', 13),
      m52('general-purpose', 'contratos', 38, 46, 'completed', 13), m52('Explore', 'esquemas', 39, 41, 'completed', 16), m52('Explore', 'clientes', 41, 44, 'completed', 16),
      m52('test-runner', 'api de cobrança', 47, null, 'working', 13), m52('code-reviewer', 'diff do serviço', 40, null), m52('test-runner', 'e2e', 44, null), m52('docs-writer', 'README do serviço', 35, 39),
      // Wave 5: two Explore.
      m52('Explore', 'logs', 45, 47), m52('Explore', 'métricas', 46, 49),
    ],
    branch: 'feat/63-separar-pagamentos', issue: { number: 63, title: 'Separar pagamentos', sub: [2, 6], pr: { number: 90, ci: 'PENDING', review: 'APPROVED' } },
  },
};

// P9: P1's session, open for longer, with its decisions and the parent session's (seedPanelDecisions).
const thisSessionOf = (c: PanelScenario): ThisSession => (c === 'p9' ? { ...THIS_SESSION.p1, startMin: 45 } : c === 'p12' || c === 'p13' ? GRAPH[c] : THIS_SESSION[c]);

const OTHERS: Record<PanelScenario, OtherSession[]> = {
  p1: [PERMISSION, INTERRUPTED],
  p2: [],
  p3: [{ ...INTERRUPTED, relation: 'parent' }],
  p4: [{ ...YOUR_TURN, relation: 'child' }, { slug: 'catalogo-exemplo', model: SONNET, account: 'team', status: 'active', relation: 'child', updatedMin: 6, branch: 'feat/31-csv' }, { slug: 'blog-estatico', model: SONNET, account: 'team', status: 'completed', relation: 'child', updatedMin: 20, branch: 'fix/5-paginacao' }],
  p5: [PERMISSION, INTERRUPTED],
  p6: [PERMISSION, INTERRUPTED, WITH_ERROR],
  p7: [{ ...PERMISSION, relation: 'parent' }, WITH_ERROR, { ...YOUR_TURN, relation: 'child' }],
  // The last two only exist for the Decisions page (C21): ended sessions, out of "needs you".
  p9: [PERMISSION, INTERRUPTED, { slug: 'vitrine-demo', title: 'Kanban da vitrine', model: OPUS, account: 'team', status: 'completed', updatedMin: 7 }, { ...WITH_ERROR, title: 'Relatório mensal mais rápido', status: 'completed', error: undefined, updatedMin: 39 }],
  p12: [{ ...YOUR_TURN, relation: 'child' }],
  p13: [WITH_ERROR],
};

/** What the fake git and GitHub answer in the scenario in use. */
const current: { cwd: string | null; session: ThisSession | null } = { cwd: null, session: null };

const iso = (now: number, minAgo: number) => new Date(now - minAgo * MIN).toISOString();

function baseSession(id: string, cwd: string, model: string, start: string, updated: string): Session {
  return {
    id, name: null, status: 'active', cwd, model, source: 'startup', startedAt: start, endedAt: null,
    awaitingInputSince: null, awaitingReason: null, updatedAt: updated, accountId: null, accountSource: null, metadata: { simulado: true },
  };
}

function makeAgent(id: string, sessionId: string, type: Agent['type'], start: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, sessionId, name: null, type, subagentType: null, status: 'working', task: null, currentTool: null,
    parentAgentId: null, startedAt: start, endedAt: null, updatedAt: start, metadata: { simulado: true }, ...extra,
  };
}

let seq = 0;
const SAMPLE_PROMPTS = [
  'Separe o cálculo de pagamentos num serviço próprio',
  'Rode os testes e me diga o que quebrou',
  'Pode seguir com o plano',
  'Ajuste o nome das variáveis para o padrão do projeto',
];

async function addEvent(storage: StoragePort, sessionId: string, agentId: string | null, createdAt: string, type: string, toolName: string | null, summary: string | null, data: unknown = null) {
  const e = { id: `${sessionId}-e${String(++seq).padStart(4, '0')}`, sessionId, agentId, type, toolName, summary, data, createdAt };
  await storage.appendEvent(e);
  return e;
}

// Assistant messages with usage, so cost and tokens go through the real path (slices and buckets).
// Each one's output is computed to add up close to `cost`, with the model's default price (US$ per
// million: Opus 5.5 4/20 and cache read 0.2; Sonnet 5.5 2/10 and 0.1).
async function addUsage(storage: StoragePort, sessionId: string, model: string, start: number, end: number, context: number, cost: number) {
  if (cost <= 0) return;
  const [pin, pout, pread] = model === OPUS ? [4, 20, 0.2] : [2, 10, 0.1];
  const n = 16;
  const input = 1_500;
  let fixed = 0;
  const reads: number[] = [];
  for (let i = 0; i < n; i++) {
    // Grows up to the final context, without passing it: passing 200k would change the window (#140).
    const read = Math.round(((i + 1) / n) * (context - 2_000) + 1_000);
    reads.push(read);
    fixed += (input * pin + read * pread) / 1e6;
  }
  const output = Math.max(50, Math.round(((cost - fixed) / n / pout) * 1e6));
  const total = emptyTokenCounts();
  for (let i = 0; i < n; i++) {
    const tokens = { input, output, cacheRead: reads[i], cacheWrite5m: 0, cacheWrite1h: 0 };
    if (i === n - 1) tokens.cacheRead = Math.max(0, context - input - output);
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += tokens[k];
    const at = new Date(start + ((end - start) * (i + 1)) / (n + 1)).toISOString();
    await addEvent(storage, sessionId, `${sessionId}:main`, at, 'AssistantMessage', null, null, {
      usage: { messageId: `${sessionId}-m${i}`, requestId: null, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '', tokens, webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0 },
    });
  }
  const bucket: TokenUsage = {
    sessionId, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '', tokens: total,
    webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0, baseline: emptyTokenCounts(), updatedAt: new Date(end).toISOString(),
  };
  await storage.putTokenUsage(bucket);
}

async function writeThisSession(storage: StoragePort, e: ThisSession, now: number, children: string[]) {
  const id = PANEL_SESSION;
  const cwd = `${ROOT}/${e.project}`;
  const start = iso(now, e.startMin);
  const s = baseSession(id, cwd, e.model, start, iso(now, 0.05));
  s.name = e.title;
  s.status = e.status;
  if (e.wait) {
    s.awaitingInputSince = iso(now, e.wait.minAgo);
    s.awaitingReason = e.wait.reason;
  }
  const background = Object.fromEntries((e.background ?? []).map((c, i) => [`bg-${i}`, { desde: start, comando: c }]));
  s.accountId = PANEL_ACCOUNTS.team.id;
  s.accountSource = PANEL_ACCOUNTS.team.source;
  // Persisted metadata keys stay as they are (phase 5).
  s.metadata = {
    simulado: true,
    branch: e.branch,
    esforco: e.effort ?? effortOf(e.model),
    familia: { filhas: children.map((slug) => `sim-panel-${slug}`) },
    estados: { ultimoEvento: null, idsNoUltimoInstante: [], erroEm: e.error ? iso(now, e.error.minAgo) : null, delegacoes: {}, background },
  };
  if (e.startMin === 0 && e.turns === 0) return; // P6: the core has not seen the session yet
  await storage.putSession(s);

  const tool = e.status === 'active' && !e.wait ? (e.tool?.name ?? null) : null;
  await storage.putAgent(makeAgent(`${id}:main`, id, 'main', start, { currentTool: tool, status: e.wait ? 'waiting' : e.status === 'error' ? 'error' : 'working' }));
  for (const [i, sub] of (e.subagents ?? []).entries()) {
    const since = iso(now, sub.minAgo + (sub.durationMin ?? 0));
    await storage.putAgent(
      makeAgent(`${id}:a${i}`, id, 'subagent', since, {
        subagentType: sub.type, name: sub.task, status: sub.status, endedAt: sub.status === 'working' ? null : iso(now, sub.minAgo),
        parentAgentId: sub.parent === undefined ? `${id}:main` : `${id}:a${sub.parent}`,
      }),
    );
  }

  const t0 = Date.parse(start);
  const turns = e.turnsMin ? e.turnsMin.map((m) => iso(now, m)) : Array.from({ length: e.turns }, (_, i) => new Date(t0 + (i * (now - t0)) / (e.turns + 1)).toISOString());
  // Prompts that look like prompts: the Feed (#94) shows the text, and "prompt" alone says nothing.
  for (const [i, t] of turns.entries()) await addEvent(storage, id, null, t, 'UserPromptSubmit', null, SAMPLE_PROMPTS[i % SAMPLE_PROMPTS.length]);
  await addUsage(storage, id, e.model, t0, now - 0.5 * MIN, e.context, e.cost);
  if (e.plan) {
    // Each previous plan comes in pending and leaves as it ended; the current one starts right after the last.
    // The plan comes before the last tool, which is the one asking for permission or asking a question.
    const todoWrite = (min: number, steps: PlanSteps, pending = false) => {
      const todos = steps.map(([content, status]) => ({ content, status: pending ? 'pending' : status, activeForm: content }));
      return addEvent(storage, id, null, iso(now, min), 'PreToolUse', 'TodoWrite', 'plano', { tool_name: 'TodoWrite', tool_input: { todos }, tool_use_id: `${id}-plano-${seq}` });
    };
    const events = [];
    for (const a of e.previousPlans ?? []) events.push(await todoWrite(a.sinceMin, a.steps, true), await todoWrite(a.sinceMin - a.durationMin, a.steps));
    const last = e.previousPlans?.at(-1);
    if (last) events.push(await todoWrite(last.sinceMin - last.durationMin - 0.5, e.plan, true));
    events.push(await todoWrite((e.wait?.minAgo ?? 0.3) + 0.2, e.plan));
    await updatePlan(storage, id, events);
  }
  if (e.tool) {
    const input = e.question ? { questions: [{ question: e.question.text, options: Array.from({ length: e.question.options }, (_, k) => ({ label: `opção ${k + 1}` })) }] } : { command: e.tool.summary };
    await addEvent(storage, id, null, iso(now, e.wait?.minAgo ?? 0.3), 'PreToolUse', e.tool.name, e.tool.summary, { tool_name: e.tool.name, tool_input: input });
  }
  if (e.notification) await addEvent(storage, id, null, iso(now, e.wait?.minAgo ?? 0), 'Notification', null, e.notification, { notification_type: e.question ? 'elicitation_dialog' : 'permission_prompt' });
  if (e.error) await addEvent(storage, id, null, iso(now, e.error.minAgo), 'APIError', null, e.error.text);
}

async function writeOtherSession(storage: StoragePort, o: OtherSession, now: number) {
  const id = `sim-panel-${o.slug}`;
  const updated = iso(now, o.updatedMin ?? o.wait?.minAgo ?? 1);
  const s = baseSession(id, `${ROOT}/${o.slug}`, o.model, iso(now, 40), updated);
  s.name = o.title ?? o.slug;
  s.status = o.status;
  if (o.status === 'completed') s.endedAt = updated;
  if (o.wait) {
    s.awaitingInputSince = iso(now, o.wait.minAgo);
    s.awaitingReason = o.wait.reason;
  }
  s.accountId = PANEL_ACCOUNTS[o.account].id;
  s.accountSource = PANEL_ACCOUNTS[o.account].source;
  s.metadata = {
    simulado: true,
    ...(o.branch ? { branch: o.branch } : {}),
    esforco: o.effort ?? effortOf(o.model),
    familia: o.relation === 'child' ? { mae: PANEL_SESSION } : {},
    estados: { ultimoEvento: null, idsNoUltimoInstante: [], erroEm: o.status === 'error' ? updated : null, delegacoes: {}, background: {} },
  };
  await storage.putSession(s);
  await storage.putAgent(makeAgent(`${id}:main`, id, 'main', s.startedAt, { status: o.wait ? 'waiting' : o.status === 'completed' ? 'completed' : 'working' }));
  if (o.tool) await addEvent(storage, id, null, s.awaitingInputSince ?? updated, 'PreToolUse', o.tool.name, o.tool.summary, { tool_name: o.tool.name, tool_input: { command: o.tool.summary } });
  if (o.wait?.reason === 'notification') await addEvent(storage, id, null, s.awaitingInputSince!, 'Notification', null, o.text ?? null, { notification_type: 'permission_prompt' });
  if (o.wait?.reason === 'stop' && o.text) await addEvent(storage, id, `${id}:main`, s.awaitingInputSince!, 'AssistantMessage', null, o.text);
  if (o.error) await addEvent(storage, id, null, updated, 'APIError', null, o.error);
}

/** Writes the scenario through the port. The parent of "this session" (relation `parent`) is linked through the metadata. */
export async function seedPanelScenario(storage: StoragePort, scenario: PanelScenario = 'p1', now = Date.now()): Promise<void> {
  const e = thisSessionOf(scenario);
  const others = OTHERS[scenario];
  for (const c of Object.values(PANEL_ACCOUNTS)) {
    await storage.putAccount({
      id: c.id, accountUuid: c.accountUuid, organizationUuid: c.organizationUuid, organizationName: null, organizationType: c.organizationType,
      label: c.label, color: c.color, configDirs: [], firstSeenAt: iso(now, 60), lastSeenAt: iso(now, 0), metadata: { simulado: true },
    });
  }
  const children = [...(e.children ?? []), ...others.filter((o) => o.relation === 'child' && !(e.children ?? []).includes(o.slug)).map((o) => o.slug)];
  await writeThisSession(storage, e, now, children);
  const parent = others.find((o) => o.relation === 'parent');
  if (parent) {
    const s = await storage.getSession(PANEL_SESSION);
    if (s) await storage.putSession({ ...s, metadata: { ...s.metadata, familia: { ...(s.metadata.familia as object), mae: `sim-panel-${parent.slug}` } } });
  }
  for (const o of others) await writeOtherSession(storage, o, now);
  current.cwd = `${ROOT}/${e.project}`;
  current.session = e;
}

/** The scenario's fake GitHub: the issue and the PR of "this session", and nothing else. */
export class SimulatorWorkSource implements WorkSource {
  /** Fake git: the scenario's branch, remote and upstream. */
  static git = async (_cwd: string, args: string[]): Promise<string | null> => {
    const e = current.session;
    if (!e) return null;
    if (args[0] === 'branch') return e.branch;
    if (args[0] === 'remote') return `https://github.com/${SIMULATOR_REPO}.git`;
    if (args[0] === 'rev-parse') return e.notPushed ? null : `origin/${e.branch}`;
    return null;
  };

  private node(): WorkNode | null {
    const i = current.session?.issue;
    if (!i) return null;
    return {
      key: `${SIMULATOR_REPO}#${i.number}`, repo: SIMULATOR_REPO, number: i.number, title: i.title,
      url: `https://github.com/${SIMULATOR_REPO}/issues/${i.number}`, state: 'OPEN', updatedAt: new Date().toISOString(),
      type: 'User Story', parent: null, progress: i.sub ? { completed: i.sub[0], total: i.sub[1], percent: Math.round((i.sub[0] / i.sub[1]) * 100) } : null,
    };
  }

  async listShallow(): Promise<WorkNode[]> {
    const n = this.node();
    return n ? [n] : [];
  }
  async nodes(keys: readonly string[]): Promise<WorkNode[]> {
    const n = this.node();
    return n && keys.includes(n.key) ? [n] : [];
  }
  async children(): Promise<ChildrenResult> {
    return { children: [], details: [] };
  }
  async detail(key: string): Promise<WorkDetail> {
    const pr = current.session?.issue?.pr;
    const prs: LinkedPullRequest[] = pr
      ? [{ number: pr.number, url: `https://github.com/${SIMULATOR_REPO}/pull/${pr.number}`, state: 'OPEN', isDraft: !!pr.draft, review: pr.review, ci: pr.ci, checks: P1_CHECKS[pr.ci ?? ''] ?? null }]
      : [];
    return { key, state: 'OPEN', pullRequests: prs, stage: stageOf('OPEN', prs) };
  }
}

/** P9's parent session: yesterday's, before /clear. It only exists in the decisions port. */
export const P9_PARENT = 'sim-panel-kanban-yesterday';

/**
 * P9's decisions, through the decisions port and its rules (number, chain, family): the parent
 * session decided yesterday; this one, linked to it by /clear, decided the rest. Synthetic texts.
 * With them, the other three families of the Decisions page (C21). In the other scenarios, nothing.
 */
export async function seedPanelDecisions(port: DecisionPort, scenario: PanelScenario = 'p1', now = Date.now()): Promise<void> {
  if (scenario !== 'p9') return;
  const repo = `${ROOT}/${THIS_SESSION.p1.project}`;
  const branch = THIS_SESSION.p1.branch;
  const nowIso = iso(now, 0);
  let n = 0;
  const decide = (sessionId: string, minAgo: number, d: Pick<DecisionDraft, 'origin' | 'choice' | 'alternatives' | 'topic'> & Partial<DecisionDraft>) =>
    registerDecision(
      port,
      {
        sourceKey: `sim:p9:${++n}`, sessionId, agentId: `${sessionId}:main`, repo, branch, context: null, decidedBy: 'user', inferred: false,
        message: { toolUseId: `sim-toolu-p9-${n}` }, decidedAt: iso(now, minAgo), metadata: { simulado: true }, ...d,
      },
      nowIso,
    );
  await decide(P9_PARENT, 20 * 60, { origin: 'question', topic: 'question:kanban arrasta', choice: 'Kanban só leitura, sem arrastar', alternatives: ['arrastar muda o status'] });
  await linkSession(port, { sessionId: PANEL_SESSION, parentSessionId: P9_PARENT, reason: 'clear', linkedAt: iso(now, 45) }, nowIso);
  await decide(PANEL_SESSION, 40, { origin: 'plan', topic: 'plan', choice: 'Plano de 5 passos aprovado', alternatives: ['plano com drag-and-drop'] });
  await decide(PANEL_SESSION, 33, { origin: 'question', topic: 'question:banco nos testes', choice: 'Postgres no Docker nos testes', alternatives: ['SQLite em memória'] });
  await decide(PANEL_SESSION, 14, { origin: 'correction', topic: 'question:banco nos testes', choice: 'SQLite em memória nos testes', alternatives: ['Postgres no Docker'] });
  await decide(PANEL_SESSION, 21, { origin: 'permission', topic: 'permission:Bash npm test', choice: 'Permitir npm test sem perguntar', alternatives: ['perguntar a cada vez'] });
  await decide(PANEL_SESSION, 6, {
    origin: 'suggested', decidedBy: 'agent', inferred: true, topic: 'kanban:cards por coluna',
    choice: '10 cards por coluna, com "mostrar mais"', alternatives: ['20 por coluna', 'rolagem infinita'],
  });
  await seedDecisionsPage(port, now);
}

/** The records the demo already promoted decisions to, by folder under /simulacao. */
const DEMO_RECORDS = {
  'vitrine-demo': ['0003-kanban-por-long-polling.md'],
  'motor-de-regras': ['0004-cobranca-em-servico-a-parte.md', '0005-contrato-da-cobranca-primeiro.md'],
  'painel-de-metricas': ['0006-cache-do-total-do-mes.md'],
  'ahrena-demo': [],
} as const;
const recordPath = (folder: keyof typeof DEMO_RECORDS, i: number) => `docs/decisoes/${DEMO_RECORDS[folder][i]}`;

/**
 * So the --demo's "Promover a registro" really writes without touching anything on the machine: one
 * folder per synthetic repository, under `base` (a temporary folder), with `docs/decisoes` and the
 * records already promoted (title only). Returns the swap of `/simulacao/<folder>` for the real folder.
 */
export function demoRecordFolders(base: string): (repo: string) => string | null {
  for (const [folder, names] of Object.entries(DEMO_RECORDS)) {
    const dir = join(base, folder, 'docs', 'decisoes');
    mkdirSync(dir, { recursive: true });
    for (const name of names) writeFileSync(join(dir, name), `# ${name.slice(0, 4)} · registro sintético da demonstração\n`);
  }
  return (repo) => {
    const folder = repo.startsWith(`${ROOT}/`) ? repo.slice(ROOT.length + 1) : null;
    return folder && Object.hasOwn(DEMO_RECORDS, folder) ? join(base, folder) : null;
  };
}

/**
 * The panel's alias in the --demo: the side panel (which sends the session's real id) sees the
 * scenario's; the simulator's sessions (`sim-…`), which the /ui sends when deciding on behalf of the
 * owning session, stay as they came, with an old id read as its new one (legacy-ids.ts).
 */
export const demoAlias = (sessionId: string): string => (sessionId.startsWith('sim-') ? currentDemoId(sessionId) : PANEL_SESSION);

/** The vitrine's parent session: yesterday's, before /clear. It only exists in the decisions port. */
export const VITRINE_PARENT = 'sim-panel-vitrine-yesterday';

type DemoDraft = Pick<DecisionDraft, 'origin' | 'choice' | 'alternatives' | 'topic'> & Partial<DecisionDraft> & { minAgo: number; promotedTo?: string };

/**
 * The other three families of the Decisions page (C21, docs/wireframes/capturas/console-decisoes.png),
 * each on a branch and in a folder: `feat/42-kanban` (vitrine-demo, with yesterday's parent),
 * `refactor/pagamentos` (motor-de-regras) and `perf/47-relatorio` (painel-de-metricas), with
 * decisions in force, replaced, promoted to a record and to confirm. In `decidedAt` order, so the
 * number in the family (D1, D2…) follows time. The record paths are fictitious, as are the folders.
 */
async function seedDecisionsPage(port: DecisionPort, now: number): Promise<void> {
  const nowIso = iso(now, 0);
  let n = 0;
  const decide = async (sessionId: string, repo: string, branch: string, d: DemoDraft) => {
    const { minAgo, promotedTo, ...rest } = d;
    const { decision } = await registerDecision(
      port,
      {
        sourceKey: `sim:c21:${++n}`, sessionId, agentId: `${sessionId}:main`, repo, branch, context: null, decidedBy: 'user', inferred: false,
        message: { toolUseId: `sim-toolu-c21-${n}` }, decidedAt: iso(now, minAgo), metadata: { simulado: true }, ...rest,
      },
      nowIso,
    );
    if (promotedTo) await markPromoted(port, decision.id, promotedTo, nowIso);
  };

  const vitrine = (sessionId: string, d: DemoDraft) => decide(sessionId, `${ROOT}/vitrine-demo`, 'feat/42-kanban', d);
  const kanban = 'sim-panel-vitrine-demo';
  await vitrine(VITRINE_PARENT, { minAgo: 26 * 60, origin: 'question', topic: 'kanban:arrastar', choice: 'Cards só leitura, sem arrastar', alternatives: ['arrastar muda o status'] });
  await linkSession(port, { sessionId: kanban, parentSessionId: VITRINE_PARENT, reason: 'clear', linkedAt: iso(now, 60) }, nowIso);
  await vitrine(kanban, { minAgo: 50, origin: 'plan', topic: 'plan', choice: 'Plano de 4 passos aprovado', alternatives: ['plano com drag-and-drop'], scope: 'session' });
  await vitrine(kanban, { minAgo: 45, origin: 'question', topic: 'kanban:banco', choice: 'Postgres no Docker nos testes', alternatives: ['SQLite em memória'], scope: 'session' });
  await vitrine(kanban, { minAgo: 30, origin: 'permission', topic: 'permission:Bash npm run build', choice: 'Permitir npm run build sem perguntar', alternatives: ['perguntar a cada vez'], scope: 'session' });
  await vitrine(kanban, {
    minAgo: 25, origin: 'question', topic: 'kanban:atualizar', choice: 'Kanban atualiza por long polling', alternatives: ['recarregar a cada 5 s'], scope: 'branch',
    promotedTo: recordPath('vitrine-demo', 0),
  });
  await vitrine(kanban, { minAgo: 20, origin: 'question', topic: 'kanban:card', choice: 'Card com 3 linhas: título, branch e PR', alternatives: ['card com o resumo da conversa'] });
  await vitrine(kanban, { minAgo: 16, origin: 'correction', topic: 'kanban:banco', choice: 'SQLite em memória nos testes', alternatives: ['Postgres no Docker'], scope: 'session' });
  await vitrine(kanban, {
    minAgo: 8, origin: 'suggested', decidedBy: 'agent', inferred: true, topic: 'kanban:encerradas', scope: 'session',
    choice: 'Esconder sessões encerradas há mais de 7 dias', alternatives: ['mostrar todas'],
  });

  const payments = (d: DemoDraft) => decide('sim-panel-motor-de-regras', `${ROOT}/motor-de-regras`, 'refactor/pagamentos', d);
  await payments({
    minAgo: 60, origin: 'question', topic: 'pagamentos:cobranca', choice: 'Cobrança vira um serviço à parte', alternatives: ['manter no módulo de pagamentos'],
    promotedTo: recordPath('motor-de-regras', 0),
  });
  await payments({ minAgo: 50, origin: 'question', topic: 'pagamentos:pr', choice: 'Abrir o PR direto', alternatives: ['review antes do PR'] });
  await payments({
    minAgo: 40, origin: 'plan', topic: 'plan', choice: 'Contrato da API de cobrança antes do código', alternatives: ['começar pelo código'],
    promotedTo: recordPath('motor-de-regras', 1),
  });
  await payments({ minAgo: 35, origin: 'question', topic: 'pagamentos:eventos', choice: 'Eventos de cobrança pela fila', alternatives: ['chamada direta entre serviços'], scope: 'branch' });
  await payments({ minAgo: 27, origin: 'correction', topic: 'pagamentos:pr', choice: 'Review por code-reviewer antes do PR', alternatives: ['abrir o PR direto'] });

  const report = (d: DemoDraft) => decide('sim-panel-painel-de-metricas', `${ROOT}/painel-de-metricas`, 'perf/47-relatorio', d);
  await report({ minAgo: 90, origin: 'plan', topic: 'plan', choice: 'Medir antes de otimizar', alternatives: ['reescrever a consulta direto'] });
  await report({ minAgo: 70, origin: 'question', topic: 'relatorio:granularidade', choice: 'Consulta por dia', alternatives: ['consulta por mês'] });
  await report({ minAgo: 55, origin: 'correction', topic: 'relatorio:granularidade', choice: 'Consulta por mês, não por dia', alternatives: ['consulta por dia'] });
  await report({
    minAgo: 45, origin: 'question', topic: 'relatorio:cache', choice: 'Cachear o total do mês por 5 min', alternatives: ['sem cache'], scope: 'branch',
    promotedTo: recordPath('painel-de-metricas', 0),
  });
  await report({
    minAgo: 40, origin: 'suggested', decidedBy: 'agent', inferred: true, topic: 'relatorio:indice', scope: 'session',
    choice: 'Índice composto em (mes, conta)', alternatives: ['view materializada'],
  });
}
