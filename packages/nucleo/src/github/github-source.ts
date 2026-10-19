// Adaptador local da fonte do trabalho: GraphQL do GitHub, com consultas rasas e medidas
// no spike #40. Nenhuma consulta aninha pais e filhas; todas são em série.
//
// | Consulta       | O que traz                                         | Custo |
// | -------------- | -------------------------------------------------- | ----: |
// | WorkShallow    | 100 issues da busca, chave do pai, resumo das filhas | 1     |
// | WorkNodes      | issues por chave, com 2 níveis de pai (só campos rasos) | 1  |
// | WorkChildren   | até 50 filhas, cada uma com PR, CI e review         | ≤ 4   |
// | WorkDetail     | PR, CI e review de um card                          | 1     |

import { execFile } from 'node:child_process';
import { backoffMs, RateLimitedError } from './cache.ts';
import type { ChildrenResult, WorkSource } from './source.ts';
import {
  parseWorkKey,
  stageOf,
  workKey,
  type CiState,
  type IssueState,
  type LinkedPullRequest,
  type PullRequestState,
  type ReviewDecision,
  type WorkDetail,
  type WorkNode,
} from './work.ts';
import { deltaQuery } from './tree.ts';

export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

const LEAN = `number title url state updatedAt repository { nameWithOwner } issueType { name }
  subIssuesSummary { total completed percentCompleted } parent { number repository { nameWithOwner } }`;
const PRS = `closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { number url state isDraft reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
const RATE = 'rateLimit { cost remaining resetAt }';

export const QUERIES = {
  shallow: `query WorkShallow($q: String!, $after: String) { ${RATE}
  search(query: $q, type: ISSUE, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on Issue { ${LEAN} } } } }`,
  children: `query WorkChildren($o: String!, $r: String!, $n: Int!) { ${RATE}
  repository(owner: $o, name: $r) { issue(number: $n) { subIssues(first: 50) { totalCount nodes { ${LEAN} ${PRS} } } } } }`,
  detail: `query WorkDetail($o: String!, $r: String!, $n: Int!) { ${RATE}
  repository(owner: $o, name: $r) { issue(number: $n) { number state repository { nameWithOwner } ${PRS} } } }`,
} as const;

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
  commits?: { nodes: { commit: { statusCheckRollup: { state: CiState } | null } }[] };
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
  }));
}

export function toWorkDetail(raw: Pick<RawIssue, 'number' | 'state' | 'repository' | 'closedByPullRequestsReferences'>): WorkDetail {
  const pullRequests = toPullRequests(raw);
  return { key: workKey(raw.repository.nameWithOwner, raw.number), state: raw.state, pullRequests, stage: stageOf(raw.state, pullRequests) };
}

export interface QueryCost {
  operation: string;
  cost: number;
  remaining: number;
}

export interface GithubGraphqlSourceOptions {
  /** Token, ou função que o obtém (ex.: `ghCliToken`). */
  token: string | (() => Promise<string>);
  fetch?: typeof fetch;
  url?: string;
  now?: () => number;
  /** Chamado a cada consulta com o custo que o GitHub cobrou. */
  onCost?: (cost: QueryCost) => void;
}

interface GraphqlError {
  type?: string;
  message: string;
}

export class GithubGraphqlSource implements WorkSource {
  private readonly opts: GithubGraphqlSourceOptions;
  private tokenValue: string | null = null;

  constructor(opts: GithubGraphqlSourceOptions) {
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

  private async token(): Promise<string> {
    if (this.tokenValue) return this.tokenValue;
    const t = this.opts.token;
    this.tokenValue = typeof t === 'string' ? t : await t();
    return this.tokenValue;
  }

  private async query<T>(operation: string, query: string, variables: Record<string, unknown>, { tolerateNotFound = false } = {}): Promise<T> {
    return githubGraphql<T>({ ...this.opts, token: await this.token() }, operation, query, variables, { tolerateNotFound });
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
 * Uma chamada ao GraphQL do GitHub (consulta ou mutação), com os erros traduzidos:
 * limite → `RateLimitedError`, escopo faltando → `GithubScopeError`, resto → `Error`.
 */
export async function githubGraphql<T>(
  opts: Omit<GithubGraphqlSourceOptions, 'token'> & { token: string },
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  { tolerateNotFound = false } = {},
): Promise<T> {
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
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}: ${message}`);
  if (json.errors?.some((e) => e.type === 'RATE_LIMITED'))
    throw new RateLimitedError(`GitHub limitou as chamadas: ${message}`, backoffMs(res.headers, now()));
  const scope = json.errors?.find((e) => e.type === 'INSUFFICIENT_SCOPES');
  if (scope) throw new GithubScopeError(`o token do GitHub não tem o escopo pedido: ${scope.message}`);
  const fatal = json.errors?.filter((e) => !(tolerateNotFound && e.type === 'NOT_FOUND')) ?? [];
  if (fatal.length || !json.data) throw new Error(`GitHub: ${fatal[0]?.message ?? message}`);
  if (json.data.rateLimit) opts.onCost?.({ operation, cost: json.data.rateLimit.cost, remaining: json.data.rateLimit.remaining });
  return json.data;
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
