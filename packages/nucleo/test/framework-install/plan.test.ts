// O domínio da instalação do framework (#184), portado dos testes do spike (spikes/framework-install):
// o plano e o PR contra uma porta falsa; nenhum PR real é aberto.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BASE_PLUGINS,
  buildCatalog,
  catalogSnapshot,
  detect,
  INSTALL_BRANCH,
  InstallRefused,
  isInstalled,
  mergeClaudeSettings,
  openInstallPullRequest,
  parseIssue,
  parseRule,
  plan,
  planHash,
  pullRequestBody,
  rulesIndex,
  unifiedDiff,
  UNREADABLE,
  UNPAIRED_MARKERS,
  upsertBlock,
  type Choice,
  type InstallPullRequestPort,
  type PullRequestState,
} from '../../src/framework-install/index.ts';

const catalog = catalogSnapshot();
const judgment = (names: readonly string[]) => catalog.plugins.filter((p) => names.includes(p.name)).flatMap((p) => p.rules).filter((r) => r.enforcement === 'judgment').length;

// Um repositório TypeScript com React e Express, CI e testes, e instruções que já existem.
const REPO: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { react: '19', express: '5' }, devDependencies: { typescript: '6' } }),
  'tsconfig.json': '{}',
  'src/app.tsx': '',
  'src/app.test.ts': '',
  '.github/workflows/ci.yml': '',
  'CLAUDE.md': '# vitrine-demo\n\nClasses com prefixo da tela.\n',
  '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'ahrena-contributing@ahrena': false, 'outro@time': true } }, null, 2) + '\n',
};
const CHOICE: Choice = { platforms: ['claude', 'codex'], plugins: detect(REPO).plugins, agency: false };

