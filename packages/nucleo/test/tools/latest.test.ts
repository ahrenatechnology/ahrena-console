// #280 layer 1, decision 0014 section 2: each latest reader parses its manager's output (fixtures),
// runs only through the injected runner and fetch, and says why when it cannot read.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AWS_CHANGELOG_URL,
  CLAUDE_CHANNEL_URL,
  compareVersions,
  debianUpstream,
  GO_DL_URL,
  parseAptPolicy,
  parseAwsChangelog,
  parseBrewInfo,
  parseClaudeChannel,
  parseFnmLts,
  parseGoDl,
  parseNpmView,
  parseRustupCheck,
  parseUvPythonList,
  parseWingetShow,
  readLatest,
  usesNetwork,
  type LatestDeps,
} from '../../src/tools/latest.ts';
import { fakeFetch, fakeRunner, HOME } from './doubles.ts';

const BREW_FORMULA = JSON.stringify({
  formulae: [{ name: 'gh', full_name: 'gh', versions: { stable: '2.83.1', head: 'HEAD', bottle: true }, installed: [{ version: '2.81.0' }] }],
  casks: [],
});
const BREW_CASK = JSON.stringify({ formulae: [], casks: [{ token: 'gcloud-cli', version: '545.0.0', installed: null }] });
const BREW_CASK_COMMA = JSON.stringify({ formulae: [], casks: [{ token: 'session-manager-plugin', version: '1.2.764.0,abc123' }] });
const APT_POLICY = `gh:
  Installed: 2.80.0
  Candidate: 2.83.1
  Version table:
     2.83.1 500
        500 https://cli.github.com/packages stable/main amd64 Packages
 *** 2.80.0 100
        100 /var/lib/dpkg/status
`;
const APT_GIT = `git:
  Installed: 1:2.43.0-1ubuntu7.3
  Candidate: 1:2.43.0-1ubuntu7.3
`;
const APT_NONE = `foo:
  Installed: (none)
  Candidate: (none)
`;
const WINGET_SHOW = `Found GitHub CLI [GitHub.cli]
Version: 2.83.1
Publisher: GitHub, Inc.
`;
const FNM_LTS = `v20.19.5 (Iron)
v22.21.0 (Jod)
v24.10.0 (Krypton)
v24.11.0 (Krypton)
`;
const RUSTUP_UPDATE = `stable-aarch64-apple-darwin - Update available : 1.90.0 (1159e78c4 2025-09-14) -> 1.91.0 (f8297e351 2025-10-28)
rustup - Up to date : 1.28.2
`;
const RUSTUP_OK = `stable-x86_64-unknown-linux-gnu - Up to date : 1.91.0 (f8297e351 2025-10-28)
rustup - Up to date : 1.28.2
`;
const UV_LIST = `cpython-3.15.0a1-macos-aarch64-none                 <download available>
cpython-3.14.0+freethreaded-macos-aarch64-none      <download available>
cpython-3.14.0-macos-aarch64-none                   <download available>
cpython-3.13.9-macos-aarch64-none                   ${HOME}/.local/share/uv/python/cpython-3.13.9-macos-aarch64-none/bin/python3.13
cpython-3.12.12-macos-aarch64-none                  <download available>
pypy-3.11.13-macos-aarch64-none                     <download available>
`;
const GO_DL = JSON.stringify([
  { version: 'go1.26rc1', stable: false, files: [] },
  { version: 'go1.25.3', stable: true, files: [] },
  { version: 'go1.24.9', stable: true, files: [] },
]);
const AWS_CHANGELOG = `=========
CHANGELOG
=========

2.31.18
=======

* api-change:\`\`ec2\`\`: Update.

2.31.17
=======
`;

describe('#280 latest: parsers over fixture outputs', () => {
  test('brew info --json=v2 (formula and cask)', () => {
    assert.equal(parseBrewInfo(BREW_FORMULA, { formula: 'gh' }), '2.83.1');
    assert.equal(parseBrewInfo(BREW_FORMULA, { formula: 'jq' }), null);
    assert.equal(parseBrewInfo(BREW_CASK, { cask: 'gcloud-cli' }), '545.0.0');
    assert.equal(parseBrewInfo(BREW_CASK_COMMA, { cask: 'session-manager-plugin' }), '1.2.764.0');
    assert.equal(parseBrewInfo('not json', { formula: 'gh' }), null);
  });
  test('apt-cache policy', () => {
    assert.equal(parseAptPolicy(APT_POLICY), '2.83.1');
    assert.equal(parseAptPolicy(APT_GIT), '2.43.0');
    assert.equal(parseAptPolicy(APT_NONE), null);
    assert.equal(debianUpstream('5:28.5.1-1~ubuntu.24.04~noble'), '28.5.1');
  });
  test('winget show', () => assert.equal(parseWingetShow(WINGET_SHOW), '2.83.1'));
  test('npm view', () => {
    assert.equal(parseNpmView('4.47.2\n'), '4.47.2');
    assert.equal(parseNpmView('"0.0.43"'), '0.0.43');
    assert.equal(parseNpmView('npm error code E404'), null);
  });
  test('fnm list-remote --lts', () => assert.equal(parseFnmLts(FNM_LTS), '24.11.0'));
  test('rustup check', () => {
    assert.equal(parseRustupCheck(RUSTUP_UPDATE), '1.91.0');
    assert.equal(parseRustupCheck(RUSTUP_OK), '1.91.0');
    assert.equal(parseRustupCheck('error: no default toolchain'), null);
  });
  test('uv python list: newest stable CPython', () => assert.equal(parseUvPythonList(UV_LIST), '3.14.0'));
  test('go.dev JSON', () => {
    assert.equal(parseGoDl(GO_DL), '1.25.3');
    assert.equal(parseGoDl('<html>'), null);
  });
  test('AWS changelog and the Claude channel', () => {
    assert.equal(parseAwsChangelog(AWS_CHANGELOG), '2.31.18');
    assert.equal(parseClaudeChannel('2.1.312\n'), '2.1.312');
    assert.equal(parseClaudeChannel('<Error>NoSuchKey</Error>'), null);
  });
  test('versions compare numerically', () => {
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.ok(compareVersions('24.10.0', '24.11.0') < 0);
  });
});

