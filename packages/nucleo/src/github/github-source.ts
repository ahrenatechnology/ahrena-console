// Adaptador local da fonte do trabalho: GraphQL do GitHub, com consultas rasas e medidas
// no spike #40. Nenhuma consulta aninha pais e filhas; todas são em série.
//
// | Consulta       | O que traz                                         | Custo |
// | -------------- | -------------------------------------------------- | ----: |
// | WorkShallow    | 100 issues da busca, chave do pai, resumo das filhas | 1     |
// | WorkNodes      | issues por chave, com 2 níveis de pai (só campos rasos) | 1  |
// | WorkChildren   | até 50 filhas, cada uma com PR, CI e review         | ≤ 4   |
// | WorkDetail     | PR, CI e review de um card                          | 1     |
// | WorkIssue      | one issue's detail: body, comments, parents, sub-issues, PR (#506) | 1 |

import { execFile } from 'node:child_process';
import { backoffMs, RateLimitedError } from './cache.ts';
import type { ChildrenResult, WorkSource } from './source.ts';
import {
  isPlan,
  isPlanStep,
  WorkIssueForbiddenError,
  WorkIssueRefusedError,
  WorkIssueWrittenUnreadError,
  type WorkIssueComment,
  type WorkIssueCurrent,
  type WorkIssueEdit,
  type WorkIssuePullRequest,
  type WorkIssueRead,
  type WorkIssueRef,
  type WorkIssueSource,
  type WorkIssueWriter,
  WorkIssueNotRemovedError,
} from './work-issue.ts';
import {
  parseWorkKey,
  stageOf,
  workKey,
  type CiState,
  type IssueState,
  type CiCounts,
  type LinkedPullRequest,
  type PullRequestState,
  type ReviewDecision,
  type WorkDetail,
  type WorkNode,
} from './work.ts';
import { deltaQuery } from './tree.ts';
import { OPTIONS_LIMITS, type WorkIssueOptions, type WorkIssueOptionsSource } from './work-issue-options.ts';

export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
/** #533 the deadline of one GitHub call; a call that outlives it fails as a timeout (`network` for the reason codes). */
export const GITHUB_TIMEOUT_MS = 30_000;

const LEAN = `number title url state updatedAt repository { nameWithOwner } issueType { name }
  subIssuesSummary { total completed percentCompleted } parent { number repository { nameWithOwner } }`;
// A contagem por estado custa o mesmo que o estado: nenhuma checagem é listada.
const CHECKS = 'contexts(first: 1) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } }';
const PRS = `closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { number url state isDraft reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state ${CHECKS} } } } } } }`;
// #506 the issue detail: the same PR read with its title, up to 3 parents (initiative > epic > item) and the first 50 sub-issues and comments.
const REF = 'number title url state stateReason repository { nameWithOwner } issueType { name }';
const DETAIL_PRS = `closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { number title url state isDraft reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state ${CHECKS} } } } } } }`;
const RATE = 'rateLimit { cost remaining resetAt }';

export const QUERIES = {
  shallow: `query WorkShallow($q: String!, $after: String) { ${RATE}
  search(query: $q, type: ISSUE, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on Issue { ${LEAN} } } } }`,
  children: `query WorkChildren($o: String!, $r: String!, $n: Int!) { ${RATE}
  repository(owner: $o, name: $r) { issue(number: $n) { subIssues(first: 50) { totalCount nodes { ${LEAN} ${PRS} } } } } }`,
  detail: `query WorkDetail($o: String!, $r: String!, $n: Int!) { ${RATE}
  repository(owner: $o, name: $r) { issue(number: $n) { number state repository { nameWithOwner } ${PRS} } } }`,
  issue: `query WorkIssue($o: String!, $r: String!, $n: Int!) { ${RATE}
  repository(owner: $o, name: $r) { issue(number: $n) { ${REF} updatedAt body labels(first: 50) { nodes { name } } milestone { title }
    comments(first: 50) { totalCount nodes { author { login } createdAt body } }
    parent { ${REF} parent { ${REF} parent { ${REF} } } }
    subIssues(first: 50) { nodes { ${REF} updatedAt } } ${DETAIL_PRS} } } }`,
  // #590 a repository's issue options, one query, each list bounded by `OPTIONS_LIMITS`: the labels, issue types and open
  // milestones (the write matches a milestone by title), and the most recently updated open issues as parent candidates.
  options: `query WorkIssueOptions($o: String!, $r: String!) { ${RATE}
  repository(owner: $o, name: $r) { labels(first: ${OPTIONS_LIMITS.labels}) { nodes { name } } issueTypes(first: ${OPTIONS_LIMITS.types}) { nodes { name } }
    milestones(first: ${OPTIONS_LIMITS.milestones}, states: [OPEN]) { nodes { title } }
    issues(first: ${OPTIONS_LIMITS.parents}, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title repository { nameWithOwner } } } } }`,
} as const;

