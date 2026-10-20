// Fake GitHub for the repositories (#104 and #105): a `fetch` that answers the GraphQL and REST that
// src/github/repos-source.ts calls, with synthetic, deterministic data. It serves the demo
// (`npm run api -- --demo`) and the tests; it never goes to the network, and any route it does not
// know gives 404 and is recorded in `chamadas`.
//
// It imitates what the screens depend on from GitHub: ETag and 304 with `If-None-Match`, 202 while a
// statistic "computes" (`calcularPrimeiro`), 403 on traffic and on alerts without write access.
// A repository's files (`files`, #183) answer the discovery (`RepoFilesDiscovery`), the content
// batches (`RepoBlobs`, by `oid` or by `<commit>:<path>`) and the recursive tree
// (`git/trees/HEAD?recursive=1`), with Git's `oid` (SHA-1 of `blob <size>\0<text>`).
// Names follow the simulator's vocabulary (vocabulary.ts): orgs `exemplo-labs` and
// `estudio-ficticio`, account `dev-sintetico`, projects under /simulacao.

import { createHash } from 'node:crypto';
import { Aleatorio, hash32 } from './random.ts';
import { RAIZ } from './vocabulary.ts';

export interface RepoFalso {
  dono: string;
  nome: string;
  privado: boolean;
  linguagem: string;
  /** viewerPermission. */
  permissao: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ';
  /** Último push, em minutos atrás. */
  pushMin: number;
  issues: number;
  prs: number;
  ci: 'SUCCESS' | 'FAILURE' | 'PENDING' | null;
  /** Commits por semana, em média (a sparkline varia em volta disto). */
  ritmo: number;
  estrelas?: number;
  forks?: number;
  observadores?: number;
  licenca?: string | null;
  release?: { tag: string; diasAtras: number } | null;
  /** Releases desde sempre: a mais nova em `release.diasAtras` (ou 10 dias), as outras a cada 40 dias. */
  releases?: number;
  /** Estatísticas que respondem 202 na primeira chamada: `commit_activity`, `code_frequency`, `contributors`. */
  calcularPrimeiro?: string[];
  dependabot?: number;
  codeScanning?: number | null;
  /** Os arquivos do branch padrão, caminho → texto (#183). Sem eles, só um README. */
  files?: Record<string, string>;
  /** A árvore recursiva vem cortada (`truncated: true`), sem os arquivos de 3 pastas ou mais de fundo. */
  truncatedTree?: boolean;
}

export interface DadosDoGithubFalso {
  login: string;
  organizacoes: string[];
  repos: RepoFalso[];
  esperandoReview: number;
  fechadasNaSemana: number;
}

export interface OpcoesDoGithubFalso {
  agora?: () => number;
  /** Atraso de cada resposta, em ms (a demonstração mostra o "carregando"). */
  atrasoMs?: number;
}

export interface GithubFalso {
  fetch: typeof fetch;
  /** `GRAPHQL <operação>` ou `GET <caminho>`, na ordem. */
  chamadas: string[];
}

const DIA = 24 * 60 * 60_000;
const SEMANA = 7 * DIA;
const TIPOS = ['História', 'Tarefa técnica', 'Bug', 'Spike', 'Épico'] as const;
const PESOS_DOS_TIPOS = [0.4, 0.3, 0.17, 0.09, 0.04];
const AUTORES = [
  { login: 'dev-sintetico', __typename: 'User', peso: 0.45 },
  { login: 'colega-a', __typename: 'User', peso: 0.2 },
  { login: 'colega-b', __typename: 'User', peso: 0.1 },
  { login: 'dependabot[bot]', __typename: 'Bot', peso: 0.1 },
  { login: 'dev-sintetico', __typename: 'User', peso: 0.15, claude: true },
] as const;
const LINGUAGENS_EXTRAS: Record<string, [string, number][]> = {
  TypeScript: [['CSS', 0.12], ['HTML', 0.09], ['Shell', 0.05], ['JavaScript', 0.03]],
  Python: [['Jupyter Notebook', 0.15], ['Shell', 0.04], ['Dockerfile', 0.01]],
  Go: [['Makefile', 0.03], ['Shell', 0.02]],
  Kotlin: [['Java', 0.1], ['Shell', 0.01]],
  Rust: [['Shell', 0.02]],
  Astro: [['TypeScript', 0.2], ['CSS', 0.15], ['MDX', 0.08]],
};