describe('#184 the plan (ported from the spike)', () => {
  test('the plugin choice follows what the repository has', () => {
    const d = detect(REPO);
    assert.equal(d.ci, 'GitHub Actions');
    assert.equal(d.tests, 'src/app.test.ts');
    assert.deepEqual(d.suggested.map((s) => s.name), ['ahrena-engineering-typescript', 'ahrena-engineering-frontend', 'ahrena-engineering-backend']);
    assert.deepEqual(d.plugins.slice(0, 3), [...BASE_PLUGINS]);
    assert.deepEqual(d.languages, ['TypeScript']);
    assert.deepEqual(d.frameworks, ['React', 'Express']);
    const py = detect({ 'pyproject.toml': '[project]\ndependencies = ["fastapi>=0.1"]\n', 'tests/test_api.py': '' });
    assert.deepEqual(py.suggested.map((s) => s.name), ['ahrena-engineering-python', 'ahrena-engineering-backend']);
    assert.equal(py.tests, 'tests/');
    assert.deepEqual(py.frameworks, ['FastAPI']);
    assert.match(py.suggested[0].why, /^achamos pyproject\.toml/);
    const none = detect({ 'README.md': '' });
    assert.deepEqual([none.suggested, none.tests, none.ci, none.languages], [[], false, false, []]);
  });

  test('the index has one line per judgment rule of the chosen plugins, and none for hooks', () => {
    const lines = rulesIndex(catalog, CHOICE.plugins);
    assert.equal(lines.length, judgment(CHOICE.plugins));
    assert.ok(lines.every((l) => l.includes('https://github.com/ahrenatechnology/ahrena-framework/blob/main/')));
    const fork = rulesIndex(catalog, CHOICE.plugins, { frameworkRepo: 'org-x/fork-do-framework' });
    assert.ok(fork.every((l) => l.includes('https://github.com/org-x/fork-do-framework/blob/main/')));
  });

  test('merges without losing anything: CLAUDE.md, a new AGENTS.md, settings.json, and the disabled plugin stays disabled', () => {
    const p = Object.fromEntries(plan(REPO, catalog, CHOICE).map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(p).sort(), ['.claude/settings.json', 'AGENTS.md', 'CLAUDE.md']); // Codex: only AGENTS.md
    assert.equal(p['AGENTS.md'].action, 'create');
    assert.equal(p['CLAUDE.md'].action, 'merge');
    assert.ok(p['CLAUDE.md'].after!.startsWith(REPO['CLAUDE.md'].trimEnd()));
    assert.match(p['CLAUDE.md'].after!, /<!-- ahrena:framework:start -->\n@AGENTS\.md\n<!-- ahrena:framework:end -->/);
    const s = JSON.parse(p['.claude/settings.json'].after!);
    assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(s.enabledPlugins['outro@time'], true);
    assert.equal(s.enabledPlugins['ahrena-contributing@ahrena'], false);
    assert.equal(s.enabledPlugins['ahrena-foundation@ahrena'], true);
    assert.deepEqual(s.extraKnownMarketplaces.ahrena, { source: { source: 'github', repo: 'ahrenatechnology/ahrena-framework' } });
    const fork = plan(REPO, catalog, CHOICE, { frameworkRepo: 'org-x/fork-do-framework' }).find((f) => f.path === '.claude/settings.json')!;
    assert.equal(JSON.parse(fork.after!).extraKnownMarketplaces.ahrena.source.repo, 'org-x/fork-do-framework');
  });

  test('running again over the result changes nothing', () => {
    const once = Object.fromEntries(plan(REPO, catalog, CHOICE).map((f) => [f.path, f.after!]));
    const again = plan({ ...REPO, ...once }, catalog, CHOICE);
    assert.ok(again.every((f) => f.action === 'unchanged'), again.filter((f) => f.action !== 'unchanged').map((f) => f.path).join());
    assert.equal(planHash(again, CHOICE), planHash(plan({ ...REPO, ...once }, catalog, CHOICE), CHOICE));
    assert.equal(isInstalled(REPO), false);
    assert.equal(isInstalled({ ...REPO, ...once }), true);
  });

  test('blocks: only the inside changes and what is around is kept', () => {
    const t = 'antes\n<!-- ahrena:framework:start -->\nvelho\n<!-- ahrena:framework:end -->\ndepois\n';
    assert.equal(upsertBlock(t, 'novo'), 'antes\n<!-- ahrena:framework:start -->\nnovo\n<!-- ahrena:framework:end -->\ndepois\n');
    assert.equal(upsertBlock('', 'x'), '<!-- ahrena:framework:start -->\nx\n<!-- ahrena:framework:end -->\n');
  });

  test('an invalid settings.json is refused, not rewritten', () => {
    assert.ok('refused' in mergeClaudeSettings('{ quebrado', ['ahrena-foundation']));
    assert.ok('refused' in mergeClaudeSettings('[1, 2]', ['ahrena-foundation']), 'not an object');
    assert.ok('refused' in mergeClaudeSettings('null', ['ahrena-foundation']), 'not an object');
    assert.ok('refused' in mergeClaudeSettings('{ "enabledPlugins": [] }', ['ahrena-foundation']), 'enabledPlugins not an object');
    const p = plan({ ...REPO, '.claude/settings.json': '{ quebrado' }, catalog, CHOICE);
    const s = p.find((f) => f.path === '.claude/settings.json')!;
    assert.deepEqual([s.action, s.after, s.before], ['refused', null, '{ quebrado']);
  });

  test('settings.json that already has everything comes back untouched, even compact', () => {
    const compact = '{"extraKnownMarketplaces":{"ahrena":{"source":{"source":"github","repo":"x/y"}}},"enabledPlugins":{"ahrena-foundation@ahrena":true,"ahrena-contributing@ahrena":false}}';
    assert.deepEqual(mergeClaudeSettings(compact, ['ahrena-foundation', 'ahrena-contributing']), { text: compact });
    const p = plan({ ...REPO, '.claude/settings.json': compact }, catalog, { ...CHOICE, plugins: ['ahrena-foundation', 'ahrena-contributing'] });
    assert.equal(p.find((f) => f.path === '.claude/settings.json')!.action, 'unchanged');
  });

  test('settings.json with an integer beyond the safe range is refused when it would be rewritten', () => {
    const big = '{ "permissions": { "allow": [] }, "id": 12345678901234567890 }';
    const r = mergeClaudeSettings(big, ['ahrena-foundation']);
    assert.ok('refused' in r && /precisão/.test(r.refused), JSON.stringify(r));
    const s = plan({ ...REPO, '.claude/settings.json': big }, catalog, CHOICE).find((f) => f.path === '.claude/settings.json')!;
    assert.deepEqual([s.action, s.after], ['refused', null]);
  });

  test('unpaired framework markers: the file is refused, not appended to', () => {
    const { start, end } = { start: '<!-- ahrena:framework:start -->', end: '<!-- ahrena:framework:end -->' };
    for (const text of [`a\n${start}\nx\n${end}\n${start}\ny\n${end}\n`, `a\n${start}\nx\n`, `a\n${end}\n`, `a\n${end}\n${start}\n`]) {
      const p = plan({ ...REPO, 'CLAUDE.md': text }, catalog, CHOICE).find((f) => f.path === 'CLAUDE.md')!;
      assert.deepEqual([p.action, p.after, p.why], ['refused', null, UNPAIRED_MARKERS], JSON.stringify(text));
      assert.throws(() => upsertBlock(text, 'novo'), /desemparelhados/);
    }
    const agents = plan({ ...REPO, 'AGENTS.md': `${start}\n` }, catalog, CHOICE).find((f) => f.path === 'AGENTS.md')!;
    assert.deepEqual([agents.action, agents.refusal], ['refused', 'unpaired-markers']);
  });

  test('a file that exists but did not come whole is refused, never overwritten; a missing one is still created', () => {
    const p = plan({ ...REPO, 'AGENTS.md': '' }, catalog, CHOICE, { unreadable: ['CLAUDE.md', 'AGENTS.md', '.claude/settings.json'] });
    for (const f of p) assert.deepEqual([f.path, f.action, f.after, f.refusal, f.why], [f.path, 'refused', null, 'unreadable', UNREADABLE], f.path);
    const missing = plan({ 'README.md': '' }, catalog, CHOICE, { unreadable: ['CLAUDE.md'] });
    assert.ok(missing.every((f) => f.action === 'create'), 'listed as unreadable but absent from the tree: create');
    assert.equal(plan({ ...REPO, '.claude/settings.json': '{' }, catalog, CHOICE).find((f) => f.action === 'refused')!.refusal, 'invalid-json');
  });

  test('settings.json keeps its indentation, so the merge does not reformat the file', () => {
    const four = `${JSON.stringify({ permissions: { allow: [] } }, null, 4)}\n`;
    const r = mergeClaudeSettings(four, ['ahrena-foundation']);
    assert.ok('text' in r);
    assert.match(r.text, /^ {4}"permissions"/m);
    const d = unifiedDiff('.claude/settings.json', four, r.text);
    assert.ok(d.del <= 1, 'at most the closing line of the last key changes');
  });

  test('Cursor: one .mdc rule per judgment rule', () => {
    const p = plan(REPO, catalog, { ...CHOICE, platforms: ['cursor'] });
    assert.equal(p.length, judgment(CHOICE.plugins));
    assert.ok(p.every((f) => /^\.cursor\/rules\/ahrena-[\w-]+\.mdc$/.test(f.path) && f.after!.startsWith('---\ndescription: ')));
  });

  test('the preview diff, in hunks with 3 lines of context', () => {
    const d = unifiedDiff('CLAUDE.md', 'a\nb\n', 'a\nb\n\nc\n');
    assert.deepEqual([d.add, d.del], [2, 0]);
    assert.equal(d.text, '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,2 +1,4 @@\n a\n b\n+\n+c');
    const created = unifiedDiff('AGENTS.md', null, 'x\ny\n');
    assert.equal(created.text, '--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1,2 @@\n+x\n+y');
    const long = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const far = unifiedDiff('f', `${long.join('\n')}\n`, `${long.map((l, i) => (i === 2 || i === 17 ? `${l}!` : l)).join('\n')}\n`);
    assert.equal(far.text.split('\n').filter((l) => l.startsWith('@@')).length, 2, 'two distant changes, two hunks');
    assert.ok(!far.text.includes(' l9'), 'the middle of the file does not appear');
    assert.deepEqual(unifiedDiff('f', 'a\n', 'a\n'), { text: '', add: 0, del: 0 });
  });

  test('CLAUDE.md always ends with @AGENTS.md, and does not duplicate the import the person already has', () => {
    const without = plan({ 'CLAUDE.md': '# x\n' }, catalog, CHOICE).find((f) => f.path === 'CLAUDE.md')!;
    assert.match(without.after!, /^@AGENTS\.md$/m);
    const withImport = plan({ 'CLAUDE.md': '# x\n\n@AGENTS.md\n' }, catalog, CHOICE).find((f) => f.path === 'CLAUDE.md')!;
    assert.equal(withImport.after!.match(/^@AGENTS\.md$/gm)!.length, 1);
  });

  test('the plan hash changes with the choice and with what would be written, never with the order', () => {
    const p = plan(REPO, catalog, CHOICE);
    const h = planHash(p, CHOICE);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(planHash([...p].reverse(), { ...CHOICE, plugins: [...CHOICE.plugins].reverse() }), h);
    assert.notEqual(planHash(p, { ...CHOICE, platforms: ['codex'] }), h);
    assert.notEqual(planHash(plan({ ...REPO, 'CLAUDE.md': '# outro\n' }, catalog, CHOICE), CHOICE), h);
  });
});