/**
 * #533 the issue write: the ids an edit names are resolved first (nothing is written when one is unknown), then
 * `updateIssue` writes the fields, `addSubIssue`/`removeSubIssue` the parent and `addComment` the comment.
 */
export const WRITE_QUERIES = {
  current: `query WorkIssueCurrent($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) { issue(number: $n) { title body updatedAt } } }`,
  id: `query WorkIssueId($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) { issue(number: $n) { id } } }`,
  update: `mutation UpdateWorkIssue($input: UpdateIssueInput!) { updateIssue(input: $input) { issue { id } } }`,
  addParent: `mutation AddWorkIssueParent($input: AddSubIssueInput!) { addSubIssue(input: $input) { issue { id } } }`,
  removeParent: `mutation RemoveWorkIssueParent($input: RemoveSubIssueInput!) { removeSubIssue(input: $input) { issue { id } } }`,
  // #534 the issue's sub-issues in GitHub's order, with what a step's checks need: ids, version, type and why it is closed.
  steps: `query WorkPlanSteps($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) { id issueTypes(first: 100) { nodes { id name } }
    issue(number: $n) { id subIssues(first: 50) { nodes { id ${REF} body updatedAt } } } } }`,
  createStep: `mutation CreateWorkPlanStep($input: CreateIssueInput!) { createIssue(input: $input) { issue { id } } }`,
  closeStep: `mutation CloseWorkPlanStep($input: CloseIssueInput!) { closeIssue(input: $input) { issue { id } } }`,
  reopenStep: `mutation ReopenWorkPlanStep($input: ReopenIssueInput!) { reopenIssue(input: $input) { issue { id } } }`,
  moveStep: `mutation MoveWorkPlanStep($input: ReprioritizeSubIssueInput!) { reprioritizeSubIssue(input: $input) { issue { id } } }`,
  comment: `mutation AddWorkIssueComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id } } } }`,
} as const;

/**
 * #533 the ids an edit names, in one query: the issue and its viewer permission always; each requested label by its
 * own name (`l0`, `l1`... so a label on any page is found), the issue types (one page of 100, an org has few) when
 * the edit sets a type, and the milestones whose title matches `$m` in any state when it sets a milestone.
 */
export function targetsQuery(edit: { labels?: readonly string[]; type?: string | null; milestone?: string | null }): string {
  const labels = edit.labels ?? [];
  const vars = ['$o: String!', '$r: String!', '$n: Int!', ...labels.map((_, i) => `$l${i}: String!`), ...(typeof edit.milestone === 'string' ? ['$m: String!'] : [])];
  const fields = [
    'id',
    'issue(number: $n) { id viewerCanUpdate parent { id } }',
    ...labels.map((_, i) => `l${i}: label(name: $l${i}) { id name }`),
    ...(typeof edit.type === 'string' ? ['issueTypes(first: 100) { nodes { id name } }'] : []),
    ...(typeof edit.milestone === 'string' ? ['milestones(first: 100, query: $m, states: [OPEN, CLOSED]) { nodes { id title } }'] : []),
  ];
  return `query WorkIssueTargets(${vars.join(', ')}) {\n  repository(owner: $o, name: $r) { ${fields.join(' ')} } }`;
}

/** Até quantas chaves cabem numa consulta de lote. */
export const NODES_BATCH = 50;
/** Até quantas páginas de 100 a leitura rasa busca. */
export const MAX_SHALLOW_PAGES = 5;