describe('#280 latest: readers through the injected runner and fetch', () => {
  const run = fakeRunner({
    '/opt/homebrew/bin/brew info --json=v2 --formula gh': BREW_FORMULA,
    '/opt/homebrew/bin/brew info --json=v2 --cask gcloud-cli': BREW_CASK,
    '/usr/bin/apt-cache policy gh': APT_POLICY,
    '/usr/local/bin/npm view wrangler version': '4.47.2\n',
    '/usr/local/bin/npm view nope version': { code: 1, stdout: '', stderr: 'E404' },
    '/usr/local/bin/fnm list-remote --lts': FNM_LTS,
    '/usr/local/bin/rustup check': { code: 100, stdout: RUSTUP_UPDATE },
    '/usr/local/bin/uv python list': UV_LIST,
    'C:\\winget.exe show --id GitHub.cli --exact --disable-interactivity': WINGET_SHOW,
  });
  const where: Record<string, string> = { brew: '/opt/homebrew/bin/brew', 'apt-cache': '/usr/bin/apt-cache', npm: '/usr/local/bin/npm', fnm: '/usr/local/bin/fnm', rustup: '/usr/local/bin/rustup', uv: '/usr/local/bin/uv', winget: 'C:\\winget.exe' };
  const fetchText = fakeFetch({ [GO_DL_URL]: GO_DL, [AWS_CHANGELOG_URL]: AWS_CHANGELOG, [CLAUDE_CHANNEL_URL]: '2.1.312\n' });
  const deps: LatestDeps = { run, fetchText, path: '/usr/bin', resolve: async (n) => where[n] ?? null };

  test('each kind', async () => {
    assert.deepEqual(await readLatest({ kind: 'homebrew', formula: 'gh' }, deps), { version: '2.83.1', error: null });
    assert.deepEqual(await readLatest({ kind: 'homebrew-cask', cask: 'gcloud-cli' }, deps), { version: '545.0.0', error: null });
    assert.deepEqual(await readLatest({ kind: 'apt', package: 'gh' }, deps), { version: '2.83.1', error: null });
    assert.deepEqual(await readLatest({ kind: 'npm', package: 'wrangler' }, deps), { version: '4.47.2', error: null });
    assert.deepEqual(await readLatest({ kind: 'fnm-lts' }, deps), { version: '24.11.0', error: null });
    assert.deepEqual(await readLatest({ kind: 'rustup' }, deps), { version: '1.91.0', error: null }, 'rustup check exits non-zero with an update');
    assert.deepEqual(await readLatest({ kind: 'uv-python' }, deps), { version: '3.14.0', error: null });
    assert.deepEqual(await readLatest({ kind: 'winget', id: 'GitHub.cli' }, deps), { version: '2.83.1', error: null });
    assert.deepEqual(await readLatest({ kind: 'go-dl' }, deps), { version: '1.25.3', error: null });
    assert.deepEqual(await readLatest({ kind: 'aws-changelog' }, deps), { version: '2.31.18', error: null });
    assert.deepEqual(await readLatest({ kind: 'claude-channel' }, deps), { version: '2.1.312', error: null });
  });

  test('the processes get the login PATH and HOMEBREW_NO_AUTO_UPDATE; a failure says why', async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const spy: LatestDeps = { ...deps, path: '/login/bin', run: async (argv, o) => ((seenEnv = o.env), run(argv, o)) };
    await readLatest({ kind: 'homebrew', formula: 'gh' }, spy);
    assert.equal(seenEnv?.PATH, '/login/bin');
    assert.equal(seenEnv?.HOMEBREW_NO_AUTO_UPDATE, '1');
    assert.deepEqual(await readLatest({ kind: 'npm', package: 'nope' }, deps), { version: null, error: 'command-failed' });
    assert.deepEqual(await readLatest({ kind: 'npm', package: 'x' }, { ...deps, resolve: async () => null }), { version: null, error: 'no-manager' });
    assert.deepEqual(await readLatest({ kind: 'go-dl' }, { ...deps, fetchText: fakeFetch({}) }), { version: null, error: 'network' });
    assert.deepEqual(await readLatest({ kind: 'go-dl' }, { ...deps, fetchText: fakeFetch({ [GO_DL_URL]: '[]' }) }), { version: null, error: 'unparsable' });
  });

  test('Homebrew and apt read local caches; the rest use the network', () => {
    assert.equal(usesNetwork({ kind: 'homebrew', formula: 'gh' }), false);
    assert.equal(usesNetwork({ kind: 'apt', package: 'gh' }), false);
    assert.equal(usesNetwork({ kind: 'npm', package: 'gh' }), true);
    assert.equal(usesNetwork({ kind: 'go-dl' }), true);
  });
});
