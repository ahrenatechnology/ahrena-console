// Plano da sessão (item 1.9): a lista de tarefas que o agente mantém enquanto trabalha, vinda de
// TodoWrite, TaskCreate e TaskUpdate e do `update_plan` dos plugins. Não é a issue do GitHub
// (essa é o card Trabalho).

import { InvalidModelError, type Metadata } from '../model.ts';

export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

/** Quem faz o passo: o agente principal, um subagente ou uma sessão filha (passo delegado). */
export const PLAN_OWNER_KINDS = ['main', 'subagent', 'session'] as const;
export type PlanOwnerKind = (typeof PLAN_OWNER_KINDS)[number];

export interface PlanOwner {
  kind: PlanOwnerKind;
  /** Id do agente no núcleo (`<sessão>:main`, `<sessão>:<agentId>`), quando se sabe. */
  agentId: string | null;
  /** Nome dado pela ferramenta: o `owner` do TaskUpdate ou a `session` do `update_plan`. */
  name: string | null;
}

/** Ferramenta que mexeu no plano por último. */
export const PLAN_SOURCES = ['TodoWrite', 'Task', 'update_plan'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

export interface PlanStep {
  /** Estável dentro do plano: o id da tarefa (TaskCreate) ou a posição na lista reescrita. */
  id: string;
  text: string;
  /** O texto no gerúndio (`activeForm`), quando a ferramenta manda. */
  activeText: string | null;
  status: PlanStepStatus;
  owner: PlanOwner;
  /** Quando o passo mudou de texto, estado ou dono pela última vez. */
  updatedAt: string;
}

export interface SessionPlan {
  sessionId: string;
  source: PlanSource;
  /** Na ordem do plano. */
  steps: PlanStep[];
  /** Passos feitos e total, para o `feitos/total` do painel. */
  done: number;
  total: number;
  /** O passo em andamento; com mais de um, o primeiro na ordem. */
  currentStepId: string | null;
  /** Hora da última mudança do plano (do evento que a causou). */
  changedAt: string;
  /** Estado interno da extração (chamadas já aplicadas, última chamada para desfazer). */
  metadata: Metadata;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function fail(message: string): never {
  throw new InvalidModelError(`SessionPlan: ${message}`);
}

export function validatePlan(p: SessionPlan): void {
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) fail('sessionId é obrigatório');
  if (!PLAN_SOURCES.includes(p.source)) fail(`source inválido: ${JSON.stringify(p.source)}`);
  if (typeof p.changedAt !== 'string' || !ISO_UTC.test(p.changedAt)) fail('changedAt precisa ser data ISO 8601 em UTC');
  validateSteps(p);
}

function validateSteps(p: Pick<SessionPlan, 'steps' | 'done' | 'total' | 'currentStepId'>): void {
  if (!Array.isArray(p.steps)) fail('steps precisa ser lista');
  const ids = new Set<string>();
  for (const s of p.steps) {
    if (typeof s.id !== 'string' || s.id.length === 0) fail('passo sem id');
    if (ids.has(s.id)) fail(`passo repetido: ${s.id}`);
    ids.add(s.id);
    if (typeof s.text !== 'string') fail(`passo ${s.id} sem texto`);
    if (!PLAN_STEP_STATUSES.includes(s.status)) fail(`status inválido no passo ${s.id}: ${JSON.stringify(s.status)}`);
    if (!s.owner || !PLAN_OWNER_KINDS.includes(s.owner.kind)) fail(`dono inválido no passo ${s.id}`);
    if (typeof s.updatedAt !== 'string' || !ISO_UTC.test(s.updatedAt)) fail(`updatedAt inválido no passo ${s.id}`);
  }
  if (p.total !== p.steps.length) fail('total precisa ser o número de passos');
  if (p.done !== p.steps.filter((s) => s.status === 'completed').length) fail('done precisa ser o número de passos feitos');
  if (p.currentStepId !== null && !ids.has(p.currentStepId)) fail('currentStepId fora dos passos');
}

/** Como o plano acabou: concluído (todos os passos feitos), abandonado (X de Y) ou o atual. */
export const PLAN_RESULTS = ['current', 'completed', 'abandoned'] as const;
export type PlanResult = (typeof PLAN_RESULTS)[number];

/**
 * Um plano do histórico da sessão (issue #131). A sessão abre vários planos; cada um fica
 * guardado do início ao fim, com os passos como estavam quando acabou. O atual é o aberto.
 */
export interface PlanRecord {
  sessionId: string;
  /** 1, 2, 3… na ordem em que os planos começaram na sessão. */
  seq: number;
  source: PlanSource;
  startedAt: string;
  /** `null` no atual. */
  endedAt: string | null;
  result: PlanResult;
  steps: PlanStep[];
  done: number;
  total: number;
  currentStepId: string | null;
  /** Hora da última mudança do plano. */
  changedAt: string;
  metadata: Metadata;
}

export function validatePlanRecord(r: PlanRecord): void {
  if (typeof r.sessionId !== 'string' || r.sessionId.length === 0) fail('sessionId é obrigatório');
  if (!Number.isInteger(r.seq) || r.seq < 1) fail(`seq inválido: ${JSON.stringify(r.seq)}`);
  if (!PLAN_SOURCES.includes(r.source)) fail(`source inválido: ${JSON.stringify(r.source)}`);
  if (!PLAN_RESULTS.includes(r.result)) fail(`result inválido: ${JSON.stringify(r.result)}`);
  for (const [k, v] of [['startedAt', r.startedAt], ['changedAt', r.changedAt]] as const) {
    if (typeof v !== 'string' || !ISO_UTC.test(v)) fail(`${k} precisa ser data ISO 8601 em UTC`);
  }
  if (r.result === 'current' ? r.endedAt !== null : typeof r.endedAt !== 'string' || !ISO_UTC.test(r.endedAt)) {
    fail('endedAt é nulo só no plano atual e data ISO 8601 em UTC nos outros');
  }
  if (r.endedAt !== null && r.endedAt < r.startedAt) fail('endedAt antes de startedAt');
  if (r.result === 'completed' && r.done !== r.total) fail('plano concluído precisa ter todos os passos feitos');
  validateSteps(r);
}
