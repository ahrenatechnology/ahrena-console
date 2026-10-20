// Porta e adaptador dos repositórios (#104 e #105), pela decisão 0001: GraphQL enxuto para o que
// ele traz numa consulta só, REST com ETag para as estatísticas que só o REST tem. Todas as
// chamadas são em série (quem chama espera uma antes da outra); nenhuma aninha listas pesadas.
//
// | Consulta       | O que traz                                                          | Custo  |
// | -------------- | ------------------------------------------------------------------- | -----: |
// | ReposLista     | login, orgs e até 100 repos por página, com contagens e CI do padrão | 1 a 2  |
// | ReposResumo    | duas buscas só com `issueCount`: PRs esperando review, issues fechadas na semana | 1 |
// | RepoDetalhe    | o repositório, as 100 releases mais novas, a 1ª página de PRs, issues fechadas e abertas do período, e duas contagens (PRs mergeados e fechados sem merge) | ≈ 4 |
// | RepoBusca      | as páginas seguintes de uma das buscas, até o teto                  | ≈ 2    |
//
// Os totais (issues fechadas e abertas, PRs mergeados e fechados sem merge) vêm do `issueCount` das
// buscas, que conta tudo; as páginas lidas são a amostra das medianas e do `porTipo`, cortada em
// `PAGINAS_DA_BUSCA`. `ContagensCruas` leva os dois números, e a resposta diz se a amostra cortou.
//
// REST, cada uma com `If-None-Match` (o 304 não gasta o limite primário):
// `stats/commit_activity`, `stats/code_frequency`, `stats/contributors` (os três devolvem 202
// enquanto o GitHub calcula), `languages`, `community/profile`, `actions/runs`, e, só com
// escrita, `traffic/*`, `dependabot/alerts` e `code-scanning/alerts`.

import { backoffMs, RateLimitedError } from './cache.ts';
import { ghCliToken, githubGraphql, type GithubGraphqlSourceOptions } from './github-source.ts';

export const GITHUB_API_URL = 'https://api.github.com';

/** Páginas de 100 que cada busca do detalhe lê, no máximo (a amostra; os totais vêm do `issueCount`). */
export const PAGINAS_DA_BUSCA = { prs: 5, fechadas: 5, abertas: 3 } as const;
/** Páginas de 100 repositórios na lista, no máximo. */
export const PAGINAS_DA_LISTA = 5;
/**
 * Tempo máximo de cada pedido ao GitHub (GraphQL e REST, corpo incluído). As chamadas saem por uma
 * fila só (src/api/repos.ts): sem teto, um pedido pendurado travaria todas as montagens.
 */
export const TEMPO_DO_PEDIDO_MS = 20_000;

export interface RepoCru {
  name: string;
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  pushedAt: string | null;
  /** ADMIN, MAINTAIN, WRITE, TRIAGE, READ; `null` sem acesso. */
  viewerPermission: string | null;
  owner: { login: string; __typename?: string };
  primaryLanguage: { name: string } | null;
  issues: { totalCount: number };
  pullRequests: { totalCount: number };
  defaultBranchRef: { name: string; target: { statusCheckRollup?: { state: string } | null } | null } | null;
}

export interface ListaCrua {
  login: string;
  organizacoes: string[];
  repos: RepoCru[];
}

export interface ResumoCru {
  esperandoReview: number;
  fechadasNaSemana: number;
}

export interface InfoCrua extends RepoCru {
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  licenseInfo: { spdxId: string | null; name: string } | null;
  latestRelease: { tagName: string; publishedAt: string | null } | null;
  /** `totalCount` é desde sempre; `nodes`, as 100 mais novas, para contar as do período. */
  releases: { totalCount: number; nodes?: { publishedAt: string | null }[] };
}

export interface PrCru {
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  additions: number;
  deletions: number;
  headRefName: string | null;
  author: { login: string; __typename?: string } | null;
  reviews: { totalCount: number; nodes: { createdAt: string }[] } | null;
  pedidosDeMudanca: { totalCount: number } | null;
}

export interface IssueCrua {
  createdAt?: string;
  closedAt?: string | null;
  issueType: { name: string } | null;
}

/** O `issueCount` de cada busca do detalhe: o total, mesmo quando a amostra lida é menor. */
export interface ContagensCruas {
  /** Issues fechadas no período. */
  fechadas: number;
  /** Issues abertas agora. */
  abertas: number;
  /** PRs atualizados no período (o universo da amostra `prs`). */
  prs: number;
  /** PRs mergeados no período (`is:merged merged:>=`). */
  mergeados: number;
  /** PRs fechados sem merge no período (`is:unmerged closed:>=`). */
  fechadosSemMerge: number;
}

