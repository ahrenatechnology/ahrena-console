import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readCodexConfig } from '../../src/agent-config/codex.ts';
import { readInstructions } from '../../src/agent-instructions/read.ts';
import { codexOf } from '../../src/telemetry/adapters/common.ts';
import { probeTool, passiveCodexVersion } from '../../src/tools/probe.ts';
import { catalogEntry } from '../../src/tools/catalog.ts';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, '.codex');
  const project = join(home, 'repo');
  const systemDir = join(home, 'system');
  const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
  await mkdir(join(project, '.git'), { recursive: true });
  return { home, codexHome, project, systemDir, put, read: (extra = {}) => readCodexConfig({ home, codexHome, project, systemDir, path: '', ...extra }) };
}

test('Codex inspects versioned profile declarations, ancestors and assets without claiming effective config', async t => {
  const f = await fixture(t);
  await f.put(join(f.codexHome, 'config.toml'), 'approval_policy = "on-request"\n[profiles.old]\nsandbox_mode = "read-only"\n[mcp_servers.docs]\ncommand = "never-execute"');
  await f.put(join(f.codexHome, 'review.config.toml'), 'sandbox_mode = "workspace-write"');
  await f.put(join(f.project, '.codex/config.toml'), 'web_search = "disabled"');
  await f.put(join(f.project, 'AGENTS.md'), 'native instructions @missing.md');
  await f.put(join(f.project, '.agents/skills/sample/SKILL.md'), 'private prose');
  const nested = join(f.project, 'sub'); await mkdir(nested);
  const d = await f.read({ project: nested });
  assert.equal(d.profiles.length, 2);
  assert.equal(d.profile, null);
  assert.equal(d.installation.status, 'not-found-on-path');
  assert.ok(d.layers.some(l => l.path === join(f.project, '.codex/config.toml')));
  assert.deepEqual(new Set(d.assets.map(a => a.kind)), new Set(['mcp', 'instructions', 'skill']));
  assert.ok(d.assets.every(a => a.applicability === 'unknown'));
  assert.ok(d.declared.every(r => r.confirmed === 'unknown'));
  const selected = await f.read({ profile: d.profiles.find(p => p.format === 'file-since-0.134').id });
  assert.ok(selected.layers.some(l => l.kind === 'profile' && l.settings[0].value === 'workspace-write'));
  assert.equal(selected.runtime.status, 'unknown');
  assert.equal(selected.diagnostics.strictEligible, false);
  assert.ok(!JSON.stringify(d).includes('never-execute'));
  assert.equal(await readFile(join(f.project, 'AGENTS.md'), 'utf8'), 'native instructions @missing.md');
});

test('secrets in TOML values, keys, profile names, MCP names and skill contents never leave JSON', async t => {
  const f = await fixture(t); const secret = 'sensitive-synthetic-marker';
  await f.put(join(f.codexHome, 'config.toml'), `model = "${secret}"\nprofile = "${secret}"\n"${secret}" = "${secret}"\n[profiles."${secret}"]\nmodel = "${secret}"\n[mcp_servers."${secret}"]\nurl = "https://${secret}"\nhttp_headers = { Authorization = "${secret}" }\nargs = ["${secret}"]`);
  await f.put(join(f.codexHome, `${secret}.config.toml`), `model = "${secret}"`);
  await f.put(join(f.project, `.agents/skills/${secret}/SKILL.md`), secret);
  const d = await f.read(); assert.ok(!JSON.stringify(d).includes(secret));
  for (const p of d.profiles) assert.ok(!JSON.stringify(await f.read({ profile: p.id })).includes(secret));
  await f.put(join(f.project, '.codex/config.toml'), `malformed ${secret}`);
  assert.equal((await f.read()).layers.find(l => l.kind === 'project').status, 'unknown');
});

