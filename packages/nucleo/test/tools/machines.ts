// Fake machines for the Tools service and route tests: a Mac (fnm, Homebrew, the AWS .pkg, Colima)
// and an Ubuntu workstation (apt, the Go tarball, Docker Engine). Every process answers from a table;
// nothing runs.
import { CLAUDE_CHANNEL_URL, AWS_CHANGELOG_URL, GO_DL_URL } from '../../src/tools/latest.ts';
import { MemoryToolChecksStore } from '../../src/tools/store.ts';
import { ToolsService, type ToolsServiceOptions } from '../../src/tools/service.ts';
import type { FetchText } from '../../src/tools/runner.ts';
import { fakeFetch, fakeFs, fakeRunner, HOME, type Answer } from './doubles.ts';

export const NOW = Date.parse('2026-10-21T09:12:00.000Z');
const FNM_NODE = `${HOME}/.local/share/fnm/node-versions/v24.10.0/installation`;
const SHELL_BIN = `${HOME}/.local/state/fnm_multishells/1_2/bin`;
export const MAC_PATH = `${SHELL_BIN}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

const brewInfo = (name: string, version: string) => JSON.stringify({ formulae: [{ name, versions: { stable: version } }], casks: [] });
const caskInfo = (token: string, version: string) => JSON.stringify({ formulae: [], casks: [{ token, version }] });

export function macTables() {
  const links: Record<string, string> = {
    [`${SHELL_BIN}/node`]: `${FNM_NODE}/bin/node`,
    [`${SHELL_BIN}/npm`]: `${FNM_NODE}/lib/node_modules/npm/bin/npm-cli.js`,
    [`${SHELL_BIN}/wrangler`]: `${FNM_NODE}/lib/node_modules/wrangler/bin/wrangler.js`,
    [`${HOME}/.local/bin/claude`]: `${HOME}/.local/share/claude/versions/2.1.299`,
    '/opt/homebrew/bin/brew': '/opt/homebrew/bin/brew',
    '/opt/homebrew/bin/fnm': '/opt/homebrew/Cellar/fnm/1.38.1/bin/fnm',
    '/opt/homebrew/bin/gh': '/opt/homebrew/Cellar/gh/2.81.0/bin/gh',
    '/opt/homebrew/bin/jq': '/opt/homebrew/Cellar/jq/1.8.1/bin/jq',
    '/opt/homebrew/bin/docker': '/opt/homebrew/Cellar/docker/28.5.1/bin/docker',
    '/opt/homebrew/bin/colima': '/opt/homebrew/Cellar/colima/0.9.1/bin/colima',
    '/usr/local/bin/aws': '/usr/local/aws-cli/aws',
    '/usr/bin/git': '/usr/bin/git',
  };
  const run: Record<string, Answer> = {
    [`${SHELL_BIN}/node --version`]: 'v24.10.0\n',
    [`${SHELL_BIN}/wrangler --version`]: ' ⛅️ wrangler 4.45.0\n',
    [`${HOME}/.local/bin/claude --version`]: '2.1.299 (Claude Code)\n',
    '/opt/homebrew/bin/gh --version': 'gh version 2.81.0 (2025-10-01)\n',
    '/opt/homebrew/bin/jq --version': 'jq-1.8.1\n',
    '/opt/homebrew/bin/docker --version': 'Docker version 28.5.1, build e180ab8\n',
    '/opt/homebrew/bin/colima version': 'colima version 0.9.1\n',
    '/usr/local/bin/aws --version': 'aws-cli/2.31.12 Python/3.13.7 Darwin/25.0.0\n',
    '/usr/bin/git --version': 'git version 2.39.5 (Apple Git-154)\n',
    '/usr/bin/sw_vers -productVersion': '26.0.1\n',
    '/opt/homebrew/bin/colima status --json': JSON.stringify({ display_name: 'colima', driver: 'macOS Virtualization.Framework', arch: 'aarch64', runtime: 'docker', cpu: 4, memory: 8589934592, disk: 107374182400 }),
    '/opt/homebrew/bin/docker context show': 'colima\n',
    '/opt/homebrew/bin/docker ps -a --format {{.State}}': 'running\nrunning\nrunning\nexited\nexited\nexited\nexited\ncreated\n',
    // Verificar agora
    '/opt/homebrew/bin/brew update': 'Already up-to-date.\n',
    '/opt/homebrew/bin/brew info --json=v2 --formula gh': brewInfo('gh', '2.83.1'),
    '/opt/homebrew/bin/brew info --json=v2 --formula jq': brewInfo('jq', '1.8.1'),
    '/opt/homebrew/bin/brew info --json=v2 --formula docker': brewInfo('docker', '28.5.1'),
    '/opt/homebrew/bin/brew info --json=v2 --formula colima': brewInfo('colima', '0.9.1'),
    '/opt/homebrew/bin/brew info --json=v2 --formula ripgrep': brewInfo('ripgrep', '15.1.0'),
    '/opt/homebrew/bin/brew info --json=v2 --formula go': brewInfo('go', '1.25.3'),
    '/opt/homebrew/bin/brew info --json=v2 --cask gcloud-cli': caskInfo('gcloud-cli', '545.0.0'),
    '/opt/homebrew/bin/brew info --json=v2 --cask session-manager-plugin': caskInfo('session-manager-plugin', '1.2.764.0'),
    [`${SHELL_BIN}/npm view wrangler version`]: '4.47.2\n',
    [`${SHELL_BIN}/npm view typescript version`]: '5.9.3\n',
    [`${SHELL_BIN}/npm view @playwright/mcp version`]: '0.0.43\n',
    '/opt/homebrew/bin/fnm list-remote --lts': 'v22.21.0 (Jod)\nv24.10.0 (Krypton)\nv24.11.0 (Krypton)\n',
  };
  const fetch: Record<string, string | Error> = { [AWS_CHANGELOG_URL]: '2.31.18\n=======\n', [CLAUDE_CHANNEL_URL]: '2.1.312\n', [GO_DL_URL]: '[{"version":"go1.25.3","stable":true}]' };
  return { links, run, fetch };
}

export function macService(o: { links?: Record<string, string>; run?: Record<string, Answer>; fetch?: FetchText; now?: () => number; extra?: Partial<ToolsServiceOptions> } = {}) {
  const t = macTables();
  const fs = fakeFs({ ...t.links, ...o.links });
  const run = fakeRunner({ ...t.run, ...o.run });
  const fetchText = o.fetch ?? fakeFetch(t.fetch);
  const store = new MemoryToolChecksStore();
  const service = new ToolsService({
    store,
    platform: 'darwin',
    arch: 'arm64',
    home: HOME,
    env: { HOME, PATH: '/usr/bin:/bin' },
    run,
    fetchText,
    loginPath: async () => MAC_PATH,
    ...fs,
    now: o.now ?? (() => NOW),
    probeCacheMs: 0,
    ...o.extra,
  });
  return { service, run, fetchText, store };
}

export const WS_HOME = '/home/exemplo';
export const WS_PATH = `${WS_HOME}/.local/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin`;

export function wsService(o: { links?: Record<string, string>; run?: Record<string, Answer> } = {}) {
  const fs = fakeFs({
    '/usr/bin/gh': '/usr/bin/gh',
    '/usr/bin/docker': '/usr/bin/docker',
    '/usr/bin/apt-get': '/usr/bin/apt-get',
    '/usr/bin/apt-cache': '/usr/bin/apt-cache',
    '/usr/bin/systemctl': '/usr/bin/systemctl',
    '/usr/local/go/bin/go': '/usr/local/go/bin/go',
    ...o.links,
  });
  const run = fakeRunner({
    '/usr/bin/gh --version': 'gh version 2.80.0 (2025-09-01)\n',
    '/usr/bin/docker --version': 'Docker version 28.5.1, build e180ab8\n',
    '/usr/local/go/bin/go version': 'go version go1.25.1 linux/amd64\n',
    '/usr/bin/docker context show': 'default\n',
    '/usr/bin/systemctl --user cat docker.service': { code: 1, stderr: 'No files found for docker.service.' },
    '/usr/bin/systemctl is-active docker': { code: 3, stdout: 'inactive\n' },
    '/usr/bin/apt-cache policy gh': 'gh:\n  Installed: 2.80.0\n  Candidate: 2.83.1\n',
    '/usr/bin/apt-cache policy docker-ce-cli': 'docker-ce-cli:\n  Installed: 5:28.5.1-1~ubuntu.24.04~noble\n  Candidate: 5:28.5.1-1~ubuntu.24.04~noble\n',
    ...o.run,
  });
  const store = new MemoryToolChecksStore();
  const service = new ToolsService({
    store,
    platform: 'linux',
    arch: 'x64',
    home: WS_HOME,
    env: { HOME: WS_HOME, PATH: '/usr/bin:/bin' },
    run,
    fetchText: fakeFetch({ [GO_DL_URL]: '[{"version":"go1.25.3","stable":true}]' }),
    loginPath: async () => WS_PATH,
    ...fs,
    readFile: async () => 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\n',
    mtime: async () => NOW - 86_400_000,
    now: () => NOW,
    probeCacheMs: 0,
  });
  return { service, run, store };
}
