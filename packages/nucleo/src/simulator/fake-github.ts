// Fake GitHub for the repositories (#104 and #105): a `fetch` that answers the GraphQL and REST that
// src/github/repos-source.ts calls, with synthetic, deterministic data. It serves the demo
// (`npm run api -- --demo`) and the tests; it never goes to the network, and any route it does not
// know gives 404 and is recorded in `calls`.
//
// It imitates what the screens depend on from GitHub: ETag and 304 with `If-None-Match`, 202 while a
// statistic "computes" (`computeFirst`), 403 on traffic and on alerts without write access.
// A repository's files (`files`, #183) answer the discovery (`RepoFilesDiscovery`, up to 20 repositories
// per query, with the 23 decision folders of #174), the content
// batches (`RepoBlobs`, by `oid` or by `<commit>:<path>`) and the recursive tree
// (`git/trees/HEAD?recursive=1`), with Git's `oid` (SHA-1 of `blob <size>\0<text>`).
// The framework install (#184) adds the writes: `FrameworkInstallTarget` (permission, the default
// branch's HEAD, the install branch and its PRs) and the mutations `CreateInstallBranch`,
// `CommitInstallFiles` and `OpenInstallPullRequest`. Each write is recorded in `writes` (the tests read
// it); the default branch is never moved by them. An opened PR's CI and review evolve with the clock
// (`pullRequestTimeline`), synthetically.
// With `auth` (#241) it also answers the console's own connection: the OAuth device flow, `/user`,
// `/user/orgs` and the org access check (fake-github-auth.ts).
// Names follow the simulator's vocabulary (vocabulary.ts): orgs `exemplo-labs` and
// `estudio-ficticio`, account `dev-sintetico`, projects under /simulacao.

import { createHash } from 'node:crypto';
import { SeededRandom, hash32 } from './random.ts';
import { ROOT } from './vocabulary.ts';
import { catalogSnapshot, MARKETPLACE_PATH } from '../framework-install/catalog.ts';
import { DEFAULT_FRAMEWORK_REPO } from '../framework-install/model.ts';
import { DECISION_DIRS } from '../adrs/parse.ts';
import { DEMO_DECISION_FILES } from './demo-decisions.ts';
import { createFakeGithubAuthRoutes, type FakeGithubAuth, type FakeGithubAuthState } from './fake-github-auth.ts';

export type { FakeGithubAuth, FakeGithubAuthState } from './fake-github-auth.ts';

export interface FakeRepo {
  owner: string;
  name: string;
  isPrivate: boolean;
  language: string;
  /** viewerPermission. */
  permission: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ';
  /** Last push, in minutes ago. */
  pushMin: number;
  issues: number;
  prs: number;
  ci: 'SUCCESS' | 'FAILURE' | 'PENDING' | null;
  /** Commits per week, on average (the sparkline varies around this). */
  commitsPerWeek: number;
  stars?: number;
  forks?: number;
  watchers?: number;
  license?: string | null;
  release?: { tag: string; daysAgo: number } | null;
  /** Releases ever: the newest at `release.daysAgo` (or 10 days), the others every 40 days. */
  releases?: number;
  /** Statistics that answer 202 on the first call: `commit_activity`, `code_frequency`, `contributors`. */
  computeFirst?: string[];
  dependabot?: number;
  codeScanning?: number | null;
  /** The default branch's files, path → text (#183). Without them, only a README. */
  files?: Record<string, string>;
  /** The recursive tree comes truncated (`truncated: true`), without files 3 or more folders deep. */
  truncatedTree?: boolean;
  /** Arquivos que o GitHub não entrega inteiros no lote de conteúdo (#184): `binary` (`isBinary`) ou `truncated` (`isTruncated`, texto cortado). */
  unreadable?: Record<string, 'binary' | 'truncated'>;
}

export interface FakeGithubData {
  login: string;
  organizations: string[];
  repos: FakeRepo[];
  awaitingReview: number;
  closedThisWeek: number;
}

/** How an opened PR evolves with the clock (#184): CI and review, synthetic. Without it, CI stays pending and the review required. */
export interface PullRequestTimeline {
  /** After this many ms the CI finishes, with `checksResult` (default `SUCCESS`). */
  checksAfterMs?: number;
  checksResult?: 'SUCCESS' | 'FAILURE';
  /** After this many ms the review is approved. */
  approvedAfterMs?: number;
}

export interface FakeGithubOptions {
  now?: () => number;
  /** Delay of each answer, in ms (the demo shows the "loading"). */
  delayMs?: number;
  pullRequestTimeline?: PullRequestTimeline;
  /** The console's own connection (#241): device flow, `/user`, `/user/orgs`, `/orgs/<org>/repos`. */
  auth?: FakeGithubAuth;
}

/** A write the fake received (#184), in order. */
export interface FakeWrite {
  operation: 'createRef' | 'createCommitOnBranch' | 'createPullRequest';
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** createCommitOnBranch: the paths written. */
  paths?: string[];
  /** createPullRequest. */
  base?: string;
  title?: string;
  body?: string;
}

/** A pull request opened in the fake (#184); tests may change `state` (`MERGED`, `CLOSED`). */
export interface FakePullRequest {
  repo: string;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  createdAt: number;
  /** The files of the head branch, path → text. */
  files: Record<string, string>;
}

export interface FakeGithub {
  fetch: typeof fetch;
  /** `GRAPHQL <operation>` or `GET <path>`, in order. */
  calls: string[];
  /** The writes, in order (#184). */
  writes: FakeWrite[];
  /** The PRs opened in the fake (#184). */
  pullRequests: FakePullRequest[];
  /** A repository's branches, name → commit (`main` included). */
  refs(owner: string, name: string): Record<string, string>;
  /** A próxima mutação com este nome (`CreateInstallBranch`, `CommitInstallFiles`, `OpenInstallPullRequest`) falha, sem escrever (#184). */
  failNext(operation: string): void;
  /** With `auth` (#241): the device codes handed out and the polls per code. */
  auth: FakeGithubAuthState | null;
}

/** A GraphQL error the fake answers with (`errors`), as GitHub does for a refused mutation. */
class FakeGraphqlError extends Error {
  readonly type: string;
  constructor(type: string, message: string) {
    super(message);
    this.type = type;
  }
}

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
const ISSUE_TYPES = ['História', 'Tarefa técnica', 'Bug', 'Spike', 'Épico'] as const;
const ISSUE_TYPE_WEIGHTS = [0.4, 0.3, 0.17, 0.09, 0.04];
const AUTHORS = [
  { login: 'dev-sintetico', __typename: 'User', weight: 0.45 },
  { login: 'colega-a', __typename: 'User', weight: 0.2 },
  { login: 'colega-b', __typename: 'User', weight: 0.1 },
  { login: 'dependabot[bot]', __typename: 'Bot', weight: 0.1 },
  { login: 'dev-sintetico', __typename: 'User', weight: 0.15, claude: true },
] as const;
const EXTRA_LANGUAGES: Record<string, [string, number][]> = {
  TypeScript: [['CSS', 0.12], ['HTML', 0.09], ['Shell', 0.05], ['JavaScript', 0.03]],
  Python: [['Jupyter Notebook', 0.15], ['Shell', 0.04], ['Dockerfile', 0.01]],
  Go: [['Makefile', 0.03], ['Shell', 0.02]],
  Kotlin: [['Java', 0.1], ['Shell', 0.01]],
  Rust: [['Shell', 0.02]],
  Astro: [['TypeScript', 0.2], ['CSS', 0.15], ['MDX', 0.08]],
};