describe('#184 the catalog', () => {
  test('rules from the frontmatter and plugins from the marketplace', () => {
    assert.deepEqual(parseRule('---\nid: naming\ntitle: "Names"\nstatement: Short.\nenforcement: hook\n---\n\n# x\n', 'f/rules/naming.md'), {
      id: 'naming',
      title: 'Names',
      statement: 'Short.',
      enforcement: 'hook',
      path: 'f/rules/naming.md',
    });
    assert.equal(parseRule('# no frontmatter\n', 'x.md'), null);
    const market = JSON.stringify({ name: 'ahrena', plugins: [{ name: 'p1', description: 'd', source: { source: 'git-subdir', path: 'one' } }, { name: 'p2', source: './two' }, { name: 'bad', source: '../x' }] });
    const c = buildCatalog('o/r', 'abc1234', market, new Map([['one/rules/a.md', '---\nid: a\ntitle: A\nstatement: S\nenforcement: judgment\n---\n'], ['two/rules/b.md', '---\nid: b\n---\n']]));
    assert.deepEqual(c.plugins.map((p) => [p.name, p.path, p.rules.map((r) => r.id)]), [['p1', 'one', ['a']], ['p2', 'two', ['b']]]);
    assert.throws(() => buildCatalog('o/r', null, '{', new Map()), /não é o JSON esperado/);
  });

  test('the snapshot carries the base plugins and the 15 judgment rules of the study', () => {
    for (const b of BASE_PLUGINS) assert.ok(catalog.plugins.some((p) => p.name === b), b);
    assert.equal(catalog.plugins.flatMap((p) => p.rules).filter((r) => r.enforcement === 'judgment').length, 15);
  });
});

