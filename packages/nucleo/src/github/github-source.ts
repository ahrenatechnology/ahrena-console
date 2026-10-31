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
  type CiCounts,
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
// A contagem por estado custa o mesmo que o estado: nenhuma checagem é listada.
const CHECKS = 'contexts(first: 1) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } }';
const PRS = `closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { number url state isDraft reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state ${CHECKS} } } } } } }`;
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
}

export interface GraphqlError {
  type?: string;
  message: string;
  path?: unknown[];
}

export class GithubGraphqlSource implements WorkSource {
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

  private async query<T>(operation: string, query: string, variables: Record<string, unknown>, { tolerateNotFound = false } = {}): Promise<T> {
    const token = await resolveGithubToken(this.opts.token);
    return retryOnGateway(() => githubGraphql<T>({ ...this.opts, token }, operation, query, variables, { tolerateNotFound }), { sleep: this.opts.sleep });
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
  constructor(message: string, paths: string[]) {
    super(message);
    this.name = 'GraphqlResponseError';
    this.paths = paths;
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
  if (fatal.length) throw new GraphqlResponseError(`GitHub: ${fatal[0].message}`, fatal.map((e) => String(e.path?.[0] ?? '')));
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
  if (errors.length) throw new GraphqlResponseError(`GitHub: ${errors[0].message}`, errors.map((e) => String(e.path?.[0] ?? '')));
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
