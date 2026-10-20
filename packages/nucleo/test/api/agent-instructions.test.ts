// As instruções dos agentes de um repositório (#183) pelo serviço e pela rota, contra o GitHub falso
// (src/simulador/github-falso.ts): nenhuma chamada à API real e nenhum token na resposta.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { AGENT_INSTRUCTIONS_TTL, AgentInstructionsService, createAgentInstructionsRoute, createCoreAgentInstructions } from '../../src/api/agent-instructions.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import type { AgentInstructions, InstructionFileView } from '../../src/agent-instructions/model.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { RepoFilesSource } from '../../src/github/repo-files-source.ts';
import { GithubReposSource } from '../../src/github/repos-source.ts';
import { CursorDeMudancas } from '../../src/mudancas/cursor.ts';
import { blobOid, criarGithubFalso, DADOS_DA_DEMO, DEMO_INSTRUCTION_FILES, type DadosDoGithubFalso, type RepoFalso } from '../../src/simulador/github-falso.ts';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const TOKEN = 'token-that-must-not-leak';
const base: Omit<RepoFalso, 'dono' | 'nome'> = { privado: false, linguagem: 'TypeScript', permissao: 'READ', pushMin: 5, issues: 0, prs: 0, ci: null, ritmo: 1 };

const FULL = DEMO_INSTRUCTION_FILES['exemplo-labs/vitrine-demo'].files;
const WARNINGS = DEMO_INSTRUCTION_FILES['exemplo-labs/motor-de-regras'];

function data(files: Record<string, string> = FULL): DadosDoGithubFalso {
  return {
    login: 'dev-sintetico',
    organizacoes: ['org-a'],
    esperandoReview: 0,
    fechadasNaSemana: 0,
    repos: [
      { ...base, dono: 'org-a', nome: 'full', files },
      { ...base, dono: 'org-a', nome: 'warnings', files: WARNINGS.files, truncatedTree: true },
      { ...base, dono: 'org-a', nome: 'empty' },
    ],
  };
}

/** `no-blobs`: só os lotes de conteúdo (`RepoBlobs`) falham. */
type Mode = 'ok' | 'down' | 'no-blobs';

interface Setup {
  service: AgentInstructionsService;
  calls: () => string[];
  statuses: number[];
  clock: { now: number };
  mode: { current: Mode };
  changes: () => Promise<{ type: string; key: string }[]>;
  /** Troca os dados do GitHub falso (um push). */
  push: (files: Record<string, string>) => void;
  /** O cache em memória, para ver o que ficou guardado. */
  store: MemoryCacheStore;
}

function setup({ token = TOKEN as string | (() => Promise<string>), noSource = false } = {}): Setup {
  const clock = { now: T0 };
  const now = () => clock.now;
  let gh = criarGithubFalso(data(), { agora: now });
  const all: string[] = [];
  const statuses: number[] = [];
  const mode = { current: 'ok' as Mode };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (mode.current === 'down') throw new Error('rede fora');
    if (mode.current === 'no-blobs' && String(init?.body ?? '').includes('RepoBlobs')) throw new Error('lote de conteúdo fora');
    const before = gh.chamadas.length;
    const r = await gh.fetch(input, init);
    all.push(...gh.chamadas.slice(before));
    statuses.push(r.status);
    return r;
  }) as typeof globalThis.fetch;
  const transport = new GithubReposSource({ token, fetch, now, url: 'https://fake.invalid/graphql', api: 'https://fake.invalid' });
  const cursor = new CursorDeMudancas({ geracao: 'g', agruparMs: 0, intervaloMinimoMs: 0 });
  const start = cursor.atual;
  const store = new MemoryCacheStore();
  const service = new AgentInstructionsService({
    source: noSource ? null : new RepoFilesSource(transport),
    cache: new GithubCache({ store, now }),
    changes: cursor,
    now,
  });
  return {
    service,
    calls: () => all,
    statuses,
    clock,
    mode,
    changes: async () => (await cursor.aguardar(start, { timeoutMs: 0 })).changes,
    push: (files) => {
      gh = criarGithubFalso(data(files), { agora: now });
    },
    store,
  };
}