// Porta falsa: guarda os branches e registra cada escrita.
function fakePort({ openPr = null as PullRequestState | null, existing = [] as string[], existingAt = 'ccc333' } = {}) {
  const calls: unknown[][] = [];
  const refs: Record<string, string> = { main: 'aaa111' };
  for (const b of existing) refs[b] = existingAt;
  const port: InstallPullRequestPort = {
    defaultBranch: async () => ({ name: 'main', oid: refs.main }),
    findOpenPr: async () => openPr,
    branchHead: async (b) => refs[b] ?? null,
    createRef: async (name, oid) => {
      calls.push(['createRef', name]);
      assert.ok(!(name in refs));
      refs[name] = oid;
    },
    createCommitOnBranch: async ({ branch, expectedHeadOid, additions }) => {
      calls.push(['commit', branch, additions.map((a) => a.path)]);
      assert.notEqual(branch, 'main');
      assert.equal(refs[branch], expectedHeadOid);
      refs[branch] = 'bbb222';
      return { oid: 'bbb222' };
    },
    createPullRequest: async ({ base, head, body, title }) => {
      calls.push(['pr', base, head, body]);
      return { number: 7, url: 'https://github.test/pr/7', title, branch: head, base, state: 'open', checks: null, review: 'review_required', updatedAt: '2026-10-20T12:00:00Z' };
    },
  };
  return { port, calls, refs };
}

