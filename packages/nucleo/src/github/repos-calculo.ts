// O cálculo das telas de repositórios (#104 e #105), sem rede e sem relógio próprio: recebe o que
// a fonte devolveu (src/github/repos-source.ts) e o instante de agora, devolve os números das
// respostas (src/api/repos-types.ts). O período (30 dias, 90 dias, 1 ano) recorta tudo o que tem
// data; o que o GitHub só dá por janela fixa (tráfego: 14 dias) fica como vem.

import type { CiDoRepo, GrupoDeRepos, MetricasDoRepo, Periodo, RepoDaLista, ResumoDosRepos, SemanaDeFrequencia } from '../api/repos-types.ts';
import type { Amostra } from '../api/repos-types.ts';
import type { ContagensCruas, InfoCrua, IssueCrua, ListaCrua, PrCru, RepoCru, ResumoCru } from './repos-source.ts';

export const DIA_MS = 24 * 60 * 60_000;
export const SEMANA_MS = 7 * DIA_MS;
const DIAS_DO_PERIODO: Record<Periodo, number> = { '30d': 30, '90d': 90, '1y': 365 };

// Formas cruas do REST.
export interface SemanaDeCommits {
  /** Domingo que abre a semana, em segundos. */
  week: number;
  total: number;
  days?: number[];
}
/** `[semana em segundos, adições, remoções (negativas)]`. */
export type SemanaDeCodigo = [number, number, number];
export interface ContribuidorCru {
  author: { login: string; type?: string } | null;
  total: number;
  weeks: { w: number; a: number; d: number; c: number }[];
}
export interface RunCru {
  status: string | null;
  conclusion: string | null;
  run_started_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}
export interface RunsCrus {
  total_count: number;
  workflow_runs: RunCru[];
}

/** Começo do período, em ms. */
export function inicioDoPeriodo(periodo: Periodo, agora: number): number {
  return agora - DIAS_DO_PERIODO[periodo] * DIA_MS;
}

/** AAAA-MM-DD (UTC), o formato das buscas do GitHub. */
export const diaIso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** O `statusCheckRollup` do último commit, como a tela mostra. */
export function ciDoRollup(state: string | null | undefined): CiDoRepo {
  if (!state) return null;
  if (state === 'SUCCESS') return 'ok';
  if (state === 'FAILURE' || state === 'ERROR') return 'failed';
  return 'running';
}

export const temEscrita = (permissao: string | null | undefined): boolean => permissao === 'ADMIN' || permissao === 'MAINTAIN' || permissao === 'WRITE';

