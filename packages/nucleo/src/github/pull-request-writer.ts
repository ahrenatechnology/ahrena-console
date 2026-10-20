// As escritas do console no GitHub para a instalação do framework (#184; estudo, "Como o PR é
// aberto"): a porta de src/framework-install/pull-request.ts sobre o GraphQL, com o token do `gh`
// que o núcleo já usa para ler (o transporte, repos-source.ts). O token fica no transporte: nunca
// entra no que esta peça devolve, nem nos erros. Toda chamada passa pela fila do GitHub do núcleo.
//
// | Operação                    | Como                                                     | Custo |
// | --------------------------- | -------------------------------------------------------- | ----: |
// | FrameworkInstallTarget      | GraphQL: id, `viewerPermission`, o HEAD do padrão, o branch de instalação e os PRs dele (aberto e o mais novo, com CI e review) | 1 |
// | CreateInstallBranch         | `createRef` do branch a partir do HEAD do padrão           | 1 (5 no secundário) |
// | CommitInstallFiles          | `createCommitOnBranch` com `expectedHeadOid`: falha se o branch andou | 1 (5) |
// | OpenInstallPullRequest      | `createPullRequest` do branch para o padrão                 | 1 (5) |
//
// O branch padrão nunca é escrito: a porta recusa um branch de instalação com o nome dele, e as
// escritas só miram o branch de instalação.

import type { InstallPullRequestPort } from '../framework-install/pull-request.ts';
import type { ChecksState, PullRequestLifecycle, PullRequestState, ReviewState } from '../framework-install/model.ts';
import { GithubCallQueue } from './call-queue.ts';
import type { GithubTransport } from './repo-files-source.ts';

const RATE = 'rateLimit { cost remaining resetAt }';
const PR = 'number url title state headRefName baseRefName updatedAt reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';

export const PULL_REQUEST_WRITER_QUERIES = {
  target: `query FrameworkInstallTarget($owner: String!, $name: String!, $branch: String!, $ref: String!) { ${RATE}
  repository(owner: $owner, name: $name) { id nameWithOwner viewerPermission
    defaultBranchRef { name target { oid } }
    installRef: ref(qualifiedName: $ref) { target { oid } }
    open: pullRequests(headRefName: $branch, states: OPEN, first: 1) { nodes { ${PR} } }
    latest: pullRequests(headRefName: $branch, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR} } } } }`,
  createRef: `mutation CreateInstallBranch($repositoryId: ID!, $name: String!, $oid: GitObjectID!) {
  createRef(input: { repositoryId: $repositoryId, name: $name, oid: $oid }) { ref { name } } }`,
  commit: `mutation CommitInstallFiles($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } } }`,
  pullRequest: `mutation OpenInstallPullRequest($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) { pullRequest { ${PR} } } }`,
} as const;

export interface RawPullRequest {
  number: number;
  url: string;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  reviewDecision: string | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

const LIFECYCLE: Record<string, PullRequestLifecycle> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
const REVIEW: Record<string, ReviewState> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' };
const CHECKS: Record<string, ChecksState> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' };

/** O PR cru do GraphQL como a tela mostra (o CI pelo `statusCheckRollup` do último commit). */
export function toPullRequestState(raw: RawPullRequest): PullRequestState {
  const rollup = raw.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null;
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    branch: raw.headRefName,
    base: raw.baseRefName,
    state: LIFECYCLE[raw.state] ?? 'open',
    checks: rollup ? (CHECKS[rollup] ?? 'pending') : null,
    review: raw.reviewDecision ? (REVIEW[raw.reviewDecision] ?? null) : null,
    updatedAt: raw.updatedAt,
  };
}

const WRITE = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** O que a instalação precisa saber do repositório antes de escrever. */
export interface InstallTarget {
  repositoryId: string;
  nameWithOwner: string;
  /** ADMIN, MAINTAIN, WRITE, TRIAGE, READ; `null` sem acesso. */
  permission: string | null;
  canWrite: boolean;
  /** `null` em repositório sem commit. */
  defaultBranch: { name: string; oid: string } | null;
  /** O commit do branch de instalação, se ele existe. */
  branchHead: string | null;
  /** O PR aberto do branch de instalação. */
  openPullRequest: PullRequestState | null;
  /** O PR mais novo do branch de instalação, aberto, mergeado ou fechado. */
  latestPullRequest: PullRequestState | null;
}

