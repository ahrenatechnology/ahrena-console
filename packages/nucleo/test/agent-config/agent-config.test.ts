// The Agent Config screen (#63). Reading: only names, paths and counts leave the configuration
// folders; no env, oauth, e-mail, command or URL value. The routes through the local API: the skill
// read and written with backup, and each write defense (origin and Host from decision 0003,
// Content-Type, name, root, symlink, version). Everything in `mkdtemp` folders. A single file: each
// test file is one more process running alongside the forwarder's short-timing tests.
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, createAgentConfigRoute, iniciarApiLocal, MAX_SKILL_BODY, MontadorDoPainel, TrabalhoPorBranch, type ApiLocal, type AgentConfigRoute } from '../../src/api/index.ts';
import { AgentConfigError, chooseProject, readAgentConfig, readFrontmatter, MAX_CONTENT, mountDemoAgentConfig, autoMemoryDir, knownProjects, skillRoot, versionOf } from '../../src/agent-config/index.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { pastaDeConfiguracao } from '../../src/perfis/descoberta.ts';
import { session } from '../fixtures.ts';

const temporaries: string[] = [];
after(() => temporaries.forEach((t) => rmSync(t, { recursive: true, force: true })));
const tmp = () => {
  const t = mkdtempSync(join(tmpdir(), 'agent-config-read-'));
  temporaries.push(t);
  return t;
};
const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

// Values that must never leave in the response.
const SECRETS = ['segredo-do-env-123', 'pessoa@exemplo.com', 'token-oauth-xyz', 'echo comando-secreto', 'https://mcp.exemplo.com/segredo', 'valor-de-settings'];

function mountHome(home: string, project: string) {
  const u = join(home, '.claude');
  write(join(u, 'skills', 'revisar-pr', 'SKILL.md'), '---\nname: revisar-pr\ndescription: >\n  Revisa um PR\n  contra o guia\n---\ncorpo\n');
  write(join(u, 'skills', 'Maiuscula', 'SKILL.md'), '---\nname: "Outra Coisa"\n---\n');
  write(join(u, 'skills', 'sem-skill-md', 'LEIAME.md'), 'nada');
  write(join(u, 'agents', 'revisor.md'), "---\nname: revisor\ndescription: 'Revisa código'\ntools: [Read]\n---\n");
  write(join(u, 'agents', 'sem-frontmatter.md'), 'texto');
  write(join(u, 'commands', 'resumo.md'), 'x');
  write(join(u, 'commands', 'git', 'limpar.md'), 'x');
  write(join(u, 'CLAUDE.md'), 'Memória que não pode sair: valor-de-settings');
  write(join(u, '.credentials.json'), JSON.stringify({ token: 'token-oauth-xyz' }));
  write(
    join(u, 'settings.json'),
    JSON.stringify({
      env: { CHAVE: 'valor-de-settings' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo comando-secreto' }, { type: 'command', command: 'echo comando-secreto' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo comando-secreto' }] }],
      },
      enabledPlugins: { 'ligado@mercado': true, 'desligado@mercado': false },
    }),
  );
  write(join(u, 'settings.local.json'), '{ quebrado');
  write(
    join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'pessoa@exemplo.com', accountUuid: '00000000-0000-0000-0000-000000000001', organizationUuid: '00000000-0000-0000-0000-000000000002' },
      userID: 'token-oauth-xyz',
      mcpServers: {
        docs: { type: 'http', url: 'https://mcp.exemplo.com/segredo', headers: { Authorization: 'token-oauth-xyz' } },
        local: { command: 'echo comando-secreto', args: ['segredo-do-env-123'], env: { CHAVE: 'segredo-do-env-123' } },
      },
      projects: { [project]: { mcpServers: { banco: { env: { SENHA: 'segredo-do-env-123' } } }, allowedTools: ['valor-de-settings'] } },
    }),
  );
  write(join(autoMemoryDir(u, project), 'MEMORY.md'), 'conteúdo da memória: valor-de-settings');
  return pastaDeConfiguracao(u, 'padrao', home);
}

function mountProject(project: string) {
  const p = join(project, '.claude');
  write(join(p, 'skills', 'abrir-issue', 'SKILL.md'), '---\nname: abrir-issue\ndescription: Abre uma issue\n---\n');
  write(join(p, 'agents', 'regras.md'), '---\nname: regras\n---\n');
  write(join(p, 'commands', 'publicar.md'), 'x');
  write(join(p, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'echo comando-secreto' }] }] }, enabledPlugins: { 'proj@mercado': true } }));
  write(join(p, 'CLAUDE.md'), 'x');
  write(join(project, 'CLAUDE.local.md'), 'x');
  write(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { tickets: { command: 'echo comando-secreto', env: { K: 'segredo-do-env-123' } } } }));
}