export function nodesQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$o${i}: String!, $r${i}: String!, $n${i}: Int!`).join(', ');
  const body = Array.from(
    { length: count },
    (_, i) => `i${i}: repository(owner: $o${i}, name: $r${i}) { issue(number: $n${i}) { ${LEAN} parent { ${LEAN} parent { ${LEAN} } } } }`,
  ).join('\n  ');
  return `query WorkNodes(${vars}) { ${RATE}\n  ${body} }`;
}

// Formas cruas do GraphQL.
interface RawRepoRef {
  nameWithOwner: string;
}
interface RawPr {
  number: number;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  reviewDecision: ReviewDecision | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: CiState; contexts?: RawChecks } | null } }[] };
}
interface RawChecks {
  totalCount: number;
  checkRunCountsByState?: { state: string; count: number }[];
  statusContextCountsByState?: { state: string; count: number }[];
}

// Os estados de um check run e de um status: o que passou, o que falhou; o resto ainda roda.
const CHECK_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_FALHOU = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'STALE']);

export function contarChecks(raw: RawChecks | null | undefined): CiCounts | null {
  if (!raw || !(raw.totalCount > 0)) return null;
  let ok = 0;
  let falhas = 0;
  for (const { state, count } of [...(raw.checkRunCountsByState ?? []), ...(raw.statusContextCountsByState ?? [])]) {
    if (CHECK_OK.has(state)) ok += count;
    else if (CHECK_FALHOU.has(state)) falhas += count;
  }
  return { total: raw.totalCount, ok, falhas, rodando: Math.max(0, raw.totalCount - ok - falhas) };
}
export interface RawIssue {
  number: number;
  title: string;
  url: string;
  state: IssueState;
  updatedAt: string;
  repository: RawRepoRef;
  issueType?: { name: string } | null;
  subIssuesSummary?: { total: number; completed: number; percentCompleted: number } | null;
  parent?: (Partial<RawIssue> & { number: number; repository?: RawRepoRef }) | null;
  closedByPullRequestsReferences?: { nodes: RawPr[] };
}

export function toWorkNode(raw: RawIssue): WorkNode {
  const repo = raw.repository.nameWithOwner;
  const s = raw.subIssuesSummary;
  return {
    key: workKey(repo, raw.number),
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    updatedAt: raw.updatedAt,
    type: raw.issueType?.name ?? null,
    parent: raw.parent ? workKey(raw.parent.repository?.nameWithOwner ?? repo, raw.parent.number) : null,
    progress: s && s.total > 0 ? { total: s.total, completed: s.completed, percent: s.percentCompleted } : null,
  };
}

export function toPullRequests(raw: Pick<RawIssue, 'closedByPullRequestsReferences'>): LinkedPullRequest[] {
  return (raw.closedByPullRequestsReferences?.nodes ?? []).map((p) => ({
    number: p.number,
    url: p.url,
    state: p.state,
    isDraft: p.isDraft,
    review: p.reviewDecision ?? null,
    ci: p.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    checks: contarChecks(p.commits?.nodes[0]?.commit.statusCheckRollup?.contexts),
  }));
}

export function toWorkDetail(raw: Pick<RawIssue, 'number' | 'state' | 'repository' | 'closedByPullRequestsReferences'>): WorkDetail {
  const pullRequests = toPullRequests(raw);
  return { key: workKey(raw.repository.nameWithOwner, raw.number), state: raw.state, pullRequests, stage: stageOf(raw.state, pullRequests) };
}

interface RawRef {
  updatedAt?: string;
  number: number;
  title: string;
  url: string;
  state: IssueState;
  stateReason?: string | null;
  repository: RawRepoRef;
  issueType?: { name: string } | null;
  parent?: RawRef | null;
}
interface RawIssueDetail extends RawRef {
  updatedAt: string;
  body: string;
  labels: { nodes: { name: string }[] };
  milestone: { title: string } | null;
  comments: { totalCount: number; nodes: { author: { login: string } | null; createdAt: string; body: string }[] };
  subIssues: { nodes: RawRef[] };
  closedByPullRequestsReferences?: { nodes: (RawPr & { title: string })[] };
}

const toIssueRef = (r: RawRef): WorkIssueRef => ({
  key: workKey(r.repository.nameWithOwner, r.number),
  repo: r.repository.nameWithOwner,
  number: r.number,
  title: r.title,
  url: r.url,
  state: r.state,
  type: r.issueType?.name ?? null,
  stateReason: r.stateReason ?? null,
  ...(r.updatedAt !== undefined ? { updatedAt: r.updatedAt } : {}),
});

/** #506 the raw detail of one issue as the port's read; the parents come nearest first. */
export function toWorkIssueRead(raw: RawIssueDetail): WorkIssueRead {
  const parentChain: WorkIssueRef[] = [];
  for (let p = raw.parent; p; p = p.parent) parentChain.push(toIssueRef(p));
  const titles = (raw.closedByPullRequestsReferences?.nodes ?? []).map((p) => p.title);
  const pullRequests: WorkIssuePullRequest[] = toPullRequests(raw).map((p, i) => ({ ...p, title: titles[i] ?? '' }));
  const comments: WorkIssueComment[] = raw.comments.nodes.map((c) => ({ author: c.author?.login ?? null, createdAt: c.createdAt, body: c.body }));
  return {
    ...toIssueRef(raw),
    updatedAt: raw.updatedAt,
    labels: raw.labels.nodes.map((l) => l.name),
    milestone: raw.milestone?.title ?? null,
    body: raw.body,
    comments,
    commentsTotal: raw.comments.totalCount,
    parentChain,
    subIssues: raw.subIssues.nodes.map(toIssueRef),
    pullRequests,
  };
}

export interface QueryCost {
  operation: string;
  cost: number;
  remaining: number;
}

/**
 * A GitHub credential: a fixed string (tests, demo) or the provider's function (#241: the
 * connection's `token()`), asked on every request. The provider caches; the sources never do.
 */
export type GithubToken = string | (() => Promise<string>);

/** What a GitHub-backed service needs to reach GitHub (#241): the credential provider and, for tests and the demo, the transport. */
export interface GithubAccess {
  token: GithubToken;
  fetch?: typeof fetch;
  /** GraphQL endpoint. */
  url?: string;
  /** REST base. */
  api?: string;
}

/** Fails early when a source is built without a credential provider (there is no `gh` default any more). */
export function requireGithubToken(token: GithubToken | undefined): GithubToken {
  if (typeof token !== 'string' && typeof token !== 'function') throw new TypeError('GitHub source without a token provider');
  return token;
}

/** The credential for one request. */
export async function resolveGithubToken(token: GithubToken): Promise<string> {
  return typeof token === 'string' ? token : token();
}

export interface GithubGraphqlSourceOptions {
  /** The credential provider (#241), asked on every request. */
  token: GithubToken;
  fetch?: typeof fetch;
  url?: string;
  now?: () => number;
  /** Chamado a cada consulta com o custo que o GitHub cobrou. */
  onCost?: (cost: QueryCost) => void;
  /** Waits between retries of a 502/503/504 (tests make it instant). Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** #533 the deadline of one call; default `GITHUB_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface GraphqlError {
  type?: string;
  message: string;
  path?: unknown[];
}

