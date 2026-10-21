// #280 layer 1, decision 0014 sections 2, 3 and 7: ToolsService.overview() (local only, no network,
// the cache when valid) and check() (brew update, the latest readers, the cache replaced), the states
// and actions of each item, and the containers card, over fake machines.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHECK_VALIDITY_MS } from '../../src/tools/store.ts';
import type { ToolItem, ToolsOverview } from '../../src/tools/service.ts';
import { fakeFetch, fakeFs, HOME } from './doubles.ts';
import { macService, macTables, NOW, wsService } from './machines.ts';

const item = (o: ToolsOverview, id: string): ToolItem => o.items.find((i) => i.id === id)!;
const NETWORK_COMMANDS = /( update$| info | view | list-remote | check$| python list)/;

describe('#280 ToolsService.overview without a check', () => {
  test('reads the installed versions locally, runs no latest reader and no network, and never says ok', async () => {
    const { service, run, fetchText } = macService();
    const o = (await service.overview())!;
    assert.equal(fetchText.calls.length, 0);
    assert.deepEqual(run.calls.filter((a) => NETWORK_COMMANDS.test(a.join(' '))), []);
    assert.equal(o.version, 1);
    assert.deepEqual(o.machine, { id: 'local', label: 'Esta máquina', platform: 'darwin', os: 'macOS 26.0.1', arch: 'arm64' });
    assert.equal(o.checkedAt, null);
    assert.equal(o.nextCheckAt, null);
    assert.equal(o.network, 'unknown');
    assert.deepEqual(o.managers, { homebrew: { present: true }, winget: { present: false }, apt: { present: false, listsUpdatedAt: null } });
    assert.equal(o.actionsAllowed, true);
    assert.deepEqual(o.mcp, { statusCheckedAt: null, servers: [] });
    assert.deepEqual(o.jobs, { current: null, queue: [], recent: [] });
    assert.ok(o.items.every((i) => i.state !== 'ok'));
    assert.deepEqual(
      o.items.map((i) => [i.id, i.group, i.installed, i.source, i.state]),
      [
        ['claude', 'cli', '2.1.299', 'native', 'checking'],
        ['git', 'cli', '2.39.5', 'manual', 'manual'],
        ['gh', 'cli', '2.81.0', 'homebrew', 'checking'],
        ['aws', 'cli', '2.31.12', 'official', 'checking'],
        ['session-manager-plugin', 'cli', null, 'homebrew', 'missing'],
        ['wrangler', 'cli', '4.45.0', 'npm', 'checking'],
        ['gcloud', 'cli', null, 'homebrew', 'missing'],
        ['docker', 'cli', '28.5.1', 'homebrew', 'checking'],
        ['colima', 'cli', '0.9.1', 'homebrew', 'checking'],
        ['jq', 'cli', '1.8.1', 'homebrew', 'checking'],
        ['rg', 'cli', null, 'homebrew', 'missing'],
        ['node', 'runtime', '24.10.0', 'fnm', 'checking'],
        ['tsc', 'runtime', null, 'npm', 'missing'],
        ['python', 'runtime', null, 'uv', 'missing'],
        ['rust', 'runtime', null, null, 'missing'],
        ['go', 'runtime', null, 'homebrew', 'missing'],
      ],
    );
    assert.equal(item(o, 'wrangler').manager, 'npm global · Node do fnm');
    assert.equal(item(o, 'gcloud').manager, 'Homebrew (cask)');
    assert.equal(item(o, 'tsc').note, 'o de cada projeto fica no package.json dele');
    assert.deepEqual(item(o, 'gh').actions, [], 'no update without a latest version');
  });

  test('a missing tool offers the catalog install: runnable without a version, blocked when the step needs one or the manager is missing', async () => {
    const { service } = macService();
    const o = (await service.overview())!;
    const [gcloud] = item(o, 'gcloud').actions;
    assert.deepEqual({ ...gcloud, planDigest: 'x' }, { id: 'install', runnable: true, admin: false, blockedReason: null, steps: [['brew', 'install', '--cask', 'gcloud-cli']], timeoutSeconds: 900, targetVersion: null, planDigest: 'x' });
    assert.match(gcloud!.planDigest, /^[0-9a-f]{16}$/);
    const [tsc] = item(o, 'tsc').actions;
    assert.equal(tsc!.runnable, false);
    assert.equal(tsc!.blockedReason, 'invalid-version');
    assert.deepEqual(tsc!.steps, [['npm', 'install', '-g', 'typescript@{version}']]);
    assert.equal(item(o, 'python').actions[0]!.blockedReason, 'invalid-version');
    assert.deepEqual(item(o, 'rust').actions, [], 'rustup is not installed through the catalog');
  });

  test('the containers card: Colima running, its VM, the context, the counts and Stop', async () => {
    const { service } = macService();
    const c = (await service.overview())!.containers;
    assert.equal(c.runtime, 'colima');
    assert.equal(c.toolId, 'container-colima');
    assert.equal(c.state, 'running');
    assert.equal(c.readOnly, false);
    assert.equal(c.version, '0.9.1');
    assert.deepEqual(c.vm, { cpus: 4, memoryBytes: 8589934592, diskBytes: 107374182400, arch: 'aarch64', vmType: 'vz' });
    assert.equal(c.dockerContext, 'colima');
    assert.deepEqual(c.containers, { running: 3, stopped: 5 });
    assert.deepEqual(c.actions.map((a) => [a.id, a.steps, a.runnable, a.admin]), [['stop', [['colima', 'stop']], true, false]]);
  });

  test('Colima stopped offers Start; no Colima offers the install; Docker Desktop is read only', async () => {
    const stopped = macService({ run: { '/opt/homebrew/bin/colima status --json': { code: 1, stderr: 'colima is not running' } } });
    const c1 = (await stopped.service.overview())!.containers;
    assert.equal(c1.state, 'stopped');
    assert.equal(c1.vm, null);
    assert.equal(c1.containers, null);
    assert.deepEqual(c1.actions.map((a) => [a.id, a.steps]), [['start', [['colima', 'start']]]]);

    const none = macService({ links: { '/opt/homebrew/bin/colima': '/nowhere' }, run: { '/opt/homebrew/bin/colima version': { code: null, error: 'ENOENT' } } });
    // A colima that does not answer its probe is not installed for the card.
    const c2 = (await none.service.overview())!.containers;
    assert.equal(c2.state, 'missing');
    assert.deepEqual(c2.actions.map((a) => [a.id, a.steps]), [['install', [['brew', 'install', 'colima', 'docker']]]]);

    const desktop = macService({
      links: { '/opt/homebrew/bin/colima': '/x', '/usr/local/bin/docker': '/Applications/Docker.app/Contents/Resources/bin/docker', '/opt/homebrew/bin/docker': '/Applications/Docker.app/Contents/Resources/bin/docker' },
      run: {
        '/opt/homebrew/bin/colima version': { code: null, error: 'ENOENT' },
        '/opt/homebrew/bin/docker context show': 'desktop-linux\n',
        '/opt/homebrew/bin/docker info --format {{.ServerVersion}}': '28.5.1\n',
      },
    });
    const c3 = (await desktop.service.overview())!.containers;
    assert.equal(c3.runtime, 'docker-desktop');
    assert.equal(c3.readOnly, true);
    assert.equal(c3.state, 'running');
    assert.deepEqual(c3.actions, []);
  });
});

