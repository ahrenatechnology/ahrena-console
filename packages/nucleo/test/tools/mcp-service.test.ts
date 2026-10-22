// #280 layer 3, decision 0014 section 6: the MCP rows of ToolsService over the fake Mac and a temp
// HOME. The row shape, the catalog's latest, `claude mcp list` only on mcpCheck (never on a read),
// and `update` only for the catalog's server in the user scope with no env and no headers.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { McpServerView } from '../../src/tools/service.ts';
import { HOME } from './doubles.ts';
import { macService } from './machines.ts';
import { MCP_LIST_OUTPUT, writeMcpConfig } from './mcp-fixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'ahrena-mcp-service-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const CLAUDE = `${HOME}/.local/bin/claude`;
const MCP_LIST = `${CLAUDE} mcp list`;

function setup(write?: (home: string, project: string) => void) {
  const base = join(root, `t${++n}`);
  const { home, project } = writeMcpConfig(base);
  write?.(home, project);
  const logs: string[] = [];
  const m = macService({
    run: { [MCP_LIST]: MCP_LIST_OUTPUT },
    extra: { claudeJsonPath: join(home, '.claude.json'), mcpProjects: async () => [project], appVersion: '0.0.32', log: (l) => logs.push(l) },
  });
  return { ...m, logs, home, project };
}

const byName = (servers: McpServerView[], name: string, scope = 'user') => servers.find((s) => s.name === name && s.scope === scope)!;

