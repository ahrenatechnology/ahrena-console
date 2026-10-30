// Kanban de um GitHub Project v2 (item 5.3): os itens agrupados pelo campo Status, com as
// raias na ordem das opções do Project, e mover um card muda o Status no GitHub.
// Segue a decisão 0001:
// - leitura com `fieldValueByName(name: "Status")`, 100 itens por página;
// - TTL de 2 min (o delta das issues não vê mudança só de campo do Project);
// - mover é uma mutação que devolve o item, e o cache é atualizado por `patch`, sem reler.
//
// | Operação       | O que faz                                              | Custo |
// | -------------- | ------------------------------------------------------ | ----: |
// | ProjectBoard   | projeto, opções do Status e 100 itens com o Status, o marco, o resumo das sub-issues e o PR que fecha a issue (CI e review) | ≈ 3 |
// | ProjectMove    | `updateProjectV2ItemFieldValue`, devolve o item         | 1     |
//
// O custo da ProjectBoard é estimado pela regra do GitHub, sem medir na API: cada página pede
// 1 (itens) + 100 (`closedByPullRequestsReferences(first: 1)`, um por item) + 100 (`commits(last: 1)`
// do PR que fecha cada issue) + 100 (`commits(last: 1)` do item que é PR; o GitHub conta os dois
// fragmentos, sem saber o tipo de cada item) = 301 nós, ÷ 100 ≈ 3 pontos por página de 100 itens. Sem o PR, a leitura gravada custou 1. Ainda é uma
// leitura só por página, e o TTL de 2 min não muda: com o quadro aberto, ~90 pontos por hora.

import { GITHUB_TTL, RateLimitedError, type GithubCache } from './cache.ts';
import { githubGraphql, GithubScopeError, requireGithubToken, resolveGithubToken, type GithubGraphqlSourceOptions } from './github-source.ts';
import { workKey, type CiState, type LinkedPullRequest, type PullRequestState, type ReviewDecision } from './work.ts';

/** Qual Project: dono (organização ou pessoa) e número, como na URL `.../projects/3`. */
export interface ProjectRef {
  owner: string;
  number: number;
  /** Campo de seleção que vira as raias. Padrão: `Status`. */
  field?: string;
}

export interface ProjectLane {
  /** Id da opção do campo; `null` na raia dos itens sem Status. */
  id: string | null;
  name: string;
  /** Cor do GitHub (`GRAY`, `GREEN`…); `null` na raia sem Status. */
  color: string | null;
}

export type ProjectItemKind = 'Issue' | 'PullRequest' | 'DraftIssue';

export interface ProjectCard {
  /** Id do item no Project (o que a mutação usa). */
  itemId: string;
  kind: ProjectItemKind;
  /** `dono/repo#número`; `null` num rascunho. */
  key: string | null;
  repo: string | null;
  number: number | null;
  title: string;
  url: string | null;
  /** `OPEN`, `CLOSED` ou `MERGED`; rascunho é `OPEN`. */
  state: string;
  updatedAt: string;
  /** Tipo de issue (`Epic`, `Tech Task`…); `null` se não tiver ou não for issue. */
  type: string | null;
  /** Chave do pai, se a issue tiver. */
  parent: string | null;
  /** Id da opção de Status; `null` sem Status. */
  statusId: string | null;
  /** Título do marco (milestone); `null` sem marco. Opcional: o cache de antes não tem. */
  milestone?: string | null;
  /** Resumo das sub-issues; `null` quando não tem filhas. */
  subIssues?: { total: number; completed: number } | null;
  /** O PR que fecha a issue (ou o próprio PR, num item que é PR), com CI e review; `null` sem PR. */
  pullRequest?: LinkedPullRequest | null;
}

export interface ProjectBoardValue {
  /** Id do Project (o que a mutação usa). */
  projectId: string;
  /** Id do campo das raias. */
  fieldId: string;
  field: string;
  title: string;
  url: string;
  /** Opções do campo, na ordem do Project. */
  options: ProjectLane[];
  /** Na ordem do Project. */
  items: ProjectCard[];
}

