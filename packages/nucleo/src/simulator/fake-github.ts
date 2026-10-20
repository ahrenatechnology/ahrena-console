// Fake GitHub for the repositories (#104 and #105): a `fetch` that answers the GraphQL and REST that
// src/github/repos-source.ts calls, with synthetic, deterministic data. It serves the demo
// (`npm run api -- --demo`) and the tests; it never goes to the network, and any route it does not
// know gives 404 and is recorded in `calls`.
//
// It imitates what the screens depend on from GitHub: ETag and 304 with `If-None-Match`, 202 while a
// statistic "computes" (`computeFirst`), 403 on traffic and on alerts without write access.
// A repository's files (`files`, #183) answer the discovery (`RepoFilesDiscovery`), the content
// batches (`RepoBlobs`, by `oid` or by `<commit>:<path>`) and the recursive tree
// (`git/trees/HEAD?recursive=1`), with Git's `oid` (SHA-1 of `blob <size>\0<text>`).
// Names follow the simulator's vocabulary (vocabulary.ts): orgs `exemplo-labs` and
// `estudio-ficticio`, account `dev-sintetico`, projects under /simulacao.

import { createHash } from 'node:crypto';
import { SeededRandom, hash32 } from './random.ts';
import { ROOT } from './vocabulary.ts';

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
}

export interface FakeGithubData {
  login: string;
  organizations: string[];
  repos: FakeRepo[];
  awaitingReview: number;
  closedThisWeek: number;
}

export interface FakeGithubOptions {
  now?: () => number;
  /** Delay of each answer, in ms (the demo shows the "loading"). */
  delayMs?: number;
}

export interface FakeGithub {
  fetch: typeof fetch;
  /** `GRAPHQL <operation>` or `GET <path>`, in order. */
  calls: string[];
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

export function createFakeGithub(data: FakeGithubData, { now = Date.now, delayMs = 0 }: FakeGithubOptions = {}): FakeGithub {
  const calls: string[] = [];
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
    };
  };


  // The operation names, variables and response aliases (`fechadas`, `abertas`, `mergeados`,
  // `fechadosSemMerge`) are the ones src/github/repos-source.ts sends: they stay as they are.
  function graphql(body: { query: string; variables: Record<string, string> }): unknown {
    const op = /query (\w+)/.exec(body.query)?.[1] ?? '?';
    calls.push(`GRAPHQL ${op}`);
    const v = body.variables ?? {};
    if (op === 'ReposLista') {
      return {
        rateLimit,
        viewer: {
          login: data.login,
          organizations: { nodes: data.organizations.map((login) => ({ login })) },
          repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: data.repos.map((x) => rawRepo(x, now())) },
        },
      };
    }
    if (op === 'RepoFilesDiscovery') {
      const repo = find(v.owner, v.name);
      return { rateLimit, repository: repo ? discovery(repo) : null };
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
        out[`b${m[2]}`] =
          text !== undefined
            ? { oid: g.oids.get(path!), byteSize: Buffer.byteLength(text), isBinary: false, text }
            : path !== undefined && g.folders.has(path)
              ? {}
              : null;
      }
      return { rateLimit, repository: out };
    }
    if (op === 'ReposResumo') return { rateLimit, review: { issueCount: data.awaitingReview }, fechadas: { issueCount: data.closedThisWeek } };
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

  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/graphql') && init?.method === 'POST') {
      const answer = graphql(JSON.parse(String(init.body)));
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
  return { fetch: fake as typeof fetch, calls };
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

const empty = () => ({ issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] });
const page = (nodes: unknown[]) => ({ issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes });

/**
 * The demo repositories' files in the Instructions tab (#183, C32 and C33). Synthetic.
 * - `exemplo-labs/vitrine-demo`: everything the tab shows, no warning;
 * - `exemplo-labs/motor-de-regras`: the four warnings (truncated tree, broken settings.json,
 *   AGENTS.md without import and an import that does not exist);
 * - `estudio-ficticio/app-receitas`: only AGENTS.md, brought in by CLAUDE.md;
 * - the others (like `dev-sintetico/blog-estatico`): only a README, the empty case.
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
  'estudio-ficticio/app-receitas': {
    files: {
      'README.md': '# app-receitas\n',
      'CLAUDE.md': '@AGENTS.md\n',
      'AGENTS.md': '# app-receitas\n\n- Kotlin com coroutines; nada de bloqueio na thread principal.\n- Telas em pt-BR.\n',
    },
  },
};

const withFiles = (repo: FakeRepo): FakeRepo => {
  const extra = DEMO_INSTRUCTION_FILES[`${repo.owner}/${repo.name}`];
  return extra ? { ...repo, files: extra.files, ...(extra.truncatedTree ? { truncatedTree: true } : {}) } : repo;
};

/** The demo, as in wireframe C22: two orgs, the personal account and eight repositories. */
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
