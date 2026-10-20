// As respostas de `/api/repos` (C22, #104) e `/api/repos/<dono>/<repo>` (C23, #105): o contrato
// que a tela consome. Toda resposta é 200, servida do cache sem esperar o GitHub (src/api/repos.ts).
// Chaves e valores fixos em inglês (#173, fase 2b); as rotas não têm caminho antigo.

/** `loading`: ainda sem dado, a leitura foi disparada; a tela relê pela mudança `repos` no cursor. */
export type EstadoDosRepos = 'ready' | 'loading' | 'no-github' | 'error';

/** O último run do branch padrão (statusCheckRollup do último commit). */
export type CiDoRepo = 'ok' | 'failed' | 'running' | null;

export type Visibilidade = 'public' | 'private';

export interface SessoesDoRepo {
  /** Sessões vivas (`active` e `error`) cujo cwd é um clone do repositório. */
  active: number;
  /** Das vivas, as que travam até você agir (`atencaoDe` nível `precisa`, #140). */
  needYou: number;
  /** Sessões com atividade no mês corrente, no fuso da máquina, qualquer status. */
  thisMonth: number;
}

export interface RepoDaLista {
  owner: string;
  name: string;
  /** `owner/name`. */
  fullName: string;
  url: string;
  visibility: Visibilidade;
  language: string | null;
  /**
   * Commits das últimas 12 semanas, a mais antiga primeiro (sparkline). Vazio enquanto as semanas
   * não chegaram (o GitHub ainda calcula, com 202, ou a leitura por repositório não terminou).
   */
  commits12: number[];
  openIssues: number;
  openPrs: number;
  ci: CiDoRepo;
  sessions: SessoesDoRepo;
  /** ISO. */
  lastPush: string | null;
}

export interface GrupoDeRepos {
  /** Login da org ou da conta. */
  owner: string;
  type: 'org' | 'personal';
  repos: RepoDaLista[];
}

export interface ResumoDosRepos {
  /** Organizações da conta, sem contar a conta pessoal. */
  organizations: number;
  repositories: number;
  /** Repositórios com ao menos uma sessão no mês. */
  withSessionsThisMonth: number;
  openPrs: number;
  /** PRs abertos, fora rascunho, com review exigido e ainda sem aprovação (`review:required`). */
  prsAwaitingReview: number;
  openIssues: number;
  issuesClosedThisWeek: number;
  /** Workflow runs concluídos nos últimos 7 dias; `greenRate` de 0 a 1, `null` sem execuções. */
  ci: { greenRate: number | null; runs: number; days: 7 };
}

export interface ListaDeRepos {
  state: EstadoDosRepos;
  /** ISO de quando veio do GitHub. */
  updatedAt: string | null;
  /** Dado velho, limite ou falha: o dado anterior vem junto. */
  error: string | null;
  /** Login do GitHub. */
  account: string | null;
  summary: ResumoDosRepos;
  /** Orgs pela atividade mais recente; a conta pessoal por último. Repos por `lastPush` desc. */
  groups: GrupoDeRepos[];
}

/** `?period=`: `1y` is the year (the old value `1a` is still accepted, src/api/legacy-routes.ts). */
export const PERIODOS = ['30d', '90d', '1y'] as const;
export type Periodo = (typeof PERIODOS)[number];
export const PERIODO_PADRAO: Periodo = '90d';

export interface SemanaDeFrequencia {
  /** ISO do domingo que abre a semana. */
  week: string;
  added: number;
  removed: number;
}

/**
 * O que a amostra paginada leu contra o total que o GitHub conta (`issueCount`). As medianas e o
 * `byType` saem da amostra; `truncated` diz que ela não cobre o total.
 */
export interface Amostra {
  read: number;
  total: number;
  truncated: boolean;
}

