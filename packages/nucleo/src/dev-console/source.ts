// Porta das leituras do GitHub do Dev Console e o adaptador GraphQL dela (decisão 0008, seção 4;
// cache e orçamento da decisão 0001). Três consultas rasas por repositório, cada uma numa chave
// do cache:
//
// | Consulta                | O que traz                                                        | Custo |
// | ----------------------- | ----------------------------------------------------------------- | ----: |
// | DevConsolePullRequests  | até 50 PRs abertos (rascunho, `mergeable`, base, CI, review, issues que fecham) e os mesclados desde a janela | 1 |
// | DevConsoleIssues        | até 100 issues abertas com as etiquetas e as fechadas desde a janela | 1 |
// | DevConsoleBranches      | os 100 branches do remoto com o commit mais recente                | 1     |
//
// O GraphQL não tem ETag (decisão 0001): a chave guarda `etag: null`, e o TTL faz o trabalho.

import { ghCliToken, githubGraphql, type GithubGraphqlSourceOptions } from '../github/github-source.ts';
import type { CiState, ReviewDecision } from '../github/work.ts';
import type { IssueFact, Mergeable, MergedPullRequestFact, PullRequestFact } from './model.ts';

export interface RepoPullRequests {
  open: PullRequestFact[];
  merged: MergedPullRequestFact[];
}

export interface RepoIssues {
  open: IssueFact[];
  closed: IssueFact[];
}

export interface DevConsoleSource {
  /** PRs abertos e os mesclados desde `mergedSince` (ISO). */
  pullRequests(repo: string, mergedSince: string): Promise<RepoPullRequests>;
  /** Issues abertas e as fechadas desde `closedSince` (ISO). */
  issues(repo: string, closedSince: string): Promise<RepoIssues>;
  /** Nomes dos branches no remoto. */
  branches(repo: string): Promise<string[]>;
}

const RATE = 'rateLimit { cost remaining resetAt }';
const LABELS = 'labels(first: 10) { nodes { name } }';

export const DEV_CONSOLE_QUERIES = {
  pullRequests: `query DevConsolePullRequests($o: String!, $r: String!, $merged: String!) { ${RATE}
  repository(owner: $o, name: $r) { pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: ASC }) { nodes {
    number title url isDraft mergeable mergeStateStatus baseRefName headRefName createdAt reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } } } } }
  merged: search(query: $merged, type: ISSUE, first: 50) { nodes { ... on PullRequest { number title url mergedAt } } } }`,
  issues: `query DevConsoleIssues($o: String!, $r: String!, $closed: String!) { ${RATE}
  repository(owner: $o, name: $r) { issues(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title url state ${LABELS} } } }
  closed: search(query: $closed, type: ISSUE, first: 50) { nodes { ... on Issue { number title url state closedAt ${LABELS} } } } }`,
  branches: `query DevConsoleBranches($o: String!, $r: String!) { ${RATE}
  repository(owner: $o, name: $r) { refs(refPrefix: "refs/heads/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } } } }`,
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
    type Data = { repository: { pullRequests: { nodes: RawPullRequest[] } } | null; merged: { nodes: Partial<MergedPullRequestFact>[] } };
    const data = await this.query<Data>('DevConsolePullRequests', DEV_CONSOLE_QUERIES.pullRequests, {
      ...split(repo),
      merged: `repo:${repo} is:pr is:merged merged:>=${searchDate(mergedSince)}`,
    });
    return {
      open: (data.repository?.pullRequests.nodes ?? []).map((p) => toPullRequestFact(repo, p)),
      merged: data.merged.nodes
        .filter((m): m is MergedPullRequestFact => typeof m.number === 'number' && typeof m.mergedAt === 'string')
        .map((m) => ({ repo, number: m.number, title: m.title, url: m.url, mergedAt: m.mergedAt })),
    };
  }

  async issues(repo: string, closedSince: string): Promise<RepoIssues> {
    type Data = { repository: { issues: { nodes: RawIssue[] } } | null; closed: { nodes: Partial<RawIssue>[] } };
    const data = await this.query<Data>('DevConsoleIssues', DEV_CONSOLE_QUERIES.issues, {
      ...split(repo),
      closed: `repo:${repo} is:issue is:closed closed:>=${searchDate(closedSince)}`,
    });
    return {
      open: (data.repository?.issues.nodes ?? []).map((i) => toIssueFact(repo, i)),
      // Um PR na busca vem como objeto vazio (`... on Issue`).
      closed: data.closed.nodes.filter((i): i is RawIssue => typeof i.number === 'number').map((i) => toIssueFact(repo, i)),
    };
  }

  async branches(repo: string): Promise<string[]> {
    type Data = { repository: { refs: { nodes: { name: string }[] } } | null };
    const data = await this.query<Data>('DevConsoleBranches', DEV_CONSOLE_QUERIES.branches, split(repo));
    return (data.repository?.refs.nodes ?? []).map((b) => b.name);
  }

  private async query<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.tokenValue) {
      const t = this.opts.token;
      this.tokenValue = typeof t === 'string' ? t : await t();
    }
    return githubGraphql<T>({ ...this.opts, token: this.tokenValue }, operation, query, variables);
  }
}

/** Fonte do `--sem-github`: toda leitura falha, e o Dev Console serve o cache com `stale: true`. */
export const disabledDevConsoleSource = (reason = 'GitHub desligado (--sem-github)'): DevConsoleSource => {
  const fail = () => Promise.reject(new Error(reason));
  return { pullRequests: fail, issues: fail, branches: fail };
};
