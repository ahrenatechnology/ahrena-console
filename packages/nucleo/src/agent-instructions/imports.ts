// Os `@imports` de um CLAUDE.md, resolvidos como o Claude Code resolve: relativos ao arquivo que
// importa, fora de blocos e trechos de código, até 5 saltos. Puro: quem chama dá `read` e `exists`.

import { posix } from 'node:path';
import type { ImportNode, InstructionKind } from './model.ts';

/**
 * Até 5 saltos de `@import`, como o Claude Code: um import no 5º salto é lido e mostrado; só o do
 * 6º em diante vira `too-deep`. O arquivo de instrução listado é o salto 0.
 */
export const MAX_IMPORT_DEPTH = 5;

const INSTRUCTION_FILE = /(^|\/)(CLAUDE|AGENTS)\.md$/;

/** `CLAUDE.md`, `.claude/CLAUDE.md` e `AGENTS.md`, da raiz ou de uma subpasta. */
export function isInstructionFile(path: string): boolean {
  return INSTRUCTION_FILE.test(path);
}

/** Quem lê cada arquivo, para a tela dizer de onde vem; `null` se não é arquivo de instrução. */
export function kindOf(path: string): InstructionKind | null {
  if (path === 'CLAUDE.md' || path === '.claude/CLAUDE.md') return 'claude-root';
  if (path === 'AGENTS.md') return 'agents-root';
  if (/(^|\/)CLAUDE\.md$/.test(path)) return 'claude-nested';
  if (/(^|\/)AGENTS\.md$/.test(path)) return 'agents-nested';
  return null;
}

/**
 * Os `@caminho` de um texto, na ordem, fora de blocos (```, ~~~) e trechos (`…`) de código. Uma
 * menção (`@fulano`) e um e-mail não são import: o caminho precisa de barra ou de extensão, e o `@`
 * vem no começo da linha ou depois de um espaço.
 */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line.replace(/`[^`]*`/g, '');
    for (const m of plain.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+)/g)) {
      const ref = m[1].replace(/[.,;:)]+$/, '');
      if (ref.includes('/') || /\.\w+$/.test(ref)) out.push(ref);
    }
  }
  return out;
}

/**
 * Para onde um `@ref` de `from` aponta no repositório; `null` quando sai dele (`@~/…`, caminho
 * absoluto ou `..` acima da raiz).
 */
export function importTarget(from: string, ref: string): string | null {
  if (ref.startsWith('~/') || ref.startsWith('/')) return null;
  const target = posix.normalize(posix.join(posix.dirname(from), ref));
  if (target === '..' || target.startsWith('../') || target === '.' || target === '') return null;
  return target;
}

/**
 * Resolve os imports de `path` em árvore. `read` devolve o texto (ou `undefined`), `exists` diz se o
 * caminho está no repositório. Cada nó diz se achou o arquivo, se está fora do repositório, se fecha
 * um ciclo (com quem o importou) ou se passou da profundidade. Um arquivo que existe mas cujo texto
 * não foi lido fica `ok` sem `bytes` (e sem imports, que não há como saber).
 */
export function resolveImports(
  path: string,
  read: (path: string) => string | undefined,
  exists: (path: string) => boolean,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): ImportNode {
  if (depth > MAX_IMPORT_DEPTH) return { path, status: 'too-deep', imports: [] };
  const text = read(path);
  const node: ImportNode = { path, status: 'ok', imports: [] };
  if (text === undefined) return node;
  node.bytes = byteLength(text);
  const ancestors = new Set(seen).add(path);
  for (const ref of importsOf(text)) {
    const target = importTarget(path, ref);
    if (target === null) node.imports.push({ ref, path: null, status: 'outside-repo', imports: [] });
    else if (ancestors.has(target)) node.imports.push({ ref, path: target, status: 'cycle', imports: [] });
    // Passou do 5º salto: nem se pergunta se existe (a leitura não busca esse texto).
    else if (depth + 1 > MAX_IMPORT_DEPTH) node.imports.push({ ref, path: target, status: 'too-deep', imports: [] });
    else if (!exists(target)) node.imports.push({ ref, path: target, status: 'missing', imports: [] });
    else node.imports.push({ ref, ...resolveImports(target, read, exists, depth + 1, ancestors) });
  }
  return node;
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}