/** Resultado de mover: o quadro já atualizado e de que raia para qual o card foi. */
export interface ProjectMoveResult extends ProjectBoard {
  moved: { itemId: string; from: string | null; to: string | null };
}

export interface BoardLane extends ProjectLane {
  items: ProjectCard[];
}

export interface ProjectBoard {
  owner: string;
  number: number;
  title: string;
  url: string;
  field: string;
  /** Raias na ordem do Project; a de "Sem status" só aparece se houver item sem Status, e vem primeiro, como no GitHub. */
  lanes: BoardLane[];
  count: number;
  fetchedAt: number;
  stale: boolean;
  staleReason: string | null;
}

/** Porta da fonte do Project: o adaptador local chama o GitHub; o do hub (7.9) lerá de lá. */
export interface ProjectSource {
  board(ref: ProjectRef): Promise<ProjectBoardValue>;
  /** Muda o campo do item para a opção e devolve o Status que o GitHub gravou. */
  move(input: { projectId: string; itemId: string; fieldId: string; optionId: string; field: string }): Promise<{ itemId: string; statusId: string | null }>;
}

/** Até quantas páginas de 100 itens a leitura busca. */
export const MAX_PROJECT_PAGES = 5;
export const DEFAULT_PROJECT_FIELD = 'Status';
/** Nome da raia dos itens sem valor no campo. */
export const NO_STATUS_LANE = 'Sem status';

// Só o estado do CI do último commit: a contagem dos checks fica para o detalhe do card.
const LAST_CI = 'commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';
const CONTENT = `content { __typename
  ... on Issue { number title url state updatedAt repository { nameWithOwner } issueType { name } parent { number repository { nameWithOwner } }
    milestone { title } subIssuesSummary { total completed }
    closedByPullRequestsReferences(first: 1, includeClosedPrs: true) { nodes { number url state isDraft reviewDecision ${LAST_CI} } } }
  ... on PullRequest { number title url state updatedAt repository { nameWithOwner } milestone { title } isDraft reviewDecision ${LAST_CI} }
  ... on DraftIssue { title updatedAt } }`;
const STATUS_VALUE = '... on ProjectV2ItemFieldSingleSelectValue { optionId }';

export const PROJECT_QUERIES = {
  board: `query ProjectBoard($o: String!, $n: Int!, $f: String!, $after: String) { rateLimit { cost remaining resetAt }
  repositoryOwner(login: $o) { ... on ProjectV2Owner { projectV2(number: $n) { id title url
    field(name: $f) { ... on ProjectV2SingleSelectField { id name options { id name color } } }
    items(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
      nodes { id isArchived fieldValueByName(name: $f) { ${STATUS_VALUE} } ${CONTENT} } } } } } }`,
  move: `mutation ProjectMove($p: ID!, $i: ID!, $fid: ID!, $v: String!, $f: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $fid, value: { singleSelectOptionId: $v } }) {
    projectV2Item { id fieldValueByName(name: $f) { ${STATUS_VALUE} } } } }`,
} as const;

/** Mensagem para quando o token do `gh` não pode ler ou mexer no Project. */
export const PROJECT_SCOPE_HINT = 'o token do `gh` precisa do escopo `project`: rode `gh auth refresh -s project`';

export class ProjectPermissionError extends Error {
  constructor(detail: string) {
    super(`sem permissão no GitHub Project (${PROJECT_SCOPE_HINT}). ${detail}`);
    this.name = 'ProjectPermissionError';
  }
}

/** A opção pedida não existe no campo das raias. */
export class ProjectOptionUnknownError extends Error {
  constructor(field: string, optionId: string) {
    super(`opção de ${field} desconhecida: ${optionId}`);
    this.name = 'ProjectOptionUnknownError';
  }
}