export interface DetalheCru {
  repo: InfoCrua;
  /** Ausente só no cache gravado antes dela; o cálculo cai na contagem da amostra. */
  contagens?: ContagensCruas;
  /** PRs atualizados desde o começo do período. */
  prs: PrCru[];
  /** Issues fechadas desde o começo do período. */
  fechadas: IssueCrua[];
  /** Issues abertas agora (só o tipo). */
  abertas: IssueCrua[];
}

export type RespostaRest<T> =
  | { estado: 'ok'; valor: T; etag: string | null }
  | { estado: 'nao-modificado' }
  /** 202: o GitHub ainda calcula a estatística. */
  | { estado: 'calculando' }
  /** 403, 404, 409, 410, 422, 451: o recurso não existe, está desligado ou não é para este token. */
  | { estado: 'indisponivel'; status: number };

// Uma implementação só, e fica: é a porta da decisão 0001 por onde entra o adaptador do hub.
/** Porta da fonte dos repositórios; a demonstração usa o adaptador do GitHub com o `fetch` do GitHub falso. */
export interface FonteDosRepos {
  lista(): Promise<ListaCrua>;
  /** A conta e as orgs dela, para as buscas ficarem nos repositórios da lista. `desde`: AAAA-MM-DD. */
  resumo(login: string, organizacoes: readonly string[], desde: string): Promise<ResumoCru>;
  /** `null`: o repositório não existe ou não é visível. `desde`: AAAA-MM-DD. */
  detalhe(dono: string, nome: string, desde: string): Promise<DetalheCru | null>;
  /** GET em `/repos/<dono>/<repo>/...`, com ETag. Dono e repo fora de `NOME_DO_DONO`/`NOME_DO_REPO` dão erro sem chamar o GitHub. */
  rest<T>(caminho: string, etag: string | null): Promise<RespostaRest<T>>;
}

/** Padrão de nome do GitHub: login de até 39 caracteres, sem hífen nas pontas nem duplo; repo de até 100. */
export const NOME_DO_DONO = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const NOME_DO_REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** O núcleo não tem token do GitHub (`gh` sem login, ou desligado). */
export class SemGithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemGithubError';
  }
}

const RATE = 'rateLimit { cost remaining resetAt }';
const REPO = `name nameWithOwner url isPrivate pushedAt viewerPermission owner { login __typename } primaryLanguage { name }
  issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount }
  defaultBranchRef { name target { ... on Commit { statusCheckRollup { state } } } }`;
const INFO = `${REPO} stargazerCount forkCount watchers { totalCount } licenseInfo { spdxId name }
  latestRelease { tagName publishedAt } releases(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount nodes { publishedAt } }`;
const PR = `createdAt mergedAt closedAt state additions deletions headRefName author { login __typename }
  reviews(first: 1) { totalCount nodes { createdAt } } pedidosDeMudanca: reviews(states: CHANGES_REQUESTED) { totalCount }`;
const ISSUE = 'createdAt closedAt issueType { name }';
const PAGINA = 'issueCount pageInfo { hasNextPage endCursor }';
const CONTAGEM = 'type: ISSUE, first: 1) { issueCount }';

export const CONSULTAS_DOS_REPOS = {
  lista: `query ReposLista($after: String) { ${RATE}
  viewer { login organizations(first: 100) { nodes { login } }
    repositories(first: 100, after: $after, isArchived: false, affiliations: [OWNER, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, ORGANIZATION_MEMBER], orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor } nodes { ${REPO} } } } }`,
  resumo: `query ReposResumo($review: String!, $fechadas: String!) { ${RATE}
  review: search(query: $review, type: ISSUE, first: 1) { issueCount }
  fechadas: search(query: $fechadas, type: ISSUE, first: 1) { issueCount } }`,
  detalhe: `query RepoDetalhe($o: String!, $r: String!, $prs: String!, $fechadas: String!, $abertas: String!, $mergeados: String!, $fechadosSemMerge: String!) { ${RATE}
  repository(owner: $o, name: $r) { ${INFO} }
  mergeados: search(query: $mergeados, ${CONTAGEM}
  fechadosSemMerge: search(query: $fechadosSemMerge, ${CONTAGEM}
  prs: search(query: $prs, type: ISSUE, first: 100) { ${PAGINA} nodes { ... on PullRequest { ${PR} } } }
  fechadas: search(query: $fechadas, type: ISSUE, first: 100) { ${PAGINA} nodes { ... on Issue { ${ISSUE} } } }
  abertas: search(query: $abertas, type: ISSUE, first: 100) { ${PAGINA} nodes { ... on Issue { issueType { name } } } } }`,
  busca: `query RepoBusca($q: String!, $after: String) { ${RATE}
  search(query: $q, type: ISSUE, first: 100, after: $after) { ${PAGINA} nodes { ... on PullRequest { ${PR} } ... on Issue { ${ISSUE} } } } }`,
} as const;