describe('#184 opening the pull request (ported from the spike)', () => {
  test('a new branch, one commit, the PR, and the default branch untouched', async () => {
    const gh = fakePort();
    const r = await openInstallPullRequest(gh.port, { files: plan(REPO, catalog, CHOICE), title: 'Instala o Ahrena Framework', body: '' });
    assert.equal(r.status, 'opened');
    assert.deepEqual(gh.calls.map((c) => c[0]), ['createRef', 'commit', 'pr']);
    assert.deepEqual(gh.calls[2], ['pr', 'main', INSTALL_BRANCH, '']);
    assert.deepEqual(gh.calls[1][2], ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json']);
    assert.equal(gh.refs.main, 'aaa111');
  });

  test('an open PR, nothing to do, a refused file and a leftover branch write nothing', async () => {
    const open = fakePort({ openPr: { number: 3 } as PullRequestState });
    assert.equal((await openInstallPullRequest(open.port, { files: plan(REPO, catalog, CHOICE), title: '', body: '' })).status, 'already-open');
    assert.deepEqual(open.calls, []);
    const nothing = fakePort();
    assert.equal((await openInstallPullRequest(nothing.port, { files: [{ path: 'AGENTS.md', action: 'unchanged', before: 'x', after: 'x', why: '' }], title: '', body: '' })).status, 'nothing-to-do');
    const refused = fakePort();
    await assert.rejects(openInstallPullRequest(refused.port, { files: plan({ ...REPO, '.claude/settings.json': '{' }, catalog, CHOICE), title: '', body: '' }), (e: unknown) => e instanceof InstallRefused && e.code === 'invalid-json');
    assert.deepEqual(refused.calls, []);
    await assert.rejects(openInstallPullRequest(fakePort().port, { files: plan(REPO, catalog, CHOICE), title: '', body: '', branch: 'main' }), (e: unknown) => e instanceof InstallRefused && e.code === 'default-branch');
    const unreadable = fakePort();
    await assert.rejects(openInstallPullRequest(unreadable.port, { files: plan(REPO, catalog, CHOICE, { unreadable: ['CLAUDE.md'] }), title: '', body: '' }), (e: unknown) => e instanceof InstallRefused && e.code === 'unreadable');
    assert.deepEqual(unreadable.calls, []);
    const leftover = fakePort({ existing: [INSTALL_BRANCH] });
    await assert.rejects(openInstallPullRequest(leftover.port, { files: plan(REPO, catalog, CHOICE), title: '', body: '' }), (e: unknown) => e instanceof InstallRefused && e.code === 'branch-exists');
    assert.deepEqual(leftover.calls, []);
  });

  test('an empty install branch at the default HEAD, left by a failure, is reused: no createRef, the commit on top of it', async () => {
    const gh = fakePort({ existing: [INSTALL_BRANCH], existingAt: 'aaa111' });
    const r = await openInstallPullRequest(gh.port, { files: plan(REPO, catalog, CHOICE), title: 't', body: '' });
    assert.equal(r.status, 'opened');
    assert.deepEqual(gh.calls.map((c) => c[0]), ['commit', 'pr']);
    assert.equal(gh.refs.main, 'aaa111');
  });

  test('optional issue: a number becomes Refs #N; empty, no reference; text is refused', () => {
    const files = plan(REPO, catalog, CHOICE);
    assert.match(pullRequestBody(files, CHOICE.plugins, parseIssue(42)), /\n\nRefs #42$/);
    assert.match(pullRequestBody(files, CHOICE.plugins, parseIssue('#42')), /\n\nRefs #42$/);
    for (const empty of [null, undefined, '', '  ']) assert.doesNotMatch(pullRequestBody(files, CHOICE.plugins, parseIssue(empty)), /Refs/);
    for (const bad of ['42; rm', 'abc', '0', '-1', 1.5, {}, '4 2']) assert.throws(() => parseIssue(bad), (e: unknown) => e instanceof InstallRefused && e.code === 'invalid-issue', String(bad));
  });
});