export class GithubGraphqlSource implements WorkSource, WorkIssueSource, WorkIssueOptionsSource, WorkIssueWriter {
  private readonly opts: GithubGraphqlSourceOptions;

  constructor(opts: GithubGraphqlSourceOptions) {
    requireGithubToken(opts?.token);
    this.opts = opts;
  }

  async listShallow(filter: string, since?: number): Promise<WorkNode[]> {
    const q = since === undefined ? filter : deltaQuery(filter, since);
    const out: WorkNode[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_SHALLOW_PAGES; page++) {
      type Data = { search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Partial<RawIssue>[] } };
      const data: Data = await this.query<Data>('WorkShallow', QUERIES.shallow, { q, after });
      // PR na busca vem como objeto vazio (`... on Issue`).
      for (const n of data.search.nodes) if (n.number !== undefined) out.push(toWorkNode(n as RawIssue));
      if (!data.search.pageInfo.hasNextPage) break;
      after = data.search.pageInfo.endCursor;
    }
    return out;
  }

  async nodes(keys: readonly string[]): Promise<WorkNode[]> {
    const out = new Map<string, WorkNode>();
    for (let i = 0; i < keys.length; i += NODES_BATCH) {
      const batch = keys.slice(i, i + NODES_BATCH).map(parseWorkKey);
      const vars: Record<string, unknown> = {};
      batch.forEach((k, j) => Object.assign(vars, { [`o${j}`]: k.owner, [`r${j}`]: k.name, [`n${j}`]: k.number }));
      const data = await this.query<Record<string, { issue: RawIssue | null } | null>>('WorkNodes', nodesQuery(batch.length), vars, {
        tolerateNotFound: true,
      });
      for (let j = 0; j < batch.length; j++) {
        // Sobe a cadeia: a issue e os pais que vieram junto, cada um raso.
        let raw: Partial<RawIssue> | null | undefined = data[`i${j}`]?.issue;
        let fallbackRepo = batch[j].repo;
        while (raw && raw.title !== undefined) {
          const full = { ...raw, repository: raw.repository ?? { nameWithOwner: fallbackRepo } } as RawIssue;
          const node = toWorkNode(full);
          if (!out.has(node.key)) out.set(node.key, node);
          fallbackRepo = full.repository.nameWithOwner;
          raw = raw.parent as Partial<RawIssue> | null | undefined;
        }
      }
    }
    return [...out.values()];
  }

  async children(key: string): Promise<ChildrenResult> {
    const k = parseWorkKey(key);
    type Data = { repository: { issue: { subIssues: { nodes: RawIssue[] } } | null } | null };
    const data = await this.query<Data>('WorkChildren', QUERIES.children, { o: k.owner, r: k.name, n: k.number });
    const raws = data.repository?.issue?.subIssues.nodes ?? [];
    return {
      // A filha sempre aponta para quem a expandiu, mesmo que o pai não tenha vindo no campo.
      children: raws.map((r) => ({ ...toWorkNode(r), parent: key })),
      details: raws.map(toWorkDetail),
    };
  }

  async detail(key: string): Promise<WorkDetail> {
    const k = parseWorkKey(key);
    type Data = { repository: { issue: RawIssue | null } | null };
    const data = await this.query<Data>('WorkDetail', QUERIES.detail, { o: k.owner, r: k.name, n: k.number });
    const issue = data.repository?.issue;
    if (!issue) throw new Error(`issue não encontrada: ${key}`);
    return toWorkDetail(issue);
  }

  /** #506 one issue's detail in one query; `null` when GitHub has no such issue. */
  async issue(key: string): Promise<WorkIssueRead | null> {
    const k = parseWorkKey(key);
    type Data = { repository: { issue: RawIssueDetail | null } | null };
    const data = await this.query<Data>('WorkIssue', QUERIES.issue, { o: k.owner, r: k.name, n: k.number }, { tolerateNotFound: true });
    const issue = data.repository?.issue;
    return issue ? toWorkIssueRead(issue) : null;
  }

  /** #590 the repository's labels, issue types, open milestones and parent candidates; `null` when GitHub has no such repository. */
  async options(repo: string): Promise<WorkIssueOptions | null> {
    const [owner, name] = repo.split('/') as [string, string];
    type Nodes<T> = { nodes: T[] } | null;
    type Data = {
      repository: {
        labels: Nodes<{ name: string }>;
        issueTypes: Nodes<{ name: string }>;
        milestones: Nodes<{ title: string }>;
        issues: Nodes<{ number: number; title: string; repository: { nameWithOwner: string } }>;
      } | null;
    };
    const data = await this.query<Data>('WorkIssueOptions', QUERIES.options, { o: owner, r: name }, { tolerateNotFound: true });
    const r = data.repository;
    if (!r) return null;
    return {
      labels: (r.labels?.nodes ?? []).map((l) => l.name),
      types: (r.issueTypes?.nodes ?? []).map((t) => t.name),
      milestones: (r.milestones?.nodes ?? []).map((m) => m.title),
      parents: (r.issues?.nodes ?? []).map((i) => ({ key: workKey(i.repository.nameWithOwner, i.number), title: i.title })),
    };
  }

  /** #533 the title, body and `updatedAt` GitHub holds now; `null` when GitHub has no such issue. */
  async current(key: string): Promise<WorkIssueCurrent | null> {
    const k = parseWorkKey(key);
    type Data = { repository: { issue: WorkIssueCurrent | null } | null };
    const data = await this.query<Data>('WorkIssueCurrent', WRITE_QUERIES.current, { o: k.owner, r: k.name, n: k.number }, { tolerateNotFound: true });
    const issue = data.repository?.issue;
    return issue ? { title: issue.title, body: issue.body, updatedAt: issue.updatedAt } : null;
  }

  /**
   * #533 writes the fields of `edit` and answers the issue as GitHub holds it. The ids the edit names (labels,
   * type, milestone, parent) are resolved before the first write: an unknown one is `WorkIssueRefusedError` and
   * nothing is written; a credential that cannot update the issue is `WorkIssueForbiddenError`. The fields go
   * in one `updateIssue`; the parent, when it is in the edit, in a second call (the route (#533) lets a parent
   * come alone, so a failed second call never leaves a half-written save).
   */
  async update(key: string, edit: WorkIssueEdit): Promise<WorkIssueRead | null> {
    const k = parseWorkKey(key);
    type Named<N extends string> = { id: string } & { [P in N]: string };
    type Targets = {
      repository: ({
        issue: { id: string; viewerCanUpdate: boolean; parent: { id: string } | null } | null;
        issueTypes?: { nodes: Named<'name'>[] };
        milestones?: { nodes: Named<'title'>[] };
      } & { [alias: `l${number}`]: Named<'name'> | null }) | null;
    };
    const labelNames = edit.labels ?? [];
    const variables: Record<string, unknown> = { o: k.owner, r: k.name, n: k.number };
    labelNames.forEach((name, i) => (variables[`l${i}`] = name));
    if (typeof edit.milestone === 'string') variables.m = edit.milestone;
    const data = await this.query<Targets>('WorkIssueTargets', targetsQuery(edit), variables, { tolerateNotFound: true });
    const repo = data.repository;
    const issue = repo?.issue;
    if (!repo || !issue) return null;
    if (!issue.viewerCanUpdate) throw new WorkIssueForbiddenError(key);

    const fields: Record<string, unknown> = { id: issue.id };
    if (edit.title !== undefined) fields.title = edit.title;
    if (edit.body !== undefined) fields.body = edit.body;
    if (edit.labels !== undefined) {
      fields.labelIds = labelNames.map((name, i) => {
        const found = repo[`l${i}`];
        if (!found) throw new WorkIssueRefusedError('labels', name);
        return found.id;
      });
    }
    if (edit.type !== undefined) {
      const found = edit.type === null ? null : (repo.issueTypes?.nodes ?? []).find((t) => t.name === edit.type);
      if (found === undefined) throw new WorkIssueRefusedError('type', edit.type!);
      fields.issueTypeId = found?.id ?? null;
    }
    if (edit.milestone !== undefined) {
      const found = edit.milestone === null ? null : (repo.milestones?.nodes ?? []).find((m) => m.title === edit.milestone);
      if (found === undefined) throw new WorkIssueRefusedError('milestone', edit.milestone!);
      fields.milestoneId = found?.id ?? null;
    }
    let parentId: string | null | undefined;
    if (typeof edit.parent === 'string') {
      parentId = await this.issueId(edit.parent);
      if (parentId === null) throw new WorkIssueRefusedError('parent', edit.parent);
    }

    if (Object.keys(fields).length > 1) await this.mutate('UpdateWorkIssue', WRITE_QUERIES.update, { input: fields });
    if (parentId) await this.mutate('AddWorkIssueParent', WRITE_QUERIES.addParent, { input: { issueId: parentId, subIssueId: issue.id, replaceParent: true } });
    else if (edit.parent === null && issue.parent) await this.mutate('RemoveWorkIssueParent', WRITE_QUERIES.removeParent, { input: { issueId: issue.parent.id, subIssueId: issue.id } });
    return this.readBack(key);
  }

  /** #533 adds a comment and answers the issue as GitHub holds it; `null` when GitHub has no such issue. */
  async comment(key: string, body: string): Promise<WorkIssueRead | null> {
    const id = await this.issueId(key);
    if (id === null) return null;
    await this.mutate('AddWorkIssueComment', WRITE_QUERIES.comment, { input: { subjectId: id, body } });
    return this.readBack(key);
  }

  /**
   * #534 the issue's sub-issues as GitHub holds them now, one fresh read, and the step among them when `step` is given,
   * found with no state check: absent, `WorkIssueRefusedError` `step` and nothing is written. Each caller applies its own
   * check on the step (`requirePlanStep`, `requireRemovedStep`). `null`: no such issue.
   */
  private async loadSteps(parent: string, step?: string) {
    const k = parseWorkKey(parent);
    type Node = RawRef & { id: string; body: string; updatedAt: string };
    type Data = { repository: { id: string; issueTypes: { nodes: { id: string; name: string }[] }; issue: { id: string; subIssues: { nodes: Node[] } } | null } | null };
    const data = await this.query<Data>('WorkPlanSteps', WRITE_QUERIES.steps, { o: k.owner, r: k.name, n: k.number }, { tolerateNotFound: true });
    const repo = data.repository;
    if (!repo?.issue) return null;
    const subs = repo.issue.subIssues.nodes;
    const find = (key: string) => subs.find((node) => toIssueRef(node).key.toLowerCase() === key.toLowerCase());
    const found = step === undefined ? undefined : find(step);
    if (step !== undefined && !found) throw new WorkIssueRefusedError('step', step);
    return { repoId: repo.id, parentId: repo.issue.id, types: repo.issueTypes.nodes, subs, step: found, find };
  }

  /** #534 the step of an edit, a removal, a move or a read: a Plan sub-issue not closed as not planned, else `WorkIssueRefusedError` `step`. */
  private requirePlanStep<T extends RawRef>(found: T | undefined, step: string): T {
    if (!found || !isPlanStep(toIssueRef(found))) throw new WorkIssueRefusedError('step', step);
    return found;
  }

  /** #534 the step of a restore: a Plan sub-issue closed as not planned; a Plan one that is not, is `WorkIssueNotRemovedError`. */
  private requireRemovedStep<T extends RawRef>(found: T | undefined, step: string): T {
    if (!found || !isPlan(toIssueRef(found).type)) throw new WorkIssueRefusedError('step', step);
    if (isPlanStep(toIssueRef(found))) throw new WorkIssueNotRemovedError(step);
    return found;
  }

  /** #534 the title, body and `updatedAt` of the step GitHub holds now. */
  async stepCurrent(parent: string, step: string): Promise<WorkIssueCurrent | null> {
    const loaded = await this.loadSteps(parent, step);
    if (!loaded) return null;
    const found = this.requirePlanStep(loaded.step, step);
    return { title: found.title, body: found.body, updatedAt: found.updatedAt };
  }

  /** #534 one `updateIssue` on the step, then the parent read back. */
  async editStep(parent: string, step: string, edit: { title?: string; body?: string }): Promise<WorkIssueRead | null> {
    const loaded = await this.loadSteps(parent, step);
    if (!loaded) return null;
    const found = this.requirePlanStep(loaded.step, step);
    await this.mutate('UpdateWorkIssue', WRITE_QUERIES.update, { input: { id: found.id,...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.body !== undefined ? { body: edit.body } : {}) } });
    return this.readBack(parent);
  }

  /** #534 one `createIssue` of the Plan type with the parent: the new step is the last sub-issue. */
  async addStep(parent: string, step: { title: string; body: string }): Promise<WorkIssueRead | null> {
    const loaded = await this.loadSteps(parent);
    if (!loaded) return null;
    const plan = loaded.types.find((t) => t.name === 'Plan');
    if (!plan) throw new WorkIssueRefusedError('type', 'Plan');
    await this.mutate('CreateWorkPlanStep', WRITE_QUERIES.createStep, { input: { repositoryId: loaded.repoId, title: step.title, body: step.body, issueTypeId: plan.id, parentIssueId: loaded.parentId } });
    return this.readBack(parent);
  }

  /** #534 closes the step as not planned: the read then leaves it out of the plan. */
  async removeStep(parent: string, step: string): Promise<WorkIssueRead | null> {
    const loaded = await this.loadSteps(parent, step);
    if (!loaded) return null;
    const found = this.requirePlanStep(loaded.step, step);
    await this.mutate('CloseWorkPlanStep', WRITE_QUERIES.closeStep, { input: { issueId: found.id, stateReason: 'NOT_PLANNED' } });
    return this.readBack(parent);
  }

  /** #534 reopens the step closed as not planned: the read then puts it back in the plan. */
  async restoreStep(parent: string, step: string): Promise<WorkIssueRead | null> {
    const loaded = await this.loadSteps(parent, step);
    if (!loaded) return null;
    const found = this.requireRemovedStep(loaded.step, step);
    await this.mutate('ReopenWorkPlanStep', WRITE_QUERIES.reopenStep, { input: { issueId: found.id } });
    return this.readBack(parent);
  }

  /** #534 `reprioritizeSubIssue` behind `after`, or before the first sub-issue for the top; a step already on top is left alone. */
  async moveStep(parent: string, step: string, after: string | null): Promise<WorkIssueRead | null> {
    const loaded = await this.loadSteps(parent, step);
    if (!loaded) return null;
    const found = this.requirePlanStep(loaded.step, step);
    const afterNode = typeof after === 'string' ? loaded.find(after) : undefined;
    if (typeof after === 'string' && !afterNode) throw new WorkIssueRefusedError('after', after);
    const first = loaded.subs[0]!;
    const input = { issueId: loaded.parentId, subIssueId: found.id, ...(afterNode ? { afterId: afterNode.id } : { beforeId: first.id }) };
    if (afterNode || first.id !== found.id) await this.mutate('MoveWorkPlanStep', WRITE_QUERIES.moveStep, { input });
    return this.readBack(parent);
  }

  /** #533 the write is applied: a failure of this read is `WorkIssueWrittenUnreadError`, never "not written". */
  private async readBack(key: string): Promise<WorkIssueRead | null> {
    try {
      return await this.issue(key);
    } catch (err) {
      throw new WorkIssueWrittenUnreadError(key, err);
    }
  }

  private async issueId(key: string): Promise<string | null> {
    const k = parseWorkKey(key);
    type Data = { repository: { issue: { id: string } | null } | null };
    const data = await this.query<Data>('WorkIssueId', WRITE_QUERIES.id, { o: k.owner, r: k.name, n: k.number }, { tolerateNotFound: true });
    return data.repository?.issue?.id ?? null;
  }

  private async query<T>(operation: string, query: string, variables: Record<string, unknown>, { tolerateNotFound = false } = {}): Promise<T> {
    const token = await resolveGithubToken(this.opts.token);
    // #533 a fresh deadline per try: a timeout is not a gateway error and is not retried.
    return retryOnGateway(() => githubGraphql<T>({ ...this.opts, token }, operation, query, variables, { tolerateNotFound, signal: this.deadline() }), { sleep: this.opts.sleep });
  }

  /** #533 a mutation is never retried: a 502 may have been applied on GitHub's side (see `retryOnGateway`). */
  private async mutate<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await resolveGithubToken(this.opts.token);
    return githubGraphql<T>({ ...this.opts, token }, operation, query, variables, { signal: this.deadline() });
  }

  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.opts.timeoutMs ?? GITHUB_TIMEOUT_MS);
  }
}