/** As buscas do detalhe, do período que começa em `desde` (AAAA-MM-DD). */
export function buscasDoDetalhe(completo: string, desde: string) {
  return {
    prs: `repo:${completo} is:pr updated:>=${desde} sort:updated-desc`,
    fechadas: `repo:${completo} is:issue is:closed closed:>=${desde} sort:updated-desc`,
    abertas: `repo:${completo} is:issue is:open sort:updated-desc`,
    mergeados: `repo:${completo} is:pr is:merged merged:>=${desde}`,
    fechadosSemMerge: `repo:${completo} is:pr is:closed is:unmerged closed:>=${desde}`,
  };
}

/** As buscas do resumo: nos repositórios da conta e das orgs dela. */
export function buscasDoResumo(login: string, organizacoes: readonly string[], desde: string) {
  const escopo = [`user:${login}`, ...organizacoes.map((o) => `org:${o}`)].join(' ');
  return {
    review: `is:pr is:open draft:false review:required archived:false ${escopo}`,
    fechadas: `is:issue is:closed closed:>=${desde} archived:false ${escopo}`,
  };
}

interface Pagina<T> {
  issueCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Partial<T>[];
}

export interface GithubReposSourceOptions extends Omit<GithubGraphqlSourceOptions, 'token'> {
  token?: string | (() => Promise<string>);
  /** Base do REST. Padrão `https://api.github.com`. */
  api?: string;
  /** Teto de cada pedido. Padrão `TEMPO_DO_PEDIDO_MS`. */
  tempoDoPedidoMs?: number;
  /** O sinal que aborta o pedido no teto (testes trocam). Padrão `AbortSignal.timeout`. */
  sinalDoPedido?: (ms: number) => AbortSignal;
}

/** Adaptador do GitHub: token do `gh` por padrão, `fetch` injetável. */
export class GithubReposSource implements FonteDosRepos {
  private readonly opts: GithubReposSourceOptions;
  private tokenValue: string | null = null;

  constructor(opts: GithubReposSourceOptions = {}) {
    this.opts = opts;
  }