async function ready(s: Setup, owner = 'org-a', repo = 'full', refresh = false): Promise<AgentInstructions> {
  await s.service.overview(owner, repo, { refresh });
  await s.service.wait();
  return s.service.overview(owner, repo);
}

describe('#183 the Instructions tab, through the service', () => {
  test('the request does not wait for GitHub: loading first, then ready, and the change is registered', async () => {
    const s = setup();
    const first = await s.service.overview('Org-A', 'Full');
    assert.equal(first.state, 'loading');
    assert.equal(first.readAt, null);
    await s.service.wait();
    const r = await s.service.overview('Org-A', 'Full');
    assert.equal(r.state, 'ready');
    assert.equal(r.repo, 'org-a/full');
    assert.match(r.commit!, /^[0-9a-f]{40}$/);
    assert.equal(r.readAt, new Date(T0).toISOString());
    assert.deepEqual(
      (await s.changes()).map((c) => [c.type, c.key]),
      [['agent-instructions', 'org-a/full']],
    );
  });

  test('the full repository: files with imports, .claude/, MCP, no text and no hook command in the list', async () => {
    const s = setup();
    const r = await ready(s);
    assert.deepEqual(
      r.files.map((f) => [f.path, f.kind]),
      [
        ['AGENTS.md', 'agents-root'],
        ['CLAUDE.md', 'claude-root'],
        ['packages/api/AGENTS.md', 'agents-nested'],
        ['packages/api/CLAUDE.md', 'claude-nested'],
        ['packages/ui/CLAUDE.md', 'claude-nested'],
      ],
    );
    const claude = r.files.find((f) => f.path === 'CLAUDE.md')!;
    assert.deepEqual(
      claude.tree.imports.map((i) => [i.ref, i.status]),
      [
        ['AGENTS.md', 'ok'],
        ['docs/style.md', 'ok'],
        ['~/.claude/personal-preferences.md', 'outside-repo'],
      ],
    );
    assert.deepEqual(claude.tree.imports[1].imports.map((i) => [i.path, i.status]), [['README.md', 'ok']], 'an import outside the known folders, read by path');
    assert.deepEqual(r.rules.find((x) => x.name === 'tests')!.paths, ['test/**', '**/*.test.ts']);
    assert.deepEqual(r.commands.map((c) => c.name), ['/check', '/pr:open']);
    assert.deepEqual(r.hooks, [
      { event: 'PostToolUse', count: 1, matchers: ['Edit|Write'] },
      { event: 'Stop', count: 1, matchers: [] },
    ]);
    assert.deepEqual(r.plugins, [{ name: 'review-kit', marketplace: 'team-tools' }]);
    assert.deepEqual(r.mcp, ['tracker', 'docs']);
    assert.deepEqual(r.warnings, []);
    const json = JSON.stringify(r);
    for (const leak of ['format.sh', 'echo pronto', 'tracker-mcp-sintetico', 'Leia as convenções', TOKEN]) assert.ok(!json.includes(leak), leak);
  });

  test('the warnings repository: truncated, invalid settings, AGENTS.md not imported, missing import', async () => {
    const s = setup();
    const r = await ready(s, 'org-a', 'warnings');
    assert.equal(r.truncated, true);
    assert.equal(r.settings, 'invalid');
    assert.deepEqual(r.warnings, [
      { kind: 'truncated' },
      { kind: 'invalid-settings', path: '.claude/settings.json' },
      { kind: 'agents-not-imported', path: 'AGENTS.md' },
      { kind: 'missing-import', path: 'CLAUDE.md', ref: 'docs/missing-guide.md' },
    ]);
  });

  test('a repository with nothing: empty, and no blob is fetched', async () => {
    const s = setup();
    const r = await ready(s, 'org-a', 'empty');
    assert.equal(r.empty, true);
    assert.deepEqual(r.files, []);
    assert.deepEqual(s.calls(), ['GRAPHQL RepoFilesDiscovery', 'GET /repos/org-a/empty/git/trees/HEAD?recursive=1']);
  });

  test('cache: inside the TTL nothing goes to GitHub; after it the tree answers 304 and the blobs come from the cache by oid', async () => {
    const s = setup();
    await ready(s);
    const firstRead = s.calls().length;
    assert.deepEqual(s.calls().filter((c) => c === 'GRAPHQL RepoFilesDiscovery').length, 1);
    s.clock.now += 61_000;
    await ready(s);
    assert.equal(s.calls().length, firstRead, 'within the 15 min nothing is called');
    s.clock.now += AGENT_INSTRUCTIONS_TTL.discovery;
    const statusesBefore = s.statuses.length;
    const r = await ready(s);
    assert.deepEqual(s.calls().slice(firstRead), ['GRAPHQL RepoFilesDiscovery', 'GET /repos/org-a/full/git/trees/HEAD?recursive=1']);
    assert.ok(s.statuses.slice(statusesBefore).includes(304), 'the tree went with If-None-Match');
    assert.equal(r.files.length, 5);
  });

  test('after a push only the changed file is fetched (blob:<oid> has no TTL)', async () => {
    const s = setup();
    await ready(s);
    s.push({ ...FULL, 'AGENTS.md': '# Convenções\n\nNova regra.\n' });
    s.clock.now += AGENT_INSTRUCTIONS_TTL.discovery + 1;
    const before = s.calls().length;
    const r = await ready(s);
    const after = s.calls().slice(before);
    assert.deepEqual(after.filter((c) => c === 'GRAPHQL RepoBlobs').length, 1);
    assert.equal(r.files.find((f) => f.path === 'AGENTS.md')!.tree.bytes, Buffer.byteLength('# Convenções\n\nNova regra.\n'));
  });

  test('with the whole tree, a missing .md import costs no request; a truncated tree asks by path', async () => {
    const s = setup();
    s.push({ ...FULL, 'CLAUDE.md': '@AGENTS.md\n@docs/nope.md\n' });
    const r = await ready(s);
    assert.deepEqual(r.warnings, [{ kind: 'missing-import', path: 'CLAUDE.md', ref: 'docs/nope.md' }]);
    assert.equal(s.calls().filter((c) => c === 'GRAPHQL RepoBlobs').length, 1, 'only the first batch');
    const t = setup();
    await ready(t, 'org-a', 'warnings');
    assert.equal(t.calls().filter((c) => c === 'GRAPHQL RepoBlobs').length, 2, 'the missing import is asked by path');
  });

  test('GitHub down: the cache is served with its time and the reason; without cache, error', async () => {
    const s = setup();
    const r1 = await ready(s);
    s.mode.current = 'down';
    s.clock.now += AGENT_INSTRUCTIONS_TTL.discovery + 61_000;
    const r2 = await ready(s);
    assert.equal(r2.state, 'ready');
    assert.equal(r2.readAt, r1.readAt);
    assert.match(r2.error!, /rede fora/);
    assert.equal(r2.files.length, 5);
    const fresh = setup();
    fresh.mode.current = 'down';
    const r3 = await ready(fresh);
    assert.equal(r3.state, 'error');
    assert.match(r3.error!, /sem dados/);
  });

  test('without GitHub: no-github, both when switched off and when the gh token is missing', async () => {
    const off = setup({ noSource: true });
    assert.equal((await off.service.overview('org-a', 'full')).state, 'no-github');
    const noToken = setup({ token: async () => Promise.reject(new Error('sem token do GitHub: rode `gh auth login`')) });
    const r = await ready(noToken);
    assert.equal(r.state, 'no-github');
    assert.match(r.error!, /gh auth login/);
  });

  test('a repository that does not exist: not-found', async () => {
    const s = setup();
    assert.equal((await ready(s, 'org-a', 'nope')).state, 'not-found');
  });

  test('the file: text, kind and each found import with its text; any other path is 404', async () => {
    const s = setup();
    await ready(s);
    const f = await s.service.file('org-a', 'full', 'CLAUDE.md');
    assert.equal(f.status, 200);
    const body = f.body as InstructionFileView;
    assert.equal(body.text, FULL['CLAUDE.md']);
    assert.equal(body.kind, 'claude-root');
    assert.equal(body.tree.imports[0].text, FULL['AGENTS.md']);
    assert.equal(body.tree.imports[1].imports[0].text, FULL['README.md']);
    assert.equal(body.tree.imports[2].text, undefined, 'outside the repository: no text');
    for (const other of ['README.md', 'docs/style.md', '.claude/settings.json', 'src/index.ts', 'nope.md']) assert.equal((await s.service.file('org-a', 'full', other)).status, 404, other);
    assert.equal((await s.service.file('org-a', 'full', '../CLAUDE.md')).status, 400);
  });

  test('the file waits for the reading in progress, when the tab opens straight on it', async () => {
    const s = setup();
    const f = await s.service.file('org-a', 'full', 'packages/api/CLAUDE.md');
    assert.equal(f.status, 200);
    assert.equal((f.body as InstructionFileView).tree.imports[0].text, FULL['packages/api/AGENTS.md']);
  });

  test('imports: the 5th hop is fetched and shown; the 6th is too-deep and never fetched', async () => {
    const s = setup();
    const chain: Record<string, string> = { 'CLAUDE.md': '@d1.md\n' };
    for (let k = 1; k <= 6; k++) chain[`d${k}.md`] = `# d${k}\n\n@d${k + 1}.md\n`;
    chain['d7.md'] = '# d7\n';
    s.push(chain);
    await ready(s);
    const f = await s.service.file('org-a', 'full', 'CLAUDE.md');
    let n = (f.body as InstructionFileView).tree;
    for (let k = 1; k <= 5; k++) {
      n = n.imports[0];
      assert.deepEqual([n.path, n.status, n.text], [`d${k}.md`, 'ok', chain[`d${k}.md`]], `hop ${k}`);
    }
    assert.deepEqual([n.imports[0].path, n.imports[0].status, n.imports[0].text], ['d6.md', 'too-deep', undefined]);
    assert.ok(s.store.entries.has(`blob:${blobOid(chain['d5.md'])}`), 'the 5th hop was fetched');
    assert.ok(!s.store.entries.has(`blob:${blobOid(chain['d6.md'])}`), 'the 6th hop was not');
  });

  test('settings.json and .mcp.json imported by a CLAUDE.md: no text on the file route, and the cache keeps only the shape', async () => {
    const s = setup();
    s.push({ ...FULL, 'CLAUDE.md': '# x\n\n@.mcp.json\n@.claude/settings.json\n' });
    const r = await ready(s);
    assert.deepEqual(r.mcp, ['tracker', 'docs']);
    assert.deepEqual(r.plugins, [{ name: 'review-kit', marketplace: 'team-tools' }]);
    assert.deepEqual(r.hooks, [
      { event: 'PostToolUse', count: 1, matchers: ['Edit|Write'] },
      { event: 'Stop', count: 1, matchers: [] },
    ]);
    const f = await s.service.file('org-a', 'full', 'CLAUDE.md');
    assert.equal(f.status, 200);
    const tree = (f.body as InstructionFileView).tree;
    assert.deepEqual(tree.imports.map((i) => [i.path, i.status, i.text, i.bytes]), [
      ['.mcp.json', 'ok', undefined, undefined],
      ['.claude/settings.json', 'ok', undefined, undefined],
    ]);
    const body = JSON.stringify(f.body);
    for (const secret of ['tracker-mcp-sintetico', 'docs.example.invalid', 'format.sh', 'Bash(npm test)', 'exemplo-labs/team-tools']) assert.ok(!body.includes(secret), `the route leaks ${secret}`);
    const cached = JSON.stringify([...s.store.entries]);
    for (const secret of ['tracker-mcp-sintetico', 'docs.example.invalid', 'sh .claude/hooks/format.sh', 'Bash(npm test)', 'exemplo-labs/team-tools']) assert.ok(!cached.includes(secret), `the cache keeps ${secret}`);
    assert.ok(!s.store.entries.has(`blob:${blobOid(FULL['.mcp.json'])}`));
    assert.ok(s.store.entries.has(`config-shape:${blobOid(FULL['.mcp.json'])}`));
  });

  test('a listed file whose text was not read: the node has no bytes, and the file route answers 503', async () => {
    const s = setup();
    s.mode.current = 'no-blobs';
    const r = await ready(s);
    assert.equal(r.state, 'ready');
    assert.match(r.error!, /lote de conteúdo fora/);
    const claude = r.files.find((x) => x.path === 'CLAUDE.md')!;
    assert.equal(claude.tree.status, 'ok');
    assert.equal(claude.tree.bytes, undefined);
    const f = await s.service.file('org-a', 'full', 'CLAUDE.md');
    assert.deepEqual(f, { status: 503, body: { error: 'o texto do arquivo não foi lido' } });
  });

  test('instructions:paths is one value per repository, { commit, located }, replaced when the commit changes', async () => {
    const s = setup();
    s.push({ ...FULL, 'CLAUDE.md': '@notes/team.txt\n', 'notes/team.txt': 'equipe\n' });
    const r1 = await ready(s);
    const key = 'instructions:paths:org-a/full';
    assert.deepEqual(s.store.entries.get(key)?.value, { commit: r1.commit, located: { 'notes/team.txt': blobOid('equipe\n') } });
    s.push({ ...FULL, 'CLAUDE.md': '@notes/team.txt\n', 'notes/team.txt': 'equipe nova\n' });
    s.clock.now += AGENT_INSTRUCTIONS_TTL.discovery + 1;
    const r2 = await ready(s);
    assert.notEqual(r2.commit, r1.commit);
    assert.deepEqual(s.store.entries.get(key)?.value, { commit: r2.commit, located: { 'notes/team.txt': blobOid('equipe nova\n') } });
    assert.deepEqual([...s.store.entries.keys()].filter((k) => k.startsWith('instructions:paths:')), [key], 'no line per commit');
  });

  test('the calls share the GitHub queue with the repositories: never two at once', async () => {
    const queue = new GithubCallQueue();
    let inFlight = 0;
    let max = 0;
    const gh = criarGithubFalso(data());
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await gh.fetch(input, init);
      } finally {
        inFlight--;
      }
    }) as typeof globalThis.fetch;
    const make = () => new AgentInstructionsService({ source: new RepoFilesSource(new GithubReposSource({ token: TOKEN, fetch, url: 'https://fake.invalid/graphql', api: 'https://fake.invalid' })), queue });
    const a = make();
    const b = make();
    await Promise.all([a.overview('org-a', 'full'), b.overview('org-a', 'warnings')]);
    await Promise.all([a.wait(), b.wait()]);
    assert.equal(max, 1);
  });
});

