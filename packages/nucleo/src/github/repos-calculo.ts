// O cálculo das telas de repositórios (#104 e #105), sem rede e sem relógio próprio: recebe o que
// a fonte devolveu (src/github/repos-source.ts) e o instante de agora, devolve os números das
// respostas (src/api/repos-tipos.ts). O período (30 dias, 90 dias, 1 ano) recorta tudo o que tem
// data; o que o GitHub só dá por janela fixa (tráfego: 14 dias) fica como vem.

import type { CiDoRepo, GrupoDeRepos, MetricasDoRepo, Periodo, RepoDaLista, ResumoDosRepos, SemanaDeFrequencia } from '../api/repos-tipos.ts';
import type { InfoCrua, IssueCrua, ListaCrua, PrCru, RepoCru, ResumoCru } from './repos-source.ts';

export const DIA_MS = 24 * 60 * 60_000;
export const SEMANA_MS = 7 * DIA_MS;
const DIAS_DO_PERIODO: Record<Periodo, number> = { '30d': 30, '90d': 90, '1a': 365 };

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
  if (state === 'FAILURE' || state === 'ERROR') return 'falhou';
  return 'rodando';
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
  return { total, porSemana: semanas.length ? arred(total / semanas.length, 1) : 0, semanas };
}

/** Linhas de código: a soma de adições menos remoções desde o primeiro commit; o saldo do período. */
export function linhasDe(frequencia: readonly SemanaDeCodigo[], desde: number): NonNullable<MetricasDoRepo['linhas']> {
  let total = 0;
  let noPeriodo = 0;
  for (const [semana, adicionadas, removidas] of frequencia) {
    // O GitHub devolve as remoções negativas; `Math.abs` aceita as duas convenções.
    const saldo = adicionadas - Math.abs(removidas);
    total += saldo;
    if (naJanela(semana, desde)) noPeriodo += saldo;
  }
  return { total, noPeriodo };
}

export function frequenciaDoPeriodo(frequencia: readonly SemanaDeCodigo[], desde: number): NonNullable<MetricasDoRepo['frequencia']> {
  const semanas: SemanaDeFrequencia[] = [...frequencia]
    .sort((a, b) => a[0] - b[0])
    .filter(([s]) => naJanela(s, desde))
    .map(([s, a, d]) => ({ semana: new Date(s * 1000).toISOString(), adicionadas: a, removidas: Math.abs(d) }));
  return {
    semanas,
    adicionadas: semanas.reduce((s, x) => s + x.adicionadas, 0),
    removidas: semanas.reduce((s, x) => s + x.removidas, 0),
  };
}

export function contribuidoresDoPeriodo(contribuidores: readonly ContribuidorCru[], desde: number): NonNullable<MetricasDoRepo['contribuidores']> {
  return contribuidores
    .map((c) => {
      const semanas = c.weeks.filter((w) => naJanela(w.w, desde));
      return {
        login: c.author?.login ?? 'desconhecido',
        commits: semanas.reduce((s, w) => s + w.c, 0),
        adicionadas: semanas.reduce((s, w) => s + w.a, 0),
        removidas: semanas.reduce((s, w) => s + w.d, 0),
      };
    })
    .filter((c) => c.commits > 0 || c.adicionadas > 0 || c.removidas > 0)
    .sort((a, b) => b.commits - a.commits || b.adicionadas - a.adicionadas || a.login.localeCompare(b.login));
}

export function linguagensDe(bytes: Record<string, number>): NonNullable<MetricasDoRepo['linguagens']> {
  const total = Object.values(bytes).reduce((s, x) => s + x, 0);
  return Object.entries(bytes)
    .sort((a, b) => b[1] - a[1])
    .map(([nome, b]) => ({ nome, bytes: b, fatia: total ? arred(b / total, 4) : 0 }));
}

