// Spike #184: o que "instalar o Ahrena Framework num repositório" escreve, por plataforma, sem
// escrever nada. Recebe os arquivos do repositório (caminho → texto, só os que interessam), o
// catálogo do framework e as escolhas da tela; devolve o plano: cada arquivo com o antes, o depois
// e a ação (criar, mesclar, igual ou recusado). Quem abre o PR é outra peça (ver o estudo).

export const MARKETPLACE = 'ahrena';
export const FRAMEWORK_REPO = 'ahrenatechnology/ahrena-framework';
const BLOCK = { start: '<!-- ahrena:framework:start -->', end: '<!-- ahrena:framework:end -->' };
const TOML_BLOCK = { start: '# ahrena:framework:start', end: '# ahrena:framework:end' };

/** Sempre: o núcleo que os outros pedem, o fluxo de contribuição e os fundamentos. */
export const BASE = ['ahrena-foundation', 'ahrena-contributing', 'ahrena-engineering-fundamentals'];

// Sinais no repositório → plugin sugerido, com o motivo que a tela mostra.
const SIGNALS = [
  ['ahrena-engineering-typescript', (f) => f.has('tsconfig.json') || f.any(/\.tsx?$/), 'tsconfig.json ou arquivos .ts'],
  ['ahrena-engineering-python', (f) => f.has('pyproject.toml') || f.has('requirements.txt') || f.has('setup.py'), 'pyproject.toml ou requirements.txt'],
  ['ahrena-engineering-go', (f) => f.has('go.mod'), 'go.mod'],
  ['ahrena-engineering-rust', (f) => f.has('Cargo.toml'), 'Cargo.toml'],
  ['ahrena-engineering-frontend', (f) => f.dep(/^(react|vue|svelte|next|@angular\/core|solid-js)$/) || f.any(/\.(tsx|jsx|vue|svelte)$/), 'React, Vue, Svelte ou Angular'],
  ['ahrena-engineering-backend', (f) => f.dep(/^(express|fastify|@nestjs\/core|koa|hono)$/) || f.pyDep(/^(fastapi|django|flask)$/) || f.has('go.mod') && f.any(/(^|\/)(cmd|internal)\//), 'um framework de servidor'],
  ['ahrena-engineering-data', (f) => f.has('dbt_project.yml') || f.pyDep(/^(great-expectations|great_expectations|pyspark|dbt-core)$/), 'dbt, Spark ou Great Expectations'],
];

/** O que a tela mostra em "o que achamos": linguagens, testes, CI e os plugins sugeridos com o motivo. */
export function detect(files) {
  const paths = Object.keys(files);
  const pkg = safeJson(files['package.json']) ?? {};
  const deps = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  const py = (files['pyproject.toml'] ?? '') + '\n' + (files['requirements.txt'] ?? '');
  const f = {
    has: (p) => p in files,
    any: (re) => paths.some((p) => re.test(p)),
    dep: (re) => [...deps].some((d) => re.test(d)),
    pyDep: (re) => py.split(/[\s"',[\]=<>~!]+/).some((d) => re.test(d.toLowerCase())),
  };
  const suggested = SIGNALS.filter(([, test]) => test(f)).map(([name, , why]) => ({ name, why }));
  return {
    ci: paths.some((p) => /^\.github\/workflows\/.+\.ya?ml$/.test(p)),
    tests: paths.some((p) => /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.\w+$|_test\.go$/.test(p)),
    suggested,
    plugins: [...BASE, ...suggested.map((s) => s.name)],
  };
}

/** Uma linha por regra de julgamento, com o link: o índice que o framework manda escrever (ARCHITECTURE.md). */
export function rulesIndex(catalog, plugins) {
  const lines = [];
  for (const p of catalog.plugins.filter((p) => plugins.includes(p.name))) {
    for (const r of p.rules.filter((r) => r.enforcement === 'judgment')) {
      lines.push(`- **${r.title}.** ${r.statement} ([${p.name}](https://github.com/${FRAMEWORK_REPO}/blob/main/${r.path}))`);
    }
  }
  return lines;
}

/** Troca só o que está entre os marcadores; sem marcadores, acrescenta o bloco no fim. Nunca apaga o resto. */
export function upsertBlock(text, body, marks = BLOCK) {
  const block = `${marks.start}\n${body.trimEnd()}\n${marks.end}`;
  if (text == null || text === '') return `${block}\n`;
  const i = text.indexOf(marks.start), j = text.indexOf(marks.end);
  if (i >= 0 && j > i) return text.slice(0, i) + block + text.slice(j + marks.end.length);
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

/**
 * `.claude/settings.json`: acrescenta o marketplace e habilita os plugins. Chaves que já existem
 * ficam; um plugin que a pessoa desligou (`false`) continua desligado. JSON inválido não é
 * reescrito: o plano recusa o arquivo e diz por quê (o instalador antigo trocava por `{}`).
 */
export function mergeClaudeSettings(text, plugins) {
  const cur = text == null ? {} : safeJson(text);
  if (cur === undefined || (cur && typeof cur !== 'object')) return { refused: 'JSON inválido: corrija o arquivo antes de instalar' };
  const next = structuredClone(cur);
  next.extraKnownMarketplaces = { ...next.extraKnownMarketplaces };
  next.extraKnownMarketplaces[MARKETPLACE] ??= { source: { source: 'github', repo: FRAMEWORK_REPO } };
  next.enabledPlugins = { ...next.enabledPlugins };
  for (const p of plugins) if (!(`${p}@${MARKETPLACE}` in next.enabledPlugins)) next.enabledPlugins[`${p}@${MARKETPLACE}`] = true;
  return { text: `${JSON.stringify(next, null, 2)}\n` };
}

/** `.codex/config.toml`: o marketplace e os plugins, num bloco com marcadores, como o `config.toml` do usuário. */
export function codexConfigBlock(plugins) {
  return [
    `[marketplaces.${MARKETPLACE}]`, 'source_type = "git"', `source = "https://github.com/${FRAMEWORK_REPO}.git"`, '',
    ...plugins.flatMap((p) => [`[plugins."${p}@${MARKETPLACE}"]`, 'enabled = true', '']),
  ].join('\n');
}

/**
 * O plano. O texto que vai para o repositório fica em inglês, como o framework; só a tela é pt-BR.
 * `choice` = { platforms: ['claude', 'codex', 'cursor'], plugins: [...], agency: bool }.
 * Devolve [{ path, action: 'create'|'merge'|'unchanged'|'refused', before, after, why }].
 */
export function plan(files, catalog, choice) {
  const out = [];
  const put = (path, after, why) => {
    const before = files[path] ?? null;
    out.push({ path, before, after, why, action: before === null ? 'create' : before === after ? 'unchanged' : 'merge' });
  };
  const index = rulesIndex(catalog, choice.plugins);
  const agentsBody = [
    '## Ahrena Framework', '',
    `Plugins: ${choice.plugins.map((p) => `\`${p}\``).join(', ')} (marketplace \`${MARKETPLACE}\`).`, '',
    'Judgment rules, one line each; the full text is behind the link:', '', ...index,
    ...(choice.agency ? ['', 'Build work enters through the `athena` agent, who plans, routes and delegates; do not implement it directly.'] : []),
  ].join('\n');
  const wantsAgents = choice.platforms.includes('codex') || choice.platforms.includes('claude');
  if (wantsAgents) put('AGENTS.md', upsertBlock(files['AGENTS.md'], agentsBody), 'índice das regras, lido pelo Codex e importado pelo CLAUDE.md');
  if (choice.platforms.includes('claude')) {
    // O import que conta é o da pessoa, fora do nosso bloco; o de dentro é nosso e volta igual.
    const own = (files['CLAUDE.md'] ?? '').replace(/<!-- ahrena:framework:start -->[\s\S]*?<!-- ahrena:framework:end -->/, '');
    const imports = /^@AGENTS\.md\s*$/m.test(own) ? 'The Ahrena Framework index lives in AGENTS.md, imported above.' : '@AGENTS.md';
    put('CLAUDE.md', upsertBlock(files['CLAUDE.md'], imports), 'o Claude Code carrega o AGENTS.md por import');
    const s = mergeClaudeSettings(files['.claude/settings.json'] ?? null, choice.plugins);
    if (s.refused) out.push({ path: '.claude/settings.json', action: 'refused', before: files['.claude/settings.json'], after: null, why: s.refused });
    else put('.claude/settings.json', s.text, 'quem clonar recebe a oferta de instalar os plugins');
  }
  if (choice.platforms.includes('codex')) {
    put('.codex/config.toml', upsertBlock(files['.codex/config.toml'], codexConfigBlock(choice.plugins), TOML_BLOCK), 'marketplace e plugins para o Codex (a confirmar no escopo do projeto)');
  }
  if (choice.platforms.includes('cursor')) {
    for (const p of catalog.plugins.filter((p) => choice.plugins.includes(p.name))) {
      for (const r of p.rules.filter((r) => r.enforcement === 'judgment')) {
        put(`.cursor/rules/ahrena-${r.id}.mdc`, `---\ndescription: ${r.statement}\nalwaysApply: false\n---\n\n${r.title}. Full text: https://github.com/${FRAMEWORK_REPO}/blob/main/${r.path}\n`, 'regra de julgamento no formato do Cursor');
      }
    }
  }
  return out;
}

/** Diff unificado mínimo (LCS por linha), para a prévia. */
export function unifiedDiff(path, before, after) {
  const a = before == null ? [] : before.replace(/\n$/, '').split('\n');
  const b = after == null ? [] : after.replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const lines = [`--- ${before == null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  let i = 0, j = 0, add = 0, del = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { lines.push(` ${a[i]}`); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { lines.push(`+${b[j++]}`); add++; }
    else { lines.push(`-${a[i++]}`); del++; }
  }
  return { text: lines.join('\n'), add, del };
}

function safeJson(t) { if (t == null) return null; try { return JSON.parse(t); } catch { return undefined; } }
