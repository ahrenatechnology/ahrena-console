// A fonte dos arquivos de um repositório (#183) contra o GitHub falso: a descoberta por GraphQL, a
// árvore recursiva com ETag e os lotes de conteúdo. Nenhuma chamada à API real.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BLOB_BATCH, blobsQuery, discoveryQuery, DISCOVERY_BATCH, RepoFilesSource, validPath } from '../../src/github/repo-files-source.ts';
import { GithubReposSource } from '../../src/github/repos-source.ts';
import { createFakeGithub, blobOid, type FakeGithubData, type FakeRepo } from '../../src/simulator/fake-github.ts';

const base: Omit<FakeRepo, 'owner' | 'name'> = { isPrivate: false, language: 'TypeScript', permission: 'READ', pushMin: 5, issues: 0, prs: 0, ci: null, commitsPerWeek: 1 };

function setup(files: Record<string, string>, extra: Partial<FakeRepo> = {}) {
  const data: FakeGithubData = { login: 'dev-sintetico', organizations: ['org-a'], awaitingReview: 0, closedThisWeek: 0, repos: [{ ...base, owner: 'org-a', name: 'repo', files, ...extra }] };
  const gh = createFakeGithub(data);
  const bodies: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(String(init.body));
    return gh.fetch(input, init);
  }) as typeof globalThis.fetch;
  const source = new RepoFilesSource(new GithubReposSource({ token: 'test-token', fetch, url: 'https://fake.invalid/graphql', api: 'https://fake.invalid' }));
  return { source, calls: gh.calls, bodies };
}

const FILES = {
  'CLAUDE.md': '@AGENTS.md\n',
  'AGENTS.md': '# a\n',
  '.mcp.json': '{}',
  '.claude/settings.json': '{}',
  '.claude/skills/release/SKILL.md': '---\nname: release\n---\n',
  '.claude/commands/a/b/c.md': 'deep\n',
  'packages/x/CLAUDE.md': '# x\n',
  'src/index.ts': '',
};

