// Instalar o Ahrena Framework pelo console (#184), pelo serviço e pelas rotas, contra o GitHub falso
// (src/simulator/fake-github.ts): nenhum PR real, nenhuma chamada à API real e nenhum token na resposta.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  createCoreFrameworkInstall,
  createFrameworkInstallRoute,
  FRAMEWORK_INSTALL_TTL,
  frameworkRepoFrom,
  FrameworkInstallService,
  type FrameworkInstallPlan,
  type InstallAnswer,
} from '../../src/api/framework-install.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubReposSource } from '../../src/github/repos-source.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, fakeFrameworkRepo, type FakeGithub, type FakeGithubData, type FakeRepo, type PullRequestTimeline } from '../../src/simulator/fake-github.ts';
import { INSTALL_BRANCH } from '../../src/framework-install/model.ts';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const TOKEN = 'token-that-must-not-leak';
const base: Omit<FakeRepo, 'owner' | 'name'> = { isPrivate: false, language: 'Python', permission: 'WRITE', pushMin: 5, issues: 0, prs: 0, ci: null, commitsPerWeek: 1 };

const PY: Record<string, string> = {
  'README.md': '# py-app\n',
  'CLAUDE.md': '# py-app\n\nRode `pytest` antes do PR.\n',
  '.claude/settings.json': `${JSON.stringify({ permissions: { allow: ['Bash(pytest)'] }, enabledPlugins: { 'ahrena-contributing@ahrena': false, 'kit@time': true } }, null, 2)}\n`,
  'pyproject.toml': '[project]\nname = "py-app"\ndependencies = ["fastapi>=0.115"]\n',
  'app/main.py': 'from fastapi import FastAPI\n',
  'tests/test_main.py': 'def test_ok():\n    assert True\n',
  '.github/workflows/ci.yml': 'name: ci\n',
};

function data(py: Record<string, string> = PY, frameworkRepo?: string): FakeGithubData {
  return {
    login: 'dev-sintetico',
    organizations: ['org-a'],
    awaitingReview: 0,
    closedThisWeek: 0,
    repos: [
      { ...base, owner: 'org-a', name: 'py-app', files: py },
      { ...base, owner: 'org-a', name: 'empty', permission: 'ADMIN' },
      { ...base, owner: 'org-a', name: 'broken', files: { 'README.md': '# broken\n', 'CLAUDE.md': '# broken\n', '.claude/settings.json': '{ "hooks": { "Stop": [ ] ,\n' } },
      { ...base, owner: 'org-a', name: 'read-only', permission: 'READ', files: { 'go.mod': 'module x\n', 'cmd/x/main.go': 'package main\n' } },
      { ...base, owner: 'org-a', name: 'binary', files: { ...PY, 'CLAUDE.md': '# py-app\u0000\u0001\n' }, unreadable: { 'CLAUDE.md': 'binary' } },
      { ...base, owner: 'org-a', name: 'truncated', files: { ...PY, 'AGENTS.md': `# regras\n\n${'- uma regra longa da pessoa\n'.repeat(40)}` }, unreadable: { 'AGENTS.md': 'truncated' } },
      fakeFrameworkRepo(frameworkRepo),
    ],
  };
}

interface Setup {
  service: FrameworkInstallService;
  gh: () => FakeGithub;
  calls: () => string[];
  clock: { now: number };
  changes: () => Promise<{ type: string; key: string }[]>;
  /** As mudanças desde agora: chame antes e confira depois. */
  mark: () => () => Promise<{ type: string; key: string }[]>;
  /** Troca os dados do GitHub falso (um push), sem as escritas de antes. */
  push: (py: Record<string, string>) => void;
  store: MemoryCacheStore;
  /** Segura a próxima chamada GraphQL que `when` aceita, dentro da fila do GitHub, até `release()`. */
  holdCall: (when: (op: string, variables: Record<string, unknown>) => boolean) => Hold;
  /** Segura a próxima leitura desta chave no cache (fora da fila do GitHub), até `release()`. */
  holdStore: (key: string) => Hold;
  /** Troca a resposta GraphQL de uma operação (o JSON inteiro, `{ data }` ou `{ errors }`). */
  tamper: { fn: ((op: string, json: { data?: unknown; errors?: unknown }) => unknown) | null };
  logs: string[];
}

interface Hold {
  reached: Promise<void>;
  release: () => void;
}

function deferredHold(): Hold & { arrive: () => Promise<void> } {
  let arrived!: () => void;
  let released!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  const gate = new Promise<void>((r) => (released = r));
  return { reached, release: () => released(), arrive: () => (arrived(), gate) };
}

