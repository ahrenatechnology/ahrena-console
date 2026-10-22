// #280 layer 1, decision 0014 section 1: the catalog builds exactly these argv lists, per entry,
// platform, source and action; no item carries a shell metacharacter, `~`, `$` or a quote; every step
// whose executable asks for a password is marked admin; `{version}` refuses anything but a version.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ACTION_IDS, CATALOG, isAdminExecutable, PLATFORMS, sourcesFor, VERSION_TOKEN, type ActionId, type Platform } from '../../src/tools/catalog.ts';
import { buildPlan, formatVersion, planDigest, substituteVersion } from '../../src/tools/plan.ts';

const V = '9.8.7';
type Row = [tool: string, platform: Platform, arch: 'x64' | 'arm64', source: string, action: ActionId, steps: string[][], admin: boolean];

const brewRows = (tool: string, formula: string, platforms: Platform[] = ['darwin', 'linux']): Row[] =>
  platforms.flatMap((p): Row[] => [
    [tool, p, 'arm64', 'homebrew', 'install', [['brew', 'install', formula]], false],
    [tool, p, 'arm64', 'homebrew', 'update', [['brew', 'upgrade', formula]], false],
  ]);
const caskRows = (tool: string, cask: string, admin = false): Row[] => [
  [tool, 'darwin', 'arm64', 'homebrew', 'install', [['brew', 'install', '--cask', cask]], admin],
  [tool, 'darwin', 'arm64', 'homebrew', 'update', [['brew', 'upgrade', '--cask', cask]], admin],
];
const aptRows = (tool: string, pkg: string): Row[] => [
  [tool, 'linux', 'arm64', 'apt', 'install', [['sudo', 'apt-get', 'install', pkg]], true],
  [tool, 'linux', 'arm64', 'apt', 'update', [['sudo', 'apt-get', 'install', '--only-upgrade', pkg]], true],
];
const npmRows = (tool: string, pkg: string): Row[] =>
  PLATFORMS.flatMap((p): Row[] => [
    [tool, p, 'arm64', 'npm', 'install', [['npm', 'install', '-g', `${pkg}@${V}`]], false],
    [tool, p, 'arm64', 'npm', 'update', [['npm', 'install', '-g', `${pkg}@${V}`]], false],
  ]);
const all = (tool: string, source: string, action: ActionId, steps: string[][]): Row[] => PLATFORMS.map((p): Row => [tool, p, 'arm64', source, action, steps, false]);