// Conclusões que contam na taxa: o que passou e o que falhou. Cancelado, pulado e neutro ficam de fora.
const RUN_VERDE = new Set(['success']);
const RUN_VERMELHO = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/** Taxa verde e duração média dos runs concluídos da amostra; `execucoes` é o `total_count` do GitHub. */
export function ciDosRuns(runs: RunsCrus): NonNullable<MetricasDoRepo['ci']> {
  const concluidos = runs.workflow_runs.filter((r) => r.status === 'completed' && r.conclusion && (RUN_VERDE.has(r.conclusion) || RUN_VERMELHO.has(r.conclusion)));
  const verdes = concluidos.filter((r) => RUN_VERDE.has(r.conclusion!)).length;
  const duracoes = concluidos
    .map((r) => Date.parse(r.updated_at ?? '') - Date.parse(r.run_started_at ?? r.created_at ?? ''))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const duracao = media(duracoes);
  return {
    taxaVerde: concluidos.length ? arred(verdes / concluidos.length, 4) : null,
    execucoes: runs.total_count,
    duracaoMediaMs: duracao === null ? null : Math.round(duracao),
  };
}

export const SEM_TIPO = 'Sem tipo';

export function issuesDoPeriodo(fechadas: readonly IssueCrua[], abertas: readonly IssueCrua[]): NonNullable<MetricasDoRepo['issues']> {
  const porTipo = new Map<string, { tipo: string; fechadas: number; abertas: number }>();
  const de = (i: IssueCrua) => {
    const tipo = i.issueType?.name ?? SEM_TIPO;
    let t = porTipo.get(tipo);
    if (!t) porTipo.set(tipo, (t = { tipo, fechadas: 0, abertas: 0 }));
    return t;
  };
  for (const i of fechadas) de(i).fechadas++;
  for (const i of abertas) de(i).abertas++;
  const tempos = fechadas.map((i) => Date.parse(i.closedAt ?? '') - Date.parse(i.createdAt ?? '')).filter((d) => Number.isFinite(d) && d >= 0);
  return {
    porTipo: [...porTipo.values()].sort((a, b) => b.fechadas + b.abertas - (a.fechadas + a.abertas) || a.tipo.localeCompare(b.tipo)),
    fechadas: fechadas.length,
    medianaAteFecharMs: mediana(tempos),
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

/** PRs do período: mergeados e fechados sem merge no período; abertos agora vêm do repositório. */
export function prsDoPeriodo(prs: readonly PrCru[], abertosAgora: number, desde: number): NonNullable<MetricasDoRepo['prs']> {
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
    mergeados: mergeados.length,
    fechadosSemMerge: fechados.length,
    abertos: abertosAgora,
    medianaAteMergeMs: mediana(mergeados.map((p) => em(p.mergedAt) - em(p.createdAt)).filter((d) => d >= 0)),
    medianaAtePrimeiroReviewMs: mediana(primeiroReview),
    tamanhoMediano: adicionadas === null || removidas === null ? null : { adicionadas, removidas },
    rodadasDeReview: rodadas === null ? null : arred(rodadas, 1),
    fatiaPorAgentes: criados.length ? arred(criados.filter(abertoPorAgente).length / criados.length, 4) : null,
  };
}

export function repoDoDetalhe(info: InfoCrua): NonNullable<MetricasDoRepo['repo']> {
  return {
    completo: info.nameWithOwner,
    url: info.url,
    visibilidade: info.isPrivate ? 'privado' : 'publico',
    ci: ciDoRollup(info.defaultBranchRef?.target?.statusCheckRollup?.state),
    branchPadrao: info.defaultBranchRef?.name ?? null,
    estrelas: info.stargazerCount,
    forks: info.forkCount,
    observadores: info.watchers.totalCount,
    release: info.latestRelease ? { tag: info.latestRelease.tagName, em: info.latestRelease.publishedAt ?? '' } : null,
    licenca: info.licenseInfo?.spdxId && info.licenseInfo.spdxId !== 'NOASSERTION' ? info.licenseInfo.spdxId : (info.licenseInfo?.name ?? null),
  };
}

export const SESSOES_VAZIAS = { ativas: 0, precisam: 0, noMes: 0 } as const;

export function repoDaLista(r: RepoCru, commits: number[]): RepoDaLista {
  const [dono, nome] = r.nameWithOwner.split('/');
  return {
    dono,
    nome,
    completo: r.nameWithOwner,
    url: r.url,
    visibilidade: r.isPrivate ? 'privado' : 'publico',
    linguagem: r.primaryLanguage?.name ?? null,
    commits12: commits,
    issuesAbertas: r.issues.totalCount,
    prsAbertos: r.pullRequests.totalCount,
    ci: ciDoRollup(r.defaultBranchRef?.target?.statusCheckRollup?.state),
    sessoes: { ...SESSOES_VAZIAS },
    ultimoPush: r.pushedAt,
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
  ci: { taxaVerde: number | null; execucoes: number },
): { conta: string; resumo: ResumoDosRepos; grupos: GrupoDeRepos[] } {
  const porDono = new Map<string, GrupoDeRepos>();
  for (const r of crua.repos) {
    const linha = repoDaLista(r, commits.get(r.nameWithOwner) ?? []);
    let g = porDono.get(linha.dono);
    if (!g) porDono.set(linha.dono, (g = { dono: linha.dono, tipo: linha.dono === crua.login ? 'pessoal' : 'org', repos: [] }));
    g.repos.push(linha);
  }
  const push = (r: RepoDaLista) => (r.ultimoPush ? Date.parse(r.ultimoPush) : 0);
  const grupos = [...porDono.values()];
  for (const g of grupos) g.repos.sort((a, b) => push(b) - push(a) || a.nome.localeCompare(b.nome));
  grupos.sort((a, b) => (a.tipo === b.tipo ? push(b.repos[0]) - push(a.repos[0]) || a.dono.localeCompare(b.dono) : a.tipo === 'pessoal' ? 1 : -1));
  const todos = grupos.flatMap((g) => g.repos);
  return {
    conta: crua.login,
    resumo: {
      organizacoes: new Set([...crua.organizacoes, ...grupos.filter((g) => g.tipo === 'org').map((g) => g.dono)]).size,
      repositorios: todos.length,
      comSessoesNoMes: 0,
      prsAbertos: todos.reduce((s, r) => s + r.prsAbertos, 0),
      prsEsperandoReview: resumo?.esperandoReview ?? 0,
      issuesAbertas: todos.reduce((s, r) => s + r.issuesAbertas, 0),
      issuesFechadasNaSemana: resumo?.fechadasNaSemana ?? 0,
      ci: { taxaVerde: ci.taxaVerde, execucoes: ci.execucoes, dias: 7 },
    },
    grupos,
  };
}

/** Junta a taxa de vários repositórios, ponderada pelas execuções concluídas da amostra. */
export function somarCi(partes: readonly { verdes: number; concluidos: number; execucoes: number }[]): { taxaVerde: number | null; execucoes: number } {
  const verdes = partes.reduce((s, p) => s + p.verdes, 0);
  const concluidos = partes.reduce((s, p) => s + p.concluidos, 0);
  return { taxaVerde: concluidos ? arred(verdes / concluidos, 4) : null, execucoes: partes.reduce((s, p) => s + p.execucoes, 0) };
}

/** Verdes e concluídos de uma amostra de runs (para `somarCi`). */
export function contarRuns(runs: RunsCrus): { verdes: number; concluidos: number; execucoes: number } {
  const concluidos = runs.workflow_runs.filter((r) => r.status === 'completed' && r.conclusion && (RUN_VERDE.has(r.conclusion) || RUN_VERMELHO.has(r.conclusion)));
  return { verdes: concluidos.filter((r) => RUN_VERDE.has(r.conclusion!)).length, concluidos: concluidos.length, execucoes: runs.total_count };
}