describe('#63 minimal frontmatter', () => {
  test('plain key, quotes, folded, literal and indented continuation', () => {
    const fm = readFrontmatter("---\nname: a\ndescription: >-\n  linha um\n  linha dois\nb: 'com ''aspas'''\nc: |\n  x\n  y\nd: começo\n  e fim\nlista:\n  - um\n---\ncorpo: não\n");
    assert.equal(fm.name, 'a');
    assert.equal(fm.description, 'linha um linha dois');
    assert.equal(fm.b, "com 'aspas'");
    assert.equal(fm.c, 'x\ny');
    assert.equal(fm.d, 'começo e fim');
    assert.equal(fm.lista, undefined);
    assert.equal(fm.corpo, undefined);
    assert.deepEqual(readFrontmatter('sem frontmatter'), {});
    assert.deepEqual(readFrontmatter('---\nname: sem fim\n'), {});
  });
});

describe('#63 GET /api/agent-config: reading', () => {
  test('reads the lists and the summary, without any env, oauth, e-mail, command or URL value', async () => {
    const home = tmp();
    const project = join(home, 'proj');
    const folder = mountHome(home, project);
    mountProject(project);
    const r = await readAgentConfig({ folders: [folder], projects: [project] });

    assert.equal(r.project, project);
    assert.deepEqual(r.projects, [project]);
    assert.equal(r.editing, true);
    assert.deepEqual(
      r.roots.map((x) => [x.id, x.kind, x.scope, x.label]),
      [
        ['u0', 'home', 'user', 'Claude home'],
        ['c0', 'claude-json', 'user', '.claude.json'],
        ['p', 'project-claude', 'project', '.claude do projeto'],
        ['r', 'project', 'project', 'Projeto · proj'],
      ],
    );
    const review = r.skills.find((s) => s.name === 'revisar-pr')!;
    assert.equal(review.description, 'Revisa um PR contra o guia');
    assert.equal(review.root, 'u0');
    assert.equal(review.scope, 'user');
    assert.equal(review.editable, true);
    assert.ok(review.editedAt > 0);
    const uppercase = r.skills.find((s) => s.name === 'Maiuscula')!;
    assert.equal(uppercase.editable, false);
    assert.equal(uppercase.declaredName, 'Outra Coisa');
    assert.deepEqual(r.skills.map((s) => [s.name, s.root]).sort(), [['Maiuscula', 'u0'], ['abrir-issue', 'p'], ['revisar-pr', 'u0']]);

    assert.deepEqual(r.subagents.map((s) => [s.name, s.description, s.scope]), [['revisor', 'Revisa código', 'user'], ['sem-frontmatter', null, 'user'], ['regras', null, 'project']]);
    assert.deepEqual(r.commands.map((c) => [c.name, c.scope]), [['git:limpar', 'user'], ['resumo', 'user'], ['publicar', 'project']]);
    assert.deepEqual(
      r.memory.map((m) => [m.name, m.scope, m.kind]),
      [['CLAUDE.md', 'user', 'instructions'], ['MEMORY.md', 'project', 'auto'], ['CLAUDE.local.md', 'project', 'instructions'], [join('.claude', 'CLAUDE.md'), 'project', 'instructions']],
    );
    assert.deepEqual(r.hooks, [
      { event: 'PreToolUse', count: 2, scope: 'user' },
      { event: 'Stop', count: 1, scope: 'user' },
      { event: 'PreToolUse', count: 1, scope: 'project' },
    ]);
    assert.deepEqual(r.plugins, [{ name: 'ligado@mercado', scope: 'user' }, { name: 'proj@mercado', scope: 'project' }]);
    assert.deepEqual(r.mcp, [
      { name: 'docs', scope: 'user', source: '.claude.json' },
      { name: 'local', scope: 'user', source: '.claude.json' },
      { name: 'banco', scope: 'project', source: '.claude.json' },
      { name: 'tickets', scope: 'project', source: '.mcp.json' },
    ]);
    // The broken settings.local.json shows up as a file, without bringing anything down.
    assert.deepEqual(r.settings.map((c) => [c.file, c.scope]), [['settings.json', 'user'], ['settings.local.json', 'user'], ['settings.json', 'project'], ['.claude.json', 'user']]);
    assert.deepEqual(r.summary.hooks, { total: 4, user: 3, project: 1 });
    assert.deepEqual(r.summary.skills, { total: 3, user: 2, project: 1 });
    assert.deepEqual(r.summary.mcp, { total: 4, user: 2, project: 2 });

    const json = JSON.stringify(r);
    for (const s of SECRETS) assert.ok(!json.includes(s), `leaked: ${s}`);
    assert.ok(!json.includes('credentials'), '.credentials.json does not even show up');
    assert.ok(!json.includes('oauthAccount') && !json.includes('emailAddress'));
  });

  test('two user folders (profiles) give two user roots, with the folder name in the label', async () => {
    const home = tmp();
    const a = mountHome(home, '/nao/existe');
    const b = pastaDeConfiguracao(join(home, '.claude-cliente'), 'nome', home);
    write(join(b.dir, 'skills', 'do-cliente', 'SKILL.md'), '---\ndescription: só do cliente\n---\n');
    write(b.claudeJson, JSON.stringify({ mcpServers: { cliente: {} } }));
    const r = await readAgentConfig({ folders: [a, b], projects: [] });
    assert.equal(r.project, null);
    assert.deepEqual(
      r.roots.map((x) => [x.id, x.label, x.path]),
      [
        ['u0', 'Claude home · .claude', a.dir],
        ['c0', '.claude.json · .claude', a.claudeJson],
        ['u1', 'Claude home · .claude-cliente', b.dir],
        ['c1', '.claude.json · .claude-cliente', b.claudeJson],
      ],
    );
    assert.equal(r.skills.find((s) => s.name === 'do-cliente')?.root, 'u1');
    assert.ok(r.mcp.some((m) => m.name === 'cliente' && m.scope === 'user'));
    assert.equal(r.summary.skills.project, 0);
  });

  test("the request's project only counts if it is a known one; without it, the most recent", () => {
    assert.equal(chooseProject(null, ['/a', '/b']), '/a');
    assert.equal(chooseProject('/b', ['/a', '/b']), '/b');
    assert.equal(chooseProject(undefined, []), null);
    assert.throws(() => chooseProject('/etc', ['/a']), (e) => e instanceof AgentConfigError && e.status === 400);
  });

  test('a skill symlink is listed (frontmatter read only), without bringing the response down', async () => {
    const home = tmp();
    const outside = tmp();
    write(join(outside, 'alvo', 'SKILL.md'), '---\nname: alvo\n---\n');
    const folder = pastaDeConfiguracao(join(home, '.claude'), 'padrao', home);
    mkdirSync(join(folder.dir, 'skills'), { recursive: true });
    symlinkSync(join(outside, 'alvo'), join(folder.dir, 'skills', 'link'));
    const r = await readAgentConfig({ folders: [folder], projects: [] });
    assert.deepEqual(r.skills.map((s) => [s.name, s.editable]), [['link', false]]);
  });

  test('SKILL.md and agents/*.md as symlinks to another file in the root: listed, nothing read from the target', async () => {
    const home = tmp();
    const folder = pastaDeConfiguracao(join(home, '.claude'), 'padrao', home);
    // Fictitious content that looks like frontmatter: if the target were read, it would show in `description`.
    write(join(folder.dir, '.credentials.json'), '---\nname: seg\ndescription: segredo-ficticio-abc\n---\n');
    mkdirSync(join(folder.dir, 'skills', 'seg'), { recursive: true });
    symlinkSync(join(folder.dir, '.credentials.json'), join(folder.dir, 'skills', 'seg', 'SKILL.md'));
    mkdirSync(join(folder.dir, 'agents'));
    symlinkSync(join(folder.dir, '.credentials.json'), join(folder.dir, 'agents', 'seg.md'));
    const r = await readAgentConfig({ folders: [folder], projects: [] });
    assert.deepEqual(r.skills.map((s) => [s.name, s.description, s.declaredName, s.editable]), [['seg', null, null, false]]);
    assert.deepEqual(r.subagents.map((s) => [s.name, s.description]), [['seg', null]]);
    assert.ok(!JSON.stringify(r).includes('segredo-ficticio-abc'));
  });

  test('SKILL.md as a hardlink to .credentials.json: listed, nothing read from the target', async () => {
    const home = tmp();
    const folder = pastaDeConfiguracao(join(home, '.claude'), 'padrao', home);
    write(join(folder.dir, '.credentials.json'), '---\nname: duro\ndescription: segredo-ficticio-abc\n---\n');
    mkdirSync(join(folder.dir, 'skills', 'duro'), { recursive: true });
    linkSync(join(folder.dir, '.credentials.json'), join(folder.dir, 'skills', 'duro', 'SKILL.md'));
    const r = await readAgentConfig({ folders: [folder], projects: [] });
    assert.deepEqual(r.skills.map((s) => [s.name, s.description, s.editable]), [['duro', null, false]]);
    assert.ok(!JSON.stringify(r).includes('segredo-ficticio-abc'));
  });

  test('project = the parent folder of a home ($HOME): no p root, nothing doubled as project', async () => {
    const t = tmp();
    const folder = mountHome(t, t);
    const r = await readAgentConfig({ folders: [folder], projects: [t] });
    assert.equal(r.project, t);
    assert.deepEqual(r.roots.map((x) => x.id), ['u0', 'c0', 'r']);
    assert.deepEqual(r.skills.map((s) => [s.name, s.root]).sort(), [['Maiuscula', 'u0'], ['revisar-pr', 'u0']]);
    assert.ok(r.subagents.every((s) => s.scope === 'user'));
    assert.equal(r.summary.skills.project, 0);
    assert.equal(r.summary.hooks.project, 0);
    assert.deepEqual(r.memory.filter((m) => m.name.endsWith('CLAUDE.md')).map((m) => [m.name, m.scope]), [['CLAUDE.md', 'user']]);
    // The `p` root does not exist: writing to it is 400 (never lands in the home).
    assert.throws(() => skillRoot('p', r.roots), (e) => e instanceof AgentConfigError && e.status === 400);
  });
});