test('missing files, invalid TOML, links and oversized input are isolated and do not change files', async t => {
  const f = await fixture(t);
  assert.equal((await f.read()).layers.find(l => l.id === 'user').status, 'absent');
  await f.put(join(f.codexHome, 'config.toml'), 'model = [invalid');
  assert.equal((await f.read()).layers.find(l => l.id === 'user').status, 'unknown');
  assert.equal(await readFile(join(f.codexHome, 'config.toml'), 'utf8'), 'model = [invalid');
  await f.put(join(f.project, 'target'), 'sandbox_mode = "read-only"');
  await mkdir(join(f.project, '.codex'));
  await symlink(join(f.project, 'target'), join(f.project, '.codex/config.toml'));
  assert.equal((await f.read()).layers.find(l => l.kind === 'project').status, 'unknown');
  await rm(join(f.project, '.codex/config.toml'));
  await link(join(f.project, 'target'), join(f.project, '.codex/config.toml'));
  assert.equal((await f.read()).layers.find(l => l.kind === 'project').status, 'unknown');
  await f.put(join(f.codexHome, 'config.toml'), ' '.repeat(1024 * 1024 + 1));
  assert.equal((await f.read()).layers.find(l => l.id === 'user').status, 'unknown');
  assert.deepEqual((await f.read({ unavailable: true })).layers, []);
  assert.ok(!(await f.read({ session: true })).layers.some(l => l.id === 'user'));
});

test('Codex native instructions never need CLAUDE imports; Claude behavior is preserved', () => {
  const paths = ['AGENTS.md', 'AGENTS.override.md'];
  const read = () => '@missing.md';
  const codex = readInstructions(paths, read, { provider: 'codex' });
  assert.equal(codex.files.length, 2); assert.deepEqual(codex.warnings, []);
  assert.ok(codex.files.every(f => f.tree.imports.length === 0));
  assert.ok(readInstructions(paths, read).warnings.some(w => w.kind === 'agents-not-imported'));
});

test('Codex catalog lookup never runs provider or helpers and package metadata is strictly validated', async t => {
  const f = await fixture(t); const binary = join(f.home, '@openai/codex/bin/codex.js');
  await f.put(join(f.home, '@openai/codex/package.json'), JSON.stringify({ name: '@openai/codex', version: '0.134.0' }));
  const entry = catalogEntry('codex'); assert.deepEqual(entry.sources, []);
  const d = await probeTool(entry, { platform: 'linux', arch: 'x64', home: f.home, path: '/bin', run: async () => { throw new Error('must never run'); }, isExecutable: async () => true, realpath: async () => binary });
  assert.equal(d.installed, '0.134.0');
  assert.equal(await passiveCodexVersion('/bin/codex'), null);
  await f.put(join(f.home, '@openai/codex/package.json'), JSON.stringify({ name: '@openai/codex', version: 'secret-marker' }));
  assert.equal(await passiveCodexVersion(binary), null);
});

test('Codex process classification uses executable identities and cannot infer readiness from history', () => {
  const stats = ['codex', '/Applications/Codex.app/Contents/MacOS/Codex', 'bash', 'claude', 'codex-helper'].map((comm, i) => ({ pid: i + 1, comm, cpuPct: 1, rssBytes: 100 }));
  const d = codexOf(stats);
  assert.equal(d.cli.count, 1); assert.equal(d.desktop.count, 1); assert.equal(d.processes.count, 2);
  assert.equal(codexOf([]).processes.count, 0);
});

