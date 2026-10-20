// Porta das leituras do GitHub do Dev Console e o adaptador GraphQL dela (decisão 0008, seção 4;
// cache e orçamento da decisão 0001). Três consultas rasas por repositório, cada uma numa chave
// do cache:
//
// | Consulta                | O que traz                                                        | Custo |
// | ----------------------- | ----------------------------------------------------------------- | ----: |
// | DevConsolePullRequests  | até 50 PRs abertos (rascunho, `mergeable`, base, CI, review, issues que fecham) e os mesclados desde a janela | 1 |
// | DevConsoleIssues        | até 100 issues abertas com as etiquetas e as fechadas como concluídas desde a janela | 1 |
// | DevConsoleBranches      | os 100 branches do remoto com o commit mais recente                | 1     |
//
// O GraphQL não tem ETag (decisão 0001): a chave guarda `etag: null`, e o TTL faz o trabalho.
// Cada conexão lê `pageInfo.hasNextPage`: com mais do que a página, a leitura vem `truncated`.

import { ghCliToken, githubGraphql, type GithubGraphqlSourceOptions } from '../github/github-source.ts';
import type { CiState, ReviewDecision } from '../github/work.ts';
import type { IssueFact, Mergeable, MergedPullRequestFact, PullRequestFact } from './model.ts';

export interface RepoPullRequests {
  open: PullRequestFact[];
  merged: MergedPullRequestFact[];
  /** O GitHub tinha mais do que a página (50 abertos ou 50 mesclados): a lista é parcial. */
  truncated?: boolean;
}

export interface RepoIssues {
  open: IssueFact[];
  closed: IssueFact[];
  /** Mais de 100 abertas ou de 50 fechadas na janela: a lista é parcial. */
  truncated?: boolean;
}

export interface RepoBranches {
  names: string[];
  /** Mais de 100 branches: só os 100 com o commit mais recente. */
  truncated?: boolean;
}

export interface DevConsoleSource {
  /** PRs abertos e os mesclados desde `mergedSince` (ISO). */
  pullRequests(repo: string, mergedSince: string): Promise<RepoPullRequests>;
  /** Issues abertas e as fechadas desde `closedSince` (ISO). */
  issues(repo: string, closedSince: string): Promise<RepoIssues>;
  /** Nomes dos branches no remoto. */
  branches(repo: string): Promise<RepoBranches>;
}

const RATE = 'rateLimit { cost remaining resetAt }';
const LABELS = 'labels(first: 10) { nodes { name } }';
const MORE = 'pageInfo { hasNextPage }';

export const DEV_CONSOLE_QUERIES = {
  pullRequests: `query DevConsolePullRequests($o: String!, $r: String!, $merged: String!) { ${RATE}
  repository(owner: $o, name: $r) { pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: ASC }) { ${MORE} nodes {
    number title url isDraft mergeable mergeStateStatus baseRefName headRefName isCrossRepository createdAt reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } } } } }
  merged: search(query: $merged, type: ISSUE, first: 50) { ${MORE} nodes { ... on PullRequest { number title url mergedAt } } } }`,
  issues: `query DevConsoleIssues($o: String!, $r: String!, $closed: String!) { ${RATE}
  repository(owner: $o, name: $r) { issues(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { ${MORE} nodes { number title url state ${LABELS} } } }
  closed: search(query: $closed, type: ISSUE, first: 50) { ${MORE} nodes { ... on Issue { number title url state closedAt ${LABELS} } } } }`,
  branches: `query DevConsoleBranches($o: String!, $r: String!) { ${RATE}
  repository(owner: $o, name: $r) { refs(refPrefix: "refs/heads/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { ${MORE} nodes { name } } } }`,
} as const;

/** A data na sintaxe da busca do GitHub, sem milissegundos. */
export const searchDate = (iso: string): string => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: Mergeable;
  mergeStateStatus: string | null;
  baseRefName: string;
  headRefName: string;
  isCrossRepository?: boolean;
  createdAt: string;
  reviewDecision: ReviewDecision | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: CiState } | null } }[] };
  closingIssuesReferences?: { nodes: { number: number; repository: { nameWithOwner: string } }[] };
}

interface RawIssue {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  closedAt?: string | null;
  labels?: { nodes: { name: string }[] };
}

interface Page<T> {
  pageInfo?: { hasNextPage: boolean };
  nodes: T[];
}

const more = (page: Page<unknown> | null | undefined): boolean => page?.pageInfo?.hasNextPage === true;

