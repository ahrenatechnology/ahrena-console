// A leitura das instruções dos agentes (#183), pura: os casos do spike (spikes/agent-instructions)
// contra um repositório sintético em memória, mais os avisos da tela (C33).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONFIG_PATHS, configShape, importsOf, importTarget, kindOf, MAX_IMPORT_DEPTH, neededPaths, readInstructions, resolveImports, withTexts } from '../../src/agent-instructions/index.ts';

// CLAUDE.md que importa AGENTS.md e um guia, uma subpasta com o seu CLAUDE.md, e um .claude com
// regra, skill, agente, comando, hook e plugin.
const REPO: Record<string, string> = {
  'CLAUDE.md': '# vitrine-demo\n\n@AGENTS.md\n@docs/style-guide.md\n@~/.claude/personal.md\n\nNão use `@not-an-import.md` nem\n```\n@neither.md\n```\nFale com @colega-a no review.\n',
  'AGENTS.md': '# Instruções\n\n- Bastidores em inglês; a tela em pt-BR.\n- Rode `npm test` antes do PR.\n',
  'docs/style-guide.md': '# Guia\n\nVeja também @../README.md e @missing.md\n',
  'README.md': '# vitrine-demo\n',
  'packages/ui/CLAUDE.md': '# ui\n\nClasses com prefixo da tela.\n@../../CLAUDE.md\n',
  '.claude/rules/tests.md': '---\npaths:\n  - "test/**"\n---\nUse o GitHub falso.\n',
  '.claude/skills/release/SKILL.md': '---\nname: release\ndescription: Publica uma versão do app.\n---\n',
  '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Revisa o diff contra as regras.\n---\n',
  '.claude/commands/pr/open.md': 'Abra o PR.\n',
  '.claude/hooks/format.sh': '#!/bin/sh\n',
  '.claude/settings.json': JSON.stringify({
    enabledPlugins: { 'review@team': true, 'old@team': false },
    extraKnownMarketplaces: { team: {} },
    hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'sh .claude/hooks/format.sh' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] },
  }),
  '.mcp.json': JSON.stringify({ mcpServers: { tracker: { command: 'secret-binary' }, store: {} } }),
  'src/index.ts': '',
};
const read = (p: string) => REPO[p];
const exists = (p: string) => p in REPO;

describe('#183 instruction files', () => {
  test('root and nested files, resolved imports and who imports whom', () => {
    const r = readInstructions(Object.keys(REPO), read);
    assert.deepEqual(
      r.files.map((f) => [f.path, f.kind, f.folder]),
      [
        ['AGENTS.md', 'agents-root', ''],
        ['CLAUDE.md', 'claude-root', ''],
        ['packages/ui/CLAUDE.md', 'claude-nested', 'packages/ui'],
      ],
    );
    const claude = r.files.find((f) => f.path === 'CLAUDE.md')!;
    assert.deepEqual(
      claude.tree.imports.map((i) => [i.ref, i.status]),
      [
        ['AGENTS.md', 'ok'],
        ['docs/style-guide.md', 'ok'],
        ['~/.claude/personal.md', 'outside-repo'],
      ],
    );
    assert.deepEqual(
      claude.tree.imports[1].imports.map((i) => [i.path, i.status]),
      [
        ['README.md', 'ok'],
        ['docs/missing.md', 'missing'],
      ],
    );
    assert.equal(claude.tree.bytes, Buffer.byteLength(REPO['CLAUDE.md']));
    assert.equal(claude.tree.ref, undefined, 'the root of the tree has no ref');
    assert.deepEqual(r.files.find((f) => f.path === 'AGENTS.md')!.importedBy, ['CLAUDE.md', 'packages/ui/CLAUDE.md']);
    assert.equal(r.empty, false);
  });

  test('kinds: .claude/CLAUDE.md is a root file; anything else is not an instruction file', () => {
    assert.equal(kindOf('.claude/CLAUDE.md'), 'claude-root');
    assert.equal(kindOf('a/b/AGENTS.md'), 'agents-nested');
    assert.equal(kindOf('docs/CLAUDE.md.bak'), null);
  });
});

