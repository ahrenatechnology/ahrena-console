// A harness for the memory actions' tests (#740): a real Tools executor over a fake spawn, a fake memory module, and temporary home and
// data folders. Nothing real runs: no ai-memory, no launchctl, no brew. (#740)
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeOverview, fakeSpawn, type SpawnCall } from '../../../test/tools/doubles.ts';
import { ToolsExecutor, type ToolsHost } from '../../tools/executor.ts';
import { createMemoryActionFiles } from '../../tools/memory-config-file.ts';
import { createMemoryActions, MEMORY_ACTIONS, type MemoryActionFiles, type MemoryActionId, type MemoryActions } from '../actions.ts';
import type { MemoryStatusState } from '../memory.ts';
import { readSetupPlan } from '../readers.ts';

export const BINARY = '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory';
const root = mkdtempSync(join(tmpdir(), 'memory-actions-'));
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
let n = 0;

// The registry's names of the two accounts the harness registers (#740).
export const ACCOUNT_A = 'Pessoal';
export const ACCOUNT_B = 'Trabalho';
export const LABEL = 'com.github.akitaonrails.ai-memory';
const planJson = (data: string): string =>
  JSON.stringify({ format: 1, data_dir: data, config_path: join(data, 'config.toml'), fresh: true, service: { action: 'install', manager: 'launchd', path: null }, agents: [{ agent: 'claude-code', found: true, wiring: 'hooks' }], other_agents: [] });

// What ai-memory's own `init` leaves in config.toml: embedding_provider is only a commented example (v3.5.1, confirmed by running it in a temporary folder) (#740).
const INIT_CONFIG = '# embedding_provider = "local"\n\n[auth]\nenabled = false\n';

export interface Setup {
  state?: MemoryStatusState;
  folders?: (a: string, b: string) => string[];
  files?: (real: MemoryActionFiles, events: string[]) => MemoryActionFiles;
  exit?: (call: SpawnCall) => number;
  uid?: number | null;
  platform?: NodeJS.Platform;
  binaryPath?: string | null;
  config?: string;
  /** The processes never exit: only the timeout ends the job (#740). */
  hang?: boolean;
}

export interface Harness {
  actions: MemoryActions;
  executor: ToolsExecutor;
  sp: ReturnType<typeof fakeSpawn>;
  state: { current: MemoryStatusState; folders: string[] };
  planned: string[];
  events: string[];
  dir: string;
  home: string;
  data: string;
  a: string;
  b: string;
}

export function harness(o: Setup = {}): Harness {
  const dir = join(root, `case-${++n}`);
  const home = join(dir, 'home');
  const data = join(dir, 'data');
  const a = join(home, '.claude');
  const b = join(home, '.claude-work');
  for (const d of [home, data, a, b]) mkdirSync(d, { recursive: true });
  if (o.config !== undefined) writeFileSync(join(data, 'config.toml'), o.config);
  const events: string[] = [];
  const sp = fakeSpawn((call) => {
    events.push(`spawn ${call.args.filter((x) => x !== '--data-dir' && x !== data).join(' ')}`);
    // The fake `init` creates the config.toml only when there is none, as the real one does without --force (#740).
    if (call.args.includes('init') && !existsSync(join(data, 'config.toml'))) writeFileSync(join(data, 'config.toml'), INIT_CONFIG);
    if (!o.hang) call.child.exit(o.exit?.(call) ?? 0);
  });
  const host: ToolsHost = {
    overview: async () => fakeOverview(),
    check: async () => null,
    actionPlan: async () => ({ kind: 'unknown' }),
    verify: async () => null,
    invalidate: () => {},
    processEnv: async () => ({ PATH: '/usr/bin', GH_TOKEN: 'fake-secret-not-real' }),
    resolveExecutable: async (name) => ({ path: name, realPath: name }),
  };
  const executor = new ToolsExecutor({ service: host, logFile: join(dir, 'tools.log'), spawn: sp.spawn, killGroup: sp.killGroup, cwd: home, killGraceMs: 10, msPerSecond: o.hang ? 1 : 1000, log: () => {} });
  const state = { current: o.state ?? ({ state: 'stopped' } as MemoryStatusState), folders: (o.folders ?? ((x, y) => [x, y]))(a, b) };
  const planned: string[] = [];
  const real = createMemoryActionFiles();
  const files = o.files ? o.files(real, events) : real;
  const actions = createMemoryActions({
    memory: {
      status: async () => state.current,
      setupPlanWithLocalFor: async (folder) => (planned.push(folder), { ok: true, value: readSetupPlan(planJson(data)) }),
    },
    queue: executor,
    binaryPath: o.binaryPath === undefined ? BINARY : o.binaryPath,
    dataDir: data,
    env: { PATH: '/usr/bin', HOME: home, GH_TOKEN: 'fake-secret-not-real', CLAUDE_CONFIG_DIR: '/Users/evil/.claude', AI_MEMORY_AUTH_TOKEN: 'fake-secret-not-real' },
    home,
    uid: () => (o.uid === undefined ? 501 : o.uid),
    platform: o.platform ?? 'darwin',
    accountFolders: async () => state.folders.map((dir) => ({ dir, name: dir === a ? ACCOUNT_A : dir === b ? ACCOUNT_B : 'Outra' })),
    files,
    labels: Object.fromEntries(MEMORY_ACTIONS.map((id) => [id, `rótulo ${id}`])) as Record<MemoryActionId, string>,
  });
  return { actions, executor, sp, state, planned, events, dir, home, data, a, b };
}

