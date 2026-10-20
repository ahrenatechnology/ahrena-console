// O que um agente herda de um repositório (#183), a partir da lista de caminhos e de um `read(path)`:
// os arquivos de instrução com a árvore de `@imports`, o que `.claude/` traz e os servidores de
// `.mcp.json`, com os avisos da tela. Puro e síncrono: a fonte (o GitHub, ou o disco) lê antes o
// que é preciso (`neededPaths` e os imports) e entrega o texto pronto. A interpretação do front
// matter, dos hooks e dos plugins é a do Agent Config (src/agent-config/parse.ts).

import { posix } from 'node:path';
import { hooksOf, marketplacesOf, mcpServersOf, parseJsonObject, pluginsOf, readFrontmatter, readFrontmatterLists } from '../agent-config/parse.ts';
import { isInstructionFile, kindOf, resolveImports } from './imports.ts';
import type { CommandEntry, DescribedEntry, ImportNode, ImportNodeWithText, InstructionFile, InstructionsContent, InstructionWarning, RuleEntry } from './model.ts';

export const SETTINGS_PATH = '.claude/settings.json';
export const MCP_PATH = '.mcp.json';

const SKILL = /^\.claude\/skills\/[^/]+\/SKILL\.md$/;
const AGENT = /^\.claude\/agents\/.+\.md$/;
const RULE = /^\.claude\/rules\/.+\.md$/;
const COMMAND = /^\.claude\/commands\/.+\.md$/;

/** Os caminhos cujo texto a leitura usa: os arquivos de instrução, skills, agentes, regras, settings e MCP. */
export function neededPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => isInstructionFile(p) || SKILL.test(p) || AGENT.test(p) || RULE.test(p) || p === SETTINGS_PATH || p === MCP_PATH);
}

/** Os caminhos que a tela pode pedir pela rota do arquivo, e só eles. */
export function isListedInstructionFile(content: Pick<InstructionsContent, 'files'>, path: string): boolean {
  return content.files.some((f) => f.path === path);
}

const byDepthThenName = (a: string, b: string) => a.split('/').length - b.split('/').length || a.localeCompare(b);

/**
 * Lê tudo o que um agente herda do repositório. `paths` é a lista de arquivos conhecidos (a árvore,
 * mais os alvos de import achados); `read(path)` devolve o texto. `truncated`: o GitHub cortou a árvore.
 */
export function readInstructions(paths: readonly string[], read: (path: string) => string | undefined, { truncated = false } = {}): InstructionsContent {
  const set = new Set(paths);
  const exists = (p: string) => set.has(p);
  const sorted = [...set].sort(byDepthThenName);

  const reachedBy = new Map<string, Set<string>>();
  const files: InstructionFile[] = sorted.filter(isInstructionFile).map((path) => {
    const tree = resolveImports(path, read, exists);
    const reached = new Set<string>();
    const walk = (n: ImportNode) =>
      n.imports.forEach((c) => {
        if (c.path && c.status === 'ok') reached.add(c.path);
        walk(c);
      });
    walk(tree);
    reachedBy.set(path, reached);
    const folder = posix.dirname(path);
    return { path, kind: kindOf(path)!, folder: folder === '.' ? '' : folder, importedBy: [], tree };
  });
  // "AGENTS.md, importado pelo CLAUDE.md": quem traz cada arquivo para o Claude Code.
  for (const f of files) f.importedBy = files.filter((g) => g !== f && reachedBy.get(g.path)!.has(f.path)).map((g) => g.path);

  // Skill e agente: o nome e a descrição do front matter; sem eles, o nome da pasta ou do arquivo.
  const described = (path: string, fallback: string): DescribedEntry => {
    const fm = readFrontmatter(read(path) ?? '');
    return { path, name: fm.name?.trim() || fallback, description: fm.description?.trim() || null };
  };
  const skills = sorted.filter((p) => SKILL.test(p)).map((p) => described(p, p.split('/').at(-2)!));
  const agents = sorted.filter((p) => AGENT.test(p)).map((p) => described(p, posix.basename(p, '.md')));
  const commands: CommandEntry[] = sorted.filter((p) => COMMAND.test(p)).map((p) => ({ path: p, name: '/' + p.slice('.claude/commands/'.length, -3).replace(/\//g, ':') }));
  const rules: RuleEntry[] = sorted
    .filter((p) => RULE.test(p))
    .map((p) => {
      const lists = readFrontmatterLists(read(p) ?? '');
      return { path: p, name: posix.basename(p, '.md'), paths: lists.paths ?? lists.globs ?? [] };
    });

  const settingsText = exists(SETTINGS_PATH) ? read(SETTINGS_PATH) : undefined;
  const settings = settingsText === undefined ? undefined : parseJsonObject(settingsText);
  const settingsState = !exists(SETTINGS_PATH) ? 'none' : settings ? 'ok' : 'invalid';
  const mcpText = exists(MCP_PATH) ? read(MCP_PATH) : undefined;
  const mcp = mcpText === undefined ? [] : mcpServersOf(parseJsonObject(mcpText));

  const hooks = hooksOf(settings);
  const plugins = pluginsOf(settings);
  const marketplaces = marketplacesOf(settings);
  const content: InstructionsContent = {
    truncated,
    empty: false,
    files,
    rules,
    skills,
    agents,
    commands,
    hooks,
    plugins,
    marketplaces,
    mcp,
    settings: settingsState,
    warnings: [],
  };
  content.empty =
    files.length + rules.length + skills.length + agents.length + commands.length + hooks.length + plugins.length + marketplaces.length + mcp.length === 0 &&
    settingsState === 'none';
  content.warnings = warningsOf(content);
  return content;
}

/**
 * Os avisos da tela (C33), na ordem: a árvore cortada, o settings.json quebrado, cada AGENTS.md que
 * nenhum CLAUDE.md importa (só sem o import) e cada `@import` que não existe, com o arquivo e o ref.
 */
export function warningsOf(content: Omit<InstructionsContent, 'warnings' | 'empty'>): InstructionWarning[] {
  const warnings: InstructionWarning[] = [];
  if (content.truncated) warnings.push({ kind: 'truncated' });
  if (content.settings === 'invalid') warnings.push({ kind: 'invalid-settings', path: SETTINGS_PATH });
  for (const f of content.files) {
    if ((f.kind === 'agents-root' || f.kind === 'agents-nested') && !f.importedBy.some((p) => kindOf(p)?.startsWith('claude'))) warnings.push({ kind: 'agents-not-imported', path: f.path });
  }
  const seen = new Set<string>();
  const walk = (n: ImportNode) => {
    for (const c of n.imports) {
      if (c.status === 'missing' && n.path && c.ref) {
        const k = `${n.path}\0${c.ref}`;
        if (!seen.has(k)) {
          seen.add(k);
          warnings.push({ kind: 'missing-import', path: n.path, ref: c.ref });
        }
      }
      walk(c);
    }
  };
  for (const f of content.files) walk(f.tree);
  return warnings;
}

/** A árvore com o texto de cada nó `ok`, para a rota do arquivo. */
export function withTexts(node: ImportNode, read: (path: string) => string | undefined): ImportNodeWithText {
  const out: ImportNodeWithText = { ...node, imports: node.imports.map((c) => withTexts(c, read)) };
  if (node.status === 'ok' && node.path) out.text = read(node.path) ?? '';
  return out;
}
