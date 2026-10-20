// node --test spikes/framework-install: o plano e o PR contra um GitHub falso; nenhum PR real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detect, plan, rulesIndex, upsertBlock, mergeClaudeSettings, unifiedDiff, BASE } from './plan.mjs';
import { openInstallPr, InstallRefused, INSTALL_BRANCH } from './pr.mjs';

const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const judgment = (names) => catalog.plugins.filter((p) => names.includes(p.name)).flatMap((p) => p.rules).filter((r) => r.enforcement === 'judgment').length;

// Um repositório TypeScript com React e Express, CI e testes, e instruções que já existem.
const REPO = {
  'package.json': JSON.stringify({ dependencies: { react: '19', express: '5' }, devDependencies: { typescript: '6' } }),
  'tsconfig.json': '{}',
  'src/app.tsx': '',
  'src/app.test.ts': '',
  '.github/workflows/ci.yml': '',
  'CLAUDE.md': '# vitrine-demo\n\nClasses com prefixo da tela.\n',
  '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'ahrena-contributing@ahrena': false, 'outro@time': true } }, null, 2) + '\n',
};
const CHOICE = { platforms: ['claude', 'codex'], plugins: detect(REPO).plugins, agency: false };

test('a escolha dos plugins segue o que o repositório tem', () => {
  const d = detect(REPO);
  assert.equal(d.ci, true);
  assert.equal(d.tests, true);
  assert.deepEqual(d.suggested.map((s) => s.name), ['ahrena-engineering-typescript', 'ahrena-engineering-frontend', 'ahrena-engineering-backend']);
  assert.deepEqual(d.plugins.slice(0, 3), BASE);
  assert.deepEqual(detect({ 'pyproject.toml': '[project]\ndependencies = ["fastapi>=0.1"]\n' }).suggested.map((s) => s.name), ['ahrena-engineering-python', 'ahrena-engineering-backend']);
  assert.deepEqual(detect({ 'README.md': '' }).suggested, []);
});

test('o índice tem uma linha por regra de julgamento dos plugins escolhidos, e nenhuma de hook', () => {
  const lines = rulesIndex(catalog, CHOICE.plugins);
  assert.equal(lines.length, judgment(CHOICE.plugins));
  assert.ok(lines.every((l) => l.includes('https://github.com/ahrenatechnology/ahrena-framework/blob/main/')));
});

test('mescla sem perder nada: CLAUDE.md, AGENTS.md novo, settings.json e o plugin desligado continua desligado', () => {
  const p = Object.fromEntries(plan(REPO, catalog, CHOICE).map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(p).sort(), ['.claude/settings.json', 'AGENTS.md', 'CLAUDE.md']); // Codex: só o AGENTS.md
  assert.equal(p['AGENTS.md'].action, 'create');
  assert.equal(p['CLAUDE.md'].action, 'merge');
  assert.ok(p['CLAUDE.md'].after.startsWith(REPO['CLAUDE.md'].trimEnd()));
  assert.match(p['CLAUDE.md'].after, /<!-- ahrena:framework:start -->\n@AGENTS\.md\n<!-- ahrena:framework:end -->/);
  const s = JSON.parse(p['.claude/settings.json'].after);
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(s.enabledPlugins['outro@time'], true);
  assert.equal(s.enabledPlugins['ahrena-contributing@ahrena'], false);
  assert.equal(s.enabledPlugins['ahrena-foundation@ahrena'], true);
  assert.deepEqual(s.extraKnownMarketplaces.ahrena, { source: { source: 'github', repo: 'ahrenatechnology/ahrena-framework' } });
});

test('rodar de novo sobre o resultado não muda nada', () => {
  const once = Object.fromEntries(plan(REPO, catalog, CHOICE).map((f) => [f.path, f.after]));
  const again = plan({ ...REPO, ...once }, catalog, CHOICE);
  assert.ok(again.every((f) => f.action === 'unchanged'), again.filter((f) => f.action !== 'unchanged').map((f) => f.path).join());
});

test('blocos: troca só o miolo e preserva o que está em volta', () => {
  const t = 'antes\n<!-- ahrena:framework:start -->\nvelho\n<!-- ahrena:framework:end -->\ndepois\n';
  assert.equal(upsertBlock(t, 'novo'), 'antes\n<!-- ahrena:framework:start -->\nnovo\n<!-- ahrena:framework:end -->\ndepois\n');
});

test('settings.json inválido é recusado, não reescrito', () => {
  assert.ok(mergeClaudeSettings('{ quebrado', ['ahrena-foundation']).refused);
  const p = plan({ ...REPO, '.claude/settings.json': '{ quebrado' }, catalog, CHOICE);
  assert.equal(p.find((f) => f.path === '.claude/settings.json').action, 'refused');
});

