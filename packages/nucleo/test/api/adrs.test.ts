import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
// As ADRs e as PDRs dos repositórios (#174) pelo serviço e pelas rotas, contra o GitHub falso
// (src/simulator/fake-github.ts): a descoberta comum em lotes de 20, o texto pelo `oid`, o extrator no
// cache, o GitHub limitando e as rotas. Nenhuma chamada à API real e nenhum token na resposta.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { createCoreDecisions, createDecisionsRoute, DecisionsService, DECISIONS_DISCOVERY_TTL, DECISIONS_INDEX_KEY, decisionsSnapshotKey, type AccountRepo } from '../../src/api/adrs.ts';
import { Accounts, startLocalApi, MontadorDoPainel, type LocalApi } from '../../src/api/index.ts';
import type { DecisionList, DecisionRecordView, RepoDecisions } from '../../src/adrs/model.ts';
import { EXTRACTOR_VERSION } from '../../src/adrs/parse.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { RepoFilesSource } from '../../src/github/repo-files-source.ts';
import { GithubReposSource } from '../../src/github/repos-source.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { blobOid, createFakeGithub, type FakeGithubData, type FakeRepo } from '../../src/simulator/fake-github.ts';
import { DEMO_DECISION_FILES } from '../../src/simulator/demo-decisions.ts';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const TOKEN = 'token-that-must-not-leak';
const base: Omit<FakeRepo, 'owner' | 'name'> = { isPrivate: false, language: 'TypeScript', permission: 'READ', pushMin: 5, issues: 0, prs: 0, ci: null, commitsPerWeek: 1 };

/** Uma pasta de fixtures do extrator (test/adrs/fixtures) posta numa pasta do repositório. */
function folder(name: string, at: string): Record<string, string> {
  const dir = fileURLToPath(new URL(`../adrs/fixtures/${name}/`, import.meta.url));
  return Object.fromEntries(readdirSync(dir).map((f) => [`${at}/${f}`, readFileSync(`${dir}${f}`, 'utf8')]));
}

const REPOS: Record<string, Record<string, string>> = {
  madr: { 'README.md': '# madr\n', ...folder('madr4', 'docs/adr'), 'docs/adr/README.md': '# índice\n' },
  mixed: { 'README.md': '# mixed\n', ...folder('mixed-pt', 'docs/decisoes'), 'docs/decisoes/0004-decisão de fila.md': '# 0004 · Decisão de fila\n\n- **Status:** proposta\n' },
  product: { 'README.md': '# product\n', ...folder('pdr', 'docs/pdr'), ...folder('nygard', 'doc/adr') },
  none: { 'README.md': '# none\n' },
};

function data(repos = REPOS): FakeGithubData {
  return { login: 'dev-sintetico', organizations: ['org-a'], awaitingReview: 0, closedThisWeek: 0, repos: Object.entries(repos).map(([name, files]) => ({ ...base, owner: 'org-a', name, files })) };
}

type Mode = 'ok' | 'down' | 'limited' | 'no-blobs' | 'forbidden' | 'bad-gateway';

interface Setup {
  service: DecisionsService;
  calls: () => string[];
  bodies: string[];
  clock: { now: number };
  mode: { current: Mode };
  account: { repos: AccountRepo[]; state: 'ready' | 'loading' | 'error'; fail: string | null };
  changes: () => Promise<{ type: string; key: string }[]>;
  push: (repos: Record<string, Record<string, string>>) => void;
  store: MemoryCacheStore;
  cache: GithubCache;
}