const EXPECTED: Row[] = [
  ...all('claude', 'native', 'update', [['claude', 'update']]),
  ...brewRows('git', 'git'),
  ...aptRows('git', 'git'),
  ...brewRows('gh', 'gh'),
  ...aptRows('gh', 'gh'),
  ['gh', 'win32', 'arm64', 'winget', 'install', [['winget', 'install', '--id', 'GitHub.cli', '--scope', 'user', '--silent']], false],
  ['gh', 'win32', 'arm64', 'winget', 'update', [['winget', 'upgrade', '--id', 'GitHub.cli', '--scope', 'user', '--silent']], false],
  ...brewRows('aws', 'awscli'),
  ['aws', 'darwin', 'arm64', 'official', 'install', [['sudo', 'installer', '-pkg', 'AWSCLIV2.pkg', '-target', '/']], true],
  ['aws', 'darwin', 'arm64', 'official', 'update', [['sudo', 'installer', '-pkg', 'AWSCLIV2.pkg', '-target', '/']], true],
  ['aws', 'linux', 'arm64', 'official', 'install', [['sudo', './aws/install']], true],
  ['aws', 'linux', 'arm64', 'official', 'update', [['sudo', './aws/install', '--bin-dir', '/usr/local/bin', '--install-dir', '/usr/local/aws-cli', '--update']], true],
  ...caskRows('session-manager-plugin', 'session-manager-plugin', true),
  ['session-manager-plugin', 'linux', 'arm64', 'official', 'install', [['sudo', 'dpkg', '-i', 'session-manager-plugin.deb']], true],
  ['session-manager-plugin', 'linux', 'arm64', 'official', 'update', [['sudo', 'dpkg', '-i', 'session-manager-plugin.deb']], true],
  ...npmRows('wrangler', 'wrangler'),
  ...caskRows('gcloud', 'gcloud-cli'),
  ...aptRows('gcloud', 'google-cloud-cli'),
  ...brewRows('docker', 'docker'),
  ...aptRows('docker', 'docker-ce-cli'),
  ...brewRows('colima', 'colima', ['darwin']),
  ...brewRows('jq', 'jq'),
  ...aptRows('jq', 'jq'),
  ...brewRows('rg', 'ripgrep'),
  ...aptRows('rg', 'ripgrep'),
  ...all('node', 'fnm', 'install', [['fnm', 'install', V], ['fnm', 'default', V]]),
  ...all('node', 'fnm', 'update', [['fnm', 'install', V], ['fnm', 'default', V]]),
  ...npmRows('tsc', 'typescript'),
  ...all('python', 'uv', 'install', [['uv', 'python', 'install', '9.8']]),
  ...all('python', 'uv', 'update', [['uv', 'python', 'upgrade', '9.8']]),
  ...all('rust', 'rustup', 'update', [['rustup', 'update', 'stable']]),
  ...brewRows('go', 'go'),
  ['go', 'linux', 'x64', 'official', 'update', [['sudo', 'rm', '-rf', '/usr/local/go'], ['sudo', 'tar', '-C', '/usr/local', '-xzf', `go${V}.linux-amd64.tar.gz`]], true],
  ['go', 'linux', 'arm64', 'official', 'update', [['sudo', 'rm', '-rf', '/usr/local/go'], ['sudo', 'tar', '-C', '/usr/local', '-xzf', `go${V}.linux-arm64.tar.gz`]], true],
  ['container-colima', 'darwin', 'arm64', 'homebrew', 'install', [['brew', 'install', 'colima', 'docker']], false],
  ['container-colima', 'darwin', 'arm64', 'homebrew', 'start', [['colima', 'start']], false],
  ['container-colima', 'darwin', 'arm64', 'homebrew', 'stop', [['colima', 'stop']], false],
  ['container-docker-engine', 'linux', 'arm64', 'apt', 'start', [['sudo', 'systemctl', 'start', 'docker']], true],
  ['container-docker-engine', 'linux', 'arm64', 'apt', 'stop', [['sudo', 'systemctl', 'stop', 'docker']], true],
  ['container-docker-rootless', 'linux', 'arm64', 'official', 'start', [['systemctl', '--user', 'start', 'docker']], false],
  ['container-docker-rootless', 'linux', 'arm64', 'official', 'stop', [['systemctl', '--user', 'stop', 'docker']], false],
  ['container-podman', 'win32', 'arm64', 'winget', 'install', [['winget', 'install', '--id', 'RedHat.Podman-Desktop', '--scope', 'user', '--silent', '--disable-interactivity']], false],
  ['container-podman', 'win32', 'arm64', 'winget', 'start', [['podman', 'machine', 'start']], false],
  ['container-podman', 'win32', 'arm64', 'winget', 'stop', [['podman', 'machine', 'stop']], false],
  ...all('playwright', 'npm', 'update', [
    ['claude', 'mcp', 'remove', '-s', 'user', 'playwright'],
    ['claude', 'mcp', 'add', '-s', 'user', 'playwright', '--', 'npx', '-y', `@playwright/mcp@${V}`],
  ]),
];

const key = (r: { tool: string; platform: string; arch: string; source: string; action: string }) => `${r.tool} ${r.platform} ${r.arch} ${r.source} ${r.action}`;

/** Every (entry, platform, arch, source, action) the catalog defines. */
function defined(): Set<string> {
  const out = new Set<string>();
  for (const e of CATALOG)
    for (const p of PLATFORMS) {
      if (e.platforms && !e.platforms.includes(p)) continue;
      for (const arch of ['x64', 'arm64'] as const)
        for (const s of sourcesFor(e, p, arch))
          for (const a of ACTION_IDS) if (s.actions[a]) out.add(key({ tool: e.id, platform: p, arch, source: s.id, action: a }));
    }
  return out;
}