/** The stats GitHub may still answer with 202, as they appear in `MetricasDoRepo.computing`. */
export const COMPUTED_STATS = ['commits', 'frequency', 'lines', 'contributors'] as const;
export type ComputedStat = (typeof COMPUTED_STATS)[number];

export interface MetricasDoRepo {
  state: EstadoDosRepos | 'not-found';
  updatedAt: string | null;
  error: string | null;
  /** Stats que o GitHub ainda devolve 202. O núcleo tenta de novo sozinho. */
  computing: ComputedStat[];
  period: Periodo;
  repo: {
    fullName: string;
    url: string;
    visibility: Visibilidade;
    ci: CiDoRepo;
    defaultBranch: string | null;
    stars: number;
    forks: number;
    watchers: number;
    release: { tag: string; at: string } | null;
    license: string | null;
  } | null;
  /** Contadores das abas: issues e PRs abertos, sessões no mês. */
  tabs: { issues: number; prs: number; sessions: number };
  /** Soma de adições menos remoções desde o primeiro commit (code_frequency); `inPeriod`, o saldo do período. */
  lines: { total: number; inPeriod: number } | null;
  /** Commits por semana no período, a mais antiga primeiro (commit_activity, até 52 semanas). */
  commits: { total: number; perWeek: number; weeks: number[] } | null;
  frequency: { weeks: SemanaDeFrequencia[]; added: number; removed: number } | null;
  /**
   * `closed` (no período) e `open` (agora) são os totais do GitHub. `byType` e a mediana (sobre
   * as fechadas) saem da amostra, que soma fechadas e abertas lidas (`sample`). O `type` é o nome
   * do tipo da issue no GitHub, ou `Sem tipo` (texto da tela) para a issue sem tipo.
   */
  issues: {
    byType: Array<{ type: string; closed: number; open: number }>;
    closed: number;
    open: number;
    medianTimeToCloseMs: number | null;
    sample: Amostra;
  } | null;
  prs: {
    /** Mergeados e fechados sem merge no período (totais do GitHub); abertos agora. */
    merged: number;
    closedUnmerged: number;
    open: number;
    medianTimeToMergeMs: number | null;
    /** Sobre os PRs do período que receberam review. */
    medianTimeToFirstReviewMs: number | null;
    /** Mediana das adições e das remoções dos mergeados. */
    medianSize: { added: number; removed: number } | null;
    /** Média, nos mergeados com review: pedidos de mudança + 1. */
    reviewRounds: number | null;
    /** De 0 a 1: PRs criados no período cujo autor é bot (`[bot]` ou tipo Bot) ou cujo branch começa com `claude/`. */
    agentShare: number | null;
    /** Os PRs atualizados no período lidos, de onde saem as medianas, as rodadas e a fatia. */
    sample: Amostra;
  } | null;
  /** Workflow runs concluídos no período (até 100 amostrados); `runs` é o total que o GitHub conta. */
  ci: { greenRate: number | null; runs: number; averageDurationMs: number | null } | null;
  languages: Array<{ name: string; bytes: number; share: number }> | null;
  /** Commits, adições e remoções no período, por quem contribuiu (até 100, os mais ativos primeiro). */
  contributors: Array<{ login: string; commits: number; added: number; removed: number }> | null;
  /** Releases publicadas no período (das 100 mais novas). */
  releases: number | null;
  /** Releases desde sempre. */
  releasesTotal: number | null;
  /** health_percentage, 0 a 100. */
  community: number | null;
  /** viewerPermission ADMIN, MAINTAIN ou WRITE. */
  canWrite: boolean;
  /** Só com `canWrite`; sem ela a chave não vem (#105 critério 5). Janela fixa de 14 dias do GitHub. */
  traffic?: { views: number; uniques: number; clones: number; referrers: string[]; days: 14 };
  /** Só com `canWrite`; alertas abertos (`null`: o recurso está desligado no repositório). */
  security?: { dependabot: number | null; codeScanning: number | null };
}