function setup({ noSource = false, many = 0, syncOnRead = true, store = new MemoryCacheStore() } = {}): Setup {
  const clock = { now: T0 };
  const now = () => clock.now;
  const extra = Object.fromEntries(Array.from({ length: many }, (_, i) => [`extra-${i}`, { 'README.md': '# x\n' }]));
  let gh = createFakeGithub(data({ ...REPOS, ...extra }), { now });
  const all: string[] = [];
  const bodies: string[] = [];
  const mode = { current: 'ok' as Mode };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    bodies.push(body);
    if (mode.current === 'down') throw new Error('rede fora');
    if (mode.current === 'limited') return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor((clock.now + 120_000) / 1000)) } });
    if (mode.current === 'no-blobs' && body.includes('RepoBlobs')) throw new Error('lote de conteúdo fora');
    if (mode.current === 'bad-gateway') return new Response('<html>502</html>', { status: 502 });
    // Uma organização com SAML não autorizado: a consulta que pede `mixed` falha inteira, como no GitHub.
    if (mode.current === 'forbidden' && body.includes('RepoFilesDiscovery') && Object.values(JSON.parse(body).variables).includes('mixed'))
      return new Response(JSON.stringify({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement' }] }), { status: 200 });
    const n = gh.calls.length;
    const r = await gh.fetch(input, init);
    all.push(...gh.calls.slice(n));
    return r;
  }) as typeof globalThis.fetch;
  const transport = new GithubReposSource({ token: TOKEN, fetch, now, url: 'https://fake.invalid/graphql', api: 'https://fake.invalid', sleep: async () => {} });
  const cursor = new ChangeCursor({ generation: 'g', batchMs: 0, minIntervalMs: 0 });
  const start = cursor.current;
  const account = { state: 'ready' as 'ready' | 'loading' | 'error', fail: null as string | null, repos: [...Object.keys(REPOS), ...Object.keys(extra)].map((name) => ({ owner: 'org-a', name, lastPush: null as string | null })) };
  const cache = new GithubCache({ store, now });
  const service = new DecisionsService({
    source: noSource ? null : new RepoFilesSource(transport),
    accountRepos: async () => {
      if (account.fail) throw new Error(account.fail);
      return { state: account.state, error: account.state === 'error' ? 'lista de repositórios fora' : null, account: 'dev-sintetico', repos: account.state === 'ready' ? account.repos : [] };
    },
    cache,
    changes: cursor,
    now,
    syncOnRead,
  });
  return {
    service,
    calls: () => all,
    bodies,
    clock,
    mode,
    account,
    changes: async () => (await cursor.wait(start, { timeoutMs: 0 })).changes,
    push: (repos) => {
      gh = createFakeGithub(data(repos), { now });
    },
    store,
    cache,
  };
}

async function list(s: Setup, kind: 'adr' | 'pdr' = 'adr', filters = {}, refresh = false): Promise<DecisionList> {
  await s.service.list(kind, filters, { refresh });
  await s.service.wait();
  return s.service.list(kind, filters);
}

async function repo(s: Setup, name: string, kind: 'adr' | 'pdr' | 'all' = 'adr', refresh = false): Promise<RepoDecisions> {
  await s.service.repo(kind, 'org-a', name, { refresh });
  await s.service.wait();
  return s.service.repo(kind, 'org-a', name);
}