/** Sunday 00:00 UTC of the week of `ms`. */
const sunday = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * DAY;
};
const iso = (ms: number) => new Date(ms).toISOString();

function weighted<T extends { weight: number }>(r: SeededRandom, items: readonly T[]): T {
  let x = r.next() * items.reduce((s, i) => s + i.weight, 0);
  for (const i of items) if ((x -= i.weight) < 0) return i;
  return items[items.length - 1];
}

interface Series {
  weeks: { week: number; total: number; added: number; removed: number }[];
  prs: Record<string, unknown>[];
  closed: Record<string, unknown>[];
  open: Record<string, unknown>[];
  runs: { status: string; conclusion: string; created_at: string; run_started_at: string; updated_at: string }[];
  contributors: { author: { login: string; type: string }; total: number; weeks: { w: number; a: number; d: number; c: number }[] }[];
}

/** A repository's series, from 3 years back up to the week of `now`. */
function generateSeries(repo: FakeRepo, now: number): Series {
  const r = new SeededRandom(`${repo.owner}/${repo.name}`);
  const end = sunday(now);
  const weeks: Series['weeks'] = [];
  const weights = [0.55, 0.22, 0.15, 0.08];
  const contrib = ['dev-sintetico', 'colega-a', 'colega-b', 'github-actions[bot]'].map((login, i) => ({
    author: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
    total: 0,
    weeks: [] as { w: number; a: number; d: number; c: number }[],
    weight: weights[i],
  }));
  // A slow wave plus noise: the sparkline is neither flat nor repeated between repositories.
  const phase = r.next() * Math.PI * 2;
  for (let i = 155; i >= 0; i--) {
    const week = end - i * WEEK;
    const wave = 1 + 0.6 * Math.sin(phase + i / 2.3) + 0.3 * Math.sin(phase * 2 + i / 0.9);
    const total = Math.max(0, Math.round(repo.commitsPerWeek * wave * (0.6 + r.next() * 0.8)));
    const added = total * r.int(30, 140);
    const removed = Math.round(added * (0.25 + r.next() * 0.35));
    weeks.push({ week: week / 1000, total, added, removed });
    let restC = total;
    let restA = added;
    let restD = removed;
    contrib.forEach((c, j) => {
      const last = j === contrib.length - 1;
      const cc = last ? restC : Math.min(restC, Math.round(total * c.weight));
      const aa = last ? restA : Math.min(restA, Math.round(added * c.weight));
      const dd = last ? restD : Math.min(restD, Math.round(removed * c.weight));
      restC -= cc;
      restA -= aa;
      restD -= dd;
      c.weeks.push({ w: week / 1000, a: aa, d: dd, c: cc });
      c.total += cc;
    });
  }

  // The last year's PRs: the ones open now are the newest `repo.prs`.
  // `pedidosDeMudanca` is the GraphQL alias src/github/repos-source.ts asks for; `_updated` never leaves.
  const prs: Record<string, unknown>[] = [];
  const perWeek = Math.max(1, Math.round(repo.commitsPerWeek / 3));
  for (let s = 0; s < 52; s++) {
    for (let k = 0; k < perWeek; k++) {
      const created = now - s * WEEK - r.int(1, 6 * 24) * 3_600_000;
      const author = weighted(r, AUTHORS);
      const reviewAt = created + r.int(1, 9) * 3_600_000 + r.int(0, 59) * 60_000;
      const closed = created + r.int(3, 70) * 3_600_000;
      const merge = r.chance(0.88);
      const reviews = author.__typename === 'Bot' && r.chance(0.5) ? 0 : r.int(1, 3);
      prs.push({
        createdAt: iso(created),
        mergedAt: merge ? iso(closed) : null,
        closedAt: iso(closed),
        state: merge ? 'MERGED' : 'CLOSED',
        additions: r.int(8, 420),
        deletions: r.int(0, 160),
        headRefName: 'claude' in author ? `claude/tarefa-${s}-${k}` : author.__typename === 'Bot' ? `dependabot/npm/pacote-${s}` : `feat/${100 + s}-${k}`,
        author: { login: author.login, __typename: author.__typename },
        reviews: { totalCount: reviews, nodes: reviews ? [{ createdAt: iso(Math.min(reviewAt, closed - 60_000)) }] : [] },
        pedidosDeMudanca: { totalCount: reviews > 1 ? r.int(0, reviews - 1) : 0 },
        _updated: closed,
      });
    }
  }
  for (let k = 0; k < repo.prs; k++) {
    const created = now - r.int(1, 9 * 24) * 3_600_000;
    prs.push({
      createdAt: iso(created), mergedAt: null, closedAt: null, state: 'OPEN', additions: r.int(10, 300), deletions: r.int(0, 90),
      headRefName: k % 2 ? `claude/aberto-${k}` : `feat/${300 + k}-aberto`, author: { login: 'dev-sintetico', __typename: 'User' },
      reviews: { totalCount: 0, nodes: [] }, pedidosDeMudanca: { totalCount: 0 }, _updated: created,
    });
  }

  const issueType = () => (r.chance(0.08) ? null : { name: weighted(r, ISSUE_TYPES.map((t, i) => ({ t, weight: ISSUE_TYPE_WEIGHTS[i] }))).t });
  const closedIssues: Record<string, unknown>[] = [];
  for (let s = 0; s < 52; s++) {
    for (let k = 0; k < Math.max(1, Math.round(repo.commitsPerWeek / 4)); k++) {
      const closedAt = now - s * WEEK - r.int(0, 6 * 24) * 3_600_000;
      closedIssues.push({ createdAt: iso(closedAt - r.int(4, 24 * 9) * 3_600_000), closedAt: iso(closedAt), issueType: issueType() });
    }
  }
  const openIssues = Array.from({ length: repo.issues }, () => ({ issueType: issueType() }));

  // The last year's runs: a few per working day, green according to the repository's CI.
  const green = repo.ci === 'FAILURE' ? 0.78 : repo.ci === 'PENDING' ? 0.9 : 0.95;
  const runs: Series['runs'] = [];
  for (let day = 0; day < 365; day++) {
    for (let k = 0; k < r.int(0, Math.max(1, Math.round(repo.commitsPerWeek / 5))); k++) {
      const start = now - day * DAY - r.int(1, 23) * 3_600_000;
      const dur = r.int(2, 11) * 60_000 + r.int(0, 59) * 1000;
      runs.push({ status: 'completed', conclusion: r.chance(green) ? 'success' : r.chance(0.85) ? 'failure' : 'cancelled', created_at: iso(start), run_started_at: iso(start + 5_000), updated_at: iso(start + dur) });
    }
  }
  return { weeks, prs, closed: closedIssues, open: openIssues, runs, contributors: contrib.map(({ weight: _weight, ...c }) => c) };
}

function rawRepo(repo: FakeRepo, now: number) {
  return {
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    isPrivate: repo.isPrivate,
    pushedAt: iso(now - repo.pushMin * 60_000),
    viewerPermission: repo.permission,
    owner: { login: repo.owner, __typename: repo.owner === 'dev-sintetico' ? 'User' : 'Organization' },
    primaryLanguage: { name: repo.language },
    issues: { totalCount: repo.issues },
    pullRequests: { totalCount: repo.prs },
    defaultBranchRef: { name: 'main', target: { statusCheckRollup: repo.ci ? { state: repo.ci } : null } },
  };
}

