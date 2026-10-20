// Spike #183: o que um agente herda ao trabalhar num repositório. A partir da lista de caminhos
// do repositório e de uma função que lê um arquivo, monta os arquivos de instrução (AGENTS.md e
// CLAUDE.md da raiz e das subpastas, com os @imports resolvidos) e o que `.claude/` traz (regras,
// skills, agentes, comandos, hooks, plugins habilitados e servidores MCP). Sem dependências.
// A mesma função serve para o disco (Agent Config, #63) e para o GitHub: só muda `read`.

import { posix } from 'node:path';

/** Até 5 saltos de @import, como o Claude Code. */
export const MAX_IMPORT_DEPTH = 5;

const INSTRUCTION = /(^|\/)(CLAUDE|AGENTS)\.md$/;

/** Quem lê cada arquivo, para a tela dizer de onde vem. */
export function kindOf(path) {
  if (path === 'CLAUDE.md' || path === '.claude/CLAUDE.md') return 'claude-root';
  if (path === 'AGENTS.md') return 'agents-root';
  if (/(^|\/)CLAUDE\.md$/.test(path)) return 'claude-nested';
  if (/(^|\/)AGENTS\.md$/.test(path)) return 'agents-nested';
  return null;
}

/** Frontmatter simples: `chave: valor` no topo, entre `---`. */
export function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) { key = kv[1]; out[key] = kv[2].trim().replace(/^["']|["']$/g, ''); }
    else if (key && /^\s*-\s+/.test(line)) out[key] = [].concat(out[key] || [], line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

/**
 * Os `@caminho` de um CLAUDE.md, fora de blocos e trechos de código. `@~/…` é da máquina de quem
 * roda e não existe no repositório; e-mail e menção (`@fulano`) sem barra nem extensão ficam de fora.
 */
export function importsOf(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
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
 * Resolve os imports de um arquivo, em árvore. Cada nó diz se achou o arquivo, se está fora do
 * repositório (`@~/`, caminho absoluto ou `..` acima da raiz), se fecha um ciclo ou passou da profundidade.
 */
export async function resolveImports(path, read, exists, depth = 0, seen = new Set()) {
  const text = await read(path);
  const node = { path, status: 'ok', bytes: text.length, imports: [] };
  if (depth >= MAX_IMPORT_DEPTH) { node.status = 'too-deep'; return node; }
  seen = new Set(seen).add(path);
  for (const ref of importsOf(text)) {
    if (ref.startsWith('~/') || ref.startsWith('/')) { node.imports.push({ ref, path: null, status: 'outside-repo', imports: [] }); continue; }
    const target = posix.normalize(posix.join(posix.dirname(path), ref));
    if (target.startsWith('..')) node.imports.push({ ref, path: null, status: 'outside-repo', imports: [] });
    else if (seen.has(target)) node.imports.push({ ref, path: target, status: 'cycle', imports: [] });
    else if (!exists(target)) node.imports.push({ ref, path: target, status: 'missing', imports: [] });
    else node.imports.push({ ref, ...(await resolveImports(target, read, exists, depth + 1, seen)) });
  }
  return node;
}

/** Eventos de hook e quantos comandos cada um tem; nunca o comando em si, como o Agent Config. */
export function hooksOf(settings) {
  const hooks = settings?.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  return Object.entries(hooks).map(([event, list]) => ({
    event,
    count: Array.isArray(list) ? list.reduce((n, m) => n + (Array.isArray(m?.hooks) ? m.hooks.length : 1), 0) : 0,
    matchers: Array.isArray(list) ? list.map((m) => m?.matcher).filter((x) => typeof x === 'string' && x) : [],
  }));
}

/** Plugins com `true` em `enabledPlugins`, e de qual marketplace. */
export function pluginsOf(settings) {
  const enabled = settings?.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  return Object.keys(enabled).filter((k) => enabled[k] === true).map((k) => {
    const [name, marketplace = null] = k.split('@');
    return { name, marketplace };
  });
}

const parseJson = (t) => { try { return JSON.parse(t); } catch { return undefined; } };

/**
 * Lê tudo o que um agente herda do repositório. `paths` é a lista de arquivos (a árvore do
 * GitHub ou do disco); `read(path)` devolve o texto. Devolve `empty: true` quando não há nada.
 */
export async function readInstructions(paths, read) {
  const set = new Set(paths);
  const exists = (p) => set.has(p);
  const files = [];
  const roots = paths.filter((p) => INSTRUCTION.test(p) || p === '.claude/CLAUDE.md').sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const p of roots) {
    const tree = await resolveImports(p, read, exists);
    const reached = new Set();
    const walk = (n) => n.imports.forEach((c) => { if (c.path && c.status === 'ok') reached.add(c.path); walk(c); });
    walk(tree);
    files.push({ path: p, kind: kindOf(p), folder: posix.dirname(p) === '.' ? '' : posix.dirname(p), tree, reached });
  }
  // "AGENTS.md, importado pelo CLAUDE.md": a tela diz quem traz cada arquivo para o Claude Code.
  for (const f of files) f.importedBy = files.filter((g) => g !== f && g.reached.has(f.path)).map((g) => g.path);
  for (const f of files) delete f.reached;

  const under = (dir) => paths.filter((p) => p.startsWith(`.claude/${dir}/`));
  // Skill e agente: o nome e a descrição do frontmatter, senão o nome da pasta ou do arquivo.
  const md = async (p, fallback) => {
    const fm = frontmatter(await read(p));
    return { path: p, name: typeof fm.name === 'string' && fm.name ? fm.name : fallback, description: typeof fm.description === 'string' ? fm.description : null };
  };
  const skills = [];
  for (const p of under('skills').filter((p) => /\/SKILL\.md$/.test(p))) skills.push(await md(p, p.split('/').at(-2)));
  const agents = [];
  for (const p of under('agents').filter((p) => p.endsWith('.md'))) agents.push(await md(p, posix.basename(p, '.md')));
  const commands = under('commands').filter((p) => p.endsWith('.md')).map((p) => ({ path: p, name: '/' + p.slice('.claude/commands/'.length, -3).replace(/\//g, ':') }));
  const rules = [];
  for (const p of under('rules').filter((p) => p.endsWith('.md'))) {
    const fm = frontmatter(await read(p));
    rules.push({ path: p, name: posix.basename(p, '.md'), paths: [].concat(fm.paths || fm.globs || []) });
  }
  const hookScripts = under('hooks');

  let settings = null;
  const settingsFiles = ['.claude/settings.json'].filter(exists);
  if (settingsFiles.length) settings = parseJson(await read('.claude/settings.json'));
  const mcp = exists('.mcp.json') ? Object.keys(parseJson(await read('.mcp.json'))?.mcpServers ?? {}) : [];

  const out = {
    files, skills, agents, commands, rules, hookScripts,
    hooks: settings ? hooksOf(settings) : [],
    plugins: settings ? pluginsOf(settings) : [],
    marketplaces: settings?.extraKnownMarketplaces ? Object.keys(settings.extraKnownMarketplaces) : [],
    settings: settingsFiles.length ? (settings === undefined ? 'invalid' : 'ok') : 'none',
    mcp,
  };
  out.empty = !files.length && !skills.length && !agents.length && !commands.length && !rules.length && !out.hooks.length && !out.plugins.length && !mcp.length;
  return out;
}


/** Busca transversal ("quais repositórios têm a regra X"): procura no texto já lido, sem chamar o GitHub. */
export function searchAcross(repos, query) {
  const q = query.toLowerCase();
  const hits = [];
  for (const [repo, texts] of Object.entries(repos)) {
    for (const [path, text] of Object.entries(texts)) {
      const i = text.toLowerCase().indexOf(q);
      if (i >= 0) hits.push({ repo, path, line: text.slice(0, i).split('\n').length });
    }
  }
  return hits;
}
