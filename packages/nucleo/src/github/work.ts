// Modelo do trabalho vindo do GitHub: iniciativa → épico → item → plano, com o resumo
// das sub-issues em cada nó e, por item aberto, os PRs vinculados com CI e review.
// Decisão 0001 (docs/decisoes/0001-github-consulta-cache.md): o nó é raso (só a chave do
// pai); filhas, PR e CI chegam quando o card é expandido.

export const WORK_LEVELS = ['initiative', 'epic', 'item', 'plan'] as const;
/** Nível na hierarquia: iniciativa, épico, item (história, tarefa, spike, bug) e plano. */
export type WorkLevel = (typeof WORK_LEVELS)[number];

/** Tipo de issue do GitHub → nível. Tipo desconhecido cai no nível abaixo do pai (ver `levelOf`). */
export const LEVEL_BY_TYPE: Readonly<Record<string, WorkLevel>> = {
  Initiative: 'initiative',
  Epic: 'epic',
  'Epic / Milestone': 'epic',
  Milestone: 'epic',
  'User Story': 'item',
  Story: 'item',
  Feature: 'item',
  Task: 'item',
  'Tech Task': 'item',
  Spike: 'item',
  Bug: 'item',
  Plan: 'plan',
};

export type IssueState = 'OPEN' | 'CLOSED';

export interface SubIssuesProgress {
  total: number;
  completed: number;
  /** 0 a 100, como o GitHub devolve. */
  percent: number;
}

/** Issue rasa: o que a leitura inicial traz, sem aninhar pais nem filhas. */
export interface WorkNode {
  /** `dono/repo#número`. */
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: IssueState;
  updatedAt: string;
  /** Tipo de issue do GitHub (`Epic`, `Tech Task`…), ou `null` se não tiver. */
  type: string | null;
  /** Chave do pai, ou `null` se for raiz. */
  parent: string | null;
  /** Resumo das sub-issues; `null` quando não tem filhas. */
  progress: SubIssuesProgress | null;
}

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';
/** `statusCheckRollup.state` do último commit; `null` quando não há checagens. */
export type CiState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export interface LinkedPullRequest {
  number: number;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  review: ReviewDecision | null;
  ci: CiState | null;
}

export const WORK_STAGES = [
  'a fazer',
  'em andamento',
  'ci rodando',
  'ci falhou',
  'ajustes pedidos',
  'em revisão',
  'mergeado',
  'concluída',
] as const;
/** Onde o item está, lido do estado da issue e do PR vinculado. */
export type WorkStage = (typeof WORK_STAGES)[number];

/** PR, CI e review de um item: só para cards abertos. */
export interface WorkDetail {
  key: string;
  state: IssueState;
  pullRequests: LinkedPullRequest[];
  stage: WorkStage;
}

export interface WorkTreeNode extends WorkNode {
  level: WorkLevel;
  /** `true` quando o card foi expandido e as filhas vieram do GitHub. */
  childrenLoaded: boolean;
  /** PR, CI e review; `null` até o card ser expandido. */
  detail: WorkDetail | null;
  children: WorkTreeNode[];
}

export interface WorkTree {
  roots: WorkTreeNode[];
  /** Quantos nós a árvore tem, em todos os níveis. */
  count: number;
  /** Quando a lista rasa foi lida do GitHub (ms desde a época). */
  fetchedAt: number;
  /** `true` quando parte do que se vê é o último dado bom, porque o GitHub falhou. */
  stale: boolean;
  staleReason: string | null;
}

export const workKey = (repo: string, number: number): string => `${repo}#${number}`;

export function parseWorkKey(key: string): { owner: string; name: string; repo: string; number: number } {
  const m = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(key);
  if (!m) throw new RangeError(`chave de issue inválida: ${key}`);
  return { owner: m[1], name: m[2], repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/** Nível pelo tipo; sem tipo conhecido, um abaixo do pai; sem pai, item. */
export function levelOf(type: string | null, parentLevel: WorkLevel | null): WorkLevel {
  const byType = type ? LEVEL_BY_TYPE[type] : undefined;
  if (byType) return byType;
  if (!parentLevel) return 'item';
  return WORK_LEVELS[Math.min(WORK_LEVELS.indexOf(parentLevel) + 1, WORK_LEVELS.length - 1)];
}

/** Etapa do item: concluída se a issue fechou; senão, pelo PR aberto (CI e review). */
export function stageOf(state: IssueState, prs: readonly LinkedPullRequest[]): WorkStage {
  if (state === 'CLOSED') return 'concluída';
  if (prs.some((p) => p.state === 'MERGED')) return 'mergeado';
  const open = prs.find((p) => p.state === 'OPEN');
  if (!open) return 'a fazer';
  if (open.isDraft) return 'em andamento';
  if (open.ci === 'FAILURE' || open.ci === 'ERROR') return 'ci falhou';
  if (open.ci === 'PENDING' || open.ci === 'EXPECTED') return 'ci rodando';
  if (open.review === 'CHANGES_REQUESTED') return 'ajustes pedidos';
  return 'em revisão';
}