test('Codex HTTP route enforces owner proof, known roots, provider/session isolation and read-only methods', async t => {
  const { Accounts, MontadorDoPainel, startLocalApi, createAgentConfigRoute } = await import('../../src/api/index.ts');
  const { openSqliteStorage } = await import('../../src/adapters/sqlite/sqlite-storage.ts');
  const { session } = await import('../fixtures.ts');
  const f = await fixture(t); const secret = 'http-synthetic-secret';
  await f.put(join(f.codexHome, 'config.toml'), `model = "${secret}"`);
  const storage = openSqliteStorage({ path: ':memory:' });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const logs: string[] = []; let reads = 0; let fail = false;
  const local = session({ id: 'local', cwd: f.project, identity: { provider: 'codex', providerSessionId: 'c', machineId: null, profileId: null, environmentId: null } });
  const remote = session({ ...local, id: 'remote', identity: { ...local.identity!, machineId: 'other' } });
  const claude = session({ id: 'claude', cwd: f.project });
  const agentConfig = createAgentConfigRoute({ folders: async () => { throw new Error('Claude discovery must not run'); }, projects: async () => { reads++; if (fail) throw new Error(secret); return [f.project]; }, session: async id => [local, remote, claude].find(s => s.id === id) ?? null, codexConfig: { home: f.home, codexHome: f.codexHome, systemDir: f.systemDir, path: '' }, log: s => logs.push(s) });
  const token = 'd'.repeat(64);
  const api = await startLocalApi({ panelBuilder, hooks: { storage }, agentConfig, port: 0, ownerToken: () => token, log: s => logs.push(s) });
  t.after(async () => { await api.close(); await storage.close(); });
  const call = async (query = '', method = 'GET', authorized = true) => {
    const r = await fetch(`${api.url}/api/agent-config/codex${query}`, { method, headers: authorized ? { authorization: `Bearer ${token}` } : {} });
    const text = await r.text(); assert.ok(!text.includes(secret)); return { status: r.status, body: JSON.parse(text) };
  };
  assert.equal((await call('', 'GET', false)).status, 403); assert.equal(reads, 0);
  assert.equal((await call('', 'POST')).status, 405);
  for (const query of ['?machine=remote', '?session=remote', '?session=claude']) {
    assert.equal((await call(query)).body.availability, 'unavailable');
  }
  assert.equal(reads, 0);
  assert.equal((await call('?project=/unknown')).status, 400);
  assert.equal((await call('?profile=/unknown')).status, 400);
  assert.equal((await call('?session=missing')).status, 404);
  const d = (await call('?session=local&profile=ignored')).body;
  assert.equal(d.profile, null); assert.equal(d.runtime.status, 'unknown');
  assert.ok(!d.layers.some(l => l.id === 'user')); assert.equal(d.diagnostics.strictEligible, false);
  fail = true; assert.equal((await call()).status, 400);
  assert.ok(!logs.join('\n').includes(secret));
});

test('prototype-named TOML keys are opaque declarations, not parser failures', async t => {
  const f = await fixture(t);
  await f.put(join(f.codexHome, 'config.toml'), 'constructor = "private"\ntoString = "private"\n__proto__ = "private"');
  const d = await f.read();
  assert.equal(d.layers.find(l => l.id === 'user').status, 'read');
  assert.equal(d.declared.length, 3);
  assert.ok(!JSON.stringify(d).includes('private'));
});

test('nested MCP/profile limits and failed skill enumeration visibly mark incomplete inspection', async t => {
  const { codexInspectionIncomplete } = await import('../../ui/screens/codex-config.js');
  const f = await fixture(t);
  await f.put(join(f.codexHome, 'config.toml'), Array.from({ length: 201 }, (_, i) => `[mcp_servers.server${i}]\ncommand = "hidden"\n[profiles.profile${i}]\nmodel = "hidden"`).join('\n'));
  const d = await f.read();
  assert.equal(d.layers.find(l => l.id === 'user').status, 'unknown');
  assert.equal(d.assets.filter(a => a.kind === 'mcp').length, 200);
  assert.equal(d.profiles.length, 200);
  assert.ok(codexInspectionIncomplete(d));
  await f.put(join(f.codexHome, 'config.toml'), 'approval_policy = "never"');
  await f.put(join(f.project, '.agents/skills'), 'not a directory');
  const broken = await f.read();
  assert.ok(broken.diagnostics.reasons.includes('skill-discovery-incomplete'));
  assert.ok(codexInspectionIncomplete(broken));
});


test('installation response reports passive package evidence but never attributes host install to a session', async t => {
  const f = await fixture(t);
  const bin = join(f.home, 'bin');
  const executable = join(f.home, '@openai/codex/bin/codex.js');
  await f.put(executable, '#!/bin/sh\nexit 99\n');
  await chmod(executable, 0o755);
  await f.put(join(f.home, '@openai/codex/package.json'), JSON.stringify({ name: '@openai/codex', version: '0.134.0' }));
  await mkdir(bin);
  await symlink(executable, join(bin, 'codex'));
  const d = await f.read({ path: bin });
  assert.deepEqual(d.installation, { status: 'found', version: '0.134.0', evidence: 'npm-package-metadata' });
  assert.deepEqual((await f.read({ path: bin, session: true })).installation, { status: 'unknown', version: null, evidence: 'unobserved' });
  const skills = join(f.project, '.agents/skills'); await mkdir(skills, { recursive: true });
  await symlink(join(f.home, 'missing-target'), join(skills, 'linked'));
  const linked = await f.read();
  assert.equal(linked.assets.find(a => a.kind === 'skill').status, 'unknown');
  const { codexInspectionIncomplete } = await import('../../ui/screens/codex-config.js');
  assert.equal(codexInspectionIncomplete(linked), true);
});