/** O token não tem o escopo que a operação pede (ex.: `project` para mover um card). */
export class GithubScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubScopeError';
  }
}

/**
 * GitHub answered 502, 503 or 504: on the GraphQL API this is usually a query that took longer than
 * GitHub's ~10 s limit (too many nodes in one request), sometimes a passing outage.
 */
export class GithubGatewayError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GithubGatewayError';
    this.status = status;
  }
}

/** Any other answer that is not 2xx: 401, 403 and 404 refuse; a 500 is GitHub failing (#340). */
export class GithubHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GithubHttpError';
    this.status = status;
  }
}

/** Waits before each retry of a 502/503/504 read; after the last one the error goes up. */
export const GATEWAY_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs a read and repeats it on `GithubGatewayError`, waiting `delaysMs` between tries. `attempt`
 * gets the try number (0 first), so a paged read can ask for a smaller page each time. Only for
 * queries: a mutation that timed out on GitHub's side may have been applied.
 */
export async function retryOnGateway<T>(
  attempt: (n: number) => Promise<T>,
  { delaysMs = GATEWAY_RETRY_DELAYS_MS, sleep = sleepFor }: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (!(err instanceof GithubGatewayError) || n >= delaysMs.length) throw err;
      await sleep(delaysMs[n]);
    }
  }
}