describe('#63 known projects', () => {
  test("the sessions' cwd, most recent first, no repeats, only folders that exist", async () => {
    const t = tmp();
    const [a, b] = [join(t, 'a'), join(t, 'b')];
    mkdirSync(a);
    mkdirSync(b);
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 's1', cwd: a, updatedAt: '2026-10-01T00:00:00.000Z' }));
    await storage.putSession(session({ id: 's2', cwd: b, updatedAt: '2026-10-03T00:00:00.000Z' }));
    await storage.putSession(session({ id: 's3', cwd: a, updatedAt: '2026-10-02T00:00:00.000Z' }));
    await storage.putSession(session({ id: 's4', cwd: join(t, 'sumiu'), updatedAt: '2026-10-04T00:00:00.000Z' }));
    await storage.putSession(session({ id: 's5', cwd: 'relativo', updatedAt: '2026-10-05T00:00:00.000Z' }));
    assert.deepEqual(await knownProjects(storage), [b, a]);
    assert.deepEqual(await knownProjects(storage, 1), [b]);
    await storage.close();
  });
});

describe('#63 the --demo folder', () => {
  test("has the wireframe's four skills, the synthetic project and nothing outside the temporary folder", async () => {
    const demo = mountDemoAgentConfig(tmp());
    try {
      const r = await readAgentConfig({ folders: demo.folders, projects: [demo.project] });
      assert.equal(r.project, demo.project);
      assert.match(r.project!, /motor-de-regras$/);
      assert.deepEqual(r.skills.map((s) => [s.name, s.scope]).sort(), [['abrir-issue', 'project'], ['migracao-segura', 'project'], ['revisar-pr', 'user'], ['rodar-bateria', 'user']]);
      assert.equal(r.skills.find((s) => s.name === 'revisar-pr')?.description, 'Revisa um PR contra o guia de estilo do projeto');
      assert.ok(r.subagents.length >= 2 && r.commands.length >= 2 && r.memory.length >= 2);
      assert.ok(r.hooks.length > 0 && r.plugins.length > 0 && r.mcp.some((m) => m.source === '.mcp.json'));
      for (const x of r.roots) assert.ok(x.path.startsWith(demo.root), x.path);
    } finally {
      demo.remove();
    }
  });
});