describe('#280 catalog: the steps of every entry, platform and action', () => {
  for (const [tool, platform, arch, source, action, steps, admin] of EXPECTED) {
    test(`${tool} · ${platform}/${arch} · ${source} · ${action}`, () => {
      const entry = CATALOG.find((e) => e.id === tool)!;
      const detection = action === 'install' ? { installed: null, sourceId: null } : { installed: '1.0.0', sourceId: source as never };
      const plan = buildPlan(entry, action, detection, V, platform, { arch, hasManager: (s) => s.id === source });
      assert.ok(plan, 'a plan');
      assert.equal(plan.sourceId, source);
      assert.deepEqual(plan.steps, steps);
      assert.equal(plan.admin, admin);
      assert.equal(plan.versionOk, true);
    });
  }

  test('the table covers every action the catalog defines, on every arch, and nothing else', () => {
    const expected = new Set<string>();
    for (const [tool, platform, arch, source, action] of EXPECTED) {
      expected.add(key({ tool, platform, arch, source, action }));
      // Rows written for one arch hold for the other unless the source is arch-specific.
      const other = arch === 'x64' ? 'arm64' : 'x64';
      const entry = CATALOG.find((e) => e.id === tool)!;
      if (sourcesFor(entry, platform, other).some((s) => s.id === source && !s.arch)) expected.add(key({ tool, platform, arch: other, source, action }));
    }
    assert.deepEqual([...defined()].sort(), [...expected].sort());
  });

  test('every wireframe item is in the catalog', () => {
    const ids = CATALOG.map((e) => e.id);
    for (const id of ['claude', 'git', 'gh', 'aws', 'session-manager-plugin', 'wrangler', 'gcloud', 'docker', 'colima', 'jq', 'rg', 'node', 'tsc', 'python', 'rust', 'go', 'container-colima', 'container-docker-engine', 'container-docker-rootless', 'container-podman', 'container-docker-desktop', 'playwright'])
      assert.ok(ids.includes(id), id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  });

  test('Colima is macOS only; Docker Desktop has no action anywhere', () => {
    assert.deepEqual(CATALOG.find((e) => e.id === 'colima')!.platforms, ['darwin']);
    assert.deepEqual(CATALOG.find((e) => e.id === 'container-docker-desktop')!.sources, []);
  });
});

describe('#280 catalog: what a step may contain', () => {
  const FORBIDDEN = /[&|;<>()$`'"~*?\\\s!]/;
  test('no argv item has a shell metacharacter, `~`, `$`, a quote or whitespace; braces only as {version}', () => {
    for (const e of CATALOG)
      for (const s of e.sources)
        for (const a of Object.values(s.actions))
          for (const step of a!.steps) {
            assert.ok(step.length > 0, `${e.id}: empty step`);
            for (const item of step) {
              assert.ok(!FORBIDDEN.test(item), `${e.id}/${s.id}: ${JSON.stringify(item)}`);
              assert.ok(!/[{}]/.test(item.split(VERSION_TOKEN).join('')), `${e.id}/${s.id}: ${JSON.stringify(item)}`);
              assert.notEqual(item, '', `${e.id}/${s.id}: empty item`);
            }
          }
  });

  test('every step whose executable is sudo, doas, pkexec, su, runas or osascript is in an admin action', () => {
    let seen = 0;
    for (const e of CATALOG)
      for (const s of e.sources)
        for (const [id, a] of Object.entries(s.actions))
          for (const step of a!.steps)
            if (isAdminExecutable(step[0]!)) {
              seen++;
              assert.equal(a!.admin, true, `${e.id}/${s.id}/${id}`);
            }
    assert.ok(seen > 0);
  });

  test('a forgotten admin mark is still caught by the plan', () => {
    const entry = { id: 'x', label: 'X', group: 'cli' as const, probe: null, sources: [{ id: 'apt' as const, label: 'apt', platforms: ['linux' as const], binaryUnder: [], latest: null, actions: { update: { steps: [['/usr/bin/sudo', 'true']] } } }] };
    assert.equal(buildPlan(entry, 'update', { installed: '1', sourceId: 'apt' }, null, 'linux')!.admin, true);
    for (const exe of ['sudo', 'doas', 'pkexec', 'su', 'runas', 'osascript', 'C:\\Windows\\System32\\runas.exe', '/usr/bin/osascript']) assert.ok(isAdminExecutable(exe), exe);
    assert.ok(!isAdminExecutable('brew'));
    assert.ok(!isAdminExecutable('sudoku'));
  });

  test('the binaryUnder paths use only ~/ at the start and no $', () => {
    for (const e of CATALOG)
      for (const s of e.sources)
        for (const p of s.binaryUnder) {
          assert.ok(!p.includes('$'), p);
          assert.ok(!p.includes('~') || p.startsWith('~/'), p);
        }
  });
});

describe('#280 plan: {version} and the digest', () => {
  const wrangler = CATALOG.find((e) => e.id === 'wrangler')!;
  const node = CATALOG.find((e) => e.id === 'node')!;
  const detection = { installed: '4.45.0', sourceId: 'npm' as const };

  test('a version that is not ^\\d+(\\.\\d+){0,3}$ is refused: the token stays and the plan is not runnable', () => {
    for (const bad of [null, '', 'latest', '4.47.2-beta.1', '4.47.2;rm', '1.2.3.4.5', '$(id)', '../x', '4.47.2 ', 'v4.47.2']) {
      const plan = buildPlan(wrangler, 'update', detection, bad, 'darwin')!;
      assert.equal(plan.versionOk, false, String(bad));
      assert.deepEqual(plan.steps, [['npm', 'install', '-g', 'wrangler@{version}']]);
      assert.equal(substituteVersion([['x', '{version}']], bad), null);
    }
    for (const good of ['4', '4.47', '4.47.2', '1.2.764.0']) assert.equal(buildPlan(wrangler, 'update', detection, good, 'darwin')!.versionOk, true, good);
  });

  test('major.minor for uv', () => {
    assert.equal(formatVersion('3.14.0', 'major.minor'), '3.14');
    assert.equal(formatVersion('3', 'major.minor'), null);
  });

  test('a step without {version} needs none', () => {
    const rust = CATALOG.find((e) => e.id === 'rust')!;
    const plan = buildPlan(rust, 'update', { installed: '1.90.0', sourceId: 'rustup' }, null, 'linux')!;
    assert.equal(plan.versionOk, true);
    assert.equal(plan.targetVersion, null);
  });

  test('planDigest is 16 hex, stable, and changes with the steps, the machine or the timeout', () => {
    const a = buildPlan(node, 'update', { installed: '24.10.0', sourceId: 'fnm' }, '24.11.0', 'darwin')!;
    const b = buildPlan(node, 'update', { installed: '24.10.0', sourceId: 'fnm' }, '24.11.0', 'darwin')!;
    const c = buildPlan(node, 'update', { installed: '24.10.0', sourceId: 'fnm' }, '24.12.0', 'darwin')!;
    const d = buildPlan(node, 'update', { installed: '24.10.0', sourceId: 'fnm' }, '24.11.0', 'darwin', { machine: 'ws-exemplo' })!;
    assert.match(a.planDigest, /^[0-9a-f]{16}$/);
    assert.equal(a.planDigest, b.planDigest);
    assert.notEqual(a.planDigest, c.planDigest);
    assert.notEqual(a.planDigest, d.planDigest);
    const base = { machine: 'local', toolId: 'gh', actionId: 'update', sourceId: 'homebrew', steps: [['brew', 'upgrade', 'gh']], timeoutSeconds: 600 };
    assert.equal(planDigest(base), planDigest({ ...base }));
    assert.notEqual(planDigest(base), planDigest({ ...base, timeoutSeconds: 601 }));
    assert.notEqual(planDigest(base), planDigest({ ...base, steps: [['brew', 'upgrade', 'gh', '--force']] }));
  });

  test('install picks the first source whose manager is present, else the first one (blocked later)', () => {
    const gh = CATALOG.find((e) => e.id === 'gh')!;
    const missing = { installed: null, sourceId: null };
    assert.equal(buildPlan(gh, 'install', missing, '2.83.1', 'linux', { hasManager: (s) => s.id === 'apt' })!.sourceId, 'apt');
    assert.equal(buildPlan(gh, 'install', missing, '2.83.1', 'linux', { hasManager: () => false })!.sourceId, 'homebrew');
    assert.equal(buildPlan(gh, 'update', { installed: '2.81.0', sourceId: 'manual' }, '2.83.1', 'darwin'), null);
    assert.equal(buildPlan(gh, 'install', { installed: '2.81.0', sourceId: 'homebrew' }, '2.83.1', 'darwin'), null);
  });
});