function setup({ frameworkRepo, timeline }: { frameworkRepo?: string; timeline?: PullRequestTimeline } = {}): Setup {
  const clock = { now: T0 };
  const now = () => clock.now;
  let gh = createFakeGithub(data(PY, frameworkRepo), { now, pullRequestTimeline: timeline });
  const all: string[] = [];
  const holds: { when: (op: string, v: Record<string, unknown>) => boolean; hold: ReturnType<typeof deferredHold> }[] = [];
  const tamper: Setup['tamper'] = { fn: null };
  const logs: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = typeof init?.body === 'string' ? (JSON.parse(init.body) as { query?: string; variables?: Record<string, unknown> }) : null;
    const op = /(?:query|mutation) (\w+)/.exec(request?.query ?? '')?.[1] ?? null;
    if (op) {
      const i = holds.findIndex((h) => h.when(op, request?.variables ?? {}));
      if (i >= 0) await holds.splice(i, 1)[0].hold.arrive();
    }
    const before = gh.calls.length;
    const r = await gh.fetch(input, init);
    all.push(...gh.calls.slice(before));
    if (op && tamper.fn) {
      const changed = tamper.fn(op, (await r.json()) as { data?: unknown });
      return new Response(JSON.stringify(changed), { status: r.status, headers: r.headers });
    }
    return r;
  }) as typeof globalThis.fetch;
  const transport = new GithubReposSource({ token: TOKEN, fetch, now, url: 'https://fake.invalid/graphql', api: 'https://fake.invalid' });
  const cursor = new ChangeCursor({ generation: 'g', batchMs: 0, minIntervalMs: 0 });
  const start = cursor.current;
  const store = new MemoryCacheStore();
  const storeHolds = new Map<string, ReturnType<typeof deferredHold>>();
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    const h = storeHolds.get(key);
    if (h) {
      storeHolds.delete(key);
      await h.arrive();
    }
    return get(key);
  };
  const service = new FrameworkInstallService({
    transport,
    cache: new GithubCache({ store, now }),
    changes: cursor,
    now,
    pullRequestPollMs: 0,
    log: (m) => logs.push(m),
    ...(frameworkRepo ? { frameworkRepo } : {}),
  });
  return {
    service,
    gh: () => gh,
    calls: () => all,
    clock,
    changes: async () => (await cursor.wait(start, { timeoutMs: 0 })).changes,
    mark: () => {
      const at = cursor.current;
      return async () => (await cursor.wait(at, { timeoutMs: 0 })).changes;
    },
    push: (py) => {
      gh = createFakeGithub(data(py, frameworkRepo), { now, pullRequestTimeline: timeline });
    },
    store,
    holdCall: (when) => {
      const hold = deferredHold();
      holds.push({ when, hold });
      return hold;
    },
    holdStore: (key) => {
      const hold = deferredHold();
      storeHolds.set(key, hold);
      return hold;
    },
    tamper,
    logs,
  };
}

async function ready(s: Setup, repo = 'py-app', query: { platforms?: string; plugins?: string } = {}): Promise<FrameworkInstallPlan> {
  await s.service.plan('org-a', repo, query);
  await s.service.wait();
  const a = await s.service.plan('org-a', repo, query);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return a.body as FrameworkInstallPlan;
}

const install = (s: Setup, p: FrameworkInstallPlan, extra: Record<string, unknown> = {}, repo = 'py-app'): Promise<InstallAnswer> =>
  s.service.install('org-a', repo, { platforms: p.choice.platforms, plugins: p.choice.plugins, planHash: p.planHash, ...extra });

