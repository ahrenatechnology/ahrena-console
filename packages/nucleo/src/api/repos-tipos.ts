// As respostas de `/api/repos` (C22, #104) e `/api/repos/<dono>/<repo>` (C23, #105): o contrato
// que a tela consome. Toda resposta é 200, servida do cache sem esperar o GitHub (src/api/repos.ts).

/** `carregando`: ainda sem dado, a leitura foi disparada; a tela relê pela mudança `repos` no cursor. */
export type EstadoDosRepos = 'pronto' | 'carregando' | 'sem-github' | 'erro';

/** O último run do branch padrão (statusCheckRollup do último commit). */
export type CiDoRepo = 'ok' | 'falhou' | 'rodando' | null;

export type Visibilidade = 'publico' | 'privado';

export interface SessoesDoRepo {
  /** Sessões vivas (`active` e `error`) cujo cwd é um clone do repositório. */
  ativas: number;
  /** Das vivas, as que travam até você agir (`atencaoDe` nível `precisa`, #140). */
  precisam: number;
  /** Sessões com atividade no mês corrente, no fuso da máquina, qualquer status. */
  noMes: number;
}

export interface RepoDaLista {
  dono: string;
  nome: string;
  /** `dono/nome`. */
  completo: string;
  url: string;
  visibilidade: Visibilidade;
  linguagem: string | null;
  /**
   * Commits das últimas 12 semanas, a mais antiga primeiro (sparkline). Vazio enquanto as semanas
   * não chegaram (o GitHub ainda calcula, com 202, ou a leitura por repositório não terminou).
   */
  commits12: number[];
  issuesAbertas: number;
  prsAbertos: number;
  ci: CiDoRepo;
  sessoes: SessoesDoRepo;
  /** ISO. */
  ultimoPush: string | null;
}

export interface GrupoDeRepos {
  /** Login da org ou da conta. */
  dono: string;
  tipo: 'org' | 'pessoal';
  repos: RepoDaLista[];
}

export interface ResumoDosRepos {
  /** Organizações da conta, sem contar a conta pessoal. */
  organizacoes: number;
  repositorios: number;
  /** Repositórios com ao menos uma sessão no mês. */
  comSessoesNoMes: number;
  prsAbertos: number;
  /** PRs abertos, fora rascunho, com review exigido e ainda sem aprovação (`review:required`). */
  prsEsperandoReview: number;
  issuesAbertas: number;
  issuesFechadasNaSemana: number;
  /** Workflow runs concluídos nos últimos 7 dias; `taxaVerde` de 0 a 1, `null` sem execuções. */
  ci: { taxaVerde: number | null; execucoes: number; dias: 7 };
}

export interface ListaDeRepos {
  estado: EstadoDosRepos;
  /** ISO de quando veio do GitHub. */
  atualizadoEm: string | null;
  /** Dado velho, limite ou falha: o dado anterior vem junto. */
  erro: string | null;
  /** Login do GitHub. */
  conta: string | null;
  resumo: ResumoDosRepos;
  /** Orgs pela atividade mais recente; a conta pessoal por último. Repos por `ultimoPush` desc. */
  grupos: GrupoDeRepos[];
}

export const PERIODOS = ['30d', '90d', '1a'] as const;
export type Periodo = (typeof PERIODOS)[number];
export const PERIODO_PADRAO: Periodo = '90d';

export interface SemanaDeFrequencia {
  /** ISO do domingo que abre a semana. */
  semana: string;
  adicionadas: number;
  removidas: number;
}

/**
 * O que a amostra paginada leu contra o total que o GitHub conta (`issueCount`). As medianas e o
 * `porTipo` saem da amostra; `truncado` diz que ela não cobre o total.
 */
export interface Amostra {
  lidos: number;
  total: number;
  truncado: boolean;
}

export interface MetricasDoRepo {
  estado: EstadoDosRepos | 'nao-encontrado';
  atualizadoEm: string | null;
  erro: string | null;
  /** Stats que o GitHub ainda devolve 202: `commits`, `frequencia`, `linhas`, `contribuidores`. O núcleo tenta de novo sozinho. */
  calculando: string[];
  periodo: Periodo;
  repo: {
    completo: string;
    url: string;
    visibilidade: Visibilidade;
    ci: CiDoRepo;
    branchPadrao: string | null;
    estrelas: number;
    forks: number;
    observadores: number;
    release: { tag: string; em: string } | null;
    licenca: string | null;
  } | null;
  /** Contadores das abas: issues e PRs abertos, sessões no mês. */
  abas: { issues: number; prs: number; sessoes: number };
  /** Soma de adições menos remoções desde o primeiro commit (code_frequency); `noPeriodo`, o saldo do período. */
  linhas: { total: number; noPeriodo: number } | null;
  /** Commits por semana no período, a mais antiga primeiro (commit_activity, até 52 semanas). */
  commits: { total: number; porSemana: number; semanas: number[] } | null;
  frequencia: { semanas: SemanaDeFrequencia[]; adicionadas: number; removidas: number } | null;
  /**
   * `fechadas` (no período) e `abertas` (agora) são os totais do GitHub. `porTipo` e a mediana (sobre
   * as fechadas) saem da amostra, que soma fechadas e abertas lidas (`amostra`).
   */
  issues: {
    porTipo: Array<{ tipo: string; fechadas: number; abertas: number }>;
    fechadas: number;
    abertas: number;
    medianaAteFecharMs: number | null;
    amostra: Amostra;
  } | null;
  prs: {
    /** Mergeados e fechados sem merge no período (totais do GitHub); abertos agora. */
    mergeados: number;
    fechadosSemMerge: number;
    abertos: number;
    medianaAteMergeMs: number | null;
    /** Sobre os PRs do período que receberam review. */
    medianaAtePrimeiroReviewMs: number | null;
    /** Mediana das adições e das remoções dos mergeados. */
    tamanhoMediano: { adicionadas: number; removidas: number } | null;
    /** Média, nos mergeados com review: pedidos de mudança + 1. */
    rodadasDeReview: number | null;
    /** De 0 a 1: PRs criados no período cujo autor é bot (`[bot]` ou tipo Bot) ou cujo branch começa com `claude/`. */
    fatiaPorAgentes: number | null;
    /** Os PRs atualizados no período lidos, de onde saem as medianas, as rodadas e a fatia. */
    amostra: Amostra;
  } | null;
  /** Workflow runs concluídos no período (até 100 amostrados); `execucoes` é o total que o GitHub conta. */
  ci: { taxaVerde: number | null; execucoes: number; duracaoMediaMs: number | null } | null;
  linguagens: Array<{ nome: string; bytes: number; fatia: number }> | null;
  /** Commits, adições e remoções no período, por quem contribuiu (até 100, os mais ativos primeiro). */
  contribuidores: Array<{ login: string; commits: number; adicionadas: number; removidas: number }> | null;
  /** Releases publicadas no período (das 100 mais novas). */
  releases: number | null;
  /** Releases desde sempre. */
  releasesNoTotal: number | null;
  /** health_percentage, 0 a 100. */
  comunidade: number | null;
  /** viewerPermission ADMIN, MAINTAIN ou WRITE. */
  escrita: boolean;
  /** Só com `escrita`; sem ela a chave não vem (#105 critério 5). Janela fixa de 14 dias do GitHub. */
  trafego?: { visitas: number; unicas: number; clones: number; origens: string[]; dias: 14 };
  /** Só com `escrita`; alertas abertos (`null`: o recurso está desligado no repositório). */
  seguranca?: { dependabot: number | null; codeScanning: number | null };
}