/** O item pedido não está no Project (ou está arquivado). */
export class ProjectItemUnknownError extends Error {
  constructor(itemId: string) {
    super(`item fora do Project: ${itemId}`);
    this.name = 'ProjectItemUnknownError';
  }
}

// Formas cruas do GraphQL.
interface RawRepoRef {
  nameWithOwner: string;
}
interface RawLastCi {
  commits?: { nodes: { commit: { statusCheckRollup: { state: CiState } | null } }[] };
}
interface RawLinkedPr extends RawLastCi {
  number: number;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  reviewDecision: ReviewDecision | null;
}
interface RawContent extends RawLastCi {
  __typename: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  updatedAt?: string;
  repository?: RawRepoRef;
  issueType?: { name: string } | null;
  parent?: { number: number; repository?: RawRepoRef } | null;
  milestone?: { title: string } | null;
  subIssuesSummary?: { total: number; completed: number } | null;
  closedByPullRequestsReferences?: { nodes: RawLinkedPr[] } | null;
  isDraft?: boolean;
  reviewDecision?: ReviewDecision | null;
}
export interface RawProjectItem {
  id: string;
  isArchived: boolean;
  fieldValueByName: { optionId?: string } | null;
  content: RawContent | null;
}
interface RawProject {
  id: string;
  title: string;
  url: string;
  field: { id?: string; name?: string; options?: { id: string; name: string; color: string }[] } | null;
  items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawProjectItem[] };
}

const linkedPr = (p: RawLinkedPr): LinkedPullRequest => ({
  number: p.number,
  url: p.url,
  state: p.state,
  isDraft: p.isDraft,
  review: p.reviewDecision ?? null,
  ci: p.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
  checks: null,
});

/** O PR do card: o que fecha a issue; num item que é PR, ele mesmo. */
function pullRequestOf(c: RawContent): LinkedPullRequest | null {
  if (c.__typename === 'Issue') {
    const p = c.closedByPullRequestsReferences?.nodes[0];
    return p ? linkedPr(p) : null;
  }
  if (c.__typename === 'PullRequest' && c.number !== undefined && c.url && c.isDraft !== undefined)
    return linkedPr({ number: c.number, url: c.url, state: (c.state ?? 'OPEN') as PullRequestState, isDraft: c.isDraft, reviewDecision: c.reviewDecision ?? null, commits: c.commits });
  return null;
}

/** Item cru → card. Arquivado, sem conteúdo ou de tipo desconhecido fica de fora (`null`). */
export function toProjectCard(raw: RawProjectItem): ProjectCard | null {
  const c = raw.content;
  if (raw.isArchived || !c || !['Issue', 'PullRequest', 'DraftIssue'].includes(c.__typename)) return null;
  const repo = c.repository?.nameWithOwner ?? null;
  return {
    itemId: raw.id,
    kind: c.__typename as ProjectItemKind,
    key: repo && c.number !== undefined ? workKey(repo, c.number) : null,
    repo,
    number: c.number ?? null,
    title: c.title ?? '',
    url: c.url ?? null,
    state: c.state ?? 'OPEN',
    updatedAt: c.updatedAt ?? '',
    type: c.issueType?.name ?? null,
    parent: c.parent ? workKey(c.parent.repository?.nameWithOwner ?? repo ?? '', c.parent.number) : null,
    statusId: raw.fieldValueByName?.optionId ?? null,
    milestone: c.milestone?.title ?? null,
    subIssues: c.subIssuesSummary && c.subIssuesSummary.total > 0 ? { total: c.subIssuesSummary.total, completed: c.subIssuesSummary.completed } : null,
    pullRequest: pullRequestOf(c),
  };
}