describe('#183 the /api/agent-instructions route', () => {
  let api: ApiLocal;
  let s: Setup;
  before(async () => {
    s = setup();
    const storage = openSqliteStorage({ path: ':memory:' });
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, agentInstructions: createAgentInstructionsRoute(s.service) });
  });
  after(() => api.close());

  const get = async (path: string) => {
    const r = await fetch(`${api.url}${path}`);
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  test('GET the list and the file answer 200 with the contract, and never the token', async () => {
    await get('/api/agent-instructions/org-a/full');
    await s.service.wait();
    const list = await get('/api/agent-instructions/org-a/full');
    assert.equal(list.status, 200);
    assert.equal(list.body.state, 'ready');
    for (const key of ['repo', 'commit', 'readAt', 'truncated', 'empty', 'files', 'rules', 'skills', 'agents', 'commands', 'hooks', 'plugins', 'marketplaces', 'mcp', 'settings', 'warnings']) assert.ok(key in list.body, key);
    assert.ok(!list.text.includes('"text"'), 'no file text in the list');
    assert.ok(!list.text.includes('"command"') && !list.text.includes('format.sh'), 'no hook command');
    const file = await get('/api/agent-instructions/org-a/full/file?path=CLAUDE.md');
    assert.equal(file.status, 200);
    assert.equal(file.body.text, FULL['CLAUDE.md']);
    for (const r of [list, file]) assert.ok(!r.text.includes(TOKEN));
  });

  test('a path that is not a listed instruction file is 404; no path, a bad path or a bad owner is 400', async () => {
    await s.service.wait();
    assert.equal((await get('/api/agent-instructions/org-a/full/file?path=README.md')).status, 404);
    assert.equal((await get('/api/agent-instructions/org-a/full/file?path=.claude%2Fsettings.json')).status, 404);
    assert.equal((await get('/api/agent-instructions/org-a/full/file')).status, 400);
    assert.equal((await get('/api/agent-instructions/org-a/full/file?path=..%2F..%2Fetc%2Fpasswd')).status, 400);
    const bad = await get('/api/agent-instructions/-org/full');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error as string, /repositório inválido/);
    assert.equal((await get('/api/agent-instructions/org-a/full/other')).status, 404);
    assert.equal((await get('/api/agent-instructions/org-a')).status, 404);
  });

  test('?refresh=1 reads GitHub again, but keeps the 30 s minimum between forced reads', async () => {
    await s.service.wait();
    const discoveries = () => s.calls().filter((c) => c === 'GRAPHQL RepoFilesDiscovery').length;
    const before = discoveries();
    s.clock.now += 10_000;
    await get('/api/agent-instructions/org-a/full?refresh=1');
    await s.service.wait();
    assert.equal(discoveries(), before, 'read again before 30 s');
    s.clock.now += 21_000;
    await get('/api/agent-instructions/org-a/full?refresh=1');
    await s.service.wait();
    assert.equal(discoveries(), before + 1);
  });

  test('only GET', async () => {
    const r = await fetch(`${api.url}/api/agent-instructions/org-a/full`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 405);
  });
});