describe('#280 ToolsService.check', () => {
  test('runs brew update first, reads every latest, stores it, and the overview shows the states and update plans', async () => {
    const { service, run, store } = macService();
    const o = (await service.check())!;
    const commands = run.calls.map((a) => a.join(' '));
    const firstRead = commands.findIndex((c) => / info | view | list-remote /.test(c));
    assert.ok(commands.indexOf('/opt/homebrew/bin/brew update') >= 0 && commands.indexOf('/opt/homebrew/bin/brew update') < firstRead, 'brew update before the reads');
    assert.equal(o.network, 'online');
    assert.equal(o.checkedAt, '2026-10-21T09:12:00.000Z');
    assert.equal(o.nextCheckAt, '2026-10-21T15:12:00.000Z');
    assert.ok(store.list('local').length > 10);
    assert.deepEqual(
      o.items.filter((i) => i.installed).map((i) => [i.id, i.installed, i.latest, i.state]),
      [
        ['claude', '2.1.299', '2.1.312', 'outdated'],
        ['git', '2.39.5', null, 'manual'],
        ['gh', '2.81.0', '2.83.1', 'outdated'],
        ['aws', '2.31.12', '2.31.18', 'manual'],
        ['wrangler', '4.45.0', '4.47.2', 'outdated'],
        ['docker', '28.5.1', '28.5.1', 'ok'],
        ['colima', '0.9.1', '0.9.1', 'ok'],
        ['jq', '1.8.1', '1.8.1', 'ok'],
        ['node', '24.10.0', '24.11.0', 'outdated'],
      ],
    );
    const plan = (id: string) => item(o, id).actions.map((a) => ({ id: a.id, steps: a.steps, runnable: a.runnable, admin: a.admin, blockedReason: a.blockedReason, targetVersion: a.targetVersion }));
    assert.deepEqual(plan('claude'), [{ id: 'update', steps: [['claude', 'update']], runnable: true, admin: false, blockedReason: null, targetVersion: '2.1.312' }]);
    assert.deepEqual(plan('gh'), [{ id: 'update', steps: [['brew', 'upgrade', 'gh']], runnable: true, admin: false, blockedReason: null, targetVersion: '2.83.1' }]);
    assert.deepEqual(plan('wrangler'), [{ id: 'update', steps: [['npm', 'install', '-g', 'wrangler@4.47.2']], runnable: true, admin: false, blockedReason: null, targetVersion: '4.47.2' }]);
    assert.deepEqual(plan('node'), [{ id: 'update', steps: [['fnm', 'install', '24.11.0'], ['fnm', 'default', '24.11.0']], runnable: true, admin: false, blockedReason: null, targetVersion: '24.11.0' }]);
    assert.deepEqual(plan('aws'), [{ id: 'update', steps: [['sudo', 'installer', '-pkg', 'AWSCLIV2.pkg', '-target', '/']], runnable: false, admin: true, blockedReason: 'admin', targetVersion: '2.31.18' }]);
    assert.deepEqual(plan('jq'), []);
    assert.deepEqual(plan('git'), [], 'instalada à mão: no action');
    assert.deepEqual(item(o, 'tsc').actions.map((a) => [a.steps, a.runnable]), [[[['npm', 'install', '-g', 'typescript@5.9.3']], true]]);
    assert.equal(item(o, 'gh').latestCheckedAt, '2026-10-21T09:12:00.000Z');
  });

  test('the next overview reads the cache with no network; past 6 h it is checking again', async () => {
    let now = NOW;
    const { service, fetchText, run } = macService({ now: () => now });
    await service.check();
    const fetches = fetchText.calls.length;
    const reads = run.calls.length;
    now = NOW + 60_000;
    const o = (await service.overview())!;
    assert.equal(item(o, 'gh').state, 'outdated');
    assert.equal(fetchText.calls.length, fetches);
    assert.deepEqual(run.calls.slice(reads).filter((a) => NETWORK_COMMANDS.test(a.join(' '))), []);
    now = NOW + CHECK_VALIDITY_MS;
    const stale = (await service.overview())!;
    assert.equal(item(stale, 'gh').state, 'checking');
    assert.equal(item(stale, 'gh').latest, null);
    assert.equal(stale.checkedAt, null);
  });

  test('offline: the network readers fail, installs and updates are blocked, the screen says so', async () => {
    const npm = `${HOME}/.local/state/fnm_multishells/1_2/bin/npm view`;
    const failing = macService({
      fetch: fakeFetch({}),
      run: {
        '/opt/homebrew/bin/brew update': { code: 1 },
        [`${npm} wrangler version`]: { code: 1 },
        [`${npm} typescript version`]: { code: 1 },
        [`${npm} @playwright/mcp version`]: { code: 1 },
        '/opt/homebrew/bin/fnm list-remote --lts': { code: 1 },
      },
    });
    const o = (await failing.service.check())!;
    assert.equal(o.network, 'offline');
    assert.equal(o.actionsAllowed, false);
    const gh = item(o, 'gh');
    assert.equal(gh.state, 'outdated', 'Homebrew read its local cache');
    assert.equal(gh.actions[0]!.blockedReason, 'offline');
    assert.equal(gh.actions[0]!.runnable, false);
    assert.equal(item(o, 'wrangler').state, 'failed');
    assert.equal(item(o, 'wrangler').latestError, 'command-failed');
    assert.equal(item(o, 'wrangler').note, 'não deu para ler a versão mais recente');
    assert.equal(o.containers.actions[0]!.blockedReason, null, 'stopping Colima does not need the network');
  });

  test('a latest version that is not a valid version never enters a step', async () => {
    const { service, store } = macService();
    await service.check();
    store.replace('local', store.list('local').map((c) => (c.toolId === 'wrangler' ? { ...c, latest: '99.0.0-rc1' } : c)));
    const a = item((await service.overview())!, 'wrangler').actions[0]!;
    assert.equal(a.runnable, false);
    assert.equal(a.blockedReason, 'invalid-version');
    assert.deepEqual(a.steps, [['npm', 'install', '-g', 'wrangler@{version}']]);
  });

  test('without Homebrew the brew installs are blocked by no-manager', async () => {
    const fs = fakeFs(macTables().links);
    const noBrew = macService({ extra: { isExecutable: async (p: string) => p !== '/opt/homebrew/bin/brew' && fs.isExecutable(p) } });
    const o = (await noBrew.service.overview())!;
    assert.equal(o.managers.homebrew.present, false);
    const [install] = item(o, 'gcloud').actions;
    assert.equal(install!.blockedReason, 'no-manager');
    assert.equal(install!.runnable, false);
  });

  test('one check at a time', async () => {
    const { service, run } = macService();
    const [a, b] = await Promise.all([service.check(), service.check()]);
    assert.equal(a, b);
    assert.equal(run.calls.filter((c) => c.join(' ') === '/opt/homebrew/bin/brew update').length, 1);
  });

  test('another machine is not served by layer 1', async () => {
    const { service } = macService();
    assert.equal(await service.overview('ws-exemplo'), null);
    assert.equal(await service.check('ws-exemplo'), null);
  });
});

