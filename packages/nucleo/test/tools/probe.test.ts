// #280 layer 1, decision 0014 section 2: the login PATH, `which` in JS, the probe's version and the
// source detected by the binary's realpath (Homebrew, fnm, npm under the active Node, manual).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CATALOG } from '../../src/tools/catalog.ts';
import { expandHome, loginShellArgv, mergePaths, parseLoginPath, readLoginPath, which, LoginPath } from '../../src/tools/login-path.ts';
import { detectSource, isUnder, npmPrefixOf, parseVersion, probeAll, probeTool } from '../../src/tools/probe.ts';
import { toolsEnv } from '../../src/tools/runner.ts';
import { fakeFs, fakeRunner, HOME } from './doubles.ts';

const entry = (id: string) => CATALOG.find((e) => e.id === id)!;
const PATH = `${HOME}/.local/state/fnm_multishells/1_2/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

describe('#280 login PATH', () => {
  test('the login shell runs once with a fixed argv; the PATH between the markers is merged with the usual folders', async () => {
    const run = fakeRunner({ [loginShellArgv('/bin/zsh').join(' ')]: `banner\n__AHRENA_PATH__/a:/b:/a__AHRENA_PATH__` });
    const lp = new LoginPath({ run, platform: 'darwin', home: HOME, env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/b' } });
    assert.equal(await lp.get(), `/a:/b:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin`);
    await lp.get();
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.calls[0], ['/bin/zsh', '-ilc', `printf '%s' "__AHRENA_PATH__$PATH__AHRENA_PATH__"`]);
  });

  test('a shell that fails falls back to the process PATH', async () => {
    const run = fakeRunner({});
    assert.equal(await readLoginPath({ run, platform: 'linux', home: HOME, env: { SHELL: '/bin/bash', PATH: '/usr/bin' } }), `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin`);
    assert.equal(parseLoginPath('no markers'), null);
    assert.equal(mergePaths(':', 'a::b', null, 'b:c'), 'a:b:c');
  });

  test('Windows reads Path without a shell', async () => {
    const run = fakeRunner({});
    assert.equal(await readLoginPath({ run, platform: 'win32', home: 'C:\\Users\\exemplo', env: { Path: 'C:\\x;C:\\y' } }), 'C:\\x;C:\\y');
    assert.equal(run.calls.length, 0);
  });

  test('which: the first executable in the PATH, PATHEXT on Windows; never a path with a slash', async () => {
    const fs = fakeFs({ '/opt/homebrew/bin/gh': '/opt/homebrew/Cellar/gh/2.81.0/bin/gh', '/usr/bin/gh': '/usr/bin/gh' });
    assert.equal(await which('gh', PATH, { platform: 'darwin', isExecutable: fs.isExecutable }), '/opt/homebrew/bin/gh');
    assert.equal(await which('nope', PATH, { platform: 'darwin', isExecutable: fs.isExecutable }), null);
    assert.equal(await which('../gh', PATH, { platform: 'darwin', isExecutable: async () => true }), null);
    const win = fakeFs({ 'C:\\tools\\gh.exe': 'C:\\tools\\gh.exe' });
    assert.equal(await which('gh', 'C:\\x;C:\\tools', { platform: 'win32', isExecutable: win.isExecutable }), 'C:\\tools\\gh.exe');
  });

  test('win32: the extensionless npm shim is skipped when PATHEXT entries exist', async () => {
    const win = fakeFs({ 'C:\\npm\\wrangler': 'C:\\npm\\wrangler', 'C:\\npm\\wrangler.cmd': 'C:\\npm\\wrangler.cmd' });
    assert.equal(await which('wrangler', 'C:\\npm', { platform: 'win32', isExecutable: win.isExecutable }), 'C:\\npm\\wrangler.cmd');
    assert.equal(await which('wrangler', 'C:\\npm', { platform: 'win32', pathExt: ';', isExecutable: win.isExecutable }), 'C:\\npm\\wrangler');
    const only = fakeFs({ 'C:\\npm\\wrangler': 'C:\\npm\\wrangler' });
    assert.equal(await which('wrangler', 'C:\\npm', { platform: 'win32', isExecutable: only.isExecutable }), null);
  });

  test('~ is expanded in code', () => {
    assert.equal(expandHome('~/.local/share/fnm', HOME, 'darwin'), `${HOME}/.local/share/fnm`);
    assert.equal(expandHome('~', HOME, 'darwin'), HOME);
    assert.equal(expandHome('/opt/homebrew', HOME, 'darwin'), '/opt/homebrew');
  });

  test('the tools environment drops AHRENA_CONSOLE_* and sets the login PATH and the non-interactive flags', () => {
    const env = toolsEnv('/a:/b', { AHRENA_CONSOLE_CORE_PORT: '1', HOME, PATH: '/usr/bin' });
    assert.deepEqual(env, { HOME, PATH: '/a:/b', NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1' });
  });
});

describe('#280 version parsing', () => {
  const cases: [string, string, string | null][] = [
    ['claude', '2.1.299 (Claude Code)\n', '2.1.299'],
    ['git', 'git version 2.51.1\n', '2.51.1'],
    ['git', 'git version 2.51.0.windows.1\n', '2.51.0'],
    ['gh', 'gh version 2.81.0 (2025-10-01)\nhttps://github.com/cli/cli/releases/tag/v2.81.0\n', '2.81.0'],
    ['aws', 'aws-cli/2.31.12 Python/3.13.7 Darwin/25.0.0 exe/arm64\n', '2.31.12'],
    ['session-manager-plugin', '1.2.764.0\n', '1.2.764.0'],
    ['wrangler', '\n ⛅️ wrangler 4.45.0\n───────────\n', '4.45.0'],
    ['gcloud', 'Google Cloud SDK 545.0.0\nbq 2.1.25\ncore 2025.10.24\n', '545.0.0'],
    ['docker', 'Docker version 28.5.1, build e180ab8\n', '28.5.1'],
    ['colima', 'colima version 0.9.1\ngit commit: 4d8d2a8\n', '0.9.1'],
    ['jq', 'jq-1.8.1\n', '1.8.1'],
    ['rg', 'ripgrep 15.1.0\n\nfeatures:+pcre2\n', '15.1.0'],
    ['node', 'v24.10.0\n', '24.10.0'],
    ['tsc', 'Version 5.9.3\n', '5.9.3'],
    ['python', 'Python 3.13.9\n', '3.13.9'],
    ['rust', 'rustc 1.91.0 (f8297e351 2025-10-28)\n', '1.91.0'],
    ['go', 'go version go1.25.3 darwin/arm64\n', '1.25.3'],
    ['container-podman', 'podman version 5.6.2\n', '5.6.2'],
    ['gh', 'command not found\n', null],
  ];
  for (const [id, out, v] of cases) test(`${id}: ${JSON.stringify(out.split('\n')[0])}`, () => assert.equal(parseVersion(entry(id).probe!, out), v));
});

describe('#280 source detection', () => {
  const ctx = { platform: 'darwin' as const, arch: 'arm64', home: HOME, npmPrefix: `${HOME}/.local/share/fnm/node-versions/v24.10.0/installation` };

  test('Homebrew, fnm, rustup, uv, the native Claude installer, the official AWS .pkg and manual', () => {
    assert.equal(detectSource(entry('gh'), '/opt/homebrew/Cellar/gh/2.81.0/bin/gh', ctx), 'homebrew');
    assert.equal(detectSource(entry('gh'), '/usr/local/Cellar/gh/2.81.0/bin/gh', ctx), 'homebrew');
    assert.equal(detectSource(entry('gcloud'), '/opt/homebrew/Caskroom/gcloud-cli/545.0.0/google-cloud-sdk/bin/gcloud', ctx), 'homebrew');
    assert.equal(detectSource(entry('node'), `${HOME}/.local/share/fnm/node-versions/v24.10.0/installation/bin/node`, ctx), 'fnm');
    assert.equal(detectSource(entry('node'), `${HOME}/Library/Application Support/fnm/node-versions/v24.10.0/installation/bin/node`, ctx), 'fnm');
    assert.equal(detectSource(entry('node'), '/opt/homebrew/Cellar/node/24.10.0/bin/node', ctx), 'manual');
    assert.equal(detectSource(entry('rust'), `${HOME}/.cargo/bin/rustup`, ctx), 'rustup');
    assert.equal(detectSource(entry('python'), `${HOME}/.local/share/uv/python/cpython-3.13.9-macos-aarch64-none/bin/python3.13`, ctx), 'uv');
    assert.equal(detectSource(entry('python'), `${HOME}/.pyenv/shims/python3`, ctx), 'pyenv');
    assert.equal(detectSource(entry('python'), '/usr/bin/python3', ctx), 'manual');
    assert.equal(detectSource(entry('claude'), `${HOME}/.local/share/claude/versions/2.1.299`, ctx), 'native');
    assert.equal(detectSource(entry('aws'), '/usr/local/aws-cli/aws', ctx), 'official');
    assert.equal(detectSource(entry('git'), '/usr/bin/git', ctx), 'manual');
    // A cask whose payload is a .pkg: the realpath is outside Homebrew, the link is not.
    assert.equal(detectSource(entry('session-manager-plugin'), '/usr/local/sessionmanagerplugin/bin/session-manager-plugin', ctx, '/opt/homebrew/bin/session-manager-plugin'), 'homebrew');
    assert.equal(detectSource(entry('session-manager-plugin'), '/usr/local/sessionmanagerplugin/bin/session-manager-plugin', ctx, '/usr/local/bin/session-manager-plugin'), 'manual');
    // The realpath wins over the link: the AWS .pkg linked from /usr/local/bin stays official.
    assert.equal(detectSource(entry('aws'), '/usr/local/aws-cli/aws', ctx, '/opt/homebrew/bin/aws'), 'official');
    // A prefix is a folder, not a string prefix.
    assert.equal(detectSource(entry('gh'), '/opt/homebrewx/bin/gh', ctx), 'manual');
  });

  test('npm global under the active Node, and Homebrew Node puts it under /opt/homebrew', () => {
    assert.equal(detectSource(entry('wrangler'), `${ctx.npmPrefix}/lib/node_modules/wrangler/bin/wrangler.js`, ctx), 'npm');
    assert.equal(detectSource(entry('wrangler'), '/opt/homebrew/lib/node_modules/wrangler/bin/wrangler.js', { ...ctx, npmPrefix: '/opt/homebrew' }), 'npm');
    assert.equal(detectSource(entry('wrangler'), '/somewhere/wrangler', { ...ctx, npmPrefix: null }), 'manual');
    assert.equal(npmPrefixOf(`${HOME}/.local/share/fnm/node-versions/v24.10.0/installation/bin/node`, 'darwin'), `${HOME}/.local/share/fnm/node-versions/v24.10.0/installation`);
    assert.equal(npmPrefixOf('C:\\fnm\\node-versions\\v24\\installation\\node.exe', 'win32'), 'C:\\fnm\\node-versions\\v24\\installation');
  });

  test('Linux: apt, Linuxbrew, the Go tarball by arch, the .deb plugin', () => {
    const linux = { platform: 'linux' as const, arch: 'x64', home: '/home/exemplo', npmPrefix: null };
    assert.equal(detectSource(entry('gh'), '/usr/bin/gh', linux), 'apt');
    assert.equal(detectSource(entry('gh'), '/home/linuxbrew/.linuxbrew/Cellar/gh/2.83.1/bin/gh', linux), 'homebrew');
    assert.equal(detectSource(entry('go'), '/usr/local/go/bin/go', linux), 'official');
    assert.equal(detectSource(entry('session-manager-plugin'), '/usr/local/sessionmanagerplugin/bin/session-manager-plugin', linux), 'official');
    assert.equal(detectSource(entry('gcloud'), '/usr/lib/google-cloud-sdk/bin/gcloud', linux), 'apt');
    assert.equal(detectSource(entry('python'), '/usr/bin/python3.12', linux), 'apt');
  });

  test('Windows paths compare case-insensitively with either slash', () => {
    assert.ok(isUnder('C:\\Users\\Exemplo\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.exe', 'C:/Users/exemplo/AppData/Local/Microsoft/WinGet', 'win32'));
    assert.ok(!isUnder('/opt/Homebrew/bin/gh', '/opt/homebrew', 'darwin'));
  });

  test('a container runtime takes the first source of the platform wherever it is', () => {
    assert.equal(detectSource(entry('container-colima'), '/somewhere/colima', ctx), 'homebrew');
    assert.equal(detectSource(entry('container-docker-desktop'), '/Applications/Docker.app/Contents/Resources/bin/docker', ctx), 'manual');
  });
});

describe('#280 probe', () => {
  const nodeReal = `${HOME}/.local/share/fnm/node-versions/v24.10.0/installation/bin/node`;
  const fs = fakeFs({
    [`${HOME}/.local/state/fnm_multishells/1_2/bin/node`]: nodeReal,
    [`${HOME}/.local/state/fnm_multishells/1_2/bin/wrangler`]: `${HOME}/.local/share/fnm/node-versions/v24.10.0/installation/lib/node_modules/wrangler/bin/wrangler.js`,
    '/opt/homebrew/bin/gh': '/opt/homebrew/Cellar/gh/2.81.0/bin/gh',
    '/usr/local/bin/aws': '/usr/local/aws-cli/aws',
    '/opt/homebrew/bin/jq': '/opt/homebrew/Cellar/jq/1.8.1/bin/jq',
  });
  const run = fakeRunner({
    [`${HOME}/.local/state/fnm_multishells/1_2/bin/node --version`]: 'v24.10.0\n',
    [`${HOME}/.local/state/fnm_multishells/1_2/bin/wrangler --version`]: ' ⛅️ wrangler 4.45.0\n',
    '/opt/homebrew/bin/gh --version': 'gh version 2.81.0 (2025-10-01)\n',
    '/usr/local/bin/aws --version': { stderr: 'aws-cli/2.31.12 Python/3.13.7 Darwin/25.0.0\n' },
    '/opt/homebrew/bin/jq --version': { code: 1, stdout: 'garbage' },
  });
  const ctx = { platform: 'darwin' as const, arch: 'arm64', home: HOME, path: PATH, run, ...fs };

  test('probeAll reads Node first and finds the global npm package under its prefix; each probe is the fixed argv with the full path', async () => {
    const d = await probeAll(CATALOG.filter((e) => ['node', 'wrangler', 'gh', 'aws', 'jq', 'git', 'colima'].includes(e.id)), ctx);
    assert.deepEqual(d.get('node'), { toolId: 'node', installed: '24.10.0', binaryPath: `${HOME}/.local/state/fnm_multishells/1_2/bin/node`, realPath: nodeReal, sourceId: 'fnm', probeError: null });
    assert.equal(d.get('wrangler')!.sourceId, 'npm');
    assert.equal(d.get('wrangler')!.installed, '4.45.0');
    assert.equal(d.get('gh')!.sourceId, 'homebrew');
    assert.equal(d.get('aws')!.installed, '2.31.12', 'version read from stderr too');
    assert.equal(d.get('aws')!.sourceId, 'official');
    assert.deepEqual([d.get('jq')!.installed, d.get('jq')!.probeError], [null, 'no-version']);
    assert.deepEqual([d.get('git')!.installed, d.get('git')!.sourceId, d.get('git')!.probeError], [null, null, null], 'missing');
    assert.ok(run.calls.every((argv) => argv[0]!.startsWith('/')), 'always the full path');
  });

  test('win32: a .cmd shim is never spawned; the tool reads as manual with a probe error, not failed', async () => {
    const wfs = fakeFs({ 'C:\\npm\\wrangler': 'C:\\npm\\wrangler', 'C:\\npm\\wrangler.cmd': 'C:\\npm\\wrangler.cmd' });
    const wrun = fakeRunner({});
    const d = await probeTool(entry('wrangler'), { platform: 'win32', arch: 'x64', home: 'C:\\Users\\exemplo', path: 'C:\\npm', run: wrun, ...wfs });
    assert.equal(wrun.calls.length, 0);
    assert.equal(d.binaryPath, 'C:\\npm\\wrangler.cmd');
    assert.equal(d.sourceId, 'manual');
    assert.equal(d.installed, null);
    assert.equal(d.probeError, 'shim-not-readable');
  });

  test('an entry for another platform is not probed', async () => {
    const before = run.calls.length;
    const d = await probeTool(entry('colima'), { ...ctx, platform: 'linux' });
    assert.equal(d.installed, null);
    assert.equal(run.calls.length, before);
  });
});

describe('#280 systemFetchText', () => {
  test('refuses redirects and caps the body at 2 MB', async () => {
    const { systemFetchText } = await import('../../src/tools/runner.ts');
    const real = globalThis.fetch;
    let seen: RequestInit | undefined;
    try {
      globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        seen = init;
        return new Response('x'.repeat(3 * 1024 * 1024));
      }) as typeof fetch;
      await assert.rejects(systemFetchText('https://example.test/a', 1000), /too large/);
      assert.equal(seen?.redirect, 'error');
      globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
      assert.equal(await systemFetchText('https://example.test/a', 1000), 'ok');
    } finally {
      globalThis.fetch = real;
    }
  });
});