interface RawTarget {
  repository: {
    id: string;
    nameWithOwner: string;
    viewerPermission: string | null;
    defaultBranchRef: { name: string; target: { oid: string } | null } | null;
    installRef: { target: { oid: string } | null } | null;
    open: { nodes: RawPullRequest[] };
    latest: { nodes: RawPullRequest[] };
  } | null;
}

export class PullRequestWriter {
  private readonly transport: GithubTransport;
  private readonly queue: GithubCallQueue;
  /** Chamadas ao GitHub (medição e testes). */
  calls = 0;

  constructor(transport: GithubTransport, queue: GithubCallQueue = new GithubCallQueue()) {
    this.transport = transport;
    this.queue = queue;
  }

  private run<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    this.calls++;
    return this.queue.run(() => this.transport.query<T>(operation, query, variables));
  }

  /** O repositório, a permissão, o padrão e o PR do branch de instalação; `null` quando não existe ou não é visível. */
  async target(owner: string, name: string, branch: string): Promise<InstallTarget | null> {
    const data = await this.run<RawTarget>('FrameworkInstallTarget', PULL_REQUEST_WRITER_QUERIES.target, { owner, name, branch, ref: `refs/heads/${branch}` });
    const r = data.repository;
    if (!r) return null;
    const head = r.defaultBranchRef?.target?.oid;
    const open = r.open?.nodes?.[0];
    const latest = r.latest?.nodes?.[0];
    return {
      repositoryId: r.id,
      nameWithOwner: r.nameWithOwner,
      permission: r.viewerPermission ?? null,
      canWrite: WRITE.has(r.viewerPermission ?? ''),
      defaultBranch: r.defaultBranchRef && head ? { name: r.defaultBranchRef.name, oid: head } : null,
      branchHead: r.installRef?.target?.oid ?? null,
      openPullRequest: open ? toPullRequestState(open) : null,
      latestPullRequest: latest ? toPullRequestState(latest) : null,
    };
  }

  /**
   * A porta da instalação para um repositório, a partir do `target` lido agora. As leituras vêm dele;
   * as três escritas vão ao GitHub. Nenhuma escrita mira o branch padrão.
   */
  port(target: InstallTarget): InstallPullRequestPort {
    const defaultName = target.defaultBranch?.name ?? null;
    const guard = (branch: string) => {
      if (branch === defaultName) throw new Error('o branch da instalação não pode ser o branch padrão');
    };
    return {
      defaultBranch: async () => {
        if (!target.defaultBranch) throw new Error('o repositório não tem commit no branch padrão');
        return target.defaultBranch;
      },
      findOpenPr: async (branch) => (target.openPullRequest && target.openPullRequest.branch === branch ? target.openPullRequest : null),
      branchHead: async () => target.branchHead,
      createRef: async (branch, oid) => {
        guard(branch);
        await this.run('CreateInstallBranch', PULL_REQUEST_WRITER_QUERIES.createRef, { repositoryId: target.repositoryId, name: `refs/heads/${branch}`, oid });
      },
      createCommitOnBranch: async ({ branch, expectedHeadOid, message, additions }) => {
        guard(branch);
        const data = await this.run<{ createCommitOnBranch: { commit: { oid: string } } }>('CommitInstallFiles', PULL_REQUEST_WRITER_QUERIES.commit, {
          input: { branch: { repositoryNameWithOwner: target.nameWithOwner, branchName: branch }, expectedHeadOid, message, fileChanges: { additions } },
        });
        return { oid: data.createCommitOnBranch.commit.oid };
      },
      createPullRequest: async ({ base, head, title, body }) => {
        guard(head);
        const data = await this.run<{ createPullRequest: { pullRequest: RawPullRequest } }>('OpenInstallPullRequest', PULL_REQUEST_WRITER_QUERIES.pullRequest, {
          input: { repositoryId: target.repositoryId, baseRefName: base, headRefName: head, title, body, draft: false },
        });
        return toPullRequestState(data.createPullRequest.pullRequest);
      },
    };
  }
}