describe('#280 ToolsService on the Linux workstation', () => {
  test('apt is admin, the Go tarball is admin, Colima does not apply, Docker Engine start asks for sudo', async () => {
    const { service } = wsService();
    const o = (await service.check())!;
    assert.equal(o.machine.os, 'Ubuntu 24.04.3 LTS');
    assert.deepEqual(o.managers.apt, { present: true, listsUpdatedAt: '2026-10-20T09:12:00.000Z' });
    assert.equal(o.managers.homebrew.present, false);
    const gh = item(o, 'gh');
    assert.deepEqual([gh.source, gh.manager, gh.state], ['apt', 'apt · repositório do GitHub CLI', 'outdated']);
    assert.deepEqual(gh.actions.map((a) => [a.steps, a.admin, a.blockedReason]), [[[['sudo', 'apt-get', 'install', '--only-upgrade', 'gh']], true, 'admin']]);
    const go = item(o, 'go');
    assert.deepEqual([go.source, go.state, go.latest], ['official', 'manual', '1.25.3']);
    assert.deepEqual(go.actions[0]!.steps, [['sudo', 'rm', '-rf', '/usr/local/go'], ['sudo', 'tar', '-C', '/usr/local', '-xzf', 'go1.25.3.linux-amd64.tar.gz']]);
    const colima = item(o, 'colima');
    assert.deepEqual([colima.state, colima.note, colima.actions], ['na', 'só no macOS', []]);
    assert.equal(item(o, 'docker').state, 'ok');
    const c = o.containers;
    assert.deepEqual([c.runtime, c.toolId, c.state, c.readOnly], ['docker-engine', 'container-docker-engine', 'stopped', false]);
    assert.deepEqual(c.actions.map((a) => [a.id, a.steps, a.admin, a.runnable]), [['start', [['sudo', 'systemctl', 'start', 'docker']], true, false]]);
  });

  test('Docker without root: the user unit, start and stop without a password', async () => {
    const { service } = wsService({
      run: {
        '/usr/bin/systemctl --user cat docker.service': '# /home/exemplo/.config/systemd/user/docker.service\n',
        '/usr/bin/systemctl --user is-active docker': 'active\n',
        '/usr/bin/docker ps -a --format {{.State}}': 'running\nexited\n',
      },
    });
    const c = (await service.overview())!.containers;
    assert.deepEqual([c.runtime, c.state, c.containers], ['docker-rootless', 'running', { running: 1, stopped: 1 }]);
    assert.deepEqual(c.actions.map((a) => [a.id, a.steps, a.admin, a.runnable]), [['stop', [['systemctl', '--user', 'stop', 'docker']], false, true]]);
  });
});