/** Domingo 00:00 UTC da semana de `ms`. */
const domingo = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * DIA;
};
const iso = (ms: number) => new Date(ms).toISOString();

function pesado<T extends { peso: number }>(r: Aleatorio, itens: readonly T[]): T {
  let x = r.proximo() * itens.reduce((s, i) => s + i.peso, 0);
  for (const i of itens) if ((x -= i.peso) < 0) return i;
  return itens[itens.length - 1];
}

interface Series {
  semanas: { week: number; total: number; adicionadas: number; removidas: number }[];
  prs: Record<string, unknown>[];
  fechadas: Record<string, unknown>[];
  abertas: Record<string, unknown>[];
  runs: { status: string; conclusion: string; created_at: string; run_started_at: string; updated_at: string }[];
  contribuidores: { author: { login: string; type: string }; total: number; weeks: { w: number; a: number; d: number; c: number }[] }[];
}

/** As séries de um repositório, de 3 anos até a semana de `agora`. */
function gerarSeries(repo: RepoFalso, agora: number): Series {
  const r = new Aleatorio(`${repo.dono}/${repo.nome}`);
  const fim = domingo(agora);
  const semanas: Series['semanas'] = [];
  const pesos = [0.55, 0.22, 0.15, 0.08];
  const contrib = ['dev-sintetico', 'colega-a', 'colega-b', 'github-actions[bot]'].map((login, i) => ({
    author: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
    total: 0,
    weeks: [] as { w: number; a: number; d: number; c: number }[],
    peso: pesos[i],
  }));
  // Uma onda lenta mais ruído: a sparkline não sai reta nem repetida entre repositórios.
  const fase = r.proximo() * Math.PI * 2;
  for (let i = 155; i >= 0; i--) {
    const week = fim - i * SEMANA;
    const onda = 1 + 0.6 * Math.sin(fase + i / 2.3) + 0.3 * Math.sin(fase * 2 + i / 0.9);
    const total = Math.max(0, Math.round(repo.ritmo * onda * (0.6 + r.proximo() * 0.8)));
    const adicionadas = total * r.inteiro(30, 140);
    const removidas = Math.round(adicionadas * (0.25 + r.proximo() * 0.35));
    semanas.push({ week: week / 1000, total, adicionadas, removidas });
    let restoC = total;
    let restoA = adicionadas;
    let restoD = removidas;
    contrib.forEach((c, j) => {
      const ultimo = j === contrib.length - 1;
      const cc = ultimo ? restoC : Math.min(restoC, Math.round(total * c.peso));
      const aa = ultimo ? restoA : Math.min(restoA, Math.round(adicionadas * c.peso));
      const dd = ultimo ? restoD : Math.min(restoD, Math.round(removidas * c.peso));
      restoC -= cc;
      restoA -= aa;
      restoD -= dd;
      c.weeks.push({ w: week / 1000, a: aa, d: dd, c: cc });
      c.total += cc;
    });
  }

  // PRs do último ano: os abertos agora são os `repo.prs` mais novos.
  const prs: Record<string, unknown>[] = [];
  const porSemana = Math.max(1, Math.round(repo.ritmo / 3));
  for (let s = 0; s < 52; s++) {
    for (let k = 0; k < porSemana; k++) {
      const criado = agora - s * SEMANA - r.inteiro(1, 6 * 24) * 3_600_000;
      const autor = pesado(r, AUTORES);
      const reviewEm = criado + r.inteiro(1, 9) * 3_600_000 + r.inteiro(0, 59) * 60_000;
      const fechado = criado + r.inteiro(3, 70) * 3_600_000;
      const merge = r.chance(0.88);
      const reviews = autor.__typename === 'Bot' && r.chance(0.5) ? 0 : r.inteiro(1, 3);
      prs.push({
        createdAt: iso(criado),
        mergedAt: merge ? iso(fechado) : null,
        closedAt: iso(fechado),
        state: merge ? 'MERGED' : 'CLOSED',
        additions: r.inteiro(8, 420),
        deletions: r.inteiro(0, 160),
        headRefName: 'claude' in autor ? `claude/tarefa-${s}-${k}` : autor.__typename === 'Bot' ? `dependabot/npm/pacote-${s}` : `feat/${100 + s}-${k}`,
        author: { login: autor.login, __typename: autor.__typename },
        reviews: { totalCount: reviews, nodes: reviews ? [{ createdAt: iso(Math.min(reviewEm, fechado - 60_000)) }] : [] },
        pedidosDeMudanca: { totalCount: reviews > 1 ? r.inteiro(0, reviews - 1) : 0 },
        _atualizado: fechado,
      });
    }
  }
  for (let k = 0; k < repo.prs; k++) {
    const criado = agora - r.inteiro(1, 9 * 24) * 3_600_000;
    prs.push({
      createdAt: iso(criado), mergedAt: null, closedAt: null, state: 'OPEN', additions: r.inteiro(10, 300), deletions: r.inteiro(0, 90),
      headRefName: k % 2 ? `claude/aberto-${k}` : `feat/${300 + k}-aberto`, author: { login: 'dev-sintetico', __typename: 'User' },
      reviews: { totalCount: 0, nodes: [] }, pedidosDeMudanca: { totalCount: 0 }, _atualizado: criado,
    });
  }

  const tipo = () => (r.chance(0.08) ? null : { name: pesado(r, TIPOS.map((t, i) => ({ t, peso: PESOS_DOS_TIPOS[i] }))).t });
  const fechadas: Record<string, unknown>[] = [];
  for (let s = 0; s < 52; s++) {
    for (let k = 0; k < Math.max(1, Math.round(repo.ritmo / 4)); k++) {
      const fechou = agora - s * SEMANA - r.inteiro(0, 6 * 24) * 3_600_000;
      fechadas.push({ createdAt: iso(fechou - r.inteiro(4, 24 * 9) * 3_600_000), closedAt: iso(fechou), issueType: tipo() });
    }
  }
  const abertas = Array.from({ length: repo.issues }, () => ({ issueType: tipo() }));

  // Runs do último ano: alguns por dia útil, verdes conforme o CI do repositório.
  const verde = repo.ci === 'FAILURE' ? 0.78 : repo.ci === 'PENDING' ? 0.9 : 0.95;
  const runs: Series['runs'] = [];
  for (let dia = 0; dia < 365; dia++) {
    for (let k = 0; k < r.inteiro(0, Math.max(1, Math.round(repo.ritmo / 5))); k++) {
      const inicio = agora - dia * DIA - r.inteiro(1, 23) * 3_600_000;
      const dur = r.inteiro(2, 11) * 60_000 + r.inteiro(0, 59) * 1000;
      runs.push({ status: 'completed', conclusion: r.chance(verde) ? 'success' : r.chance(0.85) ? 'failure' : 'cancelled', created_at: iso(inicio), run_started_at: iso(inicio + 5_000), updated_at: iso(inicio + dur) });
    }
  }
  return { semanas, prs, fechadas, abertas, runs, contribuidores: contrib.map(({ peso: _peso, ...c }) => c) };
}

