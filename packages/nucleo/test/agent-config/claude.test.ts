import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { readClaudeConfig } from '../../src/agent-config/claude.ts';
import { configHighlights } from '../../ui/screens/claude-config.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'claude-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, '.claude');
  const project = join(home, 'project');
  const managedDir = join(home, 'managed');
  const folders = [{ dir: profile, claudeJson: join(home, '.claude.json') }];
  const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  return { home, project, profile, managedDir, folders, put, read: (extra = {}) => readClaudeConfig({ home, project, managedDir, folders, ...extra }) };
}

test('scalar precedence tracks overridden origins; complex lists never pretend runtime confirmation', async t => {
  const f = await fixture(t);
  await f.put(join(f.profile, 'settings.json'), { model: 'haiku', permissions: { allow: ['Read'], deny: ['Bash'] }, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '20' } });
  await f.put(join(f.project, '.claude/settings.json'), { model: 'sonnet', permissions: { allow: ['Edit'] } });
  await f.put(join(f.project, '.claude/settings.local.json'), { model: 'opus' });
  await f.put(join(f.managedDir, 'managed-settings.json'), { model: 'sonnet[1m]' });
  await f.put(join(f.managedDir, 'managed-settings.d/20-policy.json'), { model: 'haiku' });
  const d = await f.read();
  const model = d.declared.find(r => r.key === 'model');
  assert.equal(model?.value, 'haiku');
  assert.deepEqual(model?.overridden, ['user', 'project', 'local', 'managed']);
  assert.deepEqual(model?.sources, ['managed-0']);
  assert.deepEqual(d.declared.find(r => r.key === 'permissions.allow')?.sources, ['user', 'project']);
  assert.equal(d.declared.find(r => r.key === 'permissions.allow')?.resolution, 'unknown');
  assert.equal(d.runtime.contextWindow, null);
  assert.equal(d.runtime.remaining, null);
  assert.equal(d.diagnostics.strictEligible, false);
  assert.equal(configHighlights(d).find(([k]) => k === 'Compactação declarada (%)')?.[1], 20);
});

test('secrets in values, keys, commands, URLs, custom models and malformed JSON cannot leave', async t => {
  const f = await fixture(t);
  const secret = 'sk-secret-do-not-export';
  await f.put(join(f.profile, 'settings.json'), { model: secret, env: { ANTHROPIC_API_KEY: secret, CUSTOM: secret, [secret]: secret }, hooks: { PreToolUse: [{ hooks: [{ command: secret }] }] }, statusLine: { command: secret }, enabledPlugins: { [secret]: true }, [secret]: { [secret]: secret } });
  await f.put(join(f.project, '.mcp.json'), { mcpServers: { [secret]: { url: `https://${secret}`, headers: { Authorization: secret } } } });
  await f.put(join(f.home, '.claude.json'), { oauthAccount: { token: secret }, userID: secret, mcpServers: { x: { args: [secret] } } });
  await f.put(join(f.project, '.claude/settings.local.json'), `{invalid ${secret}`);
  const d = await f.read();
  assert.ok(!JSON.stringify(d).includes(secret));
  assert.equal(d.layers.find(l => l.id === 'local')?.status, 'unknown');
  assert.deepEqual(d.diagnostics.authSources, [{ source: 'user', kind: 'ANTHROPIC_API_KEY', present: true }]);
});

test('profiles are alternatives; session without proven profile stays unresolved', async t => {
  const f = await fixture(t);
  await f.put(join(f.profile, 'settings.json'), { model: 'sonnet' });
  const other = { dir: join(f.home, '.claude-other'), claudeJson: join(f.home, '.claude-other/.claude.json') };
  await f.put(join(other.dir, 'settings.json'), { model: 'opus' });
  const ambiguous = await f.read({ folders: [...f.folders, other] });
  assert.equal(ambiguous.profile, null);
  assert.ok(!ambiguous.declared.some(r => r.key === 'model'));
  const selected = await f.read({ folders: [...f.folders, other], profile: ambiguous.profiles[1].id });
  assert.equal(selected.declared.find(r => r.key === 'model')?.value, 'opus');
  assert.equal((await f.read({ session: true })).profile, null);
});

test('remote/provider unavailable performs no config read; symlinks and oversized files unknown', async t => {
  const f = await fixture(t);
  await f.put(join(f.profile, 'settings.json'), ' '.repeat(1024 * 1024 + 1));
  await f.put(join(f.project, 'target'), { model: 'opus' });
  await mkdir(join(f.project, '.claude'));
  await symlink(join(f.project, 'target'), join(f.project, '.claude/settings.json'));
  const d = await f.read();
  assert.equal(d.layers.find(l => l.id === 'user')?.status, 'unknown');
  assert.equal(d.layers.find(l => l.id === 'project')?.status, 'unknown');
  const unavailable = await f.read({ unavailable: true });
  assert.deepEqual(unavailable.layers, []);
  assert.equal(unavailable.runtime.status, 'unknown');
});