/** Agrupa os itens nas raias, na ordem das opções; item com opção que sumiu cai em "Sem status". */
export function toLanes(value: ProjectBoardValue): BoardLane[] {
  const known = new Set(value.options.map((o) => o.id));
  const lanes: BoardLane[] = value.options.map((o) => ({ ...o, items: value.items.filter((i) => i.statusId === o.id) }));
  const none = value.items.filter((i) => !i.statusId || !known.has(i.statusId));
  return none.length ? [{ id: null, name: NO_STATUS_LANE, color: null, items: none }, ...lanes] : lanes;
}

const permission = (err: unknown): never => {
  if (err instanceof GithubScopeError) throw new ProjectPermissionError(err.message);
  if (err instanceof Error && /resource not accessible|must have (admin|write)|does not have permission|FORBIDDEN/i.test(err.message))
    throw new ProjectPermissionError(err.message);
  throw err;
};

/** Adaptador GraphQL do Project; a credencial vem do provedor (#241), a cada pedido. */
export class GithubProjectSource implements ProjectSource {
  private readonly opts: GithubGraphqlSourceOptions;

  constructor(opts: GithubGraphqlSourceOptions) {
    requireGithubToken(opts?.token);
    this.opts = opts;
  }

  async board({ owner, number, field = DEFAULT_PROJECT_FIELD }: ProjectRef): Promise<ProjectBoardValue> {
    let value: ProjectBoardValue | null = null;
    let after: string | null = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      type Data = { repositoryOwner: { projectV2?: RawProject | null } | null };
      const data: Data = await this.call<Data>('ProjectBoard', PROJECT_QUERIES.board, { o: owner, n: number, f: field, after });
      const p = data.repositoryOwner?.projectV2;
      if (!p) throw new Error(`Project não encontrado: ${owner}/${number}`);
      if (!p.field?.id || !p.field.options) throw new Error(`o Project ${owner}/${number} não tem o campo de seleção "${field}"`);
      value ??= {
        projectId: p.id,
        fieldId: p.field.id,
        field: p.field.name ?? field,
        title: p.title,
        url: p.url,
        options: p.field.options.map((o) => ({ id: o.id, name: o.name, color: o.color })),
        items: [],
      };
      for (const raw of p.items.nodes) {
        const card = toProjectCard(raw);
        if (card) value.items.push(card);
      }
      if (!p.items.pageInfo.hasNextPage) break;
      after = p.items.pageInfo.endCursor;
    }
    return value!;
  }

  async move({ projectId, itemId, fieldId, optionId, field }: Parameters<ProjectSource['move']>[0]) {
    type Data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: string; fieldValueByName: { optionId?: string } | null } | null } | null };
    const data = await this.call<Data>('ProjectMove', PROJECT_QUERIES.move, { p: projectId, i: itemId, fid: fieldId, v: optionId, f: field });
    const item = data.updateProjectV2ItemFieldValue?.projectV2Item;
    if (!item) throw new Error(`o GitHub não devolveu o item ${itemId}`);
    return { itemId: item.id, statusId: item.fieldValueByName?.optionId ?? null };
  }

  private async call<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await resolveGithubToken(this.opts.token);
    return githubGraphql<T>({ ...this.opts, token }, operation, query, variables).catch(permission);
  }
}

export interface GithubProjectOptions {
  source: ProjectSource;
  cache: GithubCache;
  project: ProjectRef;
  now?: () => number;
}

export const projectCacheKey = ({ owner, number, field = DEFAULT_PROJECT_FIELD }: ProjectRef) => `github:project:${owner}/${number}:${field}`;

/** O que o painel e o MCP usam para o kanban de um Project. */
export class GithubProject {
  readonly project: Required<ProjectRef>;
  private readonly source: ProjectSource;
  private readonly cache: GithubCache;
  private readonly now: () => number;

  constructor({ source, cache, project, now = Date.now }: GithubProjectOptions) {
    this.source = source;
    this.cache = cache;
    this.now = now;
    this.project = { field: DEFAULT_PROJECT_FIELD, ...project };
  }

  private get key(): string {
    return projectCacheKey(this.project);
  }