describe('#184 the install plan, through the service', () => {
  test('the request does not wait for GitHub: loading first, then ready, and the change is registered', async () => {
    const s = setup();
    const first = await s.service.plan('Org-A', 'Py-App');
    assert.equal((first.body as FrameworkInstallPlan).state, 'loading');
    assert.equal((first.body as FrameworkInstallPlan).planHash, null);
    await s.service.wait();
    const p = (await s.service.plan('Org-A', 'Py-App')).body as FrameworkInstallPlan;
    assert.equal(p.state, 'ready');
    assert.equal(p.repo, 'org-a/py-app');
    assert.equal(p.readAt, new Date(T0).toISOString());
    assert.deepEqual((await s.changes()).map((c) => [c.type, c.key]), [['framework-install', 'org-a/py-app']]);
  });

  test('#184/AC-4 the plugin choice follows what the repository has: base locked, suggested with the reason, the others unchecked', async () => {
    const p = await ready(setup());
    assert.deepEqual(p.found, {
      languages: ['Python'],
      frameworks: ['FastAPI'],
      tests: 'tests/',
      ci: 'GitHub Actions',
      files: { 'CLAUDE.md': true, 'AGENTS.md': false, '.claude/settings.json': true },
    });
    const byGroup = (g: string) => p.plugins.filter((x) => x.group === g);
    assert.deepEqual(byGroup('base').map((x) => [x.name, x.checked, x.locked]), [
      ['ahrena-foundation', true, true],
      ['ahrena-contributing', true, true],
      ['ahrena-engineering-fundamentals', true, true],
    ]);
    assert.deepEqual(byGroup('suggested').map((x) => [x.name, x.checked, x.locked, x.why]), [
      ['ahrena-engineering-python', true, false, 'achamos pyproject.toml ou requirements.txt'],
      ['ahrena-engineering-backend', true, false, 'achamos um framework de servidor'],
    ]);
    assert.ok(byGroup('other').length > 5 && byGroup('other').every((x) => !x.checked && !x.locked && x.why === null));
    assert.deepEqual(p.choice.plugins, ['ahrena-foundation', 'ahrena-contributing', 'ahrena-engineering-fundamentals', 'ahrena-engineering-python', 'ahrena-engineering-backend']);
    assert.deepEqual(p.platforms.map((x) => [x.id, x.available, x.checked, x.note]), [
      ['claude', true, true, null],
      ['codex', true, true, null],
      ['cursor', false, false, 'a confirmar'],
    ]);
    assert.match(p.catalogCommit!, /^[0-9a-f]{7}$/);
    assert.equal(p.frameworkRepo, 'ahrenatechnology/ahrena-framework');
  });

  test('#184/AC-3 a repository with instructions gets a merge, nothing lost, and the preview shows the diff', async () => {
    const p = await ready(setup());
    assert.equal(p.canWrite, true);
    assert.equal(p.installed, false);
    assert.equal(p.blocked, null);
    assert.equal(p.branch, INSTALL_BRANCH);
    assert.match(p.planHash!, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.files.map((f) => [f.path, f.action]), [
      ['AGENTS.md', 'create'],
      ['CLAUDE.md', 'merge'],
      ['.claude/settings.json', 'merge'],
    ]);
    const claude = p.files.find((f) => f.path === 'CLAUDE.md')!;
    assert.deepEqual([claude.add, claude.del], [4, 0]);
    assert.match(claude.diff, /^--- a\/CLAUDE\.md\n\+\+\+ b\/CLAUDE\.md\n@@ /);
    assert.match(claude.diff, /\n\+@AGENTS\.md\n/);
    const settings = p.files.find((f) => f.path === '.claude/settings.json')!;
    assert.ok(settings.add > 10 && settings.del <= 2, `${settings.add}/${settings.del}`);
    assert.match(settings.diff, /\n- {4}"kit@time": true\n\+ {4}"kit@time": true,\n/, 'the person’s plugin only gains the comma of a key that is no longer the last');
    assert.doesNotMatch(settings.diff, /^\+.*"ahrena-contributing@ahrena"/m, 'the plugin the person turned off stays off');
    const agents = p.files.find((f) => f.path === 'AGENTS.md')!;
    assert.equal(agents.del, 0);
    assert.match(agents.diff, /^--- \/dev\/null\n/);
    assert.equal(agents.add, 21, 'the study’s example: AGENTS.md +21');
    assert.match(agents.diff, /blob\/main\/engineering\/fundamentals\/rules\//);
  });

  test('a choice through the query: only Codex writes only AGENTS.md; an explicit plugin list replaces the suggested', async () => {
    const s = setup();
    const codex = await ready(s, 'py-app', { platforms: 'codex' });
    assert.deepEqual(codex.files.map((f) => f.path), ['AGENTS.md']);
    assert.deepEqual(codex.choice.platforms, ['codex']);
    const quality = await ready(s, 'py-app', { plugins: 'ahrena-engineering-quality' });
    assert.deepEqual(quality.choice.plugins, ['ahrena-foundation', 'ahrena-contributing', 'ahrena-engineering-fundamentals', 'ahrena-engineering-quality']);
    assert.equal(quality.plugins.find((x) => x.name === 'ahrena-engineering-python')!.checked, false);
    assert.notEqual(quality.planHash, (await ready(s)).planHash);
    for (const bad of [{ platforms: 'cursor' }, { platforms: 'vim' }, { plugins: 'no-such-plugin' }]) {
      const a = await s.service.plan('org-a', 'py-app', bad);
      assert.equal(a.status, 400, JSON.stringify(bad));
      assert.equal((a.body as { code: string }).code, 'bad-request');
    }
  });

  test('an empty repository (C33): creates the three files, suggests nothing and offers Install', async () => {
    const p = await ready(setup(), 'empty');
    assert.deepEqual(p.files.map((f) => [f.path, f.action]), [
      ['AGENTS.md', 'create'],
      ['CLAUDE.md', 'create'],
      ['.claude/settings.json', 'create'],
    ]);
    assert.deepEqual(p.plugins.filter((x) => x.group === 'suggested'), []);
    assert.deepEqual([p.found.languages, p.found.tests, p.found.ci], [[], false, false]);
    assert.equal(p.blocked, null);
  });

  test('an invalid settings.json blocks the install and is refused, with the reason (C37)', async () => {
    const p = await ready(setup(), 'broken');
    const s = p.files.find((f) => f.path === '.claude/settings.json')!;
    assert.deepEqual([s.action, s.add, s.del, s.diff], ['refused', 0, 0, '']);
    assert.equal(p.blocked!.kind, 'invalid-json');
    assert.equal(p.blocked!.path, '.claude/settings.json');
    assert.match(p.blocked!.message, /JSON inválido/);
  });

  test('without write permission: no button, the reason (C37)', async () => {
    const p = await ready(setup(), 'read-only');
    assert.equal(p.canWrite, false);
    assert.match(p.writeBlockedReason!, /permissão de escrita/);
    assert.equal(p.blocked!.kind, 'no-write');
    assert.ok(p.plugins.some((x) => x.name === 'ahrena-engineering-go' && x.group === 'suggested'));
  });

  test('cache: inside the TTL nothing goes to GitHub, and settings.json never enters the cache', async () => {
    const s = setup();
    await ready(s);
    const n = s.calls().length;
    s.clock.now += 61_000;
    await ready(s);
    const again = s.calls().slice(n);
    assert.deepEqual(again, ['GRAPHQL FrameworkInstallTarget'], 'after 60 s only the target (permission and PR) is read again');
    const cached = JSON.stringify([...s.store.entries]);
    assert.ok(!cached.includes('Bash(pytest)'), 'the raw settings.json is not cached');
    assert.ok(s.store.entries.has('framework-install:catalog:ahrenatechnology/ahrena-framework'));
    s.clock.now += FRAMEWORK_INSTALL_TTL.catalog;
    await ready(s);
    assert.ok(s.calls().slice(n).includes('GRAPHQL RepoFilesDiscovery'));
  });

  test('a different framework repository goes into the marketplace and the index links', async () => {
    assert.equal(frameworkRepoFrom(undefined), 'ahrenatechnology/ahrena-framework');
    assert.equal(frameworkRepoFrom('org-x/fork-do-framework'), 'org-x/fork-do-framework');
    for (const bad of ['org-x', 'a/b/c', '-x/y', 'x/..']) assert.equal(frameworkRepoFrom(bad), 'ahrenatechnology/ahrena-framework', bad);
    const p = await ready(setup({ frameworkRepo: 'org-x/fork-do-framework' }));
    assert.equal(p.frameworkRepo, 'org-x/fork-do-framework');
    assert.match(p.files.find((f) => f.path === '.claude/settings.json')!.diff, /"repo": "org-x\/fork-do-framework"/);
    assert.match(p.files.find((f) => f.path === 'AGENTS.md')!.diff, /https:\/\/github\.com\/org-x\/fork-do-framework\/blob\/main\//);
  });
});

describe('#184 opening the pull request, through the service', () => {
  test('#184/AC-2 a new branch, one commit and the PR, and the default branch untouched; the change is registered', async () => {
    const s = setup();
    const p = await ready(s);
    const mainBefore = s.gh().refs('org-a', 'py-app').main;
    const since = s.mark();
    const a = await install(s, p);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const body = a.body as { status: string; pullRequest: { number: number; branch: string; base: string; state: string; checks: string; review: string; title: string } };
    assert.equal(body.status, 'opened');
    assert.deepEqual([body.pullRequest.branch, body.pullRequest.base, body.pullRequest.state, body.pullRequest.checks, body.pullRequest.review, body.pullRequest.title], [
      INSTALL_BRANCH,
      'main',
      'open',
      'pending',
      'review_required',
      'chore: install the Ahrena Framework',
    ]);
    assert.deepEqual(s.gh().writes.map((w) => [w.operation, w.branch]), [
      ['createRef', INSTALL_BRANCH],
      ['createCommitOnBranch', INSTALL_BRANCH],
      ['createPullRequest', INSTALL_BRANCH],
    ]);
    assert.deepEqual(s.gh().writes[1].paths, ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json']);
    assert.equal(s.gh().writes[2].base, 'main');
    assert.ok(s.gh().writes.every((w) => w.branch !== 'main'), 'no write targets the default branch');
    assert.equal(s.gh().refs('org-a', 'py-app').main, mainBefore, 'the default branch did not move');
    // O que foi escrito no branch é o plano da prévia.
    const pr = s.gh().pullRequests[0];
    const settings = JSON.parse(pr.files['.claude/settings.json']);
    assert.deepEqual(settings.permissions, { allow: ['Bash(pytest)'] });
    assert.equal(settings.enabledPlugins['ahrena-contributing@ahrena'], false);
    assert.equal(settings.enabledPlugins['kit@time'], true);
    assert.equal(settings.enabledPlugins['ahrena-engineering-python@ahrena'], true);
    assert.ok(pr.files['CLAUDE.md'].startsWith(PY['CLAUDE.md'].trimEnd()));
    // A tela relê: o PR já está no plano e na rota do PR, sem esperar o GitHub.
    assert.deepEqual((await since()).map((c) => [c.type, c.key]), [['framework-install', 'org-a/py-app']]);
    const after = (await s.service.plan('org-a', 'py-app')).body as FrameworkInstallPlan;
    assert.equal(after.pullRequest!.number, body.pullRequest.number);
    assert.equal((await s.service.pullRequest('org-a', 'py-app')).pullRequest!.number, body.pullRequest.number);
    for (const x of [a, after]) assert.ok(!JSON.stringify(x).includes(TOKEN));
  });

  test('a PR already open for the branch is returned without writing anything', async () => {
    const s = setup();
    const p = await ready(s);
    assert.equal((await install(s, p)).status, 201);
    const writes = s.gh().writes.length;
    const again = await install(s, p);
    assert.equal(again.status, 200);
    assert.equal((again.body as { status: string }).status, 'already-open');
    assert.equal(s.gh().writes.length, writes);
  });

  test('two clicks at once open one PR', async () => {
    const s = setup();
    const p = await ready(s);
    const [a, b] = await Promise.all([install(s, p), install(s, p)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(s.gh().writes.filter((w) => w.operation === 'createPullRequest').length, 1);
  });

  test('the issue field: a number becomes Refs #N, empty leaves no reference, anything else is refused before any write', async () => {
    const withIssue = setup();
    assert.equal((await install(withIssue, await ready(withIssue), { issue: '12' })).status, 201);
    assert.match(withIssue.gh().writes[2].body!, /\n\nRefs #12$/);
    const empty = setup();
    assert.equal((await install(empty, await ready(empty), { issue: '' })).status, 201);
    assert.doesNotMatch(empty.gh().writes[2].body!, /Refs/);
    const bad = setup();
    const p = await ready(bad);
    const before = bad.calls().length;
    for (const issue of ['abc', '12; rm -rf', -3, '0']) {
      const a = await install(bad, p, { issue });
      assert.equal(a.status, 422, String(issue));
      assert.equal((a.body as { code: string }).code, 'invalid-issue');
    }
    assert.deepEqual(bad.gh().writes, []);
    assert.equal(bad.calls().length, before, 'refused before reading GitHub again');
  });

  test('a title from the screen, one line', async () => {
    const s = setup();
    const p = await ready(s);
    assert.equal((await install(s, p, { title: 'linha 1\nlinha 2' })).status, 400);
    assert.equal((await install(s, p, { title: 'chore: adopt the framework' })).status, 201);
    assert.equal(s.gh().writes[2].title, 'chore: adopt the framework');
  });

  test('the plan changed since the preview: 409 with the new hash, nothing written', async () => {
    const s = setup();
    const p = await ready(s);
    s.push({ ...PY, 'CLAUDE.md': '# py-app\n\nOutra regra.\n' });
    const a = await install(s, p);
    assert.equal(a.status, 409);
    const body = a.body as { code: string; planHash: string };
    assert.equal(body.code, 'plan-changed');
    assert.match(body.planHash, /^[0-9a-f]{64}$/);
    assert.notEqual(body.planHash, p.planHash);
    assert.deepEqual(s.gh().writes, []);
    // Com o hash novo, abre.
    const fresh = (await s.service.plan('org-a', 'py-app')).body as FrameworkInstallPlan;
    assert.equal(fresh.planHash, body.planHash);
    assert.equal((await install(s, fresh)).status, 201);
    // Um hash forjado para outra escolha também não passa.
    const other = setup();
    const op = await ready(other);
    assert.equal((await other.service.install('org-a', 'py-app', { platforms: ['codex'], plugins: op.choice.plugins, planHash: op.planHash })).status, 409);
  });

  test('the default branch moved between the discovery and the target: 409 plan-changed, nothing written', async () => {
    const s = setup();
    const p = await ready(s);
    // A descoberta lê um HEAD; o alvo, lido logo depois, já vê outro: o branch nasceria de um commit que o plano não leu.
    s.tamper.fn = (op, json) => {
      if (op !== 'FrameworkInstallTarget') return json;
      const data = json.data as { repository: { defaultBranchRef: { target: { oid: string } } } };
      data.repository.defaultBranchRef.target.oid = 'f'.repeat(40);
      return json;
    };
    const a = await install(s, p);
    assert.equal(a.status, 409, JSON.stringify(a.body));
    const body = a.body as { code: string; planHash: string };
    assert.equal(body.code, 'plan-changed');
    assert.match(body.planHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(s.gh().writes, []);
  });

  test('a PR already open wins over a changed plan: already-open, not 409', async () => {
    const s = setup();
    const p = await ready(s);
    const opened = await install(s, p);
    assert.equal(opened.status, 201);
    const writes = s.gh().writes.length;
    // Outra escolha com o hash da prévia: antes era 409; com o PR aberto, ele volta.
    const a = await s.service.install('org-a', 'py-app', { platforms: ['codex'], plugins: p.choice.plugins, planHash: p.planHash });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal((a.body as { status: string }).status, 'already-open');
    assert.equal((a.body as { pullRequest: { number: number } }).pullRequest.number, (opened.body as { pullRequest: { number: number } }).pullRequest.number);
    assert.equal(s.gh().writes.length, writes);
  });

  test('a background read that started before the PR opened does not erase it', async () => {
    const s = setup();
    const p = await ready(s);
    const writing = s.holdCall((op) => op === 'OpenInstallPullRequest');
    const inst = install(s, p);
    await writing.reached;
    // A leitura de fundo pega o alvo de antes do PR (do cache) e para antes de terminar.
    const reading = s.holdStore('framework-install:tree:org-a/py-app');
    await s.service.plan('org-a', 'py-app', { refresh: true });
    await reading.reached;
    writing.release();
    const a = await inst;
    assert.equal(a.status, 201, JSON.stringify(a.body));
    reading.release();
    await s.service.wait();
    const pr = (await s.service.pullRequest('org-a', 'py-app')).pullRequest;
    assert.equal(pr?.number, (a.body as { pullRequest: { number: number } }).pullRequest.number);
  });

  test('GitHub refuses a write: 502 github-error, and neither the body nor the log carries the token', async () => {
    const s = setup();
    const p = await ready(s);
    s.tamper.fn = (op, json) => (op === 'CommitInstallFiles' ? { data: null, errors: [{ message: 'Resource not accessible by integration' }] } : json);
    const a = await install(s, p);
    assert.equal(a.status, 502, JSON.stringify(a.body));
    assert.equal((a.body as { code: string }).code, 'github-error');
    assert.match((a.body as { error: string }).error, /Resource not accessible/);
    assert.ok(s.logs.some((m) => /falhou/.test(m)), JSON.stringify(s.logs));
    assert.ok(!JSON.stringify(a.body).includes(TOKEN));
    assert.ok(!s.logs.join('\n').includes(TOKEN));
  });

  test('without write permission: 403, nothing written', async () => {
    const s = setup();
    const p = await ready(s, 'read-only');
    const a = await install(s, p, {}, 'read-only');
    assert.equal(a.status, 403);
    assert.equal((a.body as { code: string }).code, 'no-write');
    assert.deepEqual(s.gh().writes, []);
  });

  test('an invalid settings.json: 422, nothing written', async () => {
    const s = setup();
    const p = await ready(s, 'broken');
    const a = await install(s, p, {}, 'broken');
    assert.equal(a.status, 422);
    assert.equal((a.body as { code: string }).code, 'invalid-json');
    assert.deepEqual(s.gh().writes, []);
  });

  test('a file GitHub did not deliver whole (binary, truncated) blocks the preview and the POST: 422, nothing written', async () => {
    for (const [repo, path] of [['binary', 'CLAUDE.md'], ['truncated', 'AGENTS.md']]) {
      const s = setup();
      const p = await ready(s, repo);
      const f = p.files.find((x) => x.path === path)!;
      assert.deepEqual([f.action, f.diff, f.why], ['refused', '', 'não deu para ler o arquivo inteiro no GitHub: nada é escrito'], repo);
      assert.deepEqual([p.blocked!.kind, p.blocked!.path, p.blocked!.url], ['unreadable', path, null], repo);
      const a = await install(s, p, {}, repo);
      assert.equal(a.status, 422, repo);
      assert.equal((a.body as { code: string }).code, 'unreadable');
      assert.deepEqual(s.gh().writes, [], repo);
      assert.ok(![...s.store.entries.keys()].some((k) => k.startsWith('blob:') && JSON.stringify(s.store.entries.get(k)!.value).includes('uma regra longa')), 'the cut text is not cached');
    }
  });

  test('a failure between the branch and the commit leaves an empty branch; the retry reuses it and opens the PR', async () => {
    const s = setup();
    const p = await ready(s);
    s.gh().failNext('CommitInstallFiles');
    const failed = await install(s, p);
    assert.equal(failed.status, 502);
    assert.equal((failed.body as { code: string }).code, 'github-error');
    assert.deepEqual(s.gh().writes.map((w) => w.operation), ['createRef']);
    assert.equal(s.gh().refs('org-a', 'py-app')[INSTALL_BRANCH], s.gh().refs('org-a', 'py-app').main, 'the branch is at the default HEAD, empty');
    const preview = await ready(s);
    assert.equal(preview.blocked, null, 'an empty branch left by the console does not block');
    const retry = await install(s, preview);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.deepEqual(s.gh().writes.map((w) => w.operation), ['createRef', 'createCommitOnBranch', 'createPullRequest'], 'no second createRef');
  });

  test('a leftover install branch with commits and no open PR blocks the preview and is not overwritten: 409', async () => {
    const s = setup();
    const p = await ready(s);
    assert.equal((await install(s, p)).status, 201);
    s.gh().pullRequests[0].state = 'CLOSED';
    s.clock.now += 61_000;
    const again = await ready(s);
    assert.equal(again.pullRequest!.state, 'closed');
    assert.equal(again.blocked!.kind, 'branch-exists');
    assert.match(again.blocked!.message, /chore\/install-ahrena-framework.*apague-o ou mescle-o no GitHub/);
    assert.equal(again.blocked!.url, `https://github.com/org-a/py-app/tree/${INSTALL_BRANCH}`);
    const writes = s.gh().writes.length;
    const a = await install(s, again);
    assert.equal(a.status, 409);
    assert.equal((a.body as { code: string }).code, 'branch-exists');
    assert.equal(s.gh().writes.length, writes);
  });

  test('#184/AC-3 idempotent: after the merge the plan changes nothing and says it is installed', async () => {
    const s = setup();
    assert.equal((await install(s, await ready(s))).status, 201);
    const merged = s.gh().pullRequests[0].files;
    s.push(merged);
    s.clock.now += FRAMEWORK_INSTALL_TTL.discovery + 1;
    const p = await ready(s);
    assert.equal(p.installed, true);
    assert.ok(p.files.every((f) => f.action === 'unchanged' && f.diff === ''), JSON.stringify(p.files.map((f) => [f.path, f.action])));
    assert.equal(p.blocked!.kind, 'nothing-to-do');
    const a = await install(s, p);
    assert.equal(a.status, 422);
    assert.equal((a.body as { code: string }).code, 'nothing-to-do');
  });

  test('the PR state evolves (CI, review) and each change is registered while someone looks', async () => {
    const s = setup({ timeline: { checksAfterMs: 20_000, approvedAfterMs: 45_000 } });
    assert.equal((await install(s, await ready(s))).status, 201);
    const live = [['framework-install', 'org-a/py-app']];
    let since = s.mark();
    s.clock.now += 25_000;
    await s.service.pollPullRequests();
    assert.equal((await s.service.pullRequest('org-a', 'py-app')).pullRequest!.checks, 'success');
    assert.deepEqual((await since()).map((c) => [c.type, c.key]), live);
    since = s.mark();
    await s.service.pollPullRequests();
    assert.deepEqual(await since(), [], 'nothing changed, nothing registered');
    s.clock.now += 25_000;
    await s.service.pollPullRequests();
    const pr = (await s.service.pullRequest('org-a', 'py-app')).pullRequest!;
    assert.deepEqual([pr.checks, pr.review, pr.state], ['success', 'approved', 'open']);
    assert.deepEqual((await since()).map((c) => [c.type, c.key]), live);
    // Ninguém olhando há mais de 15 min: não relê.
    s.gh().pullRequests[0].state = 'MERGED';
    s.clock.now += 16 * 60_000;
    const reads = s.calls().length;
    await s.service.pollPullRequests();
    assert.equal(s.calls().length, reads);
  });
});

describe('#184 the /api/framework-install routes', () => {
  let api: ApiLocal;
  let s: Setup;
  let port: number;
  before(async () => {
    s = setup();
    const storage = openSqliteStorage({ path: ':memory:' });
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, frameworkInstall: createFrameworkInstallRoute(s.service) });
    port = Number(new URL(api.url).port);
  });
  after(() => api.close());

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${api.url}${path}`, { headers });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${api.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  test('GET plan and pull-request answer the contract, never the token; owner/repo outside the GitHub pattern is 400', async () => {
    await get('/api/framework-install/org-a/read-only/plan');
    await s.service.wait();
    const p = await get('/api/framework-install/org-a/read-only/plan?platforms=claude,codex&plugins=');
    assert.equal(p.status, 200);
    for (const key of ['state', 'error', 'readAt', 'repo', 'frameworkRepo', 'catalogCommit', 'canWrite', 'writeBlockedReason', 'installed', 'found', 'platforms', 'plugins', 'choice', 'files', 'blocked', 'branch', 'title', 'planHash', 'pullRequest']) assert.ok(key in p.body, key);
    const pr = await get('/api/framework-install/org-a/read-only/pull-request');
    assert.deepEqual(pr.body, { state: 'ready', error: null, pullRequest: null });
    for (const r of [p, pr]) assert.ok(!r.text.includes(TOKEN));
    assert.equal((await get('/api/framework-install/-org/x/plan')).status, 400);
    assert.equal((await get('/api/framework-install/org-a/x/other')).status, 404);
    assert.equal((await get('/api/framework-install/org-a/read-only/plan?platforms=cursor')).status, 400);
  });

  test('the same-origin guard: the /ui itself writes; another origin, a query or a GET-only path is refused', async () => {
    await get('/api/framework-install/org-a/empty/plan');
    await s.service.wait();
    const p = (await get('/api/framework-install/org-a/empty/plan')).body as unknown as FrameworkInstallPlan;
    const payload = { platforms: p.choice.platforms, plugins: p.choice.plugins, planHash: p.planHash };
    const evil = await post('/api/framework-install/org-a/empty', payload, { origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    const query = await post('/api/framework-install/org-a/empty?x=1', payload, { origin: `http://127.0.0.1:${port}` });
    assert.equal(query.status, 403);
    const crossSite = await post('/api/framework-install/org-a/empty', payload, { 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    assert.deepEqual(s.gh().writes, [], 'nothing written by the refused requests');
    const noJson = await fetch(`${api.url}/api/framework-install/org-a/empty`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(payload) });
    assert.equal(noJson.status, 415);
    assert.equal((await post('/api/framework-install/org-a/empty', '{ broken')).status, 400);
    const ok = await post('/api/framework-install/org-a/empty', payload, { origin: `http://127.0.0.1:${port}` });
    assert.equal(ok.status, 201, ok.text);
    assert.equal((ok.body as { status: string }).status, 'opened');
    // Sem Origin, de 127.0.0.1, como as outras escritas: o PR já aberto volta sem escrever.
    const local = await post('/api/framework-install/org-a/empty', payload);
    assert.equal(local.status, 200);
    assert.equal((local.body as { status: string }).status, 'already-open');
    assert.equal(s.gh().writes.length, 3);
    const sameOriginRead = await get('/api/framework-install/org-a/empty/pull-request', { origin: `http://127.0.0.1:${port}` });
    assert.equal(sameOriginRead.status, 200);
    assert.equal((sameOriginRead.body.pullRequest as { number: number }).number, (ok.body.pullRequest as { number: number }).number);
    assert.equal((await fetch(`${api.url}/api/framework-install/org-a/empty/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405);
  });
});

describe('#184 the service as the core mounts it', () => {
  test('createCoreFrameworkInstall({ demo: true }) calls no fetch outside the fake GitHub, and the demo repositories cover the four cases', async () => {
    const original = globalThis.fetch;
    const outside: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      outside.push(String(input));
      throw new Error('real fetch in the demo');
    }) as typeof fetch;
    try {
      const { service } = createCoreFrameworkInstall({ demo: true, noGithub: false, cache: new GithubCache({ store: new MemoryCacheStore() }), changes: new ChangeCursor(), queue: new GithubCallQueue() });
      service.close();
      const read = async (full: string) => {
        const [o, r] = full.split('/');
        await service.plan(o, r);
        await service.wait();
        return (await service.plan(o, r)).body as FrameworkInstallPlan;
      };
      const noFramework = await read('exemplo-labs/painel-de-metricas');
      assert.equal(noFramework.state, 'ready', noFramework.error ?? '');
      assert.deepEqual(noFramework.files.map((f) => [f.path, f.action]), [
        ['AGENTS.md', 'create'],
        ['CLAUDE.md', 'merge'],
        ['.claude/settings.json', 'merge'],
      ]);
      assert.deepEqual(noFramework.found.frameworks, ['FastAPI']);
      assert.equal(noFramework.blocked, null);
      const empty = await read('dev-sintetico/blog-estatico');
      assert.equal(empty.blocked, null);
      assert.ok(empty.files.every((f) => f.action === 'create'));
      assert.equal((await read('exemplo-labs/motor-de-regras')).blocked!.kind, 'invalid-json');
      assert.equal((await read('exemplo-labs/gateway-sandbox')).blocked!.kind, 'no-write');
      for (const full of ['exemplo-labs/painel-de-metricas', 'dev-sintetico/blog-estatico', 'exemplo-labs/motor-de-regras', 'exemplo-labs/gateway-sandbox']) {
        assert.ok(DEMO_GITHUB_DATA.repos.some((r) => `${r.owner}/${r.name}` === full), `${full} is a repository of the Repositories screen`);
      }
      const opened = await service.install('exemplo-labs', 'painel-de-metricas', { platforms: noFramework.choice.platforms, plugins: noFramework.choice.plugins, planHash: noFramework.planHash, issue: 7 });
      assert.equal(opened.status, 201);
      assert.deepEqual(outside, []);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('createCoreFrameworkInstall({ noGithub: true }) answers no-github, and the POST 503', async () => {
    const { service } = createCoreFrameworkInstall({ demo: false, noGithub: true, cache: new GithubCache({ store: new MemoryCacheStore() }), changes: new ChangeCursor(), queue: new GithubCallQueue() });
    assert.equal(((await service.plan('org-a', 'py-app')).body as FrameworkInstallPlan).state, 'no-github');
    assert.equal((await service.install('org-a', 'py-app', { planHash: 'a'.repeat(64) })).status, 503);
  });

  test('without the gh token: no-github', async () => {
    const service = new FrameworkInstallService({
      transport: new GithubReposSource({ token: async () => Promise.reject(new Error('sem token do GitHub: rode `gh auth login`')), url: 'https://fake.invalid/graphql', api: 'https://fake.invalid' }),
      pullRequestPollMs: 0,
    });
    await service.plan('org-a', 'py-app');
    await service.wait();
    const p = (await service.plan('org-a', 'py-app')).body as FrameworkInstallPlan;
    assert.equal(p.state, 'no-github');
    assert.match(p.error!, /gh auth login/);
  });
});