test('settings is reachable from Agent Config and session link preserves remote isolation', async () => {
  const { TABS, readUrl, urlFor } = await import('../../ui/screens/agent-config.js');
  const { readFile } = await import('node:fs/promises');
  assert.ok(TABS.some(tab => tab.id === 'settings'));
  assert.equal(readUrl('?tab=settings').tab, 'settings');
  assert.ok(urlFor({ tab: 'settings', project: '/project' }).includes('tab=settings'));
  const detail = await readFile(new URL('../../ui/screens/session-detail.js', import.meta.url), 'utf8');
  assert.ok(detail.includes("source ? '&machine=remote'"));
});

test('legacy transcript provenance resolves only a unique known profile; selected project MCP is isolated', async t => {
  const { sessionProfile } = await import('../../src/agent-config/claude.ts');
  const { session } = await import('../fixtures.ts');
  const f = await fixture(t);
  const s = session({ metadata: { transcriptPath: join(f.profile, 'projects/project/session.jsonl') } });
  const id = await sessionProfile(s, f.folders);
  assert.ok(id);
  await f.put(join(f.profile, 'settings.json'), { model: 'opus' });
  await f.put(f.folders[0].claudeJson, { projects: { [f.project]: { mcpServers: { mine: { command: 'secret-command' } } }, '/other-project': { mcpServers: { other: {} } } } });
  const d = await f.read({ session: true, profile: id });
  assert.equal(d.declared.find(r => r.key === 'model')?.value, 'opus');
  assert.equal(d.layers.find(l => l.id === 'local-mcp')?.settings.length, 1);
  assert.ok(!JSON.stringify(d).includes('secret-command'));
  assert.ok(!JSON.stringify(d).includes('/other-project'));
  assert.equal(await sessionProfile(session({ metadata: { transcriptPath: '/unknown/projects/p/s.jsonl' } }), f.folders), null);
  assert.equal(await sessionProfile(session({ metadata: { import: { file: 'relative.jsonl' } } }), f.folders), null);
});

test('HTTP enforces owner proof, known roots, session isolation, safe errors and read-only methods', async t => {
  const { Accounts, MontadorDoPainel, startLocalApi, createAgentConfigRoute } = await import('../../src/api/index.ts');
  const { openSqliteStorage } = await import('../../src/adapters/sqlite/sqlite-storage.ts');
  const { session } = await import('../fixtures.ts');
  const f = await fixture(t);
  await f.put(join(f.profile, 'settings.json'), { model: 'opus', env: { ANTHROPIC_API_KEY: 'api-secret-marker' } });
  const storage = openSqliteStorage({ path: ':memory:' });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const logs: string[] = [];
  let reads = 0;
  let fail = false;
  const local = session({ id: 'local', cwd: f.project, metadata: { transcriptPath: join(f.profile, 'projects/p/local.jsonl') } });
  const remote = session({ id: 'remote', cwd: f.project, identity: { provider: 'claude', providerSessionId: 'r', machineId: 'workstation', profileId: null, environmentId: null } });
  const codex = session({ id: 'codex', cwd: f.project, identity: { provider: 'codex', providerSessionId: 'c', machineId: null, profileId: null, environmentId: null } });
  const agentConfig = createAgentConfigRoute({
    folders: async () => { reads++; if (fail) throw new Error('api-secret-marker'); return f.folders; },
    projects: async () => [f.project], session: async id => [local, remote, codex].find(s => s.id === id) ?? null,
    claudeConfig: { home: f.home, managedDir: f.managedDir }, log: message => logs.push(message),
  });
  const token = 'c'.repeat(64);
  const api = await startLocalApi({ panelBuilder, hooks: { storage }, agentConfig, port: 0, ownerToken: () => token, log: message => logs.push(message) });
  t.after(async () => { await api.close(); await storage.close(); });
  const call = async (suffix = '', method = 'GET', authorized = true) => {
    const response = await fetch(`${api.url}/api/agent-config/claude${suffix}`, { method, headers: authorized ? { authorization: `Bearer ${token}` } : {} });
    const text = await response.text();
    assert.ok(!text.includes('api-secret-marker'));
    return { status: response.status, body: JSON.parse(text) };
  };
  assert.equal((await call('', 'GET', false)).status, 403);
  assert.equal(reads, 0);
  assert.equal((await call('', 'POST')).status, 405);
  assert.equal((await call('?project=/unknown')).status, 400);
  assert.equal((await call('?profile=/unknown')).status, 400);
  const localResult = await call('?session=local&profile=ignored');
  assert.equal(localResult.status, 200);
  assert.equal(localResult.body.project, f.project);
  assert.equal(localResult.body.declared.find(r => r.key === 'model').value, 'opus');
  assert.equal(localResult.body.diagnostics.strictEligible, false);
  for (const query of ['?session=remote', '?session=codex', '?machine=remote']) {
    const result = await call(query);
    assert.equal(result.body.availability, 'unavailable');
    assert.deepEqual(result.body.layers, []);
  }
  assert.equal((await call('?session=missing')).status, 404);
  fail = true;
  assert.equal((await call()).status, 400);
  assert.ok(!logs.join('\n').includes('api-secret-marker'));
});