interface Reply {
  status: number;
  body: string;
  json: Record<string, unknown>;
}

function get(url: string, path: string, { method = 'GET', headers = {} as Record<string, string>, body = '' } = {}): Promise<Reply> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (text += p));
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, body: text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A local API with only the given agent config route, for the cases that need other folders. */
async function withApi(route: AgentConfigRoute, fn: (url: string) => Promise<void>): Promise<void> {
  const s = openSqliteStorage({ path: ':memory:' });
  const builder = new MontadorDoPainel({ storage: s, contas: new Contas({ storage: s, arquivo: null }), desktop: null, trabalho: new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(s.db) }) }) });
  const a = await iniciarApiLocal({ montador: builder, hooks: { storage: s }, port: 0, log: () => {}, agentConfig: route });
  try {
    await fn(a.url);
  } finally {
    await a.close();
    await s.close();
  }
}

/**
 * A POST with the body in chunks, never ending: resolves with the response status, which only
 * arrives if the server answers without waiting for the end of the body.
 */
function postWithoutEnd(url: string, chunk: Buffer, times: number): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: '/api/agent-config/skill', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on('error', () => {});
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('no response: the server waited for the whole body'));
    }, 5000);
    req.on('response', () => clearTimeout(timeout));
    for (let i = 0; i < times; i++) req.write(chunk);
  });
}

