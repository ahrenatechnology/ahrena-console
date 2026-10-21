// The Tools catalog (#280, decision 0014 section 1): every tool the núcleo reads, where each install
// can come from, and the only commands it may ever build for it. Changing this file is a PR with a
// security review; nothing typed on a screen or written in a config file reaches a step.
//
// - Each step is an argv list: the executable and its arguments, one by one. No shell: no `&&`, `|`,
//   `;`, `~`, `$VAR`, globs or quotes in any item (a test checks every entry).
// - The only value that is not written here is the version, the literal token `{version}` (a whole
//   item or inside one, `wrangler@{version}`), replaced by plan.ts with a version that matches
//   `VERSION_PATTERN` and comes from a latest reader (latest.ts).
// - `admin: true` marks an action that asks for an administrator password (sudo, a .pkg, a system
//   service). The núcleo never runs it: the screen shows the command for the person to run.
// - `binaryUnder`: where a source puts the binary, matched against the realpath of the binary found on
//   the login PATH (probe.ts). `~/` is expanded in code; `{npmPrefix}` is the active Node's prefix.
// - On-screen strings (labels, notes, the manager label of each source) are pt-BR; the rest English.

export const PLATFORMS = ['darwin', 'linux', 'win32'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Arch = 'x64' | 'arm64';
export type ToolGroup = 'cli' | 'runtime' | 'container' | 'mcp';
export const ACTION_IDS = ['install', 'update', 'start', 'stop'] as const;
export type ActionId = (typeof ACTION_IDS)[number];
export type SourceId = 'homebrew' | 'apt' | 'winget' | 'npm' | 'fnm' | 'uv' | 'pyenv' | 'rustup' | 'native' | 'official';
/** A detected install: one of the catalog's sources, or `manual` when none matches. */
export type DetectedSourceId = SourceId | 'manual';
export type ContainerRuntimeId = 'colima' | 'docker-engine' | 'docker-rootless' | 'podman' | 'docker-desktop';

/** The only version a step accepts (decision 0014 section 1). */
export const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;
/** The placeholder plan.ts replaces with a checked version. */
export const VERSION_TOKEN = '{version}';
/** Executables that ask for a password: refused even when an entry forgets `admin: true`. */
export const ADMIN_EXECUTABLES = ['sudo', 'doas', 'pkexec', 'su', 'runas', 'osascript'] as const;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MAX_TIMEOUT_SECONDS = 1800;

export type LatestSpec =
  | { kind: 'homebrew'; formula: string }
  | { kind: 'homebrew-cask'; cask: string }
  | { kind: 'apt'; package: string }
  | { kind: 'winget'; id: string }
  | { kind: 'npm'; package: string }
  | { kind: 'fnm-lts' }
  | { kind: 'rustup' }
  | { kind: 'uv-python' }
  | { kind: 'claude-channel' }
  | { kind: 'go-dl' }
  | { kind: 'aws-changelog' };

export interface ToolAction {
  readonly steps: readonly (readonly string[])[];
  /** Asks for an administrator password: never run by the núcleo, shown to copy. */
  readonly admin?: boolean;
  readonly timeoutSeconds?: number;
  /** How `{version}` is written: the whole version (default) or `major.minor` (uv's Python). */
  readonly versionFormat?: 'full' | 'major.minor';
}

export interface ToolSource {
  readonly id: SourceId;
  /** pt-BR: the "De onde veio" / "Quem gerencia" column. */
  readonly label: string;
  readonly platforms: readonly Platform[];
  /** Only on these CPU architectures (an official tarball per arch); all when absent. */
  readonly arch?: readonly Arch[];
  readonly binaryUnder: readonly string[];
  /** The executable that must be on the login PATH for this source's actions (`no-manager` otherwise). */
  readonly manager?: string;
  readonly latest: LatestSpec | null;
  readonly actions: Readonly<Partial<Record<ActionId, ToolAction>>>;
}

export interface ToolProbe {
  readonly argv: readonly string[];
  /** The first group is the installed version. */
  readonly version: RegExp;
}

export interface ToolEntry {
  readonly id: string;
  readonly label: string;
  readonly group: ToolGroup;
  /** `null` for an MCP server (read from Claude Code's config, layer 3). */
  readonly probe: ToolProbe | null;
  /** Only on these platforms; elsewhere the state is `na` with `naNote`. All when absent. */
  readonly platforms?: readonly Platform[];
  readonly note?: string;
  readonly naNote?: string;
  /** Container runtimes: which runtime this entry is in the containers card. */
  readonly container?: ContainerRuntimeId;
  /**
   * A service rather than a package (container runtimes): when installed, the source is the first of
   * the platform, wherever the binary is, because start and stop do not depend on how it was installed.
   */
  readonly anySourcePath?: boolean;
  readonly sources: readonly ToolSource[];
}

const ALL: readonly Platform[] = PLATFORMS;
const POSIX: readonly Platform[] = ['darwin', 'linux'];

export const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local/Cellar', '/usr/local/Caskroom', '/usr/local/Homebrew', '/home/linuxbrew/.linuxbrew'] as const;
export const FNM_DIRS = ['~/.local/share/fnm', '~/Library/Application Support/fnm', '~/.fnm'] as const;
export const RUSTUP_DIRS = ['~/.cargo/bin', '~/.rustup'] as const;
export const UV_DIRS = ['~/.local/share/uv'] as const;
export const NATIVE_CLAUDE_DIRS = ['~/.local/share/claude', '~/.claude/local'] as const;
export const APT_PREFIXES = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share'] as const;
export const NPM_PREFIX_TOKEN = '{npmPrefix}';

function brew(formula: string, platforms: readonly Platform[] = POSIX): ToolSource {
  return {
    id: 'homebrew',
    label: 'Homebrew',
    platforms,
    binaryUnder: HOMEBREW_PREFIXES,
    manager: 'brew',
    latest: { kind: 'homebrew', formula },
    actions: {
      install: { steps: [['brew', 'install', formula]], timeoutSeconds: 600 },
      update: { steps: [['brew', 'upgrade', formula]], timeoutSeconds: 600 },
    },
  };
}

function brewCask(cask: string): ToolSource {
  return {
    id: 'homebrew',
    label: 'Homebrew (cask)',
    platforms: ['darwin'],
    binaryUnder: HOMEBREW_PREFIXES,
    manager: 'brew',
    latest: { kind: 'homebrew-cask', cask },
    actions: {
      install: { steps: [['brew', 'install', '--cask', cask]], timeoutSeconds: 900 },
      update: { steps: [['brew', 'upgrade', '--cask', cask]], timeoutSeconds: 900 },
    },
  };
}

/** apt needs sudo for everything: both actions are shown to copy. */
function apt(pkg: string, label = 'apt · Ubuntu'): ToolSource {
  return {
    id: 'apt',
    label,
    platforms: ['linux'],
    binaryUnder: APT_PREFIXES,
    manager: 'apt-get',
    latest: { kind: 'apt', package: pkg },
    actions: {
      install: { steps: [['sudo', 'apt-get', 'install', pkg]], admin: true },
      update: { steps: [['sudo', 'apt-get', 'install', '--only-upgrade', pkg]], admin: true },
    },
  };
}

function npmGlobal(pkg: string): ToolSource {
  const steps = [['npm', 'install', '-g', `${pkg}@${VERSION_TOKEN}`]];
  return {
    id: 'npm',
    label: 'npm global',
    platforms: ALL,
    binaryUnder: [NPM_PREFIX_TOKEN],
    manager: 'npm',
    latest: { kind: 'npm', package: pkg },
    actions: { install: { steps, timeoutSeconds: 600 }, update: { steps, timeoutSeconds: 600 } },
  };
}

function winget(id: string): ToolSource {
  return {
    id: 'winget',
    label: 'winget',
    platforms: ['win32'],
    binaryUnder: ['~/AppData/Local/Microsoft/WinGet'],
    manager: 'winget',
    latest: { kind: 'winget', id },
    actions: {
      install: { steps: [['winget', 'install', '--id', id, '--scope', 'user', '--silent']], timeoutSeconds: 600 },
      update: { steps: [['winget', 'upgrade', '--id', id, '--scope', 'user', '--silent']], timeoutSeconds: 600 },
    },
  };
}

const goTarball = (arch: Arch, goArch: string): ToolSource => ({
  id: 'official',
  label: 'tarball oficial em /usr/local/go',
  platforms: ['linux'],
  arch: [arch],
  binaryUnder: ['/usr/local/go'],
  latest: { kind: 'go-dl' },
  actions: {
    update: {
      steps: [
        ['sudo', 'rm', '-rf', '/usr/local/go'],
        ['sudo', 'tar', '-C', '/usr/local', '-xzf', `go${VERSION_TOKEN}.linux-${goArch}.tar.gz`],
      ],
      admin: true,
    },
  },
});

const fnmSteps = [
  ['fnm', 'install', VERSION_TOKEN],
  ['fnm', 'default', VERSION_TOKEN],
];
const uvSteps = [['uv', 'python', 'install', VERSION_TOKEN]];

export const CATALOG: readonly ToolEntry[] = [
  // ---- CLIs ------------------------------------------------------------------------------------
  {
    id: 'claude',
    label: 'Claude Code',
    group: 'cli',
    probe: { argv: ['claude', '--version'], version: /(\d+\.\d+\.\d+)/ },
    sources: [
      {
        id: 'native',
        label: 'instalador nativo',
        platforms: ALL,
        binaryUnder: NATIVE_CLAUDE_DIRS,
        manager: 'claude',
        latest: { kind: 'claude-channel' },
        actions: { update: { steps: [['claude', 'update']], timeoutSeconds: 600 } },
      },
    ],
  },
  {
    id: 'git',
    label: 'Git',
    group: 'cli',
    probe: { argv: ['git', '--version'], version: /git version (\d+(?:\.\d+)+)/ },
    sources: [brew('git'), apt('git')],
  },
  {
    id: 'gh',
    label: 'GitHub CLI',
    group: 'cli',
    probe: { argv: ['gh', '--version'], version: /gh version (\d+(?:\.\d+)+)/ },
    sources: [brew('gh'), apt('gh', 'apt · repositório do GitHub CLI'), winget('GitHub.cli')],
  },
  {
    id: 'aws',
    label: 'AWS CLI',
    group: 'cli',
    probe: { argv: ['aws', '--version'], version: /aws-cli\/(\d+(?:\.\d+)+)/ },
    sources: [
      brew('awscli'),
      {
        id: 'official',
        label: 'instalador oficial (.pkg)',
        platforms: ['darwin'],
        binaryUnder: ['/usr/local/aws-cli'],
        latest: { kind: 'aws-changelog' },
        actions: {
          install: { steps: [['sudo', 'installer', '-pkg', 'AWSCLIV2.pkg', '-target', '/']], admin: true },
          update: { steps: [['sudo', 'installer', '-pkg', 'AWSCLIV2.pkg', '-target', '/']], admin: true },
        },
      },
      {
        id: 'official',
        label: 'instalador oficial (.zip)',
        platforms: ['linux'],
        binaryUnder: ['/usr/local/aws-cli'],
        latest: { kind: 'aws-changelog' },
        actions: {
          install: { steps: [['sudo', './aws/install']], admin: true },
          update: { steps: [['sudo', './aws/install', '--bin-dir', '/usr/local/bin', '--install-dir', '/usr/local/aws-cli', '--update']], admin: true },
        },
      },
    ],
  },
  {
    id: 'session-manager-plugin',
    label: 'Plugin do SSM da AWS',
    group: 'cli',
    probe: { argv: ['session-manager-plugin', '--version'], version: /(\d+(?:\.\d+){1,3})/ },
    sources: [
      brewCask('session-manager-plugin'),
      {
        id: 'official',
        label: 'pacote .deb',
        platforms: ['linux'],
        binaryUnder: ['/usr/local/sessionmanagerplugin'],
        latest: null,
        actions: {
          install: { steps: [['sudo', 'dpkg', '-i', 'session-manager-plugin.deb']], admin: true },
          update: { steps: [['sudo', 'dpkg', '-i', 'session-manager-plugin.deb']], admin: true },
        },
      },
    ],
  },
  {
    id: 'wrangler',
    label: 'Cloudflare Wrangler',
    group: 'cli',
    probe: { argv: ['wrangler', '--version'], version: /(\d+\.\d+\.\d+)/ },
    sources: [npmGlobal('wrangler')],
  },
  {
    id: 'gcloud',
    label: 'Google Cloud CLI',
    group: 'cli',
    probe: { argv: ['gcloud', '--version'], version: /Google Cloud SDK (\d+(?:\.\d+)+)/ },
    sources: [brewCask('gcloud-cli'), apt('google-cloud-cli', 'apt · repositório do Google')],
  },
  {
    id: 'docker',
    label: 'Docker CLI',
    group: 'cli',
    probe: { argv: ['docker', '--version'], version: /Docker version (\d+(?:\.\d+)+)/ },
    sources: [brew('docker'), apt('docker-ce-cli', 'apt · Docker Engine')],
  },
  {
    id: 'colima',
    label: 'Colima',
    group: 'cli',
    platforms: ['darwin'],
    naNote: 'só no macOS',
    probe: { argv: ['colima', 'version'], version: /colima version v?(\d+(?:\.\d+)+)/ },
    sources: [brew('colima', ['darwin'])],
  },
  {
    id: 'jq',
    label: 'jq',
    group: 'cli',
    probe: { argv: ['jq', '--version'], version: /jq-(\d+(?:\.\d+)+)/ },
    sources: [brew('jq'), apt('jq')],
  },
  {
    id: 'rg',
    label: 'ripgrep',
    group: 'cli',
    probe: { argv: ['rg', '--version'], version: /ripgrep (\d+(?:\.\d+)+)/ },
    sources: [brew('ripgrep'), apt('ripgrep')],
  },

  // ---- Runtimes --------------------------------------------------------------------------------
  {
    id: 'node',
    label: 'Node.js',
    group: 'runtime',
    probe: { argv: ['node', '--version'], version: /v(\d+\.\d+\.\d+)/ },
    sources: [
      {
        id: 'fnm',
        label: 'fnm',
        platforms: ALL,
        binaryUnder: FNM_DIRS,
        manager: 'fnm',
        latest: { kind: 'fnm-lts' },
        actions: { install: { steps: fnmSteps, timeoutSeconds: 900 }, update: { steps: fnmSteps, timeoutSeconds: 900 } },
      },
    ],
  },
  {
    id: 'tsc',
    label: 'TypeScript',
    group: 'runtime',
    note: 'o de cada projeto fica no package.json dele',
    probe: { argv: ['tsc', '--version'], version: /Version (\d+(?:\.\d+)+)/ },
    sources: [npmGlobal('typescript')],
  },
  {
    id: 'python',
    label: 'Python',
    group: 'runtime',
    note: 'não troca o Python dos projetos',
    probe: { argv: ['python3', '--version'], version: /Python (\d+\.\d+\.\d+)/ },
    sources: [
      {
        id: 'uv',
        label: 'uv',
        platforms: ALL,
        binaryUnder: UV_DIRS,
        manager: 'uv',
        latest: { kind: 'uv-python' },
        actions: {
          install: { steps: uvSteps, timeoutSeconds: 900, versionFormat: 'major.minor' },
          update: { steps: uvSteps, timeoutSeconds: 900, versionFormat: 'major.minor' },
        },
      },
      // Read only: the console shows it and never changes it.
      { id: 'pyenv', label: 'pyenv', platforms: POSIX, binaryUnder: ['~/.pyenv'], latest: null, actions: {} },
      { id: 'apt', label: 'apt · Python do sistema', platforms: ['linux'], binaryUnder: APT_PREFIXES, latest: null, actions: {} },
    ],
  },
  {
    id: 'rust',
    label: 'Rust',
    group: 'runtime',
    probe: { argv: ['rustc', '--version'], version: /rustc (\d+\.\d+\.\d+)/ },
    sources: [
      {
        id: 'rustup',
        label: 'rustup · stable',
        platforms: ALL,
        binaryUnder: RUSTUP_DIRS,
        manager: 'rustup',
        latest: { kind: 'rustup' },
        actions: { update: { steps: [['rustup', 'update', 'stable']], timeoutSeconds: 900 } },
      },
    ],
  },
  {
    id: 'go',
    label: 'Go',
    group: 'runtime',
    note: 'o toolchain do go.mod baixa sozinho',
    probe: { argv: ['go', 'version'], version: /go version go(\d+\.\d+(?:\.\d+)?)/ },
    sources: [brew('go'), goTarball('x64', 'amd64'), goTarball('arm64', 'arm64')],
  },

  // ---- Container runtimes (the containers card, decision 0014 section 7) ------------------------
  {
    id: 'container-colima',
    label: 'Colima',
    group: 'container',
    container: 'colima',
    platforms: ['darwin'],
    anySourcePath: true,
    probe: { argv: ['colima', 'version'], version: /colima version v?(\d+(?:\.\d+)+)/ },
    sources: [
      {
        id: 'homebrew',
        label: 'Homebrew',
        platforms: ['darwin'],
        binaryUnder: HOMEBREW_PREFIXES,
        manager: 'brew',
        latest: null,
        actions: {
          install: { steps: [['brew', 'install', 'colima', 'docker']], timeoutSeconds: 900 },
          start: { steps: [['colima', 'start']], timeoutSeconds: 600 },
          stop: { steps: [['colima', 'stop']], timeoutSeconds: 300 },
        },
      },
    ],
  },
  {
    id: 'container-docker-engine',
    label: 'Docker Engine',
    group: 'container',
    container: 'docker-engine',
    platforms: ['linux'],
    anySourcePath: true,
    probe: { argv: ['docker', '--version'], version: /Docker version (\d+(?:\.\d+)+)/ },
    sources: [
      {
        id: 'apt',
        label: 'systemd',
        platforms: ['linux'],
        binaryUnder: APT_PREFIXES,
        latest: null,
        actions: {
          start: { steps: [['sudo', 'systemctl', 'start', 'docker']], admin: true },
          stop: { steps: [['sudo', 'systemctl', 'stop', 'docker']], admin: true },
        },
      },
    ],
  },
  {
    id: 'container-docker-rootless',
    label: 'Docker sem root',
    group: 'container',
    container: 'docker-rootless',
    platforms: ['linux'],
    anySourcePath: true,
    probe: { argv: ['docker', '--version'], version: /Docker version (\d+(?:\.\d+)+)/ },
    sources: [
      {
        id: 'official',
        label: 'systemd do usuário',
        platforms: ['linux'],
        binaryUnder: [],
        manager: 'systemctl',
        latest: null,
        actions: {
          start: { steps: [['systemctl', '--user', 'start', 'docker']], timeoutSeconds: 300 },
          stop: { steps: [['systemctl', '--user', 'stop', 'docker']], timeoutSeconds: 300 },
        },
      },
    ],
  },
  {
    id: 'container-podman',
    label: 'Podman Desktop',
    group: 'container',
    container: 'podman',
    platforms: ['win32'],
    anySourcePath: true,
    probe: { argv: ['podman', '--version'], version: /podman version (\d+(?:\.\d+)+)/ },
    sources: [
      {
        id: 'winget',
        label: 'winget',
        platforms: ['win32'],
        binaryUnder: [],
        manager: 'winget',
        latest: null,
        actions: {
          install: { steps: [['winget', 'install', '--id', 'RedHat.Podman-Desktop', '--scope', 'user']], timeoutSeconds: 900 },
          start: { steps: [['podman', 'machine', 'start']], timeoutSeconds: 600 },
          stop: { steps: [['podman', 'machine', 'stop']], timeoutSeconds: 300 },
        },
      },
    ],
  },
  {
    // Read only everywhere: the console shows its state and never starts or updates it.
    id: 'container-docker-desktop',
    label: 'Docker Desktop',
    group: 'container',
    container: 'docker-desktop',
    probe: { argv: ['docker', '--version'], version: /Docker version (\d+(?:\.\d+)+)/ },
    sources: [],
  },

  // ---- Known MCP servers (the list itself is read from Claude Code's config, layer 3) -----------
  {
    id: 'playwright',
    label: 'Playwright MCP',
    group: 'mcp',
    probe: null,
    sources: [
      {
        id: 'npm',
        label: 'npm @playwright/mcp',
        platforms: ALL,
        binaryUnder: [],
        manager: 'claude',
        latest: { kind: 'npm', package: '@playwright/mcp' },
        actions: {
          update: {
            steps: [
              ['claude', 'mcp', 'remove', '-s', 'user', 'playwright'],
              ['claude', 'mcp', 'add', '-s', 'user', 'playwright', '--', 'npx', '-y', `@playwright/mcp@${VERSION_TOKEN}`],
            ],
            timeoutSeconds: 300,
          },
        },
      },
    ],
  },
];

export function catalogEntry(id: string, catalog: readonly ToolEntry[] = CATALOG): ToolEntry | undefined {
  return catalog.find((e) => e.id === id);
}

/** The entry applies to the platform (`na` otherwise). */
export function appliesTo(entry: ToolEntry, platform: Platform): boolean {
  return !entry.platforms || entry.platforms.includes(platform);
}

/** The entry's sources for this platform and arch, in the catalog's order. */
export function sourcesFor(entry: ToolEntry, platform: Platform, arch: string): ToolSource[] {
  return entry.sources.filter((s) => s.platforms.includes(platform) && (!s.arch || s.arch.includes(arch as Arch)));
}

/** The basename of an executable, for the admin check (`/usr/bin/sudo` → `sudo`, `RUNAS.EXE` → `runas`). */
export function executableName(argv0: string): string {
  const base = argv0.slice(Math.max(argv0.lastIndexOf('/'), argv0.lastIndexOf('\\')) + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com)$/, '');
}

export function isAdminExecutable(argv0: string): boolean {
  return (ADMIN_EXECUTABLES as readonly string[]).includes(executableName(argv0));
}