describe('#280 MCP rows in the overview', () => {
  test('the row shape, names only; the state unknown until Verificar conexões; no claude mcp list on a read', async () => {
    const { service, run } = setup();
    const o = (await service.overview())!;
    assert.equal(o.mcp.statusCheckedAt, null);
    assert.deepEqual(o.mcp.servers.map((s) => [s.scope, s.project, s.name]), [
      ['user', null, 'ahrena-console'],
      ['user', null, 'playwright'],
      ['user', null, 'docs'],
      ['user', null, 'tracker'],
      ['local', 'catalogo-exemplo', 'playwright'],
      ['project', 'catalogo-exemplo', 'db'],
    ]);
    const pw = byName(o.mcp.servers, 'playwright');
    assert.deepEqual(Object.keys(pw), ['id', 'name', 'scope', 'project', 'transport', 'command', 'package', 'version', 'latest', 'host', 'envCount', 'envNames', 'headerCount', 'headerNames', 'state', 'note', 'actions']);
    assert.deepEqual(pw, { id: 'playwright', name: 'playwright', scope: 'user', project: null, transport: 'stdio', command: 'npx', package: '@playwright/mcp', version: '0.0.41', latest: null, host: null, envCount: 0, envNames: [], headerCount: 0, headerNames: [], state: 'unknown', note: null, actions: [] });
    const docs = byName(o.mcp.servers, 'docs');
    assert.deepEqual([docs.transport, docs.host, docs.headerCount, docs.headerNames, docs.command], ['http', 'mcp.exemplo.dev', 1, ['Authorization'], null]);
    assert.match(docs.id, /^mcp-[0-9a-f]{12}$/);
    const tracker = byName(o.mcp.servers, 'tracker');
    assert.deepEqual([tracker.command, tracker.package, tracker.envCount, tracker.envNames], ['exemplo-tracker', null, 1, ['TRACKER_TOKEN']]);
    const db = byName(o.mcp.servers, 'db', 'project');
    assert.deepEqual([db.command, db.envCount, db.envNames], ['docker', 2, ['PGHOST', 'PGPASSWORD']]);
    const app = byName(o.mcp.servers, 'ahrena-console');
    assert.deepEqual([app.version, app.note, app.command, app.actions], ['0.0.32', 'atualiza junto com o app', 'node', []]);
    assert.equal(new Set(o.mcp.servers.map((s) => s.id)).size, o.mcp.servers.length, 'unique ids');
    await service.check();
    assert.ok(!run.calls.some((a) => a.join(' ') === MCP_LIST), 'neither the read nor Verificar agora runs claude mcp list');
  });

  test('mcpCheck: claude mcp list once, the states by name, the time; only counts in the log', async () => {
    const { service, run, logs } = setup();
    const o = (await service.mcpCheck())!;
    assert.equal(run.calls.filter((a) => a.join(' ') === MCP_LIST).length, 1);
    assert.equal(o.mcp.statusCheckedAt, '2026-10-21T09:12:00.000Z');
    const state = (name: string, scope = 'user') => byName(o.mcp.servers, name, scope).state;
    assert.deepEqual([state('playwright'), state('docs'), state('db', 'project'), state('tracker'), state('ahrena-console')], ['connected', 'needs-login', 'failed', 'unknown', 'unknown']);
    assert.equal(byName(o.mcp.servers, 'docs').note, 'o login é do Claude Code, não do console');
    assert.deepEqual(logs.filter((l) => l.includes('MCP')), ['tools: MCP states read: 2 connected, 1 failed, 1 need login, 1 unknown']);
    assert.equal(await service.mcpCheck('ws-exemplo'), null);
  });

  test('mcpCheck without claude, or when it fails: states unknown, a log line without output', async () => {
    const failing = setup();
    const f = macService({ run: { [MCP_LIST]: { code: null, error: 'timeout', stdout: '' } }, extra: { claudeJsonPath: join(failing.home, '.claude.json'), log: (l) => failing.logs.push(l) } });
    const o = (await f.service.mcpCheck())!;
    assert.ok(o.mcp.servers.every((s) => s.state === 'unknown'));
    assert.ok(o.mcp.statusCheckedAt);
    assert.ok(failing.logs.includes('tools: claude mcp list did not finish (timeout)'));
  });

  test('update: the catalog\'s server, user scope, no env, no headers, behind the latest; the catalog\'s two steps', async () => {
    const { service } = setup();
    await service.check();
    const o = (await service.overview())!;
    const pw = byName(o.mcp.servers, 'playwright');
    assert.equal(pw.latest, '0.0.43');
    assert.equal(pw.actions.length, 1);
    const a = pw.actions[0]!;
    assert.deepEqual([a.id, a.runnable, a.admin, a.blockedReason, a.targetVersion], ['update', true, false, null, '0.0.43']);
    assert.deepEqual(a.steps, [
      ['claude', 'mcp', 'remove', '-s', 'user', 'playwright'],
      ['claude', 'mcp', 'add', '-s', 'user', 'playwright', '--', 'npx', '-y', '@playwright/mcp@0.0.43'],
    ]);
    const local = byName(o.mcp.servers, 'playwright', 'local');
    assert.deepEqual([local.latest, local.actions, local.id.startsWith('mcp-')], ['0.0.43', [], true], 'the local scope never gets update');
    const plan = await service.actionPlan('local', 'playwright', 'update');
    assert.equal(plan.kind, 'plan');
    assert.equal(plan.kind === 'plan' && plan.action.planDigest, a.planDigest);
    assert.equal(plan.kind === 'plan' && plan.label, 'Atualizar Playwright MCP');
  });

  test('no update with env, under another name, unpinned, or up to date', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['env', { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.41'], env: { DEBUG: '1' } } }],
      ['other name', { pw: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.41'] } }],
      ['unpinned', { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } }],
      ['up to date', { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.43'] } }],
    ];
    for (const [label, servers] of cases) {
      const { service } = setup((home) => writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers })));
      await service.check();
      const o = (await service.overview())!;
      const user = o.mcp.servers.filter((s) => s.scope === 'user');
      assert.equal(user.length, 1, label);
      assert.deepEqual(user[0]!.actions, [], label);
      assert.equal(user[0]!.latest, '0.0.43', `${label}: the catalog's latest is shown`);
      assert.equal((await service.actionPlan('local', 'playwright', 'update')).kind, 'not-offered', label);
    }
  });

  test('verify after the update reads the version from the config again', async () => {
    const { service, home } = setup();
    await service.check();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.43'] } } }));
    assert.equal(await service.verify('local', 'playwright'), '0.0.43');
    const pw = byName((await service.overview())!.mcp.servers, 'playwright');
    assert.deepEqual([pw.version, pw.actions], ['0.0.43', []]);
  });
});