describe('#174 the decision list, through the service', () => {
  test('the request does not wait for GitHub: loading first, then the ADRs of every repository, grouped', async () => {
    const s = setup();
    assert.equal((await s.service.list('adr')).state, 'loading');
    await s.service.wait();
    const l = await s.service.list('adr');
    assert.equal(l.state, 'ready');
    assert.equal(l.account, 'dev-sintetico');
    assert.deepEqual(l.groups.map((g) => [g.repo, g.folders, g.total]), [
      ['org-a/madr', ['docs/adr'], 2],
      ['org-a/mixed', ['docs/decisoes'], 3],
      ['org-a/product', ['doc/adr'], 3],
    ]);
    assert.deepEqual(l.without, ['org-a/none']);
    assert.equal(l.totals.records, 8);
    assert.equal(l.totals.reposWith, 3);
    assert.equal(l.totals.reposRead, 4);
    assert.equal(l.readAt, new Date(T0).toISOString());
    assert.equal(l.error, null);
    // Mais novo primeiro, pelo número.
    assert.deepEqual(l.groups[0].records.map((r) => r.number), [3, 2]);
    assert.ok(!JSON.stringify(l).includes('Context and Problem Statement'), 'the list has no text');
  });

  test('the PDR list reads the same discovery: the PDR folder and the mixed folder by the type field', async () => {
    const s = setup();
    await list(s, 'adr');
    const discoveries = s.calls().filter((c) => c === 'GRAPHQL RepoFilesDiscovery').length;
    const p = await list(s, 'pdr');
    assert.equal(s.calls().filter((c) => c === 'GRAPHQL RepoFilesDiscovery').length, discoveries, 'the PDRs read nothing new');
    assert.deepEqual(p.groups.map((g) => [g.repo, g.folders, g.total, g.byTypeField]), [
      ['org-a/mixed', ['docs/decisoes'], 1, true],
      ['org-a/product', ['docs/pdr'], 2, false],
    ]);
    assert.deepEqual(p.without, ['org-a/madr', 'org-a/none']);
  });

  test('one discovery query for up to 20 repositories, then the content in batches by oid', async () => {
    const s = setup({ many: 21 });
    await list(s);
    assert.equal(s.calls().filter((c) => c === 'GRAPHQL RepoFilesDiscovery').length, 2, '25 repositories: 2 batches');
    const discovery = s.bodies.filter((b) => b.includes('RepoFilesDiscovery')).map((b) => JSON.parse(b));
    assert.equal(Object.keys(discovery[0].variables).length, 40, '20 repositories in the first batch');
    assert.ok(discovery.every((d) => !d.query.includes('org-a')), 'owner and name go as variables');
    assert.match(discovery[0].query, /HEAD:docs\/adr"/);
    assert.match(discovery[0].query, /HEAD:product-decisions"/);
    assert.equal(s.calls().filter((c) => c === 'GRAPHQL RepoBlobs').length, 3, 'one content batch per repository with records');
    assert.ok(s.bodies.every((b) => !b.includes(TOKEN)), 'the token goes only in the header');
  });

  test('the cache: inside the TTL nothing is read again; the text by oid and the extractor by oid and version', async () => {
    const s = setup();
    await list(s);
    const n = s.calls().length;
    s.clock.now += 61_000;
    await list(s);
    assert.equal(s.calls().length, n, 'inside the 15 min of the discovery, GitHub is not called');
    const oid = blobOid(REPOS.madr['docs/adr/0003-use-sqlite-in-tests.md']);
    assert.ok(s.store.entries.has(`blob:${oid}`));
    const parsed = s.store.entries.get(`adrs:parsed:${oid}:${EXTRACTOR_VERSION}`)?.value as { path: string; record: { title: string } };
    assert.equal(parsed.path, 'docs/adr/0003-use-sqlite-in-tests.md');
    assert.equal(parsed.record.title, 'Use SQLite in memory for tests');
    // Depois do TTL, a descoberta é relida; o texto não, porque o oid é o mesmo.
    s.clock.now += DECISIONS_DISCOVERY_TTL;
    await list(s);
    const after = s.calls().slice(n);
    assert.deepEqual(after, ['GRAPHQL RepoFilesDiscovery']);
  });

  test('a push after the reading invalidates the discovery of that repository only', async () => {
    const s = setup();
    await list(s);
    const n = s.calls().length;
    s.push({ ...REPOS, madr: { ...REPOS.madr, 'docs/adr/0004-new.md': '# 4. New\n\n## Status\n\nProposed\n' } });
    s.account.repos[0].lastPush = new Date(T0 + 30_000).toISOString();
    s.clock.now += 61_000;
    const l = await list(s);
    const after = s.calls().slice(n);
    assert.deepEqual(after, ['GRAPHQL RepoFilesDiscovery', 'GRAPHQL RepoBlobs'], 'only the new file is fetched');
    const madr = s.bodies.filter((b) => b.includes('RepoFilesDiscovery')).at(-1)!;
    assert.equal(Object.keys(JSON.parse(madr).variables).length, 2, 'only the pushed repository');
    assert.deepEqual(l.groups[0].records.map((r) => r.number), [4, 3, 2]);
  });

  test('search in the title and the text, without accent; status and repository filters; counts before the status filter', async () => {
    const s = setup();
    let l = await list(s, 'adr', { q: 'POSTGRES' });
    assert.deepEqual(l.groups.flatMap((g) => g.records.map((r) => r.id)), ['0003-use-sqlite-in-tests', '0002-use-postgres-in-docker-for-tests']);
    l = await list(s, 'adr', { q: 'cobranca' });
    assert.deepEqual(l.groups.flatMap((g) => g.records.map((r) => r.id)), ['0001-event-queue'], 'cobrança, sem acento');
    l = await list(s, 'adr', { status: 'superseded' });
    assert.deepEqual(l.groups.flatMap((g) => g.records.map((r) => `${g.repo}:${r.number}`)), ['org-a/madr:2', 'org-a/product:2']);
    assert.equal(l.counts.all, 8);
    assert.equal(l.counts.superseded, 2);
    l = await list(s, 'adr', { repo: 'org-a/mixed' });
    assert.deepEqual(l.groups.map((g) => g.repo), ['org-a/mixed']);
    assert.equal(l.totals.records, 8, 'the cards stay on the whole list');
    l = await list(s, 'adr', { repo: 'org-a' });
    assert.equal(l.groups.length, 3, 'only the owner: the organization');
  });

  test('more than 200 repositories: every one stays in the list (the account list goes up to 500)', async () => {
    const s = setup({ many: 246 });
    const l = await list(s);
    assert.equal(l.totals.reposRead, 250);
    assert.equal(l.without.length, 247);
    assert.ok(l.without.includes('org-a/extra-0') && l.without.includes('org-a/extra-245'));
    assert.equal(s.calls().filter((c) => c === 'GRAPHQL RepoFilesDiscovery').length, 13, '250 repositories: 13 batches of 20');
  });

  test('one repository with an error does not take the others of its batch', async () => {
    const s = setup();
    s.mode.current = 'forbidden';
    const l = await list(s);
    assert.deepEqual(l.groups.map((g) => g.repo), ['org-a/madr', 'org-a/product']);
    assert.match(l.error!, /SAML/);
    assert.equal((await repo(s, 'mixed')).state, 'error');
    assert.equal((await repo(s, 'madr')).error, null);
  });

  test('a general failure (HTTP 502) fails the whole batch after its retries (#269), without splitting it', async () => {
    const s = setup({ many: 21 });
    s.mode.current = 'bad-gateway';
    const l = await list(s);
    assert.equal(s.bodies.filter((b) => b.includes('RepoFilesDiscovery')).length, 2 * 3, 'three tries per batch of 20');
    assert.equal(l.groups.length, 0);
    assert.match(l.error!, /502/);
  });

  test('a push known from the account list also invalidates the repository tab', async () => {
    const s = setup();
    await list(s);
    s.push({ ...REPOS, madr: { ...REPOS.madr, 'docs/adr/0004-new.md': '# 4. New\n' } });
    s.account.repos[0].lastPush = new Date(T0 + 30_000).toISOString();
    s.clock.now += 61_000;
    await list(s);
    const r = await repo(s, 'madr');
    assert.deepEqual(r.records.map((x) => x.number), [4, 3, 2]);
  });

  test('the account list still loading: loading, and the next request tries again', async () => {
    const s = setup();
    s.account.state = 'loading';
    assert.equal((await list(s)).state, 'loading');
    s.account.state = 'ready';
    await list(s);
    assert.equal((await list(s)).state, 'ready');
  });

  test('without GitHub in the core: no-github', async () => {
    const s = setup({ noSource: true });
    assert.equal((await s.service.list('adr')).state, 'no-github');
    assert.equal((await s.service.repo('adr', 'org-a', 'madr')).state, 'no-github');
    assert.deepEqual(await s.service.record('adr', 'org-a', 'madr', 'x'), { status: 503, body: { error: 'sem GitHub neste núcleo' } });
  });

  test('the changes: list and <owner>/<repo>, once per content change', async () => {
    const s = setup();
    await list(s);
    const ch = await s.changes();
    assert.ok(ch.some((c) => c.type === 'adrs' && c.key === 'list'));
    assert.ok(ch.some((c) => c.type === 'adrs' && c.key === 'org-a/madr'));
    const n = ch.length;
    s.clock.now += 61_000;
    await list(s);
    assert.equal((await s.changes()).length, n, 'the same answer records nothing');
  });
});

describe('#174 GitHub limited or down: the cache with its time', () => {
  test('limited after a reading: the list comes from the cache, with the reason, the time and when it tries again', async () => {
    const s = setup();
    await list(s);
    s.mode.current = 'limited';
    s.clock.now += DECISIONS_DISCOVERY_TTL + 1;
    const l = await list(s);
    assert.equal(l.state, 'ready');
    assert.match(l.error!, /GitHub limitou/);
    assert.equal(l.readAt, new Date(T0).toISOString(), 'the time of the cache');
    assert.ok(l.retryAt && Date.parse(l.retryAt) > s.clock.now);
    assert.equal(l.totals.records, 8, 'everything still shows');
    const r = await repo(s, 'madr');
    assert.equal(r.fromCache, true);
    assert.match(r.error!, /GitHub limitou/);
    // Enquanto limitado, nem chama o GitHub.
    const n = s.bodies.length;
    s.clock.now += 61_000;
    await list(s);
    assert.equal(s.bodies.length, n);
  });

  test('down with nothing in the cache: error, with the reason', async () => {
    const s = setup();
    s.mode.current = 'down';
    const r = await repo(s, 'madr');
    assert.equal(r.state, 'error');
    assert.match(r.error!, /rede fora/);
  });

  test('the content batch fails: the records without text are left out and the error says why', async () => {
    const s = setup();
    s.mode.current = 'no-blobs';
    const r = await repo(s, 'madr');
    assert.equal(r.state, 'ready');
    assert.equal(r.records.length, 0);
    assert.match(r.error!, /lote de conteúdo fora/);
  });
});

describe('#174 one repository and one record', () => {
  test('a repository: the two kinds counted, the status counts, the folders, the format and the chains', async () => {
    const s = setup();
    const all = await repo(s, 'product', 'all');
    assert.deepEqual(all.counts, { adr: 3, pdr: 2, all: 5 });
    assert.deepEqual(all.folders, ['doc/adr', 'docs/pdr']);
    const adr = await repo(s, 'product', 'adr');
    assert.deepEqual(adr.folders, ['doc/adr']);
    assert.equal(adr.format, 'adr-tools');
    assert.equal(adr.statusCounts.accepted, 2);
    assert.deepEqual(adr.chains.map((c) => c.map((n) => n.number)), [[2, 3]]);
    assert.ok(adr.records.every((r) => r.kind === 'adr'));
    const pdr = await repo(s, 'product', 'pdr');
    assert.deepEqual(pdr.records.map((r) => [r.number, r.kindReason]), [[2, 'folder'], [1, 'prefix']]);
    assert.deepEqual(pdr.chains, []);
  });

  test('a repository that does not exist: not-found; one without records: ready and empty', async () => {
    const s = setup();
    assert.equal((await repo(s, 'nope')).state, 'not-found');
    const none = await repo(s, 'none');
    assert.equal(none.state, 'ready');
    assert.deepEqual([none.records, none.folders], [[], []]);
  });

  test('a record: structured, with the links resolved both ways, the chain and the original Markdown', async () => {
    const s = setup();
    const a = await s.service.record('adr', 'org-a', 'madr', '0003-use-sqlite-in-tests');
    assert.equal(a.status, 200);
    const r = a.body as DecisionRecordView;
    assert.equal(r.title, 'Use SQLite in memory for tests');
    assert.equal(r.format, 'madr4');
    assert.deepEqual(r.deciders, ['dev-sintetico', 'colega-a']);
    assert.equal(r.chosen, 'SQLite in memory');
    assert.deepEqual(r.links.map((l) => [l.kind, l.target, l.number, l.status]), [['supersedes', '0002-use-postgres-in-docker-for-tests', 2, 'superseded']]);
    assert.deepEqual(r.chain.map((n) => n.number), [2, 3]);
    assert.equal(r.markdown, REPOS.madr['docs/adr/0003-use-sqlite-in-tests.md']);
    const b = (await s.service.record('adr', 'org-a', 'madr', '0002-use-postgres-in-docker-for-tests')).body as DecisionRecordView;
    assert.deepEqual(b.links.map((l) => [l.kind, l.target, l.via]), [['superseded-by', '0003-use-sqlite-in-tests', 'text']]);
  });

  test('opening a record does not call GitHub: the text came in the batch', async () => {
    const s = setup();
    await repo(s, 'madr');
    const n = s.calls().length;
    await s.service.record('adr', 'org-a', 'madr', '0003-use-sqlite-in-tests');
    assert.equal(s.calls().length, n);
  });

  test('a record of the other kind, or that does not exist, is 404 with the reason', async () => {
    const s = setup();
    await repo(s, 'mixed', 'all');
    assert.deepEqual(await s.service.record('adr', 'org-a', 'mixed', '0002-free-plan'), { status: 404, body: { error: '0002-free-plan não é uma ADR: é uma PDR', kind: 'pdr' } });
    assert.equal((await s.service.record('pdr', 'org-a', 'mixed', '0002-free-plan')).status, 200);
    assert.equal((await s.service.record('adr', 'org-a', 'mixed', 'nope')).status, 404);
    assert.equal((await s.service.record('adr', 'org-a', 'mixed', '../x')).status, 400);
  });
});

describe('#174 the demo data', () => {
  test('ADRs and PDRs in several formats, in a PDR folder and in a mixed folder', async () => {
    const { service } = createCoreDecisions({
      demo: true,
      noGithub: false,
      cache: new GithubCache({ store: new MemoryCacheStore() }),
      changes: new ChangeCursor({ generation: 'g', batchMs: 0, minIntervalMs: 0 }),
      queue: new (await import('../../src/github/call-queue.ts')).GithubCallQueue(),
      accountRepos: async () => ({ state: 'ready', error: null, account: 'dev-sintetico', repos: Object.keys(DEMO_DECISION_FILES).concat('exemplo-labs/gateway-sandbox').map((k) => ({ owner: k.split('/')[0], name: k.split('/')[1], lastPush: null })) }),
    });
    await service.list('adr');
    await service.wait();
    const adr = await service.list('adr');
    const pdr = await service.list('pdr');
    const formats = new Set(adr.groups.map((g) => g.format));
    for (const f of ['madr4', 'free', 'adr-tools']) assert.ok(formats.has(f as never), f);
    assert.ok(adr.groups.some((g) => g.records.some((r) => r.status === 'unknown')), 'an ADR without status');
    assert.deepEqual(pdr.groups.map((g) => [g.repo, g.folders]), [
      ['exemplo-labs/vitrine-demo', ['docs/decisoes']],
      ['estudio-ficticio/app-receitas', ['docs/product-decisions']],
    ]);
    assert.ok(adr.without.includes('exemplo-labs/gateway-sandbox'));
    const motor = await service.repo('adr', 'exemplo-labs', 'motor-de-regras');
    assert.deepEqual(motor.chains.map((c) => c.map((n) => n.number)), [[5, 7, 8]]);
  });
});

describe('#174 the /api/adrs and /api/pdrs routes', () => {
  let api: LocalApi;
  let s: Setup;
  before(async () => {
    s = setup();
    const storage = openSqliteStorage({ path: ':memory:' });
    const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
    api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, decisions: createDecisionsRoute(s.service) });
    await s.service.list('adr');
    await s.service.wait();
  });
  after(() => api.close());

  const get = async (path: string) => {
    const r = await fetch(`${api.url}${path}`);
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  test('the three ADR routes answer 200 with the contract, and never the token', async () => {
    const l = await get('/api/adrs?q=sqlite&status=accepted&repo=org-a/madr');
    assert.equal(l.status, 200);
    assert.deepEqual((l.body as unknown as DecisionList).groups.map((g) => g.records.map((r) => r.id)), [['0003-use-sqlite-in-tests']]);
    const r = await get('/api/adrs/org-a/madr');
    assert.equal(r.status, 200);
    assert.equal((r.body as unknown as RepoDecisions).kind, 'adr');
    const one = await get('/api/adrs/org-a/madr/0003-use-sqlite-in-tests');
    assert.equal(one.status, 200);
    assert.match((one.body as unknown as DecisionRecordView).markdown, /SQLite in memory/);
    for (const x of [l, r, one]) assert.ok(!x.text.includes(TOKEN));
  });

  test('a file name with accent and space is the id, and it opens', async () => {
    const one = await get(`/api/adrs/org-a/mixed/${encodeURIComponent('0004-decisão de fila')}`);
    assert.equal(one.status, 200);
    assert.equal((one.body as unknown as DecisionRecordView).title, 'Decisão de fila');
    assert.equal((await s.service.record('adr', 'org-a', 'mixed', '..')).status, 400);
    assert.equal((await s.service.record('adr', 'org-a', 'mixed', 'a\u0000b')).status, 400);
  });

  test('the PDR routes filter by kind: pdr', async () => {
    const l = (await get('/api/pdrs')).body as unknown as DecisionList;
    assert.equal(l.kind, 'pdr');
    assert.ok(l.groups.every((g) => g.records.every((r) => r.kind === 'pdr')));
    assert.equal((await get('/api/pdrs/org-a/product')).body.kind, 'pdr');
    assert.equal((await get('/api/pdrs/org-a/product?kind=all')).body.kind, 'all');
    assert.equal((await get('/api/pdrs/org-a/mixed/0002-free-plan')).status, 200);
    assert.equal((await get('/api/pdrs/org-a/mixed/0001-event-queue')).status, 404);
  });

  test('invalid parameters are 400; unknown paths 404; writes 405', async () => {
    assert.equal((await get('/api/adrs?status=maybe')).status, 400);
    assert.equal((await get('/api/adrs?repo=a/b/c')).status, 400);
    assert.equal((await get('/api/adrs?repo=-bad')).status, 400);
    assert.equal((await get('/api/adrs/-bad/repo')).status, 400);
    assert.equal((await get('/api/adrs/org-a/madr?kind=x')).status, 400);
    assert.equal((await get('/api/adrs/org-a/madr/a/b')).status, 404);
    assert.equal((await get('/api/adrsx')).status, 404);
    const post = await fetch(`${api.url}/api/adrs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 405);
  });
});

describe('#356 the background sync (decision 0015)', () => {
  test('sync() builds the index and stores it: a new service on the same store answers at once, without GitHub', async () => {
    const first = setup({ syncOnRead: false });
    assert.equal(await first.service.sync(), 'done');
    const before = await first.service.list('adr');
    assert.equal(before.state, 'ready');
    assert.ok(before.totals.records > 0);

    // The core restarted: the same database, a new service, GitHub down.
    const second = setup({ syncOnRead: false, store: first.store });
    second.mode.current = 'down';
    const after = await second.service.list('adr');
    assert.equal(after.state, 'ready');
    assert.deepEqual(after.groups, before.groups);
    const tab = await second.service.repo('adr', 'org-a', 'madr');
    assert.equal(tab.state, 'ready');
    assert.ok(tab.records.length > 0);
    const record = await second.service.record('adr', 'org-a', 'madr', tab.records[0].id);
    assert.equal(record.status, 200);
    await second.service.wait();
    assert.equal(second.bodies.length, 0);
  });

  test('without syncOnRead a read past the validity starts nothing; Atualizar still does', async () => {
    const s = setup({ syncOnRead: false });
    await s.service.sync();
    const read = s.bodies.length;
    s.clock.now += DECISIONS_DISCOVERY_TTL + 1;
    await list(s);
    await repo(s, 'madr');
    assert.equal(s.bodies.length, read);
    await list(s, 'adr', {}, true);
    assert.ok(s.bodies.length > read);
  });

  test('an empty store still builds on the first read', async () => {
    const s = setup({ syncOnRead: false });
    assert.equal((await s.service.list('adr')).state, 'loading');
    await s.service.wait();
    assert.equal((await s.service.list('adr')).state, 'ready');
  });

  test('the account list still loading: sync() answers pending and builds nothing', async () => {
    const s = setup({ syncOnRead: false });
    s.account.state = 'loading';
    assert.equal(await s.service.sync(), 'pending');
    s.account.state = 'ready';
    assert.equal(await s.service.sync(), 'done');
  });

  test('an identity reset in the middle of a build: nothing the old service read is stored', async () => {
    const s = setup({ syncOnRead: false });
    const running = s.service.sync();
    await s.cache.clear();
    await running;
    await s.service.wait();
    assert.equal(await s.cache.peek(DECISIONS_INDEX_KEY), null);
    assert.equal(await s.cache.peek(decisionsSnapshotKey('org-a/madr')), null);
    // A service built after the reset stores again.
    const next = setup({ syncOnRead: false, store: s.store });
    assert.equal(await next.service.sync(), 'done');
    assert.ok(await next.cache.peek(DECISIONS_INDEX_KEY));
  });

  test('a failed index build makes sync() throw, so the sync status shows the error; the next good build clears it', async () => {
    const s = setup({ syncOnRead: false });
    s.account.fail = 'lista de repositórios fora';
    await assert.rejects(s.service.sync(), /lista de repositórios fora/);
    s.account.fail = null;
    assert.equal(await s.service.sync(), 'done');
  });

  test('the account list answering an error (as the real one does, without throwing): sync() throws it', async () => {
    const s = setup({ syncOnRead: false });
    s.account.state = 'error';
    await assert.rejects(s.service.sync(), /lista de repositórios fora/);
  });

  test('every repository read failing: sync() throws, not done', async () => {
    const s = setup({ syncOnRead: false });
    s.mode.current = 'down';
    await assert.rejects(s.service.sync());
  });

  test('an index in error is rebuilt on read under the sync, so the screen recovers without waiting for the next run', async () => {
    const s = setup({ syncOnRead: false });
    s.account.state = 'error';
    await assert.rejects(s.service.sync());
    assert.equal((await s.service.list('adr')).state, 'error');
    s.account.state = 'ready';
    s.clock.now += 60_001;
    assert.equal((await list(s)).state, 'ready');
  });

  test('without GitHub the step is skipped', async () => {
    assert.equal(await setup({ noSource: true, syncOnRead: false }).service.sync(), 'skipped');
  });
});