const split = (repo: string) => {
  const [o, r] = repo.split('/');
  return { o, r };
};

export function toPullRequestFact(repo: string, p: RawPullRequest): PullRequestFact {
  return {
    repo,
    number: p.number,
    title: p.title,
    url: p.url,
    isDraft: p.isDraft,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus ?? null,
    baseRefName: p.baseRefName,
    headRefName: p.headRefName,
    isCrossRepository: p.isCrossRepository ?? false,
    createdAt: p.createdAt,
    ci: p.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    review: p.reviewDecision ?? null,
    closes: (p.closingIssuesReferences?.nodes ?? []).filter((i) => i.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()).map((i) => i.number),
  };
}

export function toIssueFact(repo: string, i: RawIssue): IssueFact {
  return { repo, number: i.number, title: i.title, url: i.url, state: i.state, labels: (i.labels?.nodes ?? []).map((l) => l.name), closedAt: i.closedAt ?? null };
}

export class GithubDevConsoleSource implements DevConsoleSource {
  private readonly opts: GithubGraphqlSourceOptions;
  private tokenValue: string | null = null;

  constructor(opts: Partial<GithubGraphqlSourceOptions> = {}) {
    this.opts = { token: () => ghCliToken(), ...opts };
  }

  async pullRequests(repo: string, mergedSince: string): Promise<RepoPullRequests> {
    type Data = { repository: { pullRequests: Page<RawPullRequest> } | null; merged: Page<Partial<MergedPullRequestFact>> };
    const data = await this.query<Data>('DevConsolePullRequests', DEV_CONSOLE_QUERIES.pullRequests, {
      ...split(repo),
      merged: `repo:${repo} is:pr is:merged merged:>=${searchDate(mergedSince)}`,
    });
    return {
      open: (data.repository?.pullRequests.nodes ?? []).map((p) => toPullRequestFact(repo, p)),
      merged: data.merged.nodes
        .filter((m): m is MergedPullRequestFact => typeof m.number === 'number' && typeof m.mergedAt === 'string')
        .map((m) => ({ repo, number: m.number, title: m.title, url: m.url, mergedAt: m.mergedAt })),
      truncated: more(data.repository?.pullRequests) || more(data.merged),
    };
  }

  async issues(repo: string, closedSince: string): Promise<RepoIssues> {
    type Data = { repository: { issues: Page<RawIssue> } | null; closed: Page<Partial<RawIssue>> };
    const data = await this.query<Data>('DevConsoleIssues', DEV_CONSOLE_QUERIES.issues, {
      ...split(repo),
      closed: `repo:${repo} is:issue is:closed reason:completed closed:>=${searchDate(closedSince)}`,
    });
    return {
      open: (data.repository?.issues.nodes ?? []).map((i) => toIssueFact(repo, i)),
      // Um PR na busca vem como objeto vazio (`... on Issue`).
      closed: data.closed.nodes.filter((i): i is RawIssue => typeof i.number === 'number').map((i) => toIssueFact(repo, i)),
      truncated: more(data.repository?.issues) || more(data.closed),
    };
  }

  async branches(repo: string): Promise<RepoBranches> {
    type Data = { repository: { refs: Page<{ name: string }> } | null };
    const data = await this.query<Data>('DevConsoleBranches', DEV_CONSOLE_QUERIES.branches, split(repo));
    return { names: (data.repository?.refs.nodes ?? []).map((b) => b.name), truncated: more(data.repository?.refs) };
  }

  private async query<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.tokenValue) {
      const t = this.opts.token;
      this.tokenValue = typeof t === 'string' ? t : await t();
    }
    // Um 401 é token vencido ou trocado: esquece o guardado, e a próxima leitura pede de novo ao `gh`.
    const doFetch = this.opts.fetch ?? fetch;
    let unauthorized = false;
    const watching: typeof fetch = async (input, init) => {
      const res = await doFetch(input, init);
      if (res.status === 401) unauthorized = true;
      return res;
    };
    try {
      return await githubGraphql<T>({ ...this.opts, fetch: watching, token: this.tokenValue }, operation, query, variables);
    } catch (err) {
      if (unauthorized) this.tokenValue = null;
      throw err;
    }
  }
}

/** Fonte do `--sem-github`: toda leitura falha, e o Dev Console serve o cache com `stale: true`. */
export const disabledDevConsoleSource = (reason = 'GitHub desligado (--sem-github)'): DevConsoleSource => {
  const fail = () => Promise.reject(new Error(reason));
  return { pullRequests: fail, issues: fail, branches: fail };
};
