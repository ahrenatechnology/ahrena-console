// node --test spikes/agent-instructions: um repositório falso em memória, como o GitHub falso do núcleo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInstructions, importsOf, resolveImports, hooksOf, pluginsOf, searchAcross, MAX_IMPORT_DEPTH } from './instructions.mjs';

// Repositório sintético: CLAUDE.md que importa AGENTS.md e um guia, uma subpasta com o seu CLAUDE.md,
// e um .claude com regra, skill, agente, comando, hook e plugin.
const REPO = {
  'CLAUDE.md': '# vitrine-demo\n\n@AGENTS.md\n@docs/guia-de-estilo.md\n@~/.claude/pessoal.md\n\nNão use `@nao-e-import.md` nem\n```\n@tambem-nao.md\n```\nFale com @fulano no review.\n',
  'AGENTS.md': '# Instruções\n\n- Bastidores em inglês; a tela em pt-BR.\n- Rode `npm test` antes do PR.\n',
  'docs/guia-de-estilo.md': '# Guia\n\nVeja também @../README.md e @faltando.md\n',
  'README.md': '# vitrine-demo\n',
  'packages/ui/CLAUDE.md': '# ui\n\nClasses com prefixo da tela.\n@../../CLAUDE.md\n',
  '.claude/rules/testes.md': '---\npaths:\n  - "test/**"\n---\nUse o GitHub falso.\n',
  '.claude/skills/release/SKILL.md': '---\nname: release\ndescription: Publica uma versão do app.\n---\n',
  '.claude/agents/revisor.md': '---\nname: revisor\ndescription: Revisa o diff contra as regras.\n---\n',
  '.claude/commands/pr/abrir.md': 'Abra o PR.\n',
  '.claude/hooks/format.sh': '#!/bin/sh\n',
  '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'revisao@time': true, 'antigo@time': false }, extraKnownMarketplaces: { time: {} }, hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'sh .claude/hooks/format.sh' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] } }),
  '.mcp.json': JSON.stringify({ mcpServers: { github: {}, banco: {} } }),
  'src/index.ts': '',
};
const read = async (p) => REPO[p];

test('arquivos de instrução: raiz, subpasta, imports resolvidos e quem importa quem', async () => {
  const r = await readInstructions(Object.keys(REPO), read);
  assert.deepEqual(r.files.map((f) => [f.path, f.kind]), [['AGENTS.md', 'agents-root'], ['CLAUDE.md', 'claude-root'], ['packages/ui/CLAUDE.md', 'claude-nested']]);
  const claude = r.files.find((f) => f.path === 'CLAUDE.md');
  assert.deepEqual(claude.tree.imports.map((i) => [i.ref, i.status]), [['AGENTS.md', 'ok'], ['docs/guia-de-estilo.md', 'ok'], ['~/.claude/pessoal.md', 'outside-repo']]);
  const guia = claude.tree.imports[1];
  assert.deepEqual(guia.imports.map((i) => [i.path, i.status]), [['README.md', 'ok'], ['docs/faltando.md', 'missing']]);
  assert.deepEqual(r.files.find((f) => f.path === 'AGENTS.md').importedBy, ['CLAUDE.md', 'packages/ui/CLAUDE.md']);
  assert.equal(r.empty, false);
});

test('.claude: regras com paths, skills, agentes, comandos, hooks sem o comando, plugins e MCP', async () => {
  const r = await readInstructions(Object.keys(REPO), read);
  assert.deepEqual(r.rules, [{ path: '.claude/rules/testes.md', name: 'testes', paths: ['test/**'] }]);
  assert.deepEqual(r.skills.map((s) => [s.name, s.description]), [['release', 'Publica uma versão do app.']]);
  assert.deepEqual(r.agents.map((s) => s.name), ['revisor']);
  assert.deepEqual(r.commands.map((c) => c.name), ['/pr:abrir']);
  assert.deepEqual(r.hooks, [{ event: 'PostToolUse', count: 1, matchers: ['Edit|Write'] }, { event: 'Stop', count: 1, matchers: [] }]);
  assert.ok(!JSON.stringify(r.hooks).includes('format.sh'));
  assert.deepEqual(r.plugins, [{ name: 'revisao', marketplace: 'time' }]);
  assert.deepEqual(r.marketplaces, ['time']);
  assert.deepEqual(r.mcp, ['github', 'banco']);
  assert.deepEqual(r.hookScripts, ['.claude/hooks/format.sh']);
});

test('repositório sem nada: empty, para o aviso', async () => {
  const r = await readInstructions(['README.md', 'src/a.ts'], async () => '');
  assert.equal(r.empty, true);
  assert.equal(r.settings, 'none');
});

test('settings.json quebrado não derruba o resto', async () => {
  const r = await readInstructions(['CLAUDE.md', '.claude/settings.json'], async (p) => (p === 'CLAUDE.md' ? '# x\n' : '{ quebrado'));
  assert.equal(r.settings, 'invalid');
  assert.equal(r.files.length, 1);
});

test('imports: fora de código, sem menções, ciclo e profundidade máxima', async () => {
  assert.deepEqual(importsOf(REPO['CLAUDE.md']), ['AGENTS.md', 'docs/guia-de-estilo.md', '~/.claude/pessoal.md']);
  const ciclo = { 'a.md': '@b.md', 'b.md': '@a.md' };
  const t = await resolveImports('a.md', async (p) => ciclo[p], (p) => p in ciclo);
  assert.equal(t.imports[0].imports[0].status, 'cycle');
  const fundo = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`n${i}.md`, `@n${i + 1}.md`]));
  fundo['n8.md'] = 'fim';
  let n = await resolveImports('n0.md', async (p) => fundo[p], (p) => p in fundo);
  let depth = 0;
  while (n.imports.length) { n = n.imports[0]; depth++; }
  assert.equal(depth, MAX_IMPORT_DEPTH);
  assert.equal(n.status, 'too-deep');
});

test('hooks e plugins tolerantes a formato estranho', () => {
  assert.deepEqual(hooksOf({ hooks: { Stop: 'x' } }), [{ event: 'Stop', count: 0, matchers: [] }]);
  assert.deepEqual(pluginsOf({ enabledPlugins: { solto: true } }), [{ name: 'solto', marketplace: null }]);
});

test('busca transversal: quais repositórios têm a regra', () => {
  const hits = searchAcross({ 'exemplo-labs/vitrine-demo': { 'AGENTS.md': REPO['AGENTS.md'] }, 'exemplo-labs/motor-de-regras': { 'CLAUDE.md': '# x\nNomes em português.\n' } }, 'bastidores em inglês');
  assert.deepEqual(hits, [{ repo: 'exemplo-labs/vitrine-demo', path: 'AGENTS.md', line: 3 }]);
});