const canWrite = (repo: FakeRepo) => repo.permission === 'ADMIN' || repo.permission === 'MAINTAIN' || repo.permission === 'WRITE';
const searchSince = (q: string, field: string) => {
  const m = new RegExp(`${field}:>=(\\d{4}-\\d{2}-\\d{2})`).exec(q);
  return m ? Date.parse(`${m[1]}T00:00:00Z`) : -Infinity;
};
const withoutInternals = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

export function createFakeGithub(data: FakeGithubData, { now = Date.now, delayMs = 0, pullRequestTimeline = {}, auth }: FakeGithubOptions = {}): FakeGithub {
  const calls: string[] = [];
  const writes: FakeWrite[] = [];
  const pullRequests: FakePullRequest[] = [];
  const branchesByRepo = new Map<string, Map<string, { oid: string; files: Record<string, string> }>>();
  const series = new Map<string, Series>();
  const alreadyComputed = new Set<string>();
  const t0 = now();
  const seriesOf = (repo: FakeRepo) => {
    const k = `${repo.owner}/${repo.name}`;
    let s = series.get(k);
    if (!s) series.set(k, (s = generateSeries(repo, t0)));
    return s;
  };
  const find = (owner: string, name: string) => data.repos.find((x) => x.owner.toLowerCase() === owner.toLowerCase() && x.name.toLowerCase() === name.toLowerCase()) ?? null;
  const rateLimit = { cost: 1, remaining: 4999, resetAt: iso(t0 + 3_600_000) };
  const gitsByRepo = new Map<string, GitFake>();
  const gitOf = (repo: FakeRepo) => {
    const k = `${repo.owner}/${repo.name}`;
    let g = gitsByRepo.get(k);
    if (!g) gitsByRepo.set(k, (g = buildGit(repo)));
    return g;
  };
  /** The discovery: the commit, one alias per root file and `.claude/` 3 levels deep. */
  const discovery = (repo: FakeRepo) => {
    const g = gitOf(repo);
    const blob = (path: string) => (g.oids.has(path) ? { oid: g.oids.get(path) } : g.folders.has(path) ? {} : null);
    const entries = (folder: string, level: number): unknown[] => {
      const names = new Set<string>();
      for (const p of [...Object.keys(g.files), ...g.folders]) if (p.startsWith(`${folder}/`)) names.add(p.slice(folder.length + 1).split('/')[0]);
      return [...names].sort().map((name) => {
        const path = `${folder}/${name}`;
        if (!g.folders.has(path)) return { name, type: 'blob', oid: g.oids.get(path) };
        return { name, type: 'tree', oid: oidOf(`tree ${path}`), ...(level < 3 ? { object: { entries: entries(path, level + 1) } } : {}) };
      });
    };
    return {
      nameWithOwner: `${repo.owner}/${repo.name}`,
      head: { oid: g.commit, tree: { oid: g.tree } },
      claudeMd: blob('CLAUDE.md'),
      agentsMd: blob('AGENTS.md'),
      dotClaudeMd: blob('.claude/CLAUDE.md'),
      mcpJson: blob('.mcp.json'),
      claudeDir: g.folders.has('.claude') ? { entries: entries('.claude', 1) } : null,
      // As 23 pastas de decisão (#174), um apelido por pasta: só o primeiro nível, como o GitHub.
      ...Object.fromEntries(DECISION_DIRS.map((dir, k) => [`dir${k}`, g.folders.has(dir) ? { entries: entries(dir, 3) } : g.oids.has(dir) ? {} : null])),
    };
  };

  /** The repository's branches (#184): `main` at the commit of its files, plus what the writes created. */
  const branchesOf = (repo: FakeRepo) => {
    const k = `${repo.owner}/${repo.name}`;
    let b = branchesByRepo.get(k);
    if (!b) branchesByRepo.set(k, (b = new Map([['main', { oid: gitOf(repo).commit, files: gitOf(repo).files }]])));
    return b;
  };
  const repoById = (id: string) => data.repos.find((x) => `R_${x.owner}/${x.name}` === id) ?? null;
  /** A PR as GraphQL answers it: CI and review from the timeline. */
  const rawPullRequest = (pr: FakePullRequest) => {
    const age = now() - pr.createdAt;
    const t = pullRequestTimeline;
    const checksDone = t.checksAfterMs !== undefined && age >= t.checksAfterMs;
    const approved = t.approvedAfterMs !== undefined && age >= t.approvedAfterMs;
    const events = [pr.createdAt, checksDone ? pr.createdAt + t.checksAfterMs! : 0, approved ? pr.createdAt + t.approvedAfterMs! : 0];
    return {
      number: pr.number,
      url: `https://github.com/${pr.repo}/pull/${pr.number}`,
      title: pr.title,
      state: pr.state,
      headRefName: pr.head,
      baseRefName: pr.base,
      updatedAt: iso(Math.max(...events)),
      reviewDecision: approved ? 'APPROVED' : 'REVIEW_REQUIRED',
      commits: { nodes: [{ commit: { statusCheckRollup: { state: checksDone ? (t.checksResult ?? 'SUCCESS') : 'PENDING' } } }] },
    };
  };
  const prsOf = (repo: FakeRepo, head: string) =>
    pullRequests.filter((p) => p.repo === `${repo.owner}/${repo.name}` && p.head === head).sort((a, b) => b.number - a.number);

  /** The install's read and the three writes (#184). */
  const failures = new Set<string>();
  function installOperation(op: string, v: Record<string, unknown>): unknown {
    if (failures.delete(op)) throw new FakeGraphqlError('INTERNAL', `falha simulada em ${op}`);
    if (op === 'FrameworkInstallTarget') {
      const repo = find(String(v.owner), String(v.name));
      if (!repo) return { rateLimit, repository: null };
      const branches = branchesOf(repo);
      const branch = String(v.branch);
      const prs = prsOf(repo, branch);
      return {
        rateLimit,
        repository: {
          id: `R_${repo.owner}/${repo.name}`,
          nameWithOwner: `${repo.owner}/${repo.name}`,
          viewerPermission: repo.permission,
          defaultBranchRef: { name: 'main', target: { oid: branches.get('main')!.oid } },
          installRef: branches.has(branch) ? { target: { oid: branches.get(branch)!.oid } } : null,
          open: { nodes: prs.filter((p) => p.state === 'OPEN').slice(0, 1).map(rawPullRequest) },
          latest: { nodes: prs.slice(0, 1).map(rawPullRequest) },
        },
      };
    }
    if (op === 'CreateInstallBranch') {
      const repo = repoById(String(v.repositoryId));
      if (!repo) throw new FakeGraphqlError('NOT_FOUND', 'Could not resolve to a node with the global id');
      if (!canWrite(repo)) throw new FakeGraphqlError('FORBIDDEN', 'Resource not accessible by integration');
      const name = String(v.name).replace(/^refs\/heads\//, '');
      const branches = branchesOf(repo);
      if (branches.has(name)) throw new FakeGraphqlError('UNPROCESSABLE', `A ref named "refs/heads/${name}" already exists in the repository.`);
      const from = [...branches.values()].find((b) => b.oid === v.oid);
      if (!from) throw new FakeGraphqlError('UNPROCESSABLE', 'Object does not exist');
      branches.set(name, { oid: from.oid, files: from.files });
      writes.push({ operation: 'createRef', repo: `${repo.owner}/${repo.name}`, branch: name });
      return { createRef: { ref: { name: `refs/heads/${name}` } } };
    }
    if (op === 'CommitInstallFiles') {
      const input = v.input as { branch: { repositoryNameWithOwner: string; branchName: string }; expectedHeadOid: string; message: { headline: string }; fileChanges: { additions: { path: string; contents: string }[] } };
      const [owner, name] = input.branch.repositoryNameWithOwner.split('/');
      const repo = find(owner, name);
      if (!repo) throw new FakeGraphqlError('NOT_FOUND', 'Could not resolve to a Repository');
      if (!canWrite(repo)) throw new FakeGraphqlError('FORBIDDEN', 'Resource not accessible by integration');
      const branches = branchesOf(repo);
      const current = branches.get(input.branch.branchName);
      if (!current) throw new FakeGraphqlError('NOT_FOUND', `A ref named "${input.branch.branchName}" does not exist`);
      if (current.oid !== input.expectedHeadOid) throw new FakeGraphqlError('STALE_DATA', `Expected branch to point to "${input.expectedHeadOid}" but it did not`);
      const files = { ...current.files };
      for (const a of input.fileChanges.additions) files[a.path] = Buffer.from(a.contents, 'base64').toString('utf8');
      const oid = oidOf(`commit ${input.branch.branchName}:${current.oid}:${JSON.stringify(files)}`);
      branches.set(input.branch.branchName, { oid, files });
      writes.push({ operation: 'createCommitOnBranch', repo: `${repo.owner}/${repo.name}`, branch: input.branch.branchName, paths: input.fileChanges.additions.map((a) => a.path) });
      return { createCommitOnBranch: { commit: { oid } } };
    }
    if (op === 'OpenInstallPullRequest') {
      const input = v.input as { repositoryId: string; baseRefName: string; headRefName: string; title: string; body: string };
      const repo = repoById(input.repositoryId);
      if (!repo) throw new FakeGraphqlError('NOT_FOUND', 'Could not resolve to a node with the global id');
      if (!canWrite(repo)) throw new FakeGraphqlError('FORBIDDEN', 'Resource not accessible by integration');
      const head = branchesOf(repo).get(input.headRefName);
      if (!head) throw new FakeGraphqlError('UNPROCESSABLE', 'Head sha can\'t be blank');
      if (prsOf(repo, input.headRefName).some((p) => p.state === 'OPEN')) throw new FakeGraphqlError('UNPROCESSABLE', `A pull request already exists for ${input.headRefName}.`);
      const pr: FakePullRequest = {
        repo: `${repo.owner}/${repo.name}`,
        number: 100 + repo.prs + pullRequests.filter((p) => p.repo === `${repo.owner}/${repo.name}`).length + 1,
        title: input.title,
        body: input.body,
        head: input.headRefName,
        base: input.baseRefName,
        state: 'OPEN',
        createdAt: now(),
        files: head.files,
      };
      pullRequests.push(pr);
      writes.push({ operation: 'createPullRequest', repo: pr.repo, branch: pr.head, base: pr.base, title: pr.title, body: pr.body });
      return { createPullRequest: { pullRequest: rawPullRequest(pr) } };
    }
    return null;
  }

  // The operation names, variables and response aliases (`fechadas`, `abertas`, `mergeados`,
  // `fechadosSemMerge`) are the ones src/github/repos-source.ts sends: they stay as they are.
  function graphql(body: { query: string; variables: Record<string, string> }): unknown {
    const op = /(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? '?';
    calls.push(`GRAPHQL ${op}`);
    const v = body.variables ?? {};
    const install = installOperation(op, v);
    if (install !== null) return install;
    if (op === 'ProjectOptions') return projectOptions(data, rateLimit);
    if (op === 'ReposLista') {
      return {
        rateLimit,
        viewer: {
          login: data.login,
          organizations: { nodes: data.organizations.map((login) => ({ login })) },
          repositories: { totalCount: data.repos.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: data.repos.map((x) => rawRepo(x, now())) },
        },
      };
    }
    if (op === 'RepoFilesDiscovery') {
      // Um lote de até 20 repositórios (`$o<i>`, `$n<i>`), cada um sob `r<i>` (#174).
      const out: Record<string, unknown> = { rateLimit };
      for (let i = 0; typeof v[`o${i}`] === 'string'; i++) {
        const repo = find(v[`o${i}`], v[`n${i}`]);
        out[`r${i}`] = repo ? discovery(repo) : null;
      }
      return out;
    }
    if (op === 'RepoBlobs') {
      const repo = find(v.owner, v.name);
      if (!repo) return { rateLimit, repository: null };
      const g = gitOf(repo);
      const out: Record<string, unknown> = {};
      for (const [k, value] of Object.entries(v)) {
        const m = /^([oe])(\d+)$/.exec(k);
        if (!m) continue;
        let path: string | undefined;
        if (m[1] === 'o') path = [...g.oids].find(([, oid]) => oid === value)?.[0];
        else {
          const [commit, ...rest] = value.split(':');
          path = commit === g.commit ? rest.join(':') : undefined;
        }
        const text = path === undefined ? undefined : g.files[path];
        const how = path === undefined ? undefined : repo.unreadable?.[path];
        out[`b${m[2]}`] =
          text !== undefined
            ? how === 'binary'
              ? { oid: g.oids.get(path!), byteSize: Buffer.byteLength(text), isBinary: true, isTruncated: false, text: null }
              : how === 'truncated'
                ? { oid: g.oids.get(path!), byteSize: Buffer.byteLength(text), isBinary: false, isTruncated: true, text: text.slice(0, Math.floor(text.length / 2)) }
                : { oid: g.oids.get(path!), byteSize: Buffer.byteLength(text), isBinary: false, isTruncated: false, text }
            : path !== undefined && g.folders.has(path)
              ? {}
              : null;
      }
      return { rateLimit, repository: out };
    }
    if (op === 'ReposResumo') return { rateLimit, review: { issueCount: data.awaitingReview }, fechadas: { issueCount: data.closedThisWeek } };
    if (op === 'RepoDelivery') return delivery(v);
    if (op === 'RepoDeliveryPage') return { rateLimit, search: empty() };
    if (op === 'RepoDetalhe') {
      const repo = find(v.o, v.r);
      if (!repo) return { rateLimit, repository: null, prs: empty(), fechadas: empty(), abertas: empty(), mergeados: empty(), fechadosSemMerge: empty() };
      const s = seriesOf(repo);
      const prsSince = searchSince(v.prs, 'updated');
      const issuesSince = searchSince(v.fechadas, 'closed');
      const prs = s.prs.filter((p) => (p._updated as number) >= prsSince).map(withoutInternals);
      const closed = s.closed.filter((i) => Date.parse(i.closedAt as string) >= issuesSince);
      const mergedSince = searchSince(v.mergeados, 'merged');
      const closedSince = searchSince(v.fechadosSemMerge, 'closed');
      const merged = s.prs.filter((p) => p.mergedAt && Date.parse(p.mergedAt as string) >= mergedSince).length;
      const closedUnmerged = s.prs.filter((p) => p.state === 'CLOSED' && !p.mergedAt && Date.parse(p.closedAt as string) >= closedSince).length;
      const t = now();
      const newest = repo.release?.daysAgo ?? 10;
      const releases = Array.from({ length: Math.min(100, repo.releases ?? 0) }, (_, i) => ({ publishedAt: iso(t - (newest + i * 40) * DAY) }));
      return {
        rateLimit,
        repository: {
          ...rawRepo(repo, t),
          stargazerCount: repo.stars ?? 0,
          forkCount: repo.forks ?? 0,
          watchers: { totalCount: repo.watchers ?? 0 },
          licenseInfo: repo.license ? { spdxId: repo.license, name: repo.license } : null,
          latestRelease: repo.release ? { tagName: repo.release.tag, publishedAt: iso(t - repo.release.daysAgo * DAY) } : null,
          releases: { totalCount: repo.releases ?? 0, nodes: releases },
        },
        mergeados: { issueCount: merged },
        fechadosSemMerge: { issueCount: closedUnmerged },
        prs: page(prs),
        fechadas: page(closed),
        abertas: page(s.open),
      };
    }
    return null;
  }

  /** The Delivery tab's read (#266): no author, no assignee, as src/github/delivery-source.ts asks. */
  function delivery(v: Record<string, string>): unknown {
    const repo = find(v.o, v.r);
    if (!repo) return { rateLimit, repository: null, prs: empty(), issues: empty(), open: empty() };
    const s = seriesOf(repo);
    const k = `${repo.owner}/${repo.name}`;
    const prsSince = searchSince(v.prs, 'updated');
    const issuesSince = searchSince(v.issues, 'updated');
    const prs = s.prs
      .filter((p) => (p._updated as number) >= prsSince)
      .map((p) => {
        const reviews = p.reviews as { totalCount: number; nodes: { createdAt: string }[] };
        const first = reviews.nodes[0] ? Date.parse(reviews.nodes[0].createdAt) : 0;
        return { createdAt: p.createdAt, mergedAt: p.mergedAt, reviews: { nodes: Array.from({ length: reviews.totalCount }, (_, j) => ({ submittedAt: iso(first + j * 3_600_000) })) } };
      });
    const open = deliveryOpenItems(repo, s, now());
    const openIssues = open.filter((o) => o.__typename === 'Issue');
    const issues = [
      ...s.closed.filter((i) => Date.parse(i.closedAt as string) >= issuesSince).map((i) => ({ createdAt: i.createdAt, closedAt: i.closedAt })),
      ...openIssues.filter((i) => Date.parse(i.createdAt) >= issuesSince).map((i) => ({ createdAt: i.createdAt, closedAt: null })),
    ];
    return {
      rateLimit,
      repository: { nameWithOwner: k, issues: { totalCount: repo.issues }, pullRequests: { totalCount: repo.prs } },
      prs: page(prs),
      issues: page(issues),
      open: { issueCount: open.length, nodes: open.slice(0, 50) },
    };
  }

  function rest(path: string): { status: number; body?: unknown } {
    calls.push(`GET ${path}`);
    const url = new URL(path, 'http://falso');
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    const repo = m ? find(m[1], m[2]) : null;
    if (!m || !repo) return { status: 404, body: { message: 'Not Found' } };
    const resource = m[3];
    const s = seriesOf(repo);
    const k = `${repo.owner}/${repo.name}`;
    if (resource === 'git/trees/HEAD') {
      const g = gitOf(repo);
      const all = [...g.folders].map((path) => ({ path, mode: '040000', type: 'tree', sha: oidOf(`tree ${k}:${path}`) }))
        .concat(Object.keys(g.files).map((path) => ({ path, mode: '100644', type: 'blob', sha: g.oids.get(path)!, size: Buffer.byteLength(g.files[path]) })))
        .sort((a, b) => a.path.localeCompare(b.path));
      const tree = repo.truncatedTree ? all.filter((e) => e.path.split('/').length <= 2) : all;
      return { status: 200, body: { sha: g.tree, truncated: repo.truncatedTree === true, tree } };
    }
    const stat = /^stats\/(\w+)$/.exec(resource)?.[1];
    if (stat && repo.computeFirst?.includes(stat) && !alreadyComputed.has(`${k}:${stat}`)) {
      alreadyComputed.add(`${k}:${stat}`);
      return { status: 202, body: {} };
    }
    switch (resource) {
      case 'stats/commit_activity':
        return { status: 200, body: s.weeks.slice(-52).map((w) => ({ week: w.week, total: w.total, days: [0, 0, 0, 0, 0, 0, 0] })) };
      case 'stats/code_frequency':
        return { status: 200, body: s.weeks.map((w) => [w.week, w.added, -w.removed]) };
      case 'stats/contributors':
        return { status: 200, body: s.contributors };
      case 'languages': {
        const extras = EXTRA_LANGUAGES[repo.language] ?? [];
        const total = 400_000 + (hash32(k) % 600_000);
        const remainder = 1 - extras.reduce((a, [, f]) => a + f, 0);
        return { status: 200, body: Object.fromEntries([[repo.language, Math.round(total * remainder)], ...extras.map(([n, f]) => [n, Math.round(total * f)])]) };
      }
      case 'community/profile':
        return { status: 200, body: { health_percentage: 57 + (hash32(k) % 43) } };
      case 'actions/runs': {
        const since = Date.parse(`${(url.searchParams.get('created') ?? '>=1970-01-01').slice(2)}T00:00:00Z`);
        const inside = s.runs.filter((x) => Date.parse(x.created_at) >= since);
        return { status: 200, body: { total_count: inside.length, workflow_runs: inside.slice(0, 100) } };
      }
    }
    if (!canWrite(repo)) return { status: 403, body: { message: 'Must have push access to repository' } };
    const h = hash32(k);
    switch (resource) {
      case 'traffic/views':
        return { status: 200, body: { count: 300 + (h % 1500), uniques: 80 + (h % 300) } };
      case 'traffic/clones':
        return { status: 200, body: { count: 20 + (h % 90), uniques: 5 + (h % 30) } };
      case 'traffic/popular/referrers':
        return { status: 200, body: [{ referrer: 'github.com', count: 400 }, { referrer: 'Google', count: 120 }, { referrer: 'npmjs.com', count: 40 }] };
      case 'dependabot/alerts':
        return { status: 200, body: Array.from({ length: repo.dependabot ?? 0 }, (_, i) => ({ number: i + 1, state: 'open' })) };
      case 'code-scanning/alerts':
        return repo.codeScanning === null ? { status: 404, body: { message: 'no analysis found' } } : { status: 200, body: Array.from({ length: repo.codeScanning ?? 0 }, (_, i) => ({ number: i + 1 })) };
    }
    return { status: 404, body: { message: 'Not Found' } };
  }

  const authRoutes = auth
    ? createFakeGithubAuthRoutes(auth, {
        now,
        calls,
        organizations: () => data.organizations,
        repoNames: (org) => {
          const names = data.repos.filter((r) => r.owner.toLowerCase() === org.toLowerCase()).map((r) => r.name);
          return names.length > 0 || data.organizations.includes(org) ? names : null;
        },
      })
    : null;
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (authRoutes) {
      const answer = authRoutes.answer(url, init);
      if (answer) return answer;
      if (!authRoutes.authorized(init)) {
        calls.push(`UNAUTHORIZED ${url.pathname}`);
        return Response.json({ message: 'Bad credentials' }, { status: 401 });
      }
    }
    if (url.pathname.endsWith('/graphql') && init?.method === 'POST') {
      let answer: unknown;
      try {
        answer = graphql(JSON.parse(String(init.body)));
      } catch (err) {
        if (err instanceof FakeGraphqlError) return Response.json({ data: null, errors: [{ type: err.type, message: err.message }] }, { status: 200 });
        throw err;
      }
      if (answer === null) return Response.json({ errors: [{ message: 'operação desconhecida no GitHub falso' }] }, { status: 200 });
      return Response.json({ data: answer });
    }
    const path = `${url.pathname}${url.search}`;
    const r = rest(path);
    if (r.status !== 200) return new Response(r.status === 202 ? '{}' : JSON.stringify(r.body), { status: r.status });
    const text = JSON.stringify(r.body);
    const etag = `"${hash32(text).toString(16)}"`;
    const asked = new Headers(init?.headers).get('if-none-match');
    if (asked === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(text, { status: 200, headers: { etag, 'content-type': 'application/json' } });
  };
  return {
    fetch: fake as typeof fetch,
    calls,
    writes,
    pullRequests,
    failNext: (operation) => void failures.add(operation),
    auth: authRoutes?.state ?? null,
    refs: (owner, name) => {
      const repo = find(owner, name);
      return repo ? Object.fromEntries([...branchesOf(repo)].map(([b, x]) => [b, x.oid])) : {};
    },
  };
}

/**
 * The Projects the fake account sees (#241, `ProjectOptions`): the simulator's Project `exemplo/3`
 * (organization, with Status), one of the person's without a Status field and one closed.
 */
function projectOptions(data: FakeGithubData, rateLimit: unknown): unknown {
  const node = (owner: string, type: 'User' | 'Organization', number: number, title: string, items: number, status: boolean, closed = false) => ({
    number,
    title,
    url: `https://github.com/${type === 'User' ? 'users' : 'orgs'}/${owner}/projects/${number}`,
    closed,
    owner: { __typename: type, login: owner },
    items: { totalCount: items },
    field: status ? { __typename: 'ProjectV2SingleSelectField' } : null,
  });
  return {
    rateLimit,
    viewer: {
      login: data.login,
      projectsV2: { totalCount: 2, nodes: [node(data.login, 'User', 1, 'Notas soltas', 4, false), node(data.login, 'User', 2, 'Arquivo de 2025', 12, true, true)] },
      organizations: {
        nodes: [
          { login: 'exemplo', projectsV2: { totalCount: 1, nodes: [node('exemplo', 'Organization', 3, 'Ahrena Console', 12, true)] } },
          ...data.organizations.map((login) => ({ login, projectsV2: { totalCount: 0, nodes: [] } })),
        ],
      },
    },
  };
}

interface GitFake {
  files: Record<string, string>;
  oids: Map<string, string>;
  folders: Set<string>;
  tree: string;
  commit: string;
}

const oidOf = (text: string) => createHash('sha1').update(text).digest('hex');

/** A file's Git `oid`: SHA-1 of `blob <bytes>\0<text>`. */
export function blobOid(text: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
}

function buildGit(repo: FakeRepo): GitFake {
  const files = repo.files ?? { 'README.md': `# ${repo.name}\n` };
  const oids = new Map(Object.entries(files).map(([p, t]) => [p, blobOid(t)] as const));
  const folders = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const tree = oidOf(`tree ${[...oids].sort().map(([p, o]) => `${p}:${o}`).join('\n')}`);
  return { files, oids, folders, tree, commit: oidOf(`commit ${repo.owner}/${repo.name}:${tree}`) };
}

const OPEN_TITLES = [
  'Exportar o relatório em CSV',
  'Trocar o motor de templates',
  'Retry com backoff na fila',
  'Separar pagamentos em serviços',
  'Cache das consultas do catálogo',
  'Migração do esquema de pedidos',
  'Paginação na listagem de itens',
  'Mensagem de erro mais clara no login',
  'Atualizar as dependências de build',
  'Teste de carga do endpoint de busca',
  'Documentar a configuração local',
  'Filtro por data no histórico',
] as const;

/**
 * A repository's open PRs and issues for the Delivery tab (#266), the oldest first: the series' open
 * PRs (the newest, `repo.prs`) and `repo.issues` issues opened up to 60 days ago, with synthetic
 * titles and states. Deterministic by repository.
 */
function deliveryOpenItems(repo: FakeRepo, s: Series, now: number) {
  const r = new SeededRandom(`${repo.owner}/${repo.name}:open`);
  const url = `https://github.com/${repo.owner}/${repo.name}`;
  const prs = s.prs
    .filter((p) => p.state === 'OPEN')
    .map((p, i) => {
      const number = 200 + i * 3;
      const draft = i % 4 === 1;
      const ci = repo.ci === 'FAILURE' && i === 0 ? 'FAILURE' : 'SUCCESS';
      return {
        __typename: 'PullRequest' as const,
        number,
        title: OPEN_TITLES[(number + repo.name.length) % OPEN_TITLES.length],
        url: `${url}/pull/${number}`,
        createdAt: p.createdAt as string,
        isDraft: draft,
        reviewDecision: i % 3 === 2 ? ('APPROVED' as const) : ('REVIEW_REQUIRED' as const),
        commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
      };
    });
  const issues = Array.from({ length: repo.issues }, (_, i) => {
    const number = 20 + i * 5;
    const linked = i % 5 === 2 && prs[0] ? prs[0].number : null;
    return {
      __typename: 'Issue' as const,
      number,
      title: OPEN_TITLES[(number * 7 + repo.name.length) % OPEN_TITLES.length],
      url: `${url}/issues/${number}`,
      createdAt: iso(now - r.int(1, 60 * 24) * 3_600_000),
      closedByPullRequestsReferences: { nodes: linked ? [{ number: linked, state: 'OPEN' }] : [] },
    };
  });
  return [...prs, ...issues].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

const empty = () => ({ issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] });
const page = (nodes: unknown[]) => ({ issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes });

/**
 * The demo repositories' files in the Instructions tab (#183, C32 and C33) and in the framework
 * install (#184, C36 and C37). Synthetic.
 * - `exemplo-labs/vitrine-demo`: everything the tab shows, no warning;
 * - `exemplo-labs/motor-de-regras`: the four warnings (truncated tree, broken settings.json,
 *   AGENTS.md without import and an import that does not exist); the install is blocked by the JSON;
 * - `estudio-ficticio/app-receitas`: only AGENTS.md, brought in by CLAUDE.md;
 * - `exemplo-labs/painel-de-metricas`: instructions without the framework, Python with FastAPI, tests
 *   and CI: the install creates AGENTS.md and merges CLAUDE.md and settings.json;
 * - `exemplo-labs/gateway-sandbox`: a Go service the account only reads: no install button;
 * - the others (like `dev-sintetico/blog-estatico`): only a README, the empty case (C33 offers Install).
 */
export const DEMO_INSTRUCTION_FILES: Record<string, { files: Record<string, string>; truncatedTree?: boolean }> = {
  'exemplo-labs/vitrine-demo': {
    files: {
      'README.md': '# vitrine-demo\n\nVitrine sintética da demonstração do Ahrena Console.\n',
      'CLAUDE.md': [
        '# vitrine-demo',
        '',
        'Leia as convenções do time antes de mudar qualquer coisa.',
        '',
        '@AGENTS.md',
        '@docs/style.md',
        '@~/.claude/personal-preferences.md',
        '',
        '## Exemplos',
        '',
        'Um `@` dentro de bloco de código não é import:',
        '',
        '```md',
        '@docs/not-an-import.md',
        '```',
        '',
        'Nem `@docs/inline.md` num trecho de código. Dúvidas sobre o design? Fale com @colega-a.',
        '',
      ].join('\n'),
      'AGENTS.md': '# Convenções\n\n- Código, rotas e chaves JSON em inglês; a tela em pt-BR.\n- Rode `npm test` antes de abrir o PR.\n- Um assunto por commit.\n',
      'docs/style.md': '# Guia de estilo\n\n- Componentes com o prefixo da tela.\n- Funções pequenas, nomes que dizem o que fazem.\n- Veja também @../README.md\n',
      'packages/ui/CLAUDE.md': '# packages/ui\n\nClasses CSS com o prefixo da tela (`vit-`). Nada de cor solta: use os tokens.\n',
      'packages/api/CLAUDE.md': '# packages/api\n\n@AGENTS.md\n',
      'packages/api/AGENTS.md': '# packages/api\n\nRotas em inglês, mensagens de erro em pt-BR.\n',
      '.claude/rules/tests.md': '---\npaths:\n  - "test/**"\n  - "**/*.test.ts"\n---\nUse o GitHub falso nos testes; nunca a API real.\n',
      '.claude/rules/style.md': '---\ndescription: Estilo geral do código\n---\nPrefira funções pequenas e nomes em inglês.\n',
      '.claude/skills/release/SKILL.md': '---\nname: release\ndescription: Publica uma versão do app, com changelog e tag.\n---\n\n# Release\n\n1. Atualize o changelog.\n2. Crie a tag.\n',
      '.claude/skills/screenshots/SKILL.md': '---\nname: screenshots\ndescription: Tira as capturas das telas para o PR.\n---\n',
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Revisa o diff contra as regras do repositório.\n---\n\nVocê revisa diffs.\n',
      '.claude/commands/pr/open.md': 'Abra o PR com o template do repositório.\n',
      '.claude/commands/check.md': 'Rode os testes e o lint.\n',
      '.claude/hooks/format.sh': '#!/bin/sh\nnpx prettier --write "$1"\n',
      '.claude/settings.json': JSON.stringify(
        {
          permissions: { allow: ['Bash(npm test)'] },
          enabledPlugins: { 'review-kit@team-tools': true, 'old-kit@team-tools': false },
          extraKnownMarketplaces: { 'team-tools': { source: { source: 'github', repo: 'exemplo-labs/team-tools' } } },
          hooks: {
            PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'sh .claude/hooks/format.sh' }] }],
            Stop: [{ hooks: [{ type: 'command', command: 'echo pronto' }] }],
          },
        },
        null,
        2,
      ),
      '.mcp.json': JSON.stringify({ mcpServers: { tracker: { command: 'npx', args: ['-y', 'tracker-mcp-sintetico'] }, docs: { url: 'https://docs.example.invalid/mcp' } } }, null, 2),
      'src/index.ts': 'export {};\n',
    },
  },
  'exemplo-labs/motor-de-regras': {
    truncatedTree: true,
    files: {
      'README.md': '# motor-de-regras\n',
      'CLAUDE.md': '# motor-de-regras\n\n@docs/missing-guide.md\n\nRode `npm run check` antes do PR.\n',
      'AGENTS.md': '# motor-de-regras\n\nO código novo em inglês; o legado fica como está.\n',
      '.claude/settings.json': '{ "hooks": { "Stop": [ ] ,\n',
      'src/rules/engine.ts': 'export {};\n',
      'services/billing/workers/AGENTS.md': '# workers\n\nFilas idempotentes.\n',
    },
  },
  'exemplo-labs/painel-de-metricas': {
    files: {
      'README.md': '# painel-de-metricas\n\nPainel sintético de métricas da demonstração.\n',
      'CLAUDE.md': '# painel-de-metricas\n\nUse o ambiente virtual do projeto e rode `pytest` antes do PR.\n',
      '.claude/settings.json': `${JSON.stringify({ permissions: { allow: ['Bash(pytest)', 'Bash(ruff check .)'] } }, null, 2)}\n`,
      'pyproject.toml': '[project]\nname = "painel-de-metricas"\nversion = "0.3.0"\ndependencies = [\n  "fastapi>=0.115",\n  "uvicorn>=0.30",\n]\n\n[project.optional-dependencies]\ndev = ["pytest>=8", "ruff>=0.6"]\n',
      'app/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n',
      'app/metrics.py': 'def total(values):\n    return sum(values)\n',
      'tests/test_metrics.py': 'from app.metrics import total\n\n\ndef test_total():\n    assert total([1, 2]) == 3\n',
      '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pytest\n',
    },
  },
  'exemplo-labs/gateway-sandbox': {
    files: {
      'README.md': '# gateway-sandbox\n\nGateway sintético de testes.\n',
      'go.mod': 'module example.invalid/gateway-sandbox\n\ngo 1.23\n',
      'cmd/gateway/main.go': 'package main\n\nfunc main() {}\n',
      'internal/route/route.go': 'package route\n',
      'internal/route/route_test.go': 'package route\n',
    },
  },
  'estudio-ficticio/app-receitas': {
    files: {
      'README.md': '# app-receitas\n',
      'CLAUDE.md': '@AGENTS.md\n',
      'AGENTS.md': '# app-receitas\n\n- Kotlin com coroutines; nada de bloqueio na thread principal.\n- Telas em pt-BR.\n',
    },
  },
};

