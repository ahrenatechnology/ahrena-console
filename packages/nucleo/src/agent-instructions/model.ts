// O contrato da aba Instruções de um repositório (#183): o que um agente herda ao trabalhar nele.
// Bastidores em inglês; o texto que a pessoa vê (as mensagens de `error`) em pt-BR.
//
// O texto dos arquivos é dado do repositório: o núcleo só o devolve para a tela mostrar, nunca o
// entrega a um agente como instrução. Dos hooks sai o evento, o matcher e a quantidade, nunca o comando.

import type { EnabledPlugin, HookSummary } from '../agent-config/parse.ts';

export type { EnabledPlugin, HookSummary };

/** Quem lê o arquivo: o Claude Code na raiz ou numa subpasta, ou a convenção AGENTS.md. */
export type InstructionKind = 'claude-root' | 'agents-root' | 'claude-nested' | 'agents-nested';

/**
 * - `ok`: achado no repositório;
 * - `outside-repo`: `@~/…`, caminho absoluto ou `..` acima da raiz; vem da máquina de quem roda;
 * - `missing`: o arquivo não existe no repositório;
 * - `cycle`: o arquivo já está entre os que o importaram;
 * - `too-deep`: passou dos 5 saltos que o Claude Code segue.
 */
export type ImportStatus = 'ok' | 'outside-repo' | 'missing' | 'cycle' | 'too-deep';

export interface ImportNode {
  /** O `@caminho` como está escrito; ausente na raiz da árvore. */
  ref?: string;
  /** O caminho no repositório; `null` quando está fora dele. */
  path: string | null;
  status: ImportStatus;
  /** Tamanho em bytes, quando o arquivo foi lido. */
  bytes?: number;
  imports: ImportNode[];
}

/** O nó com o texto do import já lido (só nos `ok`), para a tela abrir no lugar do `@`. */
export interface ImportNodeWithText extends ImportNode {
  text?: string;
  imports: ImportNodeWithText[];
}

export interface InstructionFile {
  path: string;
  kind: InstructionKind;
  /** A pasta do arquivo; `''` na raiz. */
  folder: string;
  /** Os arquivos de instrução que trazem este, por `@import` (direto ou não). */
  importedBy: string[];
  tree: ImportNode;
}

export interface RuleEntry {
  path: string;
  name: string;
  /** Os `paths` (ou `globs`) do front matter; vazio vale para o repositório todo. */
  paths: string[];
}

export interface DescribedEntry {
  path: string;
  name: string;
  description: string | null;
}

export interface CommandEntry {
  path: string;
  /** O nome que se digita: `/pasta:nome`. */
  name: string;
}

export type SettingsState = 'ok' | 'invalid' | 'none';

export type WarningKind = 'truncated' | 'agents-not-imported' | 'missing-import' | 'invalid-settings';

export interface InstructionWarning {
  kind: WarningKind;
  /** O arquivo do aviso: o AGENTS.md sem import, o que tem o import quebrado, o settings.json. */
  path?: string;
  /** O `@caminho` que não existe (`missing-import`). */
  ref?: string;
}

/** O que se lê dos arquivos, sem a origem: o mesmo para o disco e para o GitHub. */
export interface InstructionsContent {
  /** O GitHub cortou a árvore: arquivos de subpastas podem faltar. */
  truncated: boolean;
  /** Nada de instrução, `.claude/` nem `.mcp.json`. */
  empty: boolean;
  files: InstructionFile[];
  rules: RuleEntry[];
  skills: DescribedEntry[];
  agents: DescribedEntry[];
  commands: CommandEntry[];
  hooks: HookSummary[];
  plugins: EnabledPlugin[];
  marketplaces: string[];
  /** Os nomes dos servidores de `.mcp.json`. */
  mcp: string[];
  settings: SettingsState;
  warnings: InstructionWarning[];
}

/**
 * - `ready`: leitura feita (com `error` quando é o cache servido porque o GitHub falhou);
 * - `loading`: sem leitura ainda; a tela espera a mudança `agent-instructions`;
 * - `no-github`: núcleo sem `gh` ou com `--no-github`;
 * - `error`: falhou e não há leitura anterior;
 * - `not-found`: o repositório não existe ou não é visível para o token.
 */
export type InstructionsState = 'ready' | 'loading' | 'no-github' | 'error' | 'not-found';

/** `GET /api/agent-instructions/<owner>/<repo>`: sem o texto dos arquivos. */
export interface AgentInstructions extends InstructionsContent {
  state: InstructionsState;
  /** Motivo do dado velho ou da falha, em pt-BR; `null` sem problema. */
  error: string | null;
  repo: string;
  /** O commit lido (o HEAD do branch padrão); `null` em repositório sem commit ou sem leitura. */
  commit: string | null;
  /** Quando a leitura veio do GitHub (ISO); `null` sem leitura. */
  readAt: string | null;
}

/** `GET /api/agent-instructions/<owner>/<repo>/file?path=`: um arquivo, com os imports já lidos. */
export interface InstructionFileView {
  state: InstructionsState;
  error: string | null;
  repo: string;
  readAt: string | null;
  path: string;
  kind: InstructionKind;
  text: string;
  tree: ImportNodeWithText;
}