  /** O quadro, pelo cache (TTL de 2 min). `force` é o botão de atualizar (mínimo de 30 s). */
  async board({ force = false }: { force?: boolean } = {}): Promise<ProjectBoard> {
    const r = await this.cache.get<ProjectBoardValue>(this.key, GITHUB_TTL.project, async () => ({ value: await this.source.board(this.project) }), { force });
    return this.view(r.value, r.fetchedAt, r.stale, r.staleReason);
  }

  /**
   * The stored board, of any age up to 24 h, without calling GitHub (decision 0015): `stale` once it
   * is past the Project's TTL. `null` when nothing was ever stored.
   */
  async snapshot(): Promise<ProjectBoard | null> {
    const hit = await this.cache.peek<ProjectBoardValue>(this.key);
    if (!hit) return null;
    const old = this.now() - hit.fetchedAt > GITHUB_TTL.project;
    return this.view(hit.value, hit.fetchedAt, old, old ? 'o sincronismo em segundo plano ainda não releu o quadro' : null);
  }

  /**
   * Move um card para a raia `optionId`: uma mutação, e o cache é atualizado com o que ela
   * devolveu, sem reler. Só lê o Project se ainda não houver nada no cache.
   */
  async move(itemId: string, optionId: string): Promise<ProjectMoveResult> {
    const wait = this.cache.pauseLeftMs();
    if (wait > 0) throw new RateLimitedError('GitHub limitou as chamadas; tente de novo em instantes', wait);
    if (!(await this.cache.peek(this.key))) await this.board();
    const cur = (await this.cache.peek<ProjectBoardValue>(this.key))!.value;
    if (!cur.options.some((o) => o.id === optionId)) throw new ProjectOptionUnknownError(this.project.field, optionId);
    const before = cur.items.find((i) => i.itemId === itemId);
    if (!before) throw new ProjectItemUnknownError(itemId);
    const from = before.statusId && cur.options.some((o) => o.id === before.statusId) ? before.statusId : null;
    let moved: { itemId: string; statusId: string | null };
    try {
      moved = await this.source.move({ projectId: cur.projectId, itemId, fieldId: cur.fieldId, optionId, field: this.project.field });
    } catch (err) {
      if (err instanceof RateLimitedError) this.cache.pause(err.retryAfterMs);
      throw err;
    }
    await this.cache.patch<ProjectBoardValue>(this.key, (v) => ({
      ...v,
      items: v.items.map((i) => (i.itemId === moved.itemId ? { ...i, statusId: moved.statusId } : i)),
    }));
    const after = (await this.cache.peek<ProjectBoardValue>(this.key))!;
    return { ...this.view(after.value, after.fetchedAt, false, null), moved: { itemId: moved.itemId, from, to: moved.statusId } };
  }

  /** Quanto falta da pausa por limite do GitHub (0 se não há): o `Retry-After` da API. */
  pauseLeftMs(): number {
    return this.cache.pauseLeftMs();
  }

  private view(value: ProjectBoardValue, fetchedAt: number, stale: boolean, staleReason: string | null): ProjectBoard {
    return {
      owner: this.project.owner,
      number: this.project.number,
      title: value.title,
      url: value.url,
      field: value.field,
      lanes: toLanes(value),
      count: value.items.length,
      fetchedAt,
      stale,
      staleReason,
    };
  }
}

export interface CreateGithubProjectOptions extends Partial<GithubGraphqlSourceOptions> {
  project: ProjectRef;
  cache: GithubCache;
}

/** Monta o kanban do Project com o adaptador GraphQL, sobre o cache dado; `token` é o provedor da credencial (#241). */
export function createGithubProject({ project, cache, token, ...rest }: CreateGithubProjectOptions): GithubProject {
  return new GithubProject({ source: new GithubProjectSource({ token: requireGithubToken(token), ...rest }), cache, project, ...(rest.now ? { now: rest.now } : {}) });
}