const withFiles = (repo: FakeRepo): FakeRepo => {
  const key = `${repo.owner}/${repo.name}`;
  const extra = DEMO_INSTRUCTION_FILES[key];
  // Os registros de decisão (#174) somam-se aos arquivos de instrução; sem nenhum dos dois, fica só o README.
  const decisions = DEMO_DECISION_FILES[key];
  if (!extra && !decisions) return repo;
  const files = { ...(extra?.files ?? { 'README.md': `# ${repo.name}\n` }), ...decisions };
  return { ...repo, files, ...(extra?.truncatedTree ? { truncatedTree: true } : {}) };
};

/** The demo, as in wireframe C22: two orgs, the personal account and eight repositories. */
/** The fake GitHub's address in the demo: it does not resolve, so even if the fake failed nothing reaches GitHub. */
export const FAKE_GITHUB_BASE = 'https://fake-github.invalid';

export const DEMO_GITHUB_DATA: FakeGithubData = {
  login: 'dev-sintetico',
  organizations: ['exemplo-labs', 'estudio-ficticio'],
  awaitingReview: 4,
  closedThisWeek: 17,
  repos: ([
    { owner: 'exemplo-labs', name: 'vitrine-demo', isPrivate: false, language: 'TypeScript', permission: 'ADMIN', pushMin: 2, issues: 14, prs: 3, ci: 'SUCCESS', commitsPerWeek: 14, stars: 128, forks: 14, watchers: 9, license: 'MIT', release: { tag: 'v0.4.2', daysAgo: 6 }, releases: 12, dependabot: 2, codeScanning: 0 },
    { owner: 'exemplo-labs', name: 'motor-de-regras', isPrivate: true, language: 'TypeScript', permission: 'WRITE', pushMin: 12, issues: 9, prs: 5, ci: 'PENDING', commitsPerWeek: 11, stars: 3, forks: 1, watchers: 4, license: null, release: { tag: 'v2.1.0', daysAgo: 20 }, releases: 31, dependabot: 5, codeScanning: 1 },
    { owner: 'exemplo-labs', name: 'painel-de-metricas', isPrivate: true, language: 'Python', permission: 'WRITE', pushMin: 3, issues: 6, prs: 2, ci: 'FAILURE', commitsPerWeek: 8, stars: 1, forks: 0, watchers: 3, license: null, release: null, releases: 0, dependabot: 1, codeScanning: null, computeFirst: ['contributors'] },
    { owner: 'exemplo-labs', name: 'gateway-sandbox', isPrivate: true, language: 'Go', permission: 'READ', pushMin: 26 * 60, issues: 4, prs: 1, ci: 'SUCCESS', commitsPerWeek: 5, stars: 0, forks: 0, watchers: 2, license: null, release: { tag: 'v0.9.0', daysAgo: 45 }, releases: 6 },
    { owner: 'estudio-ficticio', name: 'app-receitas', isPrivate: true, language: 'Kotlin', permission: 'WRITE', pushMin: 6, issues: 11, prs: 4, ci: 'SUCCESS', commitsPerWeek: 9, stars: 2, forks: 0, watchers: 5, license: null, release: { tag: 'v1.8.3', daysAgo: 3 }, releases: 22, dependabot: 0, codeScanning: 0 },
    { owner: 'estudio-ficticio', name: 'catalogo-exemplo', isPrivate: false, language: 'TypeScript', permission: 'READ', pushMin: 4, issues: 3, prs: 1, ci: 'SUCCESS', commitsPerWeek: 6, stars: 42, forks: 7, watchers: 6, license: 'Apache-2.0', release: { tag: 'v3.0.0', daysAgo: 12 }, releases: 9 },
    { owner: 'dev-sintetico', name: 'cli-de-notas', isPrivate: false, language: 'Rust', permission: 'ADMIN', pushMin: 2 * 24 * 60, issues: 2, prs: 0, ci: 'SUCCESS', commitsPerWeek: 4, stars: 17, forks: 2, watchers: 1, license: 'MIT', release: { tag: 'v0.2.0', daysAgo: 30 }, releases: 4, dependabot: 0, codeScanning: 0 },
    { owner: 'dev-sintetico', name: 'blog-estatico', isPrivate: false, language: 'Astro', permission: 'ADMIN', pushMin: 60, issues: 1, prs: 1, ci: 'SUCCESS', commitsPerWeek: 3, stars: 5, forks: 1, watchers: 1, license: 'MIT', release: null, releases: 0, dependabot: 1, codeScanning: 0 },
  ] as FakeRepo[]).map(withFiles),
};