  async lista(): Promise<ListaCrua> {
    type Data = { viewer: { login: string; organizations: { nodes: { login: string }[] }; repositories: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RepoCru[] } } };
    const repos: RepoCru[] = [];
    let after: string | null = null;
    let login = '';
    let organizacoes: string[] = [];
    for (let pagina = 0; pagina < PAGINAS_DA_LISTA; pagina++) {
      const data: Data = await this.graphql<Data>('ReposLista', CONSULTAS_DOS_REPOS.lista, { after });
      login = data.viewer.login;
      organizacoes = data.viewer.organizations.nodes.map((o) => o.login);
      repos.push(...data.viewer.repositories.nodes.filter(Boolean));
      if (!data.viewer.repositories.pageInfo.hasNextPage) break;
      after = data.viewer.repositories.pageInfo.endCursor;
    }
    return { login, organizacoes, repos };
  }

  async resumo(login: string, organizacoes: readonly string[], desde: string): Promise<ResumoCru> {
    type Data = { review: { issueCount: number }; fechadas: { issueCount: number } };
    const data = await this.graphql<Data>('ReposResumo', CONSULTAS_DOS_REPOS.resumo, buscasDoResumo(login, organizacoes, desde));
    return { esperandoReview: data.review.issueCount, fechadasNaSemana: data.fechadas.issueCount };
  }

  async detalhe(dono: string, nome: string, desde: string): Promise<DetalheCru | null> {
    const buscas = buscasDoDetalhe(`${dono}/${nome}`, desde);
    type Data = {
      repository: InfoCrua | null;
      prs: Pagina<PrCru>;
      fechadas: Pagina<IssueCrua>;
      abertas: Pagina<IssueCrua>;
      mergeados: { issueCount: number };
      fechadosSemMerge: { issueCount: number };
    };
    const data = await this.graphql<Data>('RepoDetalhe', CONSULTAS_DOS_REPOS.detalhe, { o: dono, r: nome, ...buscas }, true);
    if (!data.repository) return null;
    return {
      repo: data.repository,
      contagens: {
        fechadas: data.fechadas.issueCount,
        abertas: data.abertas.issueCount,
        prs: data.prs.issueCount,
        mergeados: data.mergeados.issueCount,
        fechadosSemMerge: data.fechadosSemMerge.issueCount,
      },
      prs: await this.resto(buscas.prs, data.prs, PAGINAS_DA_BUSCA.prs) as PrCru[],
      fechadas: await this.resto(buscas.fechadas, data.fechadas, PAGINAS_DA_BUSCA.fechadas) as IssueCrua[],
      abertas: await this.resto(buscas.abertas, data.abertas, PAGINAS_DA_BUSCA.abertas) as IssueCrua[],
    };
  }

  /** As páginas seguintes de uma busca, em série, até `maximo` páginas no total. */
  private async resto<T>(q: string, primeira: Pagina<T>, maximo: number): Promise<Partial<T>[]> {
    const nos = primeira.nodes.filter((n) => n && Object.keys(n).length > 0);
    let pagina = primeira;
    for (let i = 1; i < maximo && pagina.pageInfo.hasNextPage; i++) {
      const data: { search: Pagina<T> } = await this.graphql<{ search: Pagina<T> }>('RepoBusca', CONSULTAS_DOS_REPOS.busca, { q, after: pagina.pageInfo.endCursor });
      pagina = data.search;
      nos.push(...pagina.nodes.filter((n) => n && Object.keys(n).length > 0));
    }
    return nos;
  }

  async rest<T>(caminho: string, etag: string | null): Promise<RespostaRest<T>> {
    const m = /^\/repos\/([^/]+)\/([^/?]+)\//.exec(caminho);
    if (!m || !NOME_DO_DONO.test(m[1]) || !NOME_DO_REPO.test(m[2])) throw new Error(`caminho do REST fora de /repos/<dono>/<repo>/: ${caminho.slice(0, 120)}`);
    const doFetch = this.opts.fetch ?? fetch;
    const now = this.opts.now ?? Date.now;
    const headers: Record<string, string> = {
      authorization: `bearer ${await this.token()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    if (etag) headers['if-none-match'] = etag;
    const { res, texto } = await this.comTeto(async (signal) => {
      const res = await doFetch(`${this.opts.api ?? GITHUB_API_URL}${caminho}`, { method: 'GET', headers, signal });
      // 304 e 202 decidem pelo status; o corpo não importa.
      return { res, texto: res.status === 304 || res.status === 202 ? '' : await res.text() };
    });
    if (res.status === 304) return { estado: 'nao-modificado' };
    if (res.status === 202) return { estado: 'calculando' };
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      // corpo vazio ou HTML: decide pelo status
    }
    const mensagem = (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    if (res.status === 429 || (res.status === 403 && (/rate limit/i.test(mensagem) || res.headers.get('x-ratelimit-remaining') === '0')))
      throw new RateLimitedError(`GitHub limitou as chamadas: ${mensagem}`, backoffMs(res.headers, now()));
    if ([403, 404, 409, 410, 422, 451].includes(res.status)) return { estado: 'indisponivel', status: res.status };
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}: ${mensagem}`);
    // 204: estatística de repositório vazio.
    return { estado: 'ok', valor: (json ?? []) as T, etag: res.headers.get('etag') };
  }

  private async token(): Promise<string> {
    if (this.tokenValue) return this.tokenValue;
    const t = this.opts.token ?? (() => ghCliToken());
    try {
      this.tokenValue = typeof t === 'string' ? t : await t();
    } catch (err) {
      throw new SemGithubError(err instanceof Error ? err.message : String(err));
    }
    return this.tokenValue;
  }

  private async graphql<T>(operacao: string, consulta: string, variaveis: Record<string, unknown>, tolerarNaoEncontrado = false): Promise<T> {
    const token = await this.token();
    return this.comTeto((signal) => githubGraphql<T>({ ...this.opts, token }, operacao, consulta, variaveis, { tolerateNotFound: tolerarNaoEncontrado, signal }));
  }

  /** Um pedido com teto de tempo: estourado, vira um erro comum, que libera a fila de quem chama. */
  private async comTeto<T>(pedido: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ms = this.opts.tempoDoPedidoMs ?? TEMPO_DO_PEDIDO_MS;
    const signal = (this.opts.sinalDoPedido ?? ((x: number) => AbortSignal.timeout(x)))(ms);
    try {
      return await pedido(signal);
    } catch (err) {
      if (signal.aborted) throw new Error(`o GitHub não respondeu em ${ms / 1000} s`);
      throw err;
    }
  }
}