function repoCru(repo: RepoFalso, agora: number) {
  return {
    name: repo.nome,
    nameWithOwner: `${repo.dono}/${repo.nome}`,
    url: `https://github.com/${repo.dono}/${repo.nome}`,
    isPrivate: repo.privado,
    pushedAt: iso(agora - repo.pushMin * 60_000),
    viewerPermission: repo.permissao,
    owner: { login: repo.dono, __typename: repo.dono === 'dev-sintetico' ? 'User' : 'Organization' },
    primaryLanguage: { name: repo.linguagem },
    issues: { totalCount: repo.issues },
    pullRequests: { totalCount: repo.prs },
    defaultBranchRef: { name: 'main', target: { statusCheckRollup: repo.ci ? { state: repo.ci } : null } },
  };
}

const escrita = (repo: RepoFalso) => repo.permissao === 'ADMIN' || repo.permissao === 'MAINTAIN' || repo.permissao === 'WRITE';
const desdeDaBusca = (q: string, campo: string) => {
  const m = new RegExp(`${campo}:>=(\\d{4}-\\d{2}-\\d{2})`).exec(q);
  return m ? Date.parse(`${m[1]}T00:00:00Z`) : -Infinity;
};
const semInternos = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

export function criarGithubFalso(dados: DadosDoGithubFalso, { agora = Date.now, atrasoMs = 0 }: OpcoesDoGithubFalso = {}): GithubFalso {
  const chamadas: string[] = [];
  const series = new Map<string, Series>();
  const jaCalculou = new Set<string>();
  const t0 = agora();
  const seriesDe = (repo: RepoFalso) => {
    const k = `${repo.dono}/${repo.nome}`;
    let s = series.get(k);
    if (!s) series.set(k, (s = gerarSeries(repo, t0)));
    return s;
  };
  const achar = (dono: string, nome: string) => dados.repos.find((x) => x.dono.toLowerCase() === dono.toLowerCase() && x.nome.toLowerCase() === nome.toLowerCase()) ?? null;
  const rateLimit = { cost: 1, remaining: 4999, resetAt: iso(t0 + 3_600_000) };
  const gitsByRepo = new Map<string, GitFake>();
  const gitOf = (repo: RepoFalso) => {
    const k = `${repo.dono}/${repo.nome}`;
    let g = gitsByRepo.get(k);
    if (!g) gitsByRepo.set(k, (g = buildGit(repo)));
    return g;
  };
  /** A descoberta: o commit, um apelido por arquivo da raiz e `.claude/` em 3 níveis. */
  const discovery = (repo: RepoFalso) => {
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
      nameWithOwner: `${repo.dono}/${repo.nome}`,
      head: { oid: g.commit, tree: { oid: g.tree } },
      claudeMd: blob('CLAUDE.md'),
      agentsMd: blob('AGENTS.md'),
      dotClaudeMd: blob('.claude/CLAUDE.md'),
      mcpJson: blob('.mcp.json'),
      claudeDir: g.folders.has('.claude') ? { entries: entries('.claude', 1) } : null,
    };
  };

  function graphql(corpo: { query: string; variables: Record<string, string> }): unknown {
    const op = /query (\w+)/.exec(corpo.query)?.[1] ?? '?';
    chamadas.push(`GRAPHQL ${op}`);
    const v = corpo.variables ?? {};
    if (op === 'ReposLista') {
      return {
        rateLimit,
        viewer: {
          login: dados.login,
          organizations: { nodes: dados.organizacoes.map((login) => ({ login })) },
          repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: dados.repos.map((x) => repoCru(x, agora())) },
        },
      };
    }
    if (op === 'RepoFilesDiscovery') {
      const repo = achar(v.owner, v.name);
      return { rateLimit, repository: repo ? discovery(repo) : null };
    }
    if (op === 'RepoBlobs') {
      const repo = achar(v.owner, v.name);
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
    if (op === 'ReposResumo') return { rateLimit, review: { issueCount: dados.esperandoReview }, fechadas: { issueCount: dados.fechadasNaSemana } };
    if (op === 'RepoDetalhe') {
      const repo = achar(v.o, v.r);
      if (!repo) return { rateLimit, repository: null, prs: vazia(), fechadas: vazia(), abertas: vazia(), mergeados: vazia(), fechadosSemMerge: vazia() };
      const s = seriesDe(repo);
      const desdePr = desdeDaBusca(v.prs, 'updated');
      const desdeIssue = desdeDaBusca(v.fechadas, 'closed');
      const prs = s.prs.filter((p) => (p._atualizado as number) >= desdePr).map(semInternos);
      const fechadas = s.fechadas.filter((i) => Date.parse(i.closedAt as string) >= desdeIssue);
      const desdeMerge = desdeDaBusca(v.mergeados, 'merged');
      const desdeFechado = desdeDaBusca(v.fechadosSemMerge, 'closed');
      const mergeados = s.prs.filter((p) => p.mergedAt && Date.parse(p.mergedAt as string) >= desdeMerge).length;
      const fechadosSemMerge = s.prs.filter((p) => p.state === 'CLOSED' && !p.mergedAt && Date.parse(p.closedAt as string) >= desdeFechado).length;
      const t = agora();
      const maisNova = repo.release?.diasAtras ?? 10;
      const releases = Array.from({ length: Math.min(100, repo.releases ?? 0) }, (_, i) => ({ publishedAt: iso(t - (maisNova + i * 40) * DIA) }));
      return {
        rateLimit,
        repository: {
          ...repoCru(repo, t),
          stargazerCount: repo.estrelas ?? 0,
          forkCount: repo.forks ?? 0,
          watchers: { totalCount: repo.observadores ?? 0 },
          licenseInfo: repo.licenca ? { spdxId: repo.licenca, name: repo.licenca } : null,
          latestRelease: repo.release ? { tagName: repo.release.tag, publishedAt: iso(t - repo.release.diasAtras * DIA) } : null,
          releases: { totalCount: repo.releases ?? 0, nodes: releases },
        },
        mergeados: { issueCount: mergeados },
        fechadosSemMerge: { issueCount: fechadosSemMerge },
        prs: pagina(prs),
        fechadas: pagina(fechadas),
        abertas: pagina(s.abertas),
      };
    }
    return null;
  }

  function rest(caminho: string): { status: number; corpo?: unknown } {
    chamadas.push(`GET ${caminho}`);
    const url = new URL(caminho, 'http://falso');
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    const repo = m ? achar(m[1], m[2]) : null;
    if (!m || !repo) return { status: 404, corpo: { message: 'Not Found' } };
    const recurso = m[3];
    const s = seriesDe(repo);
    const k = `${repo.dono}/${repo.nome}`;
    if (recurso === 'git/trees/HEAD') {
      const g = gitOf(repo);
      const all = [...g.folders].map((path) => ({ path, mode: '040000', type: 'tree', sha: oidOf(`tree ${k}:${path}`) }))
        .concat(Object.keys(g.files).map((path) => ({ path, mode: '100644', type: 'blob', sha: g.oids.get(path)!, size: Buffer.byteLength(g.files[path]) })))
        .sort((a, b) => a.path.localeCompare(b.path));
      const tree = repo.truncatedTree ? all.filter((e) => e.path.split('/').length <= 2) : all;
      return { status: 200, corpo: { sha: g.tree, truncated: repo.truncatedTree === true, tree } };
    }
    const stat = /^stats\/(\w+)$/.exec(recurso)?.[1];
    if (stat && repo.calcularPrimeiro?.includes(stat) && !jaCalculou.has(`${k}:${stat}`)) {
      jaCalculou.add(`${k}:${stat}`);
      return { status: 202, corpo: {} };
    }
    switch (recurso) {
      case 'stats/commit_activity':
        return { status: 200, corpo: s.semanas.slice(-52).map((w) => ({ week: w.week, total: w.total, days: [0, 0, 0, 0, 0, 0, 0] })) };
      case 'stats/code_frequency':
        return { status: 200, corpo: s.semanas.map((w) => [w.week, w.adicionadas, -w.removidas]) };
      case 'stats/contributors':
        return { status: 200, corpo: s.contribuidores };
      case 'languages': {
        const extras = LINGUAGENS_EXTRAS[repo.linguagem] ?? [];
        const total = 400_000 + (hash32(k) % 600_000);
        const resto = 1 - extras.reduce((a, [, f]) => a + f, 0);
        return { status: 200, corpo: Object.fromEntries([[repo.linguagem, Math.round(total * resto)], ...extras.map(([n, f]) => [n, Math.round(total * f)])]) };
      }
      case 'community/profile':
        return { status: 200, corpo: { health_percentage: 57 + (hash32(k) % 43) } };
      case 'actions/runs': {
        const desde = Date.parse(`${(url.searchParams.get('created') ?? '>=1970-01-01').slice(2)}T00:00:00Z`);
        const dentro = s.runs.filter((x) => Date.parse(x.created_at) >= desde);
        return { status: 200, corpo: { total_count: dentro.length, workflow_runs: dentro.slice(0, 100) } };
      }
    }
    if (!escrita(repo)) return { status: 403, corpo: { message: 'Must have push access to repository' } };
    const h = hash32(k);
    switch (recurso) {
      case 'traffic/views':
        return { status: 200, corpo: { count: 300 + (h % 1500), uniques: 80 + (h % 300) } };
      case 'traffic/clones':
        return { status: 200, corpo: { count: 20 + (h % 90), uniques: 5 + (h % 30) } };
      case 'traffic/popular/referrers':
        return { status: 200, corpo: [{ referrer: 'github.com', count: 400 }, { referrer: 'Google', count: 120 }, { referrer: 'npmjs.com', count: 40 }] };
      case 'dependabot/alerts':
        return { status: 200, corpo: Array.from({ length: repo.dependabot ?? 0 }, (_, i) => ({ number: i + 1, state: 'open' })) };
      case 'code-scanning/alerts':
        return repo.codeScanning === null ? { status: 404, corpo: { message: 'no analysis found' } } : { status: 200, corpo: Array.from({ length: repo.codeScanning ?? 0 }, (_, i) => ({ number: i + 1 })) };
    }
    return { status: 404, corpo: { message: 'Not Found' } };
  }

  const falso = async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (atrasoMs > 0) await new Promise((r) => setTimeout(r, atrasoMs));
    const url = new URL(typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url);
    if (url.pathname.endsWith('/graphql') && init?.method === 'POST') {
      const data = graphql(JSON.parse(String(init.body)));
      if (data === null) return Response.json({ errors: [{ message: 'operação desconhecida no GitHub falso' }] }, { status: 200 });
      return Response.json({ data });
    }
    const caminho = `${url.pathname}${url.search}`;
    const r = rest(caminho);
    if (r.status !== 200) return new Response(r.status === 202 ? '{}' : JSON.stringify(r.corpo), { status: r.status });
    const texto = JSON.stringify(r.corpo);
    const etag = `"${hash32(texto).toString(16)}"`;
    const pedida = new Headers(init?.headers).get('if-none-match');
    if (pedida === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(texto, { status: 200, headers: { etag, 'content-type': 'application/json' } });
  };
  return { fetch: falso as typeof fetch, chamadas };
}