describe('#183 repo files source', () => {
  test('discovery: the commit, the root files and .claude/ in three levels, in one GraphQL query', async () => {
    const { source, calls } = setup(FILES);
    const d = await source.discover('org-a', 'repo');
    assert.ok(d);
    assert.equal(d.nameWithOwner, 'org-a/repo');
    assert.match(d.commit!, /^[0-9a-f]{40}$/);
    assert.deepEqual(d.files.map((f) => f.path).sort(), ['.claude/settings.json', '.claude/skills/release/SKILL.md', '.mcp.json', 'AGENTS.md', 'CLAUDE.md']);
    assert.equal(d.files.find((f) => f.path === 'AGENTS.md')!.oid, blobOid('# a\n'));
    assert.deepEqual(calls, ['GRAPHQL RepoFilesDiscovery']);
    assert.equal(await source.discover('org-a', 'nope'), null);
  });

  test('discovery (#174): the decision folders, first level only, without index nor template', async () => {
    const { source } = setup({
      ...FILES,
      'docs/adr/0001-a.md': '# 1. A\n',
      'docs/adr/README.md': '# index\n',
      'docs/adr/template.md': '# t\n',
      'docs/adr/old/0000-x.md': '# x\n',
      'docs/adr/notes.txt': 'x',
      'docs/pdr/PDR-001-b.md': '# PDR-001: B\n',
      'docs/decisoes/0001-c.md': '# 0001 · C\n',
    });
    const d = (await source.discover('org-a', 'repo'))!;
    assert.deepEqual(d.decisionFolders, ['docs/adr', 'docs/decisoes', 'docs/pdr']);
    assert.deepEqual(d.decisions!.map((f) => f.path), ['docs/adr/0001-a.md', 'docs/decisoes/0001-c.md', 'docs/pdr/PDR-001-b.md']);
    assert.equal(d.decisions![0].oid, blobOid('# 1. A\n'));
  });

  test('discovery (#174): up to 20 repositories per query, one result per repository in order', async () => {
    const { source, calls, bodies } = setup(FILES);
    const asked = [{ owner: 'org-a', name: 'repo' }, ...Array.from({ length: 21 }, (_, i) => ({ owner: 'org-a', name: `missing-${i}` }))];
    const out = await source.discoverMany(asked);
    assert.equal(out.length, 22);
    assert.equal(out[0]!.nameWithOwner, 'org-a/repo');
    assert.ok(out.slice(1).every((d) => d === null));
    assert.deepEqual(calls, ['GRAPHQL RepoFilesDiscovery', 'GRAPHQL RepoFilesDiscovery']);
    assert.ok(bodies.every((b) => !JSON.parse(b).query.includes('missing-')), 'names go as variables');
    assert.equal(DISCOVERY_BATCH, 20);
    assert.throws(() => discoveryQuery([]));
    assert.match(discoveryQuery([{ owner: 'a', name: 'b' }]).query, /dir22: object\(expression: "HEAD:product-decisions"\)/);
  });

  test('tree: only the interesting paths, the ETag, and 304 on the second read', async () => {
    const { source, calls } = setup(FILES);
    const first = await source.tree('org-a', 'repo', null);
    assert.equal(first.state, 'ok');
    if (first.state !== 'ok') return;
    assert.deepEqual(first.value.files.map((f) => f.path).sort(), ['.claude/commands/a/b/c.md', '.claude/settings.json', '.claude/skills/release/SKILL.md', '.mcp.json', 'AGENTS.md', 'CLAUDE.md', 'packages/x/CLAUDE.md']);
    assert.equal(first.value.truncated, false);
    assert.ok(first.etag);
    assert.deepEqual(await source.tree('org-a', 'repo', first.etag), { state: 'not-modified' });
    assert.deepEqual(calls, ['GET /repos/org-a/repo/git/trees/HEAD?recursive=1', 'GET /repos/org-a/repo/git/trees/HEAD?recursive=1']);
  });

  test('tree: the truncated flag of GitHub passes through', async () => {
    const { source } = setup(FILES, { truncatedTree: true });
    const t = await source.tree('org-a', 'repo', null);
    assert.ok(t.state === 'ok' && t.value.truncated);
    assert.ok(t.state === 'ok' && !t.value.files.some((f) => f.path === 'packages/x/CLAUDE.md'), 'the fake cuts the deep paths');
  });

  test('blobs: by oid and by commit:path, at most 50 per query, null where there is no file', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`docs/f${i}.md`] = `file ${i}\n`;
    const { source, calls, bodies } = setup(many);
    const d = (await source.discover('org-a', 'repo'))!;
    const requests = [{ oid: blobOid('file 0\n') }, ...Array.from({ length: 59 }, (_, i) => ({ commit: d.commit!, path: `docs/f${i + 1}.md` })), { commit: d.commit!, path: 'docs/none.md' }, { commit: d.commit!, path: 'docs' }];
    const blobs = await source.blobs('org-a', 'repo', requests);
    assert.equal(blobs.length, 62);
    assert.equal(blobs[0]!.text, 'file 0\n');
    assert.equal(blobs[59]!.text, 'file 59\n');
    assert.equal(blobs[60], null);
    assert.equal(blobs[61], null, 'a folder is not a file');
    assert.equal(calls.filter((c) => c === 'GRAPHQL RepoBlobs').length, 2);
    assert.ok(bodies.every((b) => !b.includes('test-token')), 'the token goes only in the header');
    assert.ok(bodies.filter((b) => b.includes('RepoBlobs')).every((b) => !JSON.parse(b).query.includes('docs/')), 'paths go as variables, never inside the query text');
    assert.equal(BLOB_BATCH, 50);
  });

  test('blobs refuse a path with .. or an oid out of shape, without calling GitHub', async () => {
    const { source, calls } = setup(FILES);
    await assert.rejects(source.blobs('org-a', 'repo', [{ commit: 'a'.repeat(40), path: '../etc/passwd' }]));
    await assert.rejects(source.blobs('org-a', 'repo', [{ oid: 'HEAD' }]));
    assert.deepEqual(calls, []);
    assert.equal(validPath('docs/a.md'), true);
    assert.equal(validPath('docs//a.md'), false);
    assert.equal(blobsQuery([{ oid: 'a'.repeat(40) }]).variables.o0, 'a'.repeat(40));
  });
});