/**
 * The framework's repository in the fake (#184): `.claude-plugin/marketplace.json` and each plugin's
 * rules with their frontmatter, rebuilt from the package's snapshot (src/framework-install/catalog-snapshot.json).
 * Not in the Repositories screen: only the framework install reads it.
 */
export function fakeFrameworkRepo(fullName: string = DEFAULT_FRAMEWORK_REPO): FakeRepo {
  const [owner, name] = fullName.split('/');
  const catalog = catalogSnapshot();
  const files: Record<string, string> = {
    'README.md': '# ahrena-framework\n\nSynthetic copy of the framework catalog for the demo.\n',
    [MARKETPLACE_PATH]: `${JSON.stringify(
      {
        name: catalog.marketplace,
        plugins: catalog.plugins.map((p) => ({ name: p.name, description: p.description, keywords: p.keywords, source: { source: 'git-subdir', url: `https://github.com/${fullName}.git`, path: p.path } })),
      },
      null,
      2,
    )}\n`,
  };
  for (const p of catalog.plugins) {
    for (const r of p.rules) files[r.path] = `---\nid: ${r.id}\ntitle: ${r.title}\nstatement: ${r.statement}\nenforcement: ${r.enforcement}\n---\n\n# ${r.title}\n\n${r.statement}\n`;
  }
  return { owner, name, isPrivate: false, language: 'Markdown', permission: 'READ', pushMin: 60, issues: 0, prs: 0, ci: 'SUCCESS', commitsPerWeek: 5, files };
}