interface GitFake {
  files: Record<string, string>;
  oids: Map<string, string>;
  folders: Set<string>;
  tree: string;
  commit: string;
}

const oidOf = (text: string) => createHash('sha1').update(text).digest('hex');

/** O `oid` do Git de um arquivo: SHA-1 de `blob <bytes>\0<texto>`. */
export function blobOid(text: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
}

function buildGit(repo: RepoFalso): GitFake {
  const files = repo.files ?? { 'README.md': `# ${repo.nome}\n` };
  const oids = new Map(Object.entries(files).map(([p, t]) => [p, blobOid(t)] as const));
  const folders = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const tree = oidOf(`tree ${[...oids].sort().map(([p, o]) => `${p}:${o}`).join('\n')}`);
  return { files, oids, folders, tree, commit: oidOf(`commit ${repo.dono}/${repo.nome}:${tree}`) };
}

const vazia = () => ({ issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] });
const pagina = (nodes: unknown[]) => ({ issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes });

/**
 * Os arquivos dos repositórios da demonstração na aba Instruções (#183, C32 e C33). Sintéticos.
 * - `exemplo-labs/vitrine-demo`: tudo o que a aba mostra, sem aviso;
 * - `exemplo-labs/motor-de-regras`: os quatro avisos (árvore cortada, settings.json quebrado,
 *   AGENTS.md sem import e import que não existe);
 * - `estudio-ficticio/app-receitas`: só o AGENTS.md, trazido pelo CLAUDE.md;
 * - os outros (como `dev-sintetico/blog-estatico`): só um README, o caso vazio.
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

const withFiles = (repo: RepoFalso): RepoFalso => {
  const extra = DEMO_INSTRUCTION_FILES[`${repo.dono}/${repo.nome}`];
  return extra ? { ...repo, files: extra.files, ...(extra.truncatedTree ? { truncatedTree: true } : {}) } : repo;
};

/** A demonstração, como no wireframe C22: duas orgs, a conta pessoal e oito repositórios. */
export const DADOS_DA_DEMO: DadosDoGithubFalso = {
  login: 'dev-sintetico',
  organizacoes: ['exemplo-labs', 'estudio-ficticio'],
  esperandoReview: 4,
  fechadasNaSemana: 17,
  repos: ([
    { dono: 'exemplo-labs', nome: 'vitrine-demo', privado: false, linguagem: 'TypeScript', permissao: 'ADMIN', pushMin: 2, issues: 14, prs: 3, ci: 'SUCCESS', ritmo: 14, estrelas: 128, forks: 14, observadores: 9, licenca: 'MIT', release: { tag: 'v0.4.2', diasAtras: 6 }, releases: 12, dependabot: 2, codeScanning: 0 },
    { dono: 'exemplo-labs', nome: 'motor-de-regras', privado: true, linguagem: 'TypeScript', permissao: 'WRITE', pushMin: 12, issues: 9, prs: 5, ci: 'PENDING', ritmo: 11, estrelas: 3, forks: 1, observadores: 4, licenca: null, release: { tag: 'v2.1.0', diasAtras: 20 }, releases: 31, dependabot: 5, codeScanning: 1 },
    { dono: 'exemplo-labs', nome: 'painel-de-metricas', privado: true, linguagem: 'Python', permissao: 'WRITE', pushMin: 3, issues: 6, prs: 2, ci: 'FAILURE', ritmo: 8, estrelas: 1, forks: 0, observadores: 3, licenca: null, release: null, releases: 0, dependabot: 1, codeScanning: null, calcularPrimeiro: ['contributors'] },
    { dono: 'exemplo-labs', nome: 'gateway-sandbox', privado: true, linguagem: 'Go', permissao: 'READ', pushMin: 26 * 60, issues: 4, prs: 1, ci: 'SUCCESS', ritmo: 5, estrelas: 0, forks: 0, observadores: 2, licenca: null, release: { tag: 'v0.9.0', diasAtras: 45 }, releases: 6 },
    { dono: 'estudio-ficticio', nome: 'app-receitas', privado: true, linguagem: 'Kotlin', permissao: 'WRITE', pushMin: 6, issues: 11, prs: 4, ci: 'SUCCESS', ritmo: 9, estrelas: 2, forks: 0, observadores: 5, licenca: null, release: { tag: 'v1.8.3', diasAtras: 3 }, releases: 22, dependabot: 0, codeScanning: 0 },
    { dono: 'estudio-ficticio', nome: 'catalogo-exemplo', privado: false, linguagem: 'TypeScript', permissao: 'READ', pushMin: 4, issues: 3, prs: 1, ci: 'SUCCESS', ritmo: 6, estrelas: 42, forks: 7, observadores: 6, licenca: 'Apache-2.0', release: { tag: 'v3.0.0', diasAtras: 12 }, releases: 9 },
    { dono: 'dev-sintetico', nome: 'cli-de-notas', privado: false, linguagem: 'Rust', permissao: 'ADMIN', pushMin: 2 * 24 * 60, issues: 2, prs: 0, ci: 'SUCCESS', ritmo: 4, estrelas: 17, forks: 2, observadores: 1, licenca: 'MIT', release: { tag: 'v0.2.0', diasAtras: 30 }, releases: 4, dependabot: 0, codeScanning: 0 },
    { dono: 'dev-sintetico', nome: 'blog-estatico', privado: false, linguagem: 'Astro', permissao: 'ADMIN', pushMin: 60, issues: 1, prs: 1, ci: 'SUCCESS', ritmo: 3, estrelas: 5, forks: 1, observadores: 1, licenca: 'MIT', release: null, releases: 0, dependabot: 1, codeScanning: 0 },
  ] as RepoFalso[]).map(withFiles),
};