export function mediana(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  const v = [...valores].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const media = (valores: readonly number[]): number | null => (valores.length ? valores.reduce((s, x) => s + x, 0) / valores.length : null);
const arred = (x: number, casas = 2) => Math.round(x * 10 ** casas) / 10 ** casas;

/** A semana entra no período se termina depois do começo dele. */
const naJanela = (semanaSeg: number, desde: number) => semanaSeg * 1000 + SEMANA_MS > desde;

/** Commits das últimas 12 semanas, a mais antiga primeiro (o `commit_activity` termina na semana corrente). */
export function commits12(atividade: readonly SemanaDeCommits[] | null): number[] {
  if (!atividade || atividade.length === 0) return [];
  const ultimas = [...atividade].sort((a, b) => a.week - b.week).slice(-12).map((s) => s.total);
  return [...Array(12 - ultimas.length).fill(0), ...ultimas];
}

export function commitsDoPeriodo(atividade: readonly SemanaDeCommits[], desde: number): NonNullable<MetricasDoRepo['commits']> {
  const semanas = [...atividade].sort((a, b) => a.week - b.week).filter((s) => naJanela(s.week, desde)).map((s) => s.total);
  const total = semanas.reduce((s, x) => s + x, 0);
  return { total, perWeek: semanas.length ? arred(total / semanas.length, 1) : 0, weeks: semanas };
}

/** Linhas de código: a soma de adições menos remoções desde o primeiro commit; o saldo do período. */
export function linhasDe(frequencia: readonly SemanaDeCodigo[], desde: number): NonNullable<MetricasDoRepo['lines']> {
  let total = 0;
  let noPeriodo = 0;
  for (const [semana, adicionadas, removidas] of frequencia) {
    // O GitHub devolve as remoções negativas; `Math.abs` aceita as duas convenções.
    const saldo = adicionadas - Math.abs(removidas);
    total += saldo;
    if (naJanela(semana, desde)) noPeriodo += saldo;
  }
  return { total, inPeriod: noPeriodo };
}

export function frequenciaDoPeriodo(frequencia: readonly SemanaDeCodigo[], desde: number): NonNullable<MetricasDoRepo['frequency']> {
  const semanas: SemanaDeFrequencia[] = [...frequencia]
    .sort((a, b) => a[0] - b[0])
    .filter(([s]) => naJanela(s, desde))
    .map(([s, a, d]) => ({ week: new Date(s * 1000).toISOString(), added: a, removed: Math.abs(d) }));
  return {
    weeks: semanas,
    added: semanas.reduce((s, x) => s + x.added, 0),
    removed: semanas.reduce((s, x) => s + x.removed, 0),
  };
}

export function contribuidoresDoPeriodo(contribuidores: readonly ContribuidorCru[], desde: number): NonNullable<MetricasDoRepo['contributors']> {
  return contribuidores
    .map((c) => {
      const semanas = c.weeks.filter((w) => naJanela(w.w, desde));
      return {
        login: c.author?.login ?? 'desconhecido',
        commits: semanas.reduce((s, w) => s + w.c, 0),
        added: semanas.reduce((s, w) => s + w.a, 0),
        removed: semanas.reduce((s, w) => s + w.d, 0),
      };
    })
    .filter((c) => c.commits > 0 || c.added > 0 || c.removed > 0)
    .sort((a, b) => b.commits - a.commits || b.added - a.added || a.login.localeCompare(b.login));
}

export function linguagensDe(bytes: Record<string, number>): NonNullable<MetricasDoRepo['languages']> {
  const total = Object.values(bytes).reduce((s, x) => s + x, 0);
  return Object.entries(bytes)
    .sort((a, b) => b[1] - a[1])
    .map(([name, b]) => ({ name, bytes: b, share: total ? arred(b / total, 4) : 0 }));
}

// Conclusões que contam na taxa: o que passou e o que falhou. Cancelado, pulado e neutro ficam de fora.
const RUN_VERDE = new Set(['success']);
const RUN_VERMELHO = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/** Taxa verde e duração média dos runs concluídos da amostra; `runs` é o `total_count` do GitHub. */
export function ciDosRuns(runs: RunsCrus): NonNullable<MetricasDoRepo['ci']> {
  const concluidos = runs.workflow_runs.filter((r) => r.status === 'completed' && r.conclusion && (RUN_VERDE.has(r.conclusion) || RUN_VERMELHO.has(r.conclusion)));
  const verdes = concluidos.filter((r) => RUN_VERDE.has(r.conclusion!)).length;
  const duracoes = concluidos
    .map((r) => Date.parse(r.updated_at ?? '') - Date.parse(r.run_started_at ?? r.created_at ?? ''))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const duracao = media(duracoes);
  return {
    greenRate: concluidos.length ? arred(verdes / concluidos.length, 4) : null,
    runs: runs.total_count,
    averageDurationMs: duracao === null ? null : Math.round(duracao),
  };
}

/** The `type` of an issue without one: screen text, next to GitHub's own type names. */
export const SEM_TIPO = 'Sem tipo';

/** A amostra contra o total; sem total (cache antigo), o total é o que se leu. */
export function amostraDe(lidos: number, total: number | undefined): Amostra {
  const t = Math.max(lidos, total ?? lidos);
  return { read: lidos, total: t, truncated: lidos < t };
}

/** Totais pelo `issueCount` (`contagens`); `byType` e a mediana pela amostra lida. */
export function issuesDoPeriodo(fechadas: readonly IssueCrua[], abertas: readonly IssueCrua[], contagens?: Pick<ContagensCruas, 'fechadas' | 'abertas'>): NonNullable<MetricasDoRepo['issues']> {
  const porTipo = new Map<string, { type: string; closed: number; open: number }>();
  const de = (i: IssueCrua) => {
    const tipo = i.issueType?.name ?? SEM_TIPO;
    let t = porTipo.get(tipo);
    if (!t) porTipo.set(tipo, (t = { type: tipo, closed: 0, open: 0 }));
    return t;
  };
  for (const i of fechadas) de(i).closed++;
  for (const i of abertas) de(i).open++;
  const tempos = fechadas.map((i) => Date.parse(i.closedAt ?? '') - Date.parse(i.createdAt ?? '')).filter((d) => Number.isFinite(d) && d >= 0);
  return {
    byType: [...porTipo.values()].sort((a, b) => b.closed + b.open - (a.closed + a.open) || a.type.localeCompare(b.type)),
    closed: contagens?.fechadas ?? fechadas.length,
    open: contagens?.abertas ?? abertas.length,
    medianTimeToCloseMs: mediana(tempos),
    sample: amostraDe(fechadas.length + abertas.length, contagens ? contagens.fechadas + contagens.abertas : undefined),
  };
}

/**
 * Critério da "fatia aberta por agentes" (#105 critério 3): o PR foi aberto por um agente quando o
 * autor é um bot (`__typename` Bot, ou login terminado em `[bot]`) ou quando o branch de origem
 * começa com `claude/` (o padrão do Claude Code). As duas pistas vêm na mesma consulta do PR e
 * dá para conferir uma a uma no GitHub; o trailer `Co-Authored-By` exigiria ler os commits de
 * cada PR, e fica de fora.
 */
export function abertoPorAgente(pr: Pick<PrCru, 'author' | 'headRefName'>): boolean {
  const a = pr.author;
  if (a && (a.__typename === 'Bot' || /\[bot\]$/i.test(a.login))) return true;
  return /^claude\//.test(pr.headRefName ?? '');
}

/**
 * PRs do período: mergeados e fechados sem merge pelo `issueCount` (`contagens`; sem ele, pela
 * amostra); abertos agora vêm do repositório. Medianas, rodadas e fatia saem da amostra.
 */
export function prsDoPeriodo(prs: readonly PrCru[], abertosAgora: number, desde: number, contagens?: Pick<ContagensCruas, 'prs' | 'mergeados' | 'fechadosSemMerge'>): NonNullable<MetricasDoRepo['prs']> {
  const em = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
  const mergeados = prs.filter((p) => p.mergedAt && em(p.mergedAt) >= desde);
  const fechados = prs.filter((p) => p.state === 'CLOSED' && !p.mergedAt && em(p.closedAt) >= desde);
  const criados = prs.filter((p) => em(p.createdAt) >= desde);
  const comReview = prs.filter((p) => (p.reviews?.nodes[0]?.createdAt ? em(p.reviews.nodes[0].createdAt) >= desde : false));
  const primeiroReview = comReview.map((p) => em(p.reviews!.nodes[0].createdAt) - em(p.createdAt)).filter((d) => d >= 0);
  const mergeadosComReview = mergeados.filter((p) => (p.reviews?.totalCount ?? 0) > 0);
  const adicionadas = mediana(mergeados.map((p) => p.additions));
  const removidas = mediana(mergeados.map((p) => p.deletions));
  const rodadas = media(mergeadosComReview.map((p) => (p.pedidosDeMudanca?.totalCount ?? 0) + 1));
  return {
    merged: contagens?.mergeados ?? mergeados.length,
    closedUnmerged: contagens?.fechadosSemMerge ?? fechados.length,
    open: abertosAgora,
    medianTimeToMergeMs: mediana(mergeados.map((p) => em(p.mergedAt) - em(p.createdAt)).filter((d) => d >= 0)),
    medianTimeToFirstReviewMs: mediana(primeiroReview),
    medianSize: adicionadas === null || removidas === null ? null : { added: adicionadas, removed: removidas },
    reviewRounds: rodadas === null ? null : arred(rodadas, 1),
    agentShare: criados.length ? arred(criados.filter(abertoPorAgente).length / criados.length, 4) : null,
    sample: amostraDe(prs.length, contagens?.prs),
  };
}

/** Releases publicadas desde `desde`, entre as 100 mais novas; sem os nós (cache antigo), `null`. */
export function releasesDoPeriodo(info: Pick<InfoCrua, 'releases'>, desde: number): number | null {
  const nos = info.releases.nodes;
  if (!nos) return null;
  return nos.filter((r) => r.publishedAt && Date.parse(r.publishedAt) >= desde).length;
}

export function repoDoDetalhe(info: InfoCrua): NonNullable<MetricasDoRepo['repo']> {
  return {
    fullName: info.nameWithOwner,
    url: info.url,
    visibility: info.isPrivate ? 'private' : 'public',
    ci: ciDoRollup(info.defaultBranchRef?.target?.statusCheckRollup?.state),
    defaultBranch: info.defaultBranchRef?.name ?? null,
    stars: info.stargazerCount,
    forks: info.forkCount,
    watchers: info.watchers.totalCount,
    release: info.latestRelease ? { tag: info.latestRelease.tagName, at: info.latestRelease.publishedAt ?? '' } : null,
    license: info.licenseInfo?.spdxId && info.licenseInfo.spdxId !== 'NOASSERTION' ? info.licenseInfo.spdxId : (info.licenseInfo?.name ?? null),
  };
}

export const SESSOES_VAZIAS = { active: 0, needYou: 0, thisMonth: 0 } as const;

export function repoDaLista(r: RepoCru, commits: number[]): RepoDaLista {
  const [owner, name] = r.nameWithOwner.split('/');
  return {
    owner,
    name,
    fullName: r.nameWithOwner,
    url: r.url,
    visibility: r.isPrivate ? 'private' : 'public',
    language: r.primaryLanguage?.name ?? null,
    commits12: commits,
    openIssues: r.issues.totalCount,
    openPrs: r.pullRequests.totalCount,
    ci: ciDoRollup(r.defaultBranchRef?.target?.statusCheckRollup?.state),
    sessions: { ...SESSOES_VAZIAS },
    lastPush: r.pushedAt,
  };
}

/**
 * Agrupa por dono: as orgs pela atividade mais recente, a conta pessoal por último; dentro do
 * grupo, pelo último push. `commits` e `ci` vêm da leitura por repositório (podem faltar).
 */
export function montarLista(
  crua: ListaCrua,
  resumo: ResumoCru | null,
  commits: ReadonlyMap<string, number[]>,
  ci: { greenRate: number | null; runs: number },
): { account: string; summary: ResumoDosRepos; groups: GrupoDeRepos[] } {
  const porDono = new Map<string, GrupoDeRepos>();
  for (const r of crua.repos) {
    const linha = repoDaLista(r, commits.get(r.nameWithOwner) ?? []);
    let g = porDono.get(linha.owner);
    if (!g) porDono.set(linha.owner, (g = { owner: linha.owner, type: linha.owner === crua.login ? 'personal' : 'org', repos: [] }));
    g.repos.push(linha);
  }
  const push = (r: RepoDaLista) => (r.lastPush ? Date.parse(r.lastPush) : 0);
  const grupos = [...porDono.values()];
  for (const g of grupos) g.repos.sort((a, b) => push(b) - push(a) || a.name.localeCompare(b.name));
  grupos.sort((a, b) => (a.type === b.type ? push(b.repos[0]) - push(a.repos[0]) || a.owner.localeCompare(b.owner) : a.type === 'personal' ? 1 : -1));
  const todos = grupos.flatMap((g) => g.repos);
  return {
    account: crua.login,
    summary: {
      organizations: new Set([...crua.organizacoes, ...grupos.filter((g) => g.type === 'org').map((g) => g.owner)]).size,
      repositories: todos.length,
      withSessionsThisMonth: 0,
      openPrs: todos.reduce((s, r) => s + r.openPrs, 0),
      prsAwaitingReview: resumo?.esperandoReview ?? 0,
      openIssues: todos.reduce((s, r) => s + r.openIssues, 0),
      issuesClosedThisWeek: resumo?.fechadasNaSemana ?? 0,
      ci: { greenRate: ci.greenRate, runs: ci.runs, days: 7 },
    },
    groups: grupos,
  };
}

/** Junta a taxa de vários repositórios, ponderada pelas execuções concluídas da amostra. */
export function somarCi(partes: readonly { verdes: number; concluidos: number; execucoes: number }[]): { greenRate: number | null; runs: number } {
  const verdes = partes.reduce((s, p) => s + p.verdes, 0);
  const concluidos = partes.reduce((s, p) => s + p.concluidos, 0);
  return { greenRate: concluidos ? arred(verdes / concluidos, 4) : null, runs: partes.reduce((s, p) => s + p.execucoes, 0) };
}

/** Verdes e concluídos de uma amostra de runs (para `somarCi`). */
export function contarRuns(runs: RunsCrus): { verdes: number; concluidos: number; execucoes: number } {
  const concluidos = runs.workflow_runs.filter((r) => r.status === 'completed' && r.conclusion && (RUN_VERDE.has(r.conclusion) || RUN_VERMELHO.has(r.conclusion)));
  return { verdes: concluidos.filter((r) => RUN_VERDE.has(r.conclusion!)).length, concluidos: concluidos.length, execucoes: runs.total_count };
}