/**
 * O GitHub respondeu 200 com `errors` do GraphQL (FORBIDDEN de uma organização com SAML, por exemplo):
 * a falha é de parte da consulta, não do transporte. `paths` traz o primeiro trecho de cada erro.
 */
export class GraphqlResponseError extends Error {
  readonly paths: string[];
  /** #533 the GraphQL `type` of each error (`FORBIDDEN`, `NOT_FOUND`...), so a write can tell a refusal from a failure. */
  readonly types: string[];
  constructor(message: string, paths: string[], types: string[] = []) {
    super(message);
    this.name = 'GraphqlResponseError';
    this.paths = paths;
    this.types = types;
  }
}

/**
 * Uma chamada ao GraphQL do GitHub (consulta ou mutação), com os erros traduzidos:
 * limite → `RateLimitedError`, escopo faltando → `GithubScopeError`, resto → `Error`.
 */
export async function githubGraphql<T>(
  opts: Omit<GithubGraphqlSourceOptions, 'token'> & { token: string },
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  { tolerateNotFound = false, signal }: { tolerateNotFound?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const { data, errors, message } = await graphqlCall<T>(opts, operation, query, variables, signal);
  const fatal = errors.filter((e) => !(tolerateNotFound && e.type === 'NOT_FOUND'));
  if (fatal.length) throw new GraphqlResponseError(`GitHub: ${fatal[0].message}`, fatal.map((e) => String(e.path?.[0] ?? '')), fatal.map((e) => e.type ?? ''));
  if (!data) throw new Error(`GitHub: ${message}`);
  return data;
}

/**
 * The same call, but GraphQL errors that came with data (a FORBIDDEN of one organization among
 * several, #340) go back to the caller instead of failing it. Rate limit and missing scope still throw,
 * and so does an answer with errors and no data.
 */
export async function githubGraphqlPartial<T>(
  opts: Omit<GithubGraphqlSourceOptions, 'token'> & { token: string },
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ data: T; errors: GraphqlError[] }> {
  const { data, errors, message } = await graphqlCall<T>(opts, operation, query, variables, signal);
  if (data) return { data, errors };
  if (errors.length) throw new GraphqlResponseError(`GitHub: ${errors[0].message}`, errors.map((e) => String(e.path?.[0] ?? '')), errors.map((e) => e.type ?? ''));
  throw new Error(`GitHub: ${message}`);
}

/** The request and the errors every caller treats the same; `message` is the first error's text or the status. */
async function graphqlCall<T>(
  opts: Omit<GithubGraphqlSourceOptions, 'token'> & { token: string },
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ data: T | null; errors: GraphqlError[]; message: string }> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const res = await doFetch(opts.url ?? GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      authorization: `bearer ${opts.token}`,
      'content-type': 'application/json',
      'GraphQL-Features': 'sub_issues,issue_types',
    },
    body: JSON.stringify({ query, variables }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  let json: { data?: (T & { rateLimit?: { cost: number; remaining: number } }) | null; errors?: GraphqlError[]; message?: string } = {};
  try {
    json = JSON.parse(text);
  } catch {
    // corpo vazio ou HTML: decide pelo status abaixo
  }
  const message = json.errors?.[0]?.message ?? json.message ?? `HTTP ${res.status}`;
  if (res.status === 429 || (res.status === 403 && (/rate limit/i.test(message) || res.headers.get('x-ratelimit-remaining') === '0')))
    throw new RateLimitedError(`GitHub limitou as chamadas: ${message}`, backoffMs(res.headers, now()));
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new GithubGatewayError(`GitHub respondeu ${res.status}: ${message}`, res.status);
  if (!res.ok) throw new GithubHttpError(`GitHub respondeu ${res.status}: ${message}`, res.status);
  if (json.errors?.some((e) => e.type === 'RATE_LIMITED'))
    throw new RateLimitedError(`GitHub limitou as chamadas: ${message}`, backoffMs(res.headers, now()));
  const scope = json.errors?.find((e) => e.type === 'INSUFFICIENT_SCOPES');
  if (scope) throw new GithubScopeError(`o token do GitHub não tem o escopo pedido: ${scope.message}`);
  const errors = (json.errors ?? []).map((e) => ({ ...e, message: e.message ?? message }));
  if (json.data?.rateLimit) opts.onCost?.({ operation, cost: json.data.rateLimit.cost, remaining: json.data.rateLimit.remaining });
  return { data: json.data ?? null, errors, message };
}

/** Token do `gh` já autenticado na máquina. */
export function ghCliToken(bin = 'gh'): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(bin, ['auth', 'token'], { timeout: 10_000 }, (err, stdout) => {
      const token = stdout?.trim();
      if (err || !token) reject(new Error('sem token do GitHub: rode `gh auth login`'));
      else resolve(token);
    }),
  );
}