/** git falso da demonstração: `/simulacao/<projeto>` é clone do repositório de mesmo nome, se houver. */
export function gitDaDemo(dados: DadosDoGithubFalso = DADOS_DA_DEMO) {
  return async (cwd: string, args: string[]): Promise<string | null> => {
    if (args[0] !== 'remote' || !cwd.startsWith(`${RAIZ}/`)) return null;
    const repo = dados.repos.find((r) => r.nome === cwd.slice(RAIZ.length + 1));
    return repo ? `https://github.com/${repo.dono}/${repo.nome}.git` : null;
  };
}

/**
 * Sessões que o cenário do simulador não tem, somadas às de verdade na demonstração, para a tela
 * ficar como no wireframe (ativas e "precisam de você" em alguns repositórios). Só a demo usa.
 */
export const SESSOES_EXTRAS_DA_DEMO: Record<string, { active: number; needYou: number; thisMonth: number }> = {
  'exemplo-labs/vitrine-demo': { active: 3, needYou: 1, thisMonth: 6 },
  'exemplo-labs/motor-de-regras': { active: 3, needYou: 2, thisMonth: 5 },
  'exemplo-labs/painel-de-metricas': { active: 1, needYou: 1, thisMonth: 2 },
  'estudio-ficticio/app-receitas': { active: 1, needYou: 0, thisMonth: 3 },
};