describe('#183 the service as the core mounts it', () => {
  test('createCoreAgentInstructions({ demo: true }) calls no fetch outside the fake GitHub, and the demo repositories cover the tab', async () => {
    const original = globalThis.fetch;
    const outside: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      outside.push(String(input));
      throw new Error('real fetch in the demo');
    }) as typeof fetch;
    try {
      const { service } = createCoreAgentInstructions({ demo: true, noGithub: false, cache: new GithubCache({ store: new MemoryCacheStore() }), changes: new CursorDeMudancas(), queue: new GithubCallQueue() });
      const read = async (full: string) => {
        const [o, r] = full.split('/');
        await service.overview(o, r);
        await service.wait();
        return service.overview(o, r);
      };
      const complete = await read('exemplo-labs/vitrine-demo');
      assert.equal(complete.state, 'ready');
      assert.ok(complete.files.length >= 3 && complete.skills.length && complete.agents.length && complete.commands.length && complete.hooks.length && complete.plugins.length && complete.mcp.length);
      assert.deepEqual(complete.warnings, []);
      assert.deepEqual((await read('exemplo-labs/motor-de-regras')).warnings.map((w) => w.kind), ['truncated', 'invalid-settings', 'agents-not-imported', 'missing-import']);
      assert.equal((await read('dev-sintetico/blog-estatico')).empty, true);
      assert.ok(DADOS_DA_DEMO.repos.some((r) => `${r.dono}/${r.nome}` === 'dev-sintetico/blog-estatico'), 'the empty case is a repository of the Repositories screen');
      assert.deepEqual(outside, []);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('createCoreAgentInstructions({ noGithub: true }) answers no-github', async () => {
    const { service } = createCoreAgentInstructions({ demo: false, noGithub: true, cache: new GithubCache({ store: new MemoryCacheStore() }), changes: new CursorDeMudancas(), queue: new GithubCallQueue() });
    assert.equal((await service.overview('org-a', 'full')).state, 'no-github');
  });
});