describe('#63 /api/agent-config and /api/agent-config/skill', () => {
  let sqlite: SqliteStorage;
  let api: ApiLocal;
  let host: string;
  let t: string;
  let outside: string;
  let project: string;
  let backups: string;
  let home: ReturnType<typeof pastaDeConfiguracao>;
  const json = { 'content-type': 'application/json' };
  const post = (body: unknown, headers: Record<string, string> = json) => get(api.url, '/api/agent-config/skill', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  before(async () => {
    t = mkdtempSync(join(tmpdir(), 'agent-config-http-'));
    outside = mkdtempSync(join(tmpdir(), 'agent-config-outside-'));
    home = pastaDeConfiguracao(join(t, '.claude'), 'padrao', t);
    project = join(t, 'proj');
    backups = join(t, 'backups');
    write(join(home.dir, 'skills', 'revisar-pr', 'SKILL.md'), '---\nname: revisar-pr\ndescription: Revisa\n---\nversão antiga\n');
    write(home.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'pessoa@exemplo.com' }, mcpServers: { docs: { env: { K: 'segredo-do-env-123' } } } }));
    mkdirSync(project);
    // Symlinks out of the root: the skill folder and SKILL.md.
    write(join(outside, 'alvo', 'SKILL.md'), 'de fora');
    symlinkSync(join(outside, 'alvo'), join(home.dir, 'skills', 'link-pasta'));
    mkdirSync(join(home.dir, 'skills', 'link-arquivo'));
    symlinkSync(join(outside, 'alvo', 'SKILL.md'), join(home.dir, 'skills', 'link-arquivo', 'SKILL.md'));
    // Symlink inside the root: SKILL.md pointing at the home's `.credentials.json`.
    write(join(home.dir, '.credentials.json'), '{"token":"segredo-ficticio-abc"}');
    mkdirSync(join(home.dir, 'skills', 'seg'));
    symlinkSync(join(home.dir, '.credentials.json'), join(home.dir, 'skills', 'seg', 'SKILL.md'));
    // Hardlink: passes `lstat` and `realpath`; only `nlink` gives it away.
    mkdirSync(join(home.dir, 'skills', 'duro'));
    linkSync(join(home.dir, '.credentials.json'), join(home.dir, 'skills', 'duro', 'SKILL.md'));

    sqlite = openSqliteStorage({ path: ':memory:' });
    const work = new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db) }) });
    const builder = new MontadorDoPainel({ storage: sqlite, contas: new Contas({ storage: sqlite, arquivo: null }), desktop: null, trabalho: work });
    const agentConfig = createAgentConfigRoute({ folders: async () => [home], projects: async () => [project], backups, now: () => new Date('2026-10-20T12:34:56.789Z') });
    api = await iniciarApiLocal({ montador: builder, hooks: { storage: sqlite }, port: 0, log: () => {}, agentConfig });
    host = new URL(api.url).host;
  });
  after(async () => {
    await api.close();
    await sqlite.close();
    rmSync(t, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('GET /api/agent-config: the contract, no secrets; /ui itself can read; an unknown project gives 400', async () => {
    const r = await get(api.url, '/api/agent-config', { headers: { origin: `http://${host}` } });
    assert.equal(r.status, 200);
    assert.equal(r.json.project, project);
    assert.deepEqual(r.json.projects, [project]);
    assert.equal(r.json.editing, true);
    assert.equal(r.json.backups, backups, "the backups folder, for the screen's Backups button");
    for (const key of ['roots', 'summary', 'skills', 'subagents', 'commands', 'memory', 'mcp', 'plugins', 'hooks', 'settings']) assert.ok(key in r.json, key);
    assert.ok(!r.body.includes('segredo-do-env-123') && !r.body.includes('pessoa@exemplo.com'));
    assert.equal((await get(api.url, `/api/agent-config?project=${encodeURIComponent(project)}`)).status, 200);
    assert.equal((await get(api.url, '/api/agent-config?project=%2Fetc')).status, 400);
    assert.equal((await get(api.url, '/api/agent-config', { method: 'POST', headers: json })).status, 405);
    assert.equal((await get(api.url, '/api/agent-config', { headers: { origin: 'https://exemplo.com' } })).status, 403);
  });

  test('skill GET: content and version; 404 if missing; 400 with an invalid name or root', async () => {
    const r = await get(api.url, '/api/agent-config/skill?root=u0&name=revisar-pr');
    assert.equal(r.status, 200);
    assert.equal(r.json.content, '---\nname: revisar-pr\ndescription: Revisa\n---\nversão antiga\n');
    assert.equal(r.json.version, versionOf(r.json.content as string));
    assert.equal(r.json.scope, 'user');
    assert.equal(r.json.root, 'u0');
    assert.equal(r.json.name, 'revisar-pr');
    assert.ok((r.json.editedAt as number) > 0);
    assert.equal((await get(api.url, '/api/agent-config/skill?root=u0&name=nao-existe')).status, 404);
    assert.equal((await get(api.url, '/api/agent-config/skill?root=p&name=nao-existe')).status, 404);
    assert.equal((await get(api.url, '/api/agent-config/skill?root=u0&name=..')).status, 400);
    assert.equal((await get(api.url, '/api/agent-config/skill?root=c0&name=revisar-pr')).status, 400);
    assert.equal((await get(api.url, `/api/agent-config/skill?root=${encodeURIComponent(home.dir)}&name=revisar-pr`)).status, 400);
    assert.equal((await get(api.url, '/api/agent-config/skill?root=u0&name=link-pasta')).status, 403);
    assert.equal((await get(api.url, '/api/agent-config/skill?root=u0&name=link-arquivo')).status, 403);
  });

  test('GET of a skill whose SKILL.md is a symlink inside the root (the .credentials.json): 403, without the secret', async () => {
    const r = await get(api.url, '/api/agent-config/skill?root=u0&name=seg');
    assert.equal(r.status, 403, r.body);
    assert.ok(!r.body.includes('segredo-ficticio-abc'));
    const list = await get(api.url, '/api/agent-config');
    assert.ok(!list.body.includes('segredo-ficticio-abc'));
    assert.equal((list.json.skills as { name: string; editable: boolean }[]).find((s) => s.name === 'seg')?.editable, false);
    assert.equal((await post({ root: 'u0', name: 'seg', content: 'invadiu' })).status, 403);
    assert.equal(readFileSync(join(home.dir, '.credentials.json'), 'utf8'), '{"token":"segredo-ficticio-abc"}');
  });

  test('GET, listing and POST of a SKILL.md that is a hardlink to .credentials.json: 403, without the secret', async () => {
    const r = await get(api.url, '/api/agent-config/skill?root=u0&name=duro');
    assert.equal(r.status, 403, r.body);
    assert.match(String(r.json.error), /hardlink/);
    assert.ok(!r.body.includes('segredo-ficticio-abc'));
    const list = await get(api.url, '/api/agent-config');
    assert.ok(!list.body.includes('segredo-ficticio-abc'));
    assert.equal((list.json.skills as { name: string; editable: boolean }[]).find((s) => s.name === 'duro')?.editable, false);
    assert.equal((await post({ root: 'u0', name: 'duro', content: 'invadiu' })).status, 403);
    assert.equal(readFileSync(join(home.dir, '.credentials.json'), 'utf8'), '{"token":"segredo-ficticio-abc"}');
  });

  test('POST replaces the skill: backup with the old content first, atomic write, new version', async () => {
    const before = await get(api.url, '/api/agent-config/skill?root=u0&name=revisar-pr');
    const r = await post({ root: 'u0', name: 'revisar-pr', content: 'versão nova\n', version: before.json.version });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.path, join(home.dir, 'skills', 'revisar-pr', 'SKILL.md'));
    assert.equal(r.json.version, versionOf('versão nova\n'));
    assert.equal(readFileSync(r.json.path as string, 'utf8'), 'versão nova\n');
    const backup = r.json.backup as string;
    assert.ok(backup.startsWith(join(backups, '2026-10-20') + '/'), backup);
    assert.match(backup, /\/revisar-pr\/SKILL\.md\.bak-2026-10-20T12-34-56-789Z-[0-9a-f]{6}$/);
    assert.equal(readFileSync(backup, 'utf8'), before.json.content);
    // No temporary file left behind.
    assert.deepEqual(readdirSync(join(home.dir, 'skills', 'revisar-pr')), ['SKILL.md']);
  });

  test('POST with a version that does not match gives 409 and does not write', async () => {
    const r = await post({ root: 'u0', name: 'revisar-pr', content: 'por cima', version: versionOf('outra coisa') });
    assert.equal(r.status, 409);
    assert.notEqual(readFileSync(join(home.dir, 'skills', 'revisar-pr', 'SKILL.md'), 'utf8'), 'por cima');
    assert.equal((await post({ root: 'u0', name: 'nao-existe-ainda', content: 'x', version: versionOf('x') })).status, 409);
    assert.ok(!existsSync(join(home.dir, 'skills', 'nao-existe-ainda', 'SKILL.md')));
  });

  test('POST of a new skill creates skills/<name>/SKILL.md, without backup; in the project, creates .claude', async () => {
    const r = await post({ root: 'u0', name: 'nova-skill', content: '---\nname: nova-skill\n---\n' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.backup, null);
    assert.equal(readFileSync(join(home.dir, 'skills', 'nova-skill', 'SKILL.md'), 'utf8'), '---\nname: nova-skill\n---\n');
    const p = await post({ root: 'p', name: 'do-projeto', content: 'oi', project });
    assert.equal(p.status, 200, p.body);
    assert.equal(readFileSync(join(project, '.claude', 'skills', 'do-projeto', 'SKILL.md'), 'utf8'), 'oi');
    const list = await get(api.url, '/api/agent-config');
    assert.ok((list.json.skills as { name: string; root: string }[]).some((s) => s.name === 'do-projeto' && s.root === 'p'));
  });

  test("POST with create: true only creates; if the skill exists, 409 and nothing changes (the screen's \"Nova\")", async () => {
    const created = await post({ root: 'u0', name: 'so-cria', content: 'um', create: true });
    assert.equal(created.status, 200, created.body);
    assert.equal(created.json.backup, null);
    const again = await post({ root: 'u0', name: 'so-cria', content: 'dois', create: true });
    assert.equal(again.status, 409, again.body);
    assert.equal(readFileSync(join(home.dir, 'skills', 'so-cria', 'SKILL.md'), 'utf8'), 'um');
  });

  test('two concurrent "Nova" with the same name: one creates, the other gives 409; the file is the winner\'s', async () => {
    const [a, b] = await Promise.all([
      post({ root: 'u0', name: 'corrida', content: 'aba A', create: true }),
      post({ root: 'u0', name: 'corrida', content: 'aba B', create: true }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const winner = a.status === 200 ? 'aba A' : 'aba B';
    assert.equal(readFileSync(join(home.dir, 'skills', 'corrida', 'SKILL.md'), 'utf8'), winner);
    assert.equal((a.status === 200 ? a : b).json.backup, null);
    assert.deepEqual(readdirSync(join(home.dir, 'skills', 'corrida')), ['SKILL.md']);
  });

  test('/ui itself writes (Origin equal to http://<Host>); another site\'s Origin and a foreign Host give 403', async () => {
    const ok = await post({ root: 'u0', name: 'pela-ui', content: 'x' }, { ...json, origin: `http://${host}` });
    assert.equal(ok.status, 200, ok.body);
    for (const origin of ['https://exemplo.com', 'null', `https://${host}`, 'http://localhost:1']) {
      assert.equal((await post({ root: 'u0', name: 'de-fora', content: 'x' }, { ...json, origin })).status, 403, origin);
    }
    const port = new URL(api.url).port;
    assert.equal((await post({ root: 'u0', name: 'de-fora', content: 'x' }, { ...json, host: `exemplo.com:${port}` })).status, 403);
    assert.equal((await post({ root: 'u0', name: 'de-fora', content: 'x' }, { ...json, host: `exemplo.com:${port}`, origin: `http://exemplo.com:${port}` })).status, 403);
    assert.ok(!existsSync(join(home.dir, 'skills', 'de-fora')));
    // `localhost` is our Host too: with it, only the Origin `http://localhost:<port>` passes.
    const local = await post({ root: 'u0', name: 'pelo-localhost', content: 'x' }, { ...json, host: `localhost:${port}`, origin: `http://localhost:${port}` });
    assert.equal(local.status, 200, local.body);
    assert.equal((await post({ root: 'u0', name: 'de-fora', content: 'x' }, { ...json, host: `localhost:${port}`, origin: `http://127.0.0.1:${port}` })).status, 403);
    assert.ok(!existsSync(join(home.dir, 'skills', 'de-fora')));
    // The exception is only for this route: another write with Origin is still refused.
    assert.equal((await get(api.url, '/api/hooks', { method: 'POST', headers: { ...json, origin: `http://${host}` }, body: '{}' })).status, 403);
  });

  test('write defenses: JSON required, name, root, symlink, size', async () => {
    assert.equal((await post({ root: 'u0', name: 'x', content: 'x' }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post({ root: 'u0', name: 'x', content: 'x' }, {})).status, 415);
    assert.equal((await post('não é json')).status, 400);
    assert.equal((await post('[]')).status, 400);
    for (const name of ['..', 'a..b', 'x/../../evil', '../evil', 'SKILL.md/x', 'Maiuscula', '', '-comeca-com-hifen', 'a'.repeat(65), 7]) {
      assert.equal((await post({ root: 'u0', name, content: 'x' })).status, 400, String(name));
    }
    assert.ok(!existsSync(join(t, 'evil')) && !existsSync(join(home.dir, 'evil')));
    for (const root of ['zz', 'c0', 'r', home.dir, '/tmp', null]) {
      assert.equal((await post({ root, name: 'ok', content: 'x' })).status, 400, String(root));
    }
    assert.equal((await post({ root: 'p', name: 'ok', content: 'x', project: '/etc' })).status, 400);
    // Symlink out: the skill folder and SKILL.md itself.
    const folder = await post({ root: 'u0', name: 'link-pasta', content: 'invadiu' });
    assert.equal(folder.status, 403);
    assert.match(String(folder.json.error), /fora da raiz/);
    const file = await post({ root: 'u0', name: 'link-arquivo', content: 'invadiu' });
    assert.equal(file.status, 403);
    assert.match(String(file.json.error), /symlink/);
    assert.equal(readFileSync(join(outside, 'alvo', 'SKILL.md'), 'utf8'), 'de fora');
    // Content: text, up to MAX_CONTENT.
    assert.equal((await post({ root: 'u0', name: 'ok', content: 42 })).status, 400);
    assert.equal((await post({ root: 'u0', name: 'grande', content: 'a'.repeat(MAX_CONTENT + 1) })).status, 413);
    assert.equal((await post({ root: 'u0', name: 'no-limite', content: 'a'.repeat(MAX_CONTENT) })).status, 200);
  });

  test('POST body above MAX_SKILL_BODY: 413 without reading the rest', async () => {
    // The content fits in MAX_CONTENT; what exceeds the limit is the body (one extra field).
    const body = JSON.stringify({ root: 'u0', name: 'corpo-grande', content: 'x', extra: 'a'.repeat(MAX_SKILL_BODY) });
    assert.equal((await post(body)).status, 413, 'with Content-Length');
    // Without Content-Length (chunked) and never finishing the body: the 413 arrives anyway.
    const chunk = Buffer.alloc(64 * 1024, 'a');
    assert.equal(await postWithoutEnd(api.url, chunk, Math.ceil(MAX_SKILL_BODY / chunk.length) + 2), 413);
    assert.ok(!existsSync(join(home.dir, 'skills', 'corpo-grande')));
    // The server stays up.
    assert.equal((await get(api.url, '/api/agent-config/skill?root=u0&name=revisar-pr')).status, 200);
  });

  test("project = the home's parent folder: POST to root p gives 400 and nothing lands in the home", async () => {
    const t4 = mkdtempSync(join(tmpdir(), 'agent-config-project-home-'));
    try {
      const h4 = pastaDeConfiguracao(join(t4, '.claude'), 'padrao', t4);
      mkdirSync(h4.dir);
      await withApi(createAgentConfigRoute({ folders: async () => [h4], projects: async () => [t4], backups: join(t4, 'b') }), async (url) => {
        const r = await get(url, '/api/agent-config/skill', { method: 'POST', headers: json, body: JSON.stringify({ root: 'p', name: 'nova', content: 'x', create: true }) });
        assert.equal(r.status, 400, r.body);
        assert.ok(!existsSync(join(h4.dir, 'skills', 'nova')));
        const list = await get(url, '/api/agent-config');
        assert.ok(!(list.json.roots as { id: string }[]).some((x) => x.id === 'p'));
      });
    } finally {
      rmSync(t4, { recursive: true, force: true });
    }
  });

  test('two concurrent writes with the same version: one passes, the other gives 409', async () => {
    const read = await get(api.url, '/api/agent-config/skill?root=u0&name=nova-skill');
    const [a, b] = await Promise.all([
      post({ root: 'u0', name: 'nova-skill', content: 'aba A', version: read.json.version }),
      post({ root: 'u0', name: 'nova-skill', content: 'aba B', version: read.json.version }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const winner = a.status === 200 ? 'aba A' : 'aba B';
    assert.equal(readFileSync(join(home.dir, 'skills', 'nova-skill', 'SKILL.md'), 'utf8'), winner);
  });

  test("the project's .claude as a symlink out of the project is refused", async () => {
    const t3 = mkdtempSync(join(tmpdir(), 'agent-config-claude-link-'));
    try {
      const proj = join(t3, 'clonado');
      mkdirSync(proj);
      mkdirSync(join(t3, 'outra'));
      symlinkSync(join(t3, 'outra'), join(proj, '.claude'));
      await withApi(createAgentConfigRoute({ folders: async () => [], projects: async () => [proj], backups: join(t3, 'b') }), async (url) => {
        const r = await get(url, '/api/agent-config/skill', { method: 'POST', headers: json, body: JSON.stringify({ root: 'p', name: 'nova', content: 'x' }) });
        assert.equal(r.status, 403, r.body);
        assert.ok(!existsSync(join(t3, 'outra', 'skills')));
      });
    } finally {
      rmSync(t3, { recursive: true, force: true });
    }
  });

  test('the whole skills folder as a symlink out is refused too', async () => {
    const t2 = mkdtempSync(join(tmpdir(), 'agent-config-skills-link-'));
    try {
      const h2 = pastaDeConfiguracao(join(t2, '.claude'), 'padrao', t2);
      mkdirSync(h2.dir);
      symlinkSync(outside, join(h2.dir, 'skills'));
      await withApi(createAgentConfigRoute({ folders: async () => [h2], projects: async () => [], backups: join(t2, 'b') }), async (url) => {
        const r = await get(url, '/api/agent-config/skill', { method: 'POST', headers: json, body: JSON.stringify({ root: 'u0', name: 'nova', content: 'x' }) });
        assert.equal(r.status, 403, r.body);
        assert.match(String(r.json.error), /fora da raiz/);
        assert.ok(!existsSync(join(outside, 'nova')));
      });
    } finally {
      rmSync(t2, { recursive: true, force: true });
    }
  });
});
