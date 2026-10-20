// O modelo da instalação do Ahrena Framework num repositório (#184): o catálogo do framework, o que
// a detecção acha, a escolha da pessoa, o plano (um item por arquivo) e o estado do PR. Nada aqui
// fala com o GitHub: as portas ficam em pull-request.ts e quem as implementa em src/github.

/** O marketplace do framework, nome das chaves `<plugin>@ahrena` no `.claude/settings.json`. */
export const MARKETPLACE = 'ahrena';
/** O repositório do framework por padrão; trocável por `AHRENA_CONSOLE_FRAMEWORK_REPO` (decisão 1 de 20/10). */
export const DEFAULT_FRAMEWORK_REPO = 'ahrenatechnology/ahrena-framework';
/** Os marcadores do bloco do framework no `CLAUDE.md` e no `AGENTS.md`. */
export const BLOCK = { start: '<!-- ahrena:framework:start -->', end: '<!-- ahrena:framework:end -->' } as const;
/** O branch do PR de instalação; nunca o padrão. */
export const INSTALL_BRANCH = 'chore/install-ahrena-framework';
/** O título padrão do PR (o texto que vai para o repositório fica em inglês, como o framework). */
export const INSTALL_TITLE = 'chore: install the Ahrena Framework';

/** Sempre instalados, travados na tela: o núcleo, o fluxo de contribuição e os fundamentos. */
export const BASE_PLUGINS = ['ahrena-foundation', 'ahrena-contributing', 'ahrena-engineering-fundamentals'] as const;

export type PlatformId = 'claude' | 'codex' | 'cursor';
export const PLATFORM_IDS: readonly PlatformId[] = ['claude', 'codex', 'cursor'];
/** As plataformas que a instalação escreve hoje; o Cursor fica "a confirmar" (decisão 2 de 20/10). */
export const AVAILABLE_PLATFORMS: readonly PlatformId[] = ['claude', 'codex'];

export interface CatalogRule {
  id: string;
  title: string;
  statement: string;
  /** `hook`: cumprida por script do plugin; `judgment`: entra no índice, uma linha mais o link. */
  enforcement: string;
  /** O caminho no repositório do framework (o link do índice). */
  path: string;
}

export interface CatalogPlugin {
  name: string;
  /** A pasta do plugin no repositório do framework. */
  path: string;
  description: string;
  keywords: string[];
  rules: CatalogRule[];
}

export interface Catalog {
  marketplace: string;
  /** `dono/repo` do framework. */
  repo: string;
  /** O commit lido, curto. */
  commit: string | null;
  plugins: CatalogPlugin[];
}

export interface Suggestion {
  name: string;
  /** O motivo, em pt-BR, para a tela. */
  why: string;
}

export interface Detection {
  /** Linguagens achadas pelos sinais (TypeScript, Python…). */
  languages: string[];
  /** Frameworks achados nas dependências (React, FastAPI…). */
  frameworks: string[];
  /** A pasta ou o arquivo de teste achado primeiro; `false` sem testes. */
  tests: string | false;
  /** `GitHub Actions` com workflow; `false` sem CI. */
  ci: string | false;
  suggested: Suggestion[];
  /** Base e sugeridos, nessa ordem: a escolha padrão. */
  plugins: string[];
}

export interface Choice {
  platforms: PlatformId[];
  plugins: string[];
  /** A diretiva da agência (ADR-017 do framework); a tela ainda não oferece. */
  agency?: boolean;
}

export type FileAction = 'create' | 'merge' | 'unchanged' | 'refused';

/**
 * Por que um arquivo foi recusado: JSON que não dá para mesclar, marcadores do framework
 * desemparelhados, ou um arquivo que existe mas o GitHub não entregou inteiro (binário, cortado).
 */
export type RefusalKind = 'invalid-json' | 'unpaired-markers' | 'unreadable';

export interface PlanFile {
  path: string;
  action: FileAction;
  /** O texto de hoje; `null` quando o arquivo não existe. */
  before: string | null;
  /** O texto depois; `null` quando o arquivo é recusado. */
  after: string | null;
  /** O motivo, em pt-BR, para a tela. */
  why: string;
  /** Só em `refused`: a causa. */
  refusal?: RefusalKind;
}

export type PullRequestLifecycle = 'open' | 'merged' | 'closed';
export type ChecksState = 'pending' | 'success' | 'failure';
export type ReviewState = 'approved' | 'changes_requested' | 'review_required';

/** O PR de instalação como a tela mostra. */
export interface PullRequestState {
  number: number;
  url: string;
  title: string;
  branch: string;
  base: string;
  state: PullRequestLifecycle;
  checks: ChecksState | null;
  review: ReviewState | null;
  updatedAt: string;
}

/** A instalação foi recusada antes de qualquer escrita. `code` vai na resposta da rota. */
export class InstallRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InstallRefused';
    this.code = code;
  }
}