describe('#183 what .claude/ brings', () => {
  test('rules with paths, skills, agents, commands, hooks without the command, plugins and MCP names', () => {
    const r = readInstructions(Object.keys(REPO), read);
    assert.deepEqual(r.rules, [{ path: '.claude/rules/tests.md', name: 'tests', paths: ['test/**'] }]);
    assert.deepEqual(r.skills, [{ path: '.claude/skills/release/SKILL.md', name: 'release', description: 'Publica uma versão do app.' }]);
    assert.deepEqual(r.agents.map((s) => s.name), ['reviewer']);
    assert.deepEqual(r.commands, [{ path: '.claude/commands/pr/open.md', name: '/pr:open' }]);
    assert.deepEqual(r.hooks, [
      { event: 'PostToolUse', count: 1, matchers: ['Edit|Write'] },
      { event: 'Stop', count: 1, matchers: [] },
    ]);
    const json = JSON.stringify(r);
    assert.ok(!json.includes('format.sh') && !json.includes('echo ok') && !json.includes('secret-binary'), 'no hook command nor MCP value');
    assert.deepEqual(r.plugins, [{ name: 'review', marketplace: 'team' }]);
    assert.deepEqual(r.marketplaces, ['team']);
    assert.deepEqual(r.mcp, ['tracker', 'store']);
    assert.equal(r.settings, 'ok');
  });

  test('a skill or agent without frontmatter takes the folder or file name', () => {
    const r = readInstructions(['.claude/skills/deploy/SKILL.md', '.claude/agents/helper.md'], () => '# no frontmatter\n');
    assert.deepEqual(r.skills, [{ path: '.claude/skills/deploy/SKILL.md', name: 'deploy', description: null }]);
    assert.deepEqual(r.agents, [{ path: '.claude/agents/helper.md', name: 'helper', description: null }]);
  });

  test('neededPaths: only the files whose text the reading uses', () => {
    assert.deepEqual(neededPaths(Object.keys(REPO)).sort(), [
      '.claude/agents/reviewer.md',
      '.claude/rules/tests.md',
      '.claude/settings.json',
      '.claude/skills/release/SKILL.md',
      '.mcp.json',
      'AGENTS.md',
      'CLAUDE.md',
      'packages/ui/CLAUDE.md',
    ]);
  });
});

describe('#183 empty and broken repositories', () => {
  test('a repository with nothing: empty, settings none, no warnings', () => {
    const r = readInstructions(['README.md', 'src/a.ts'], () => '');
    assert.equal(r.empty, true);
    assert.equal(r.settings, 'none');
    assert.deepEqual(r.warnings, []);
  });

  test('a broken settings.json does not take the rest down, and becomes a warning', () => {
    const r = readInstructions(['CLAUDE.md', '.claude/settings.json'], (p) => (p === 'CLAUDE.md' ? '# x\n' : '{ broken'));
    assert.equal(r.settings, 'invalid');
    assert.equal(r.files.length, 1);
    assert.deepEqual(r.warnings, [{ kind: 'invalid-settings', path: '.claude/settings.json' }]);
  });
});