test('Cursor: uma regra .mdc por regra de julgamento', () => {
  const p = plan(REPO, catalog, { ...CHOICE, platforms: ['cursor'] });
  assert.equal(p.length, judgment(CHOICE.plugins));
  assert.ok(p.every((f) => /^\.cursor\/rules\/ahrena-[\w-]+\.mdc$/.test(f.path) && f.after.startsWith('---\ndescription: ')));
});

test('diff da prévia', () => {
  const d = unifiedDiff('CLAUDE.md', 'a\nb\n', 'a\nb\n\nc\n');
  assert.deepEqual([d.add, d.del], [2, 0]);
  assert.match(d.text, /^--- a\/CLAUDE\.md\n\+\+\+ b\/CLAUDE\.md\n a\n b\n\+\n\+c$/);
});

// GitHub falso: guarda os branches e registra cada escrita.
function fakeGithub({ openPr = null } = {}) {
  const calls = [];
  const refs = { main: 'aaa111' };
  return {
    calls, refs,
    defaultBranch: async () => ({ name: 'main', oid: refs.main }),
    findOpenPr: async () => openPr,
    createRef: async (name, oid) => { calls.push(['createRef', name]); assert.ok(!(name in refs)); refs[name] = oid; },
    createCommitOnBranch: async ({ branch, expectedHeadOid, additions }) => {
      calls.push(['commit', branch, additions.map((a) => a.path)]);
      assert.notEqual(branch, 'main');
      assert.equal(refs[branch], expectedHeadOid);
      refs[branch] = 'bbb222';
      return { oid: 'bbb222' };
    },
    createPullRequest: async ({ base, head, body }) => { calls.push(['pr', base, head, body]); return { number: 7, url: 'https://github.test/pr/7' }; },
  };
}

test('abrir o PR: branch novo, um commit, o PR, e o padrão intocado', async () => {
  const gh = fakeGithub();
  const r = await openInstallPr(gh, { plan: plan(REPO, catalog, CHOICE), title: 'Instala o Ahrena Framework', body: '' });
  assert.equal(r.status, 'opened');
  assert.deepEqual(gh.calls.map((c) => c[0]), ['createRef', 'commit', 'pr']);
  assert.deepEqual(gh.calls[2], ['pr', 'main', INSTALL_BRANCH, '']);
  assert.equal(gh.refs.main, 'aaa111');
});

test('PR já aberto, nada a fazer e arquivo recusado não escrevem nada', async () => {
  const aberto = fakeGithub({ openPr: { number: 3 } });
  assert.equal((await openInstallPr(aberto, { plan: plan(REPO, catalog, CHOICE), title: '', body: '' })).status, 'already-open');
  assert.deepEqual(aberto.calls, []);
  const nada = fakeGithub();
  assert.equal((await openInstallPr(nada, { plan: [{ path: 'AGENTS.md', action: 'unchanged' }], title: '', body: '' })).status, 'nothing-to-do');
  const recusado = fakeGithub();
  await assert.rejects(openInstallPr(recusado, { plan: plan({ ...REPO, '.claude/settings.json': '{' }, catalog, CHOICE), title: '', body: '' }), InstallRefused);
  assert.deepEqual(recusado.calls, []);
  await assert.rejects(openInstallPr(fakeGithub(), { plan: plan(REPO, catalog, CHOICE), title: '', body: '', branch: 'main' }), InstallRefused);
});

test('issue opcional: com número vira Refs #N; vazio, nenhuma referência; texto é recusado', async () => {
  const com = fakeGithub();
  await openInstallPr(com, { plan: plan(REPO, catalog, CHOICE), title: 't', body: 'Instala.', issue: 42 });
  assert.equal(com.calls[2][3], 'Instala.\n\nRefs #42');
  const sem = fakeGithub();
  await openInstallPr(sem, { plan: plan(REPO, catalog, CHOICE), title: 't', body: 'Instala.' });
  assert.equal(sem.calls[2][3], 'Instala.');
  await assert.rejects(openInstallPr(fakeGithub(), { plan: plan(REPO, catalog, CHOICE), title: 't', body: '', issue: '42; rm' }), InstallRefused);
});

test('o CLAUDE.md sempre sai com @AGENTS.md, e não duplica o import que a pessoa já tem', () => {
  const sem = plan({ 'CLAUDE.md': '# x\n' }, catalog, CHOICE).find((f) => f.path === 'CLAUDE.md');
  assert.match(sem.after, /^@AGENTS\.md$/m);
  const com = plan({ 'CLAUDE.md': '# x\n\n@AGENTS.md\n' }, catalog, CHOICE).find((f) => f.path === 'CLAUDE.md');
  assert.equal(com.after.match(/^@AGENTS\.md$/gm).length, 1);
});