/**
 * The Delivery tab's fake GitHub (#266): the demo's repositories plus one that no simulated session
 * works in (`portal-de-ajuda` is not a simulator project), so the tab shows a repository without Claude
 * hours. Only the Delivery read uses it; the Repositories screen keeps `DEMO_GITHUB_DATA`.
 */
export const DEMO_DELIVERY_GITHUB_DATA: FakeGithubData = {
  ...DEMO_GITHUB_DATA,
  repos: [
    ...DEMO_GITHUB_DATA.repos,
    { owner: 'estudio-ficticio', name: 'portal-de-ajuda', isPrivate: true, language: 'TypeScript', permission: 'WRITE', pushMin: 5 * 60, issues: 5, prs: 2, ci: 'SUCCESS', commitsPerWeek: 7 },
  ],
};

/**
 * The demo's GitHub Projects for the Delivery tab (#266, wireframe C55): three projects over the
 * Delivery fake's repositories, with `gateway-sandbox` in two of them. The key is the Project's `owner/number`.
 */
export const DEMO_DELIVERY_PROJECTS: { key: string; label: string; repos: string[] }[] = [
  { key: 'exemplo-labs/7', label: 'Loja de exemplo', repos: ['exemplo-labs/vitrine-demo', 'estudio-ficticio/catalogo-exemplo', 'exemplo-labs/gateway-sandbox'] },
  { key: 'exemplo-labs/8', label: 'Plataforma de regras', repos: ['exemplo-labs/motor-de-regras', 'exemplo-labs/gateway-sandbox'] },
  { key: 'estudio-ficticio/2', label: 'Métricas', repos: ['exemplo-labs/painel-de-metricas', 'estudio-ficticio/app-receitas', 'estudio-ficticio/portal-de-ajuda'] },
];

/** The demo's fake git: `/simulacao/<project>` is a clone of the repository with the same name, if there is one. */
export function demoGit(data: FakeGithubData = DEMO_GITHUB_DATA) {
  return async (cwd: string, args: string[]): Promise<string | null> => {
    if (args[0] !== 'remote' || !cwd.startsWith(`${ROOT}/`)) return null;
    const repo = data.repos.find((r) => r.name === cwd.slice(ROOT.length + 1));
    return repo ? `https://github.com/${repo.owner}/${repo.name}.git` : null;
  };
}

/**
 * Sessions the simulator's scenario does not have, added to the real ones in the demo, so the screen
 * looks like the wireframe (active and "needs you" in some repositories). Only the demo uses it.
 */
export const DEMO_EXTRA_SESSIONS: Record<string, { active: number; needYou: number; thisMonth: number }> = {
  'exemplo-labs/vitrine-demo': { active: 3, needYou: 1, thisMonth: 6 },
  'exemplo-labs/motor-de-regras': { active: 3, needYou: 2, thisMonth: 5 },
  'exemplo-labs/painel-de-metricas': { active: 1, needYou: 1, thisMonth: 2 },
  'estudio-ficticio/app-receitas': { active: 1, needYou: 0, thisMonth: 3 },
};