describe('#183 imports', () => {
  test('outside code, without mentions; cycle', () => {
    assert.deepEqual(importsOf(REPO['CLAUDE.md']), ['AGENTS.md', 'docs/style-guide.md', '~/.claude/personal.md']);
    assert.deepEqual(importsOf('mail me at dev@example.invalid, or @someone.\n~~~\n@fenced.md\n~~~\n@ok.md.'), ['ok.md']);
    const cycle: Record<string, string> = { 'a.md': '@b.md', 'b.md': '@a.md' };
    const t = resolveImports('a.md', (p) => cycle[p], (p) => p in cycle);
    assert.equal(t.imports[0].imports[0].status, 'cycle');
  });

  test('maximum depth: the 5th hop is read and shown; too-deep only from the 6th', () => {
    const deep: Record<string, string> = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`n${i}.md`, `@n${i + 1}.md`]));
    deep['n8.md'] = 'end';
    const reads: string[] = [];
    let n = resolveImports(
      'n0.md',
      (p) => (reads.push(p), deep[p]),
      (p) => p in deep,
    );
    const chain = [n];
    while (n.imports.length) chain.push((n = n.imports[0]));
    assert.equal(MAX_IMPORT_DEPTH, 5);
    assert.deepEqual(
      chain.map((c) => [c.path, c.status]),
      [
        ['n0.md', 'ok'],
        ['n1.md', 'ok'],
        ['n2.md', 'ok'],
        ['n3.md', 'ok'],
        ['n4.md', 'ok'],
        ['n5.md', 'ok'],
        ['n6.md', 'too-deep'],
      ],
    );
    assert.equal(chain[5].bytes, Buffer.byteLength('@n6.md'), 'the 5th hop carries its size');
    assert.deepEqual(reads, ['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md', 'n5.md'], 'the 6th hop is never read');
    // Passou do 5º salto: `too-deep` mesmo que o alvo nem exista.
    const gone = resolveImports('n0.md', (p) => (p === 'n5.md' ? '@nowhere.md' : deep[p]), (p) => p in deep);
    let g = gone;
    for (let k = 0; k < 5; k++) g = g.imports[0];
    assert.deepEqual([g.imports[0].path, g.imports[0].status], ['nowhere.md', 'too-deep']);
  });

  test('a file that exists but whose text was not read: ok, without bytes', () => {
    const t = resolveImports('CLAUDE.md', (p) => (p === 'CLAUDE.md' ? '@AGENTS.md\n' : undefined), (p) => p === 'AGENTS.md');
    assert.deepEqual(t.imports[0], { ref: 'AGENTS.md', path: 'AGENTS.md', status: 'ok', imports: [] });
    assert.equal(withTexts(t, () => undefined).imports[0].text, undefined);
  });

  test('settings.json and .mcp.json: only the shape is kept, and an import of them carries no text or size', () => {
    const shape = JSON.parse(configShape(REPO['.claude/settings.json']));
    assert.deepEqual(shape, {
      hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{}] }], Stop: [{ hooks: [{}] }] },
      enabledPlugins: { 'review@team': true },
      extraKnownMarketplaces: { team: {} },
    });
    assert.deepEqual(JSON.parse(configShape(REPO['.mcp.json'])), { mcpServers: { tracker: {}, store: {} } });
    assert.equal(configShape('{ broken'), '');
    assert.equal(configShape('[1]'), '');
    // A leitura a partir da forma dá o mesmo que a partir do texto bruto.
    const shaped = (p: string) => (CONFIG_PATHS.has(p) ? configShape(REPO[p]) : REPO[p]);
    const fromShape = readInstructions(Object.keys(REPO), shaped);
    const fromRaw = readInstructions(Object.keys(REPO), read);
    assert.deepEqual([fromShape.hooks, fromShape.plugins, fromShape.marketplaces, fromShape.mcp, fromShape.settings], [fromRaw.hooks, fromRaw.plugins, fromRaw.marketplaces, fromRaw.mcp, fromRaw.settings]);
    // Importados por um CLAUDE.md: o nó aparece, sem texto e sem tamanho.
    const files: Record<string, string> = { 'CLAUDE.md': '@.mcp.json\n@.claude/settings.json\n', '.mcp.json': REPO['.mcp.json'], '.claude/settings.json': REPO['.claude/settings.json'] };
    const tree = readInstructions(Object.keys(files), (p) => files[p]).files[0].tree;
    assert.deepEqual(tree.imports.map((i) => [i.path, i.status, i.bytes]), [
      ['.mcp.json', 'ok', undefined],
      ['.claude/settings.json', 'ok', undefined],
    ]);
    const t = withTexts(tree, (p) => files[p]);
    assert.deepEqual(t.imports.map((i) => i.text), [undefined, undefined]);
  });

  test('outside the repository: home, absolute path and .. above the root', () => {
    assert.equal(importTarget('CLAUDE.md', '~/x.md'), null);
    assert.equal(importTarget('CLAUDE.md', '/etc/x.md'), null);
    assert.equal(importTarget('CLAUDE.md', '../x.md'), null);
    assert.equal(importTarget('a/b/CLAUDE.md', '../../x.md'), 'x.md');
    const t = resolveImports('CLAUDE.md', () => '@../../escape.md\n@/abs.md', exists);
    assert.deepEqual(t.imports.map((i) => [i.path, i.status]), [
      [null, 'outside-repo'],
      [null, 'outside-repo'],
    ]);
  });

  test('withTexts: each found import carries its text, the others do not', () => {
    const tree = readInstructions(Object.keys(REPO), read).files.find((f) => f.path === 'CLAUDE.md')!.tree;
    const t = withTexts(tree, read);
    assert.equal(t.text, REPO['CLAUDE.md']);
    assert.equal(t.imports[0].text, REPO['AGENTS.md']);
    assert.equal(t.imports[2].text, undefined);
    assert.equal(t.imports[1].imports[1].text, undefined, 'missing has no text');
  });
});

describe('#183 warnings (C33)', () => {
  test('AGENTS.md without an import, missing import (file and ref), truncated tree', () => {
    const files: Record<string, string> = { 'AGENTS.md': '# a\n', 'CLAUDE.md': '@docs/gone.md\n', 'x/AGENTS.md': '# b\n', 'x/CLAUDE.md': '@AGENTS.md\n' };
    const r = readInstructions(Object.keys(files), (p) => files[p], { truncated: true });
    assert.deepEqual(r.warnings, [
      { kind: 'truncated' },
      { kind: 'agents-not-imported', path: 'AGENTS.md' },
      { kind: 'missing-import', path: 'CLAUDE.md', ref: 'docs/gone.md' },
    ]);
    assert.equal(r.truncated, true);
  });

  test('the AGENTS.md warning only shows without the import', () => {
    const r = readInstructions(Object.keys(REPO), read);
    assert.deepEqual(r.warnings, [{ kind: 'missing-import', path: 'docs/style-guide.md', ref: 'missing.md' }], 'reported once, though two files reach it');
  });
});
