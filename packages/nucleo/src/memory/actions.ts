/*
 * The memory actions (#740, #719): activate, stop, start, deactivate and delete-data, each a plan the person confirms (with its
 * `planDigest`) and then a job on the Tools executor's queue (decisions 0014 and 0017). What this module guarantees:
 * - Every command is a fixed argv built here from the constants below; nothing from a request reaches a process. Each one cites the
 *   upstream v3.5.1 file and line that confirm it (the sources of the ai-memory repository, `src/commands/` and `src/cli.rs`) (#740).
 * - `CLAUDE_CONFIG_DIR` is the one variable added to the child's allowlist, and only with a registered account folder (#740/AC-7).
 * - Nothing runs until the digest of the plan, rebuilt from a fresh read, matches the one confirmed; one job at a time, on the queue (#740/AC-6).
 * - A step that fails ends the sequence; there is no rollback, and deactivate stays available (#740/AC-3).
 * - The module touches no file: the folders it checks and the one config.toml write come through `MemoryActionFiles` (#719/AC-10).
 */

import { createHash } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { embeddedAiMemoryEnv, registeredAccountFolder, type RegisteredAccountFolder } from '../tools/embedded-ai-memory.ts';
import type { EnqueueResult, JobSpec, StepRun, ToolJob } from '../tools/executor.ts';
import type { MemoryRead, MemoryReadFailure, MemoryStatusState } from './memory.ts';
import type { MemorySetupPlan, MemorySetupPlanReading } from './readers.ts';

export const MEMORY_ACTIONS = ['activate', 'stop', 'start', 'deactivate', 'delete-data'] as const;
export type MemoryActionId = (typeof MEMORY_ACTIONS)[number];

/** Why an action is not offered now (#740). */
export type MemoryNotOffered = 'no-binary' | 'state-unknown' | 'already-running' | 'not-running' | 'not-stopped' | 'no-accounts' | 'not-installed' | 'unsupported-platform';

/** One step as the person sees it: the command without any path, and the account it runs for (#740). */
export interface MemoryPlanStep {
  display: string[];
  /** The index into `accounts`, or null when the step is not per account (#740). */
  account: number | null;
}

/** A Claude account folder of the core's registry and the name the screens give the account: never the path (#740). */
export interface RegistryAccount {
  dir: string;
  name: string;
}

export interface MemoryPlanAccount {
  /** A local path: for the local screen only (#740). */
  dir: string;
  setup: MemorySetupPlan;
}

export interface MemoryActionPlan {
  actionId: MemoryActionId;
  label: string;
  steps: MemoryPlanStep[];
  timeoutSeconds: number;
  planDigest: string;
  /** Activate: one entry per registered account folder (#740/AC-1). */
  accounts: MemoryPlanAccount[];
  /** Activate: the launchd service the plan installs (#740). */
  service: { action: string; manager: string } | null;
  /** Activate: where ai-memory keeps its data, a local path for the local screen only (#740/AC-1). */
  dataDir: string | null;
  /** Delete-data: what is deleted and what stays, as ids the text names (#740/AC-4). */
  deletes: string[];
  keeps: string[];
  needsAcknowledgment: boolean;
  /** Deactivate: starting needs a new activation afterwards (#740). */
  startNeedsActivation: boolean;
}

export type MemoryPlanResult = { kind: 'plan'; plan: MemoryActionPlan } | { kind: 'not-offered'; reason: MemoryNotOffered } | { kind: 'unreadable'; reason: MemoryReadFailure };
export type MemoryActResult =
  | { kind: 'not-offered'; reason: MemoryNotOffered }
  | { kind: 'unreadable'; reason: MemoryReadFailure }
  | { kind: 'stale'; plan: MemoryActionPlan }
  | { kind: 'acknowledgment-required'; plan: MemoryActionPlan }
  | { kind: 'queued'; job: ToolJob };

/** What the actions do to the files; the module itself touches none (#740). */
export interface MemoryActionFiles {
  isDirectory(path: string): boolean;
  exists(path: string): boolean;
  /** Sets `embedding_provider = "none"` in the config file, atomically (#740/AC-2). */
  writeEmbeddingsOff(configPath: string): Promise<void>;
}

export interface MemoryActionsOptions {
  memory: { status(): Promise<MemoryStatusState>; setupPlanWithLocalFor(folder: RegisteredAccountFolder): Promise<MemoryRead<MemorySetupPlanReading>> };
  queue: { enqueue(machine: string, spec: JobSpec): EnqueueResult };
  /** The embedded binary's absolute path, or null when this core has none (#725). */
  binaryPath: string | null;
  /** Tests only: ai-memory's own default folder is used when absent, as the runner does (#735). */
  dataDir?: string;
  /** The core's environment, before the allowlist keeps its part (#727). */
  env?: NodeJS.ProcessEnv;
  /** The user's home, where the LaunchAgents folder is: injected, never from a request (#740). */
  home: string;
  uid: () => number | null;
  /** Whether the LaunchAgent is loaded in the user's domain: runs the fixed argv `/bin/launchctl print <target>`, true only on exit 0; this module spawns nothing itself (#740). */
  launchdLoaded: (target: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  /** The Claude account folders of the core's registry, each with its account's name (#740/AC-7). */
  accountFolders: () => Promise<readonly RegistryAccount[]>;
  files: MemoryActionFiles;
  /** The pt-BR label of each action, for the job (#740). */
  labels: Record<MemoryActionId, string>;
  log?: (message: string) => void;
}

export interface MemoryActions {
  plan(actionId: MemoryActionId): Promise<MemoryPlanResult>;
  /** Rebuilds the plan from a fresh read; only a plan whose digest is `planDigest` is queued (#740/AC-1). */
  act(actionId: MemoryActionId, planDigest: string, acknowledged: boolean): Promise<MemoryActResult>;
}

const TOOL_ID = 'ai-memory';
const MACHINE = 'local';
// The LaunchAgent label ai-memory installs (upstream src/commands/user_service.rs:33) (#740).
// The plist it writes under the user's home (user_service.rs:250-253) (#740).
// Upstream stop is `bootout` (user_service.rs:885-905); its start runs `bootout` only when `launchctl print` exits 0 (loaded, user_service.rs:896-901), then `bootstrap` (user_service.rs:904). Start here probes at plan time and does the same (#740).
const LAUNCHD_LABEL = 'com.github.akitaonrails.ai-memory';
const LAUNCHCTL = '/bin/launchctl';
const LAUNCH_AGENTS = ['Library', 'LaunchAgents'] as const;
// Each step of a setup can run a health self-check; the executor's timeout is per step (#740).
const STEP_TIMEOUT_SECONDS = 180;
const SHOWN = 'ai-memory';
// Upstream `reset` empties exactly these three folders and keeps the logs (src/commands/reset.rs:1, 40; src/cli.rs:234) (#740/AC-4).
const DELETES = ['wiki/', 'db/', 'raw/'];
const KEEPS = ['config.toml', 'access-credentials', 'logs'];
const CONFIG_FILE = 'config.toml';
const ACCOUNT_NAME_MAX = 60;

/** The name the failure line gives an account: the registry's label, cleaned and capped, or "conta N" by its place when it has none or it carries an e-mail; never a path (#740). */
function accountName(name: string, index: number): string {
  const clean = name.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, ACCOUNT_NAME_MAX);
  return clean === '' || clean.includes('@') ? `conta ${index + 1}` : clean;
}
const DATA_DIR_OPTION = '--data-dir';

/** One step as it runs; `display` is what the job and the plan show (#740). */
interface Step {
  display: string[];
  account: number | null;
  /** The registry's name of the account the step runs for: local, for the failure line (#740). */
  accountName?: string;
  run: { kind: 'command'; argv: string[]; folder: RegisteredAccountFolder | null } | { kind: 'write-config'; configPath: string };
}

interface Built {
  plan: MemoryActionPlan;
  steps: Step[];
}

type Building = { kind: 'built'; built: Built } | { kind: 'not-offered'; reason: MemoryNotOffered } | { kind: 'unreadable'; reason: MemoryReadFailure };

export function createMemoryActions(options: MemoryActionsOptions): MemoryActions {
  const { binaryPath, files } = options;
  const platform = options.platform ?? process.platform;
  const dataDirArgs = options.dataDir === undefined ? [] : [DATA_DIR_OPTION, options.dataDir];

  /*
   * Every flag below was read in the v3.5.1 sources (#740): `setup --yes` cli.rs:2164-2165, `--agent` cli.rs:2171-2172, `auth enable --no-mcp` cli.rs:1453 and 1511-1512 (auth_enable.rs:71-73 skips the MCP re-registration with it),
   * `uninstall --apply --yes` cli.rs:1530 and 1550 (the `--purge-data` of cli.rs:1535 is never passed), `reset --confirm` cli.rs:2441-2444.
   */
  /** An ai-memory command, as run and as shown (#740). */
  const ai = (args: string[], account: number | null, folder: RegisteredAccountFolder | null, accountName?: string): Step => ({
    display: [SHOWN, ...args],
    account,
    ...(accountName === undefined ? {} : { accountName }),
    run: { kind: 'command', argv: [binaryPath ?? '', ...dataDirArgs, ...args], folder },
  });

  const userDomain = (): string | null => {
    const uid = options.uid();
    return platform === 'darwin' && uid !== null ? `gui/${uid}` : null;
  };

  const plistPath = (): string => join(options.home, ...LAUNCH_AGENTS, `${LAUNCHD_LABEL}.plist`);

  /** The registry's accounts whose folder is accepted, once each, with the name the failure line gives (#740). */
  async function registeredAccounts(): Promise<{ folder: RegisteredAccountFolder; name: string }[]> {
    const registry = await options.accountFolders();
    const dirs = registry.map((account) => account.dir);
    const accepted = new Map<RegisteredAccountFolder, string>();
    registry.forEach((account, index) => {
      const folder = registeredAccountFolder(account.dir, dirs, files.isDirectory);
      if (folder !== null && !accepted.has(folder)) accepted.set(folder, accountName(account.name, index));
    });
    return [...accepted].map(([folder, name]) => ({ folder, name }));
  }

  /** The state the action needs, or why it is not offered (#740). */
  async function offering(actionId: MemoryActionId): Promise<MemoryNotOffered | null> {
    if (binaryPath === null) return 'no-binary';
    const { state } = await options.memory.status();
    if (state === 'unavailable') return 'no-binary';
    if (state === 'unknown') return 'state-unknown';
    if (actionId === 'activate') return state === 'running' ? 'already-running' : null;
    if (actionId === 'deactivate') return null;
    if (actionId === 'delete-data') return state === 'stopped' ? null : 'not-stopped';
    if (userDomain() === null) return 'unsupported-platform';
    if (actionId === 'stop') return state === 'running' ? null : 'not-running';
    if (state === 'running') return 'already-running';
    return files.exists(plistPath()) ? null : 'not-installed';
  }

  function finish(actionId: MemoryActionId, steps: Step[], extra: Partial<MemoryActionPlan> = {}): Built {
    const identity = JSON.stringify({ actionId, steps: steps.map((step) => [step.display, step.run, step.account]), timeoutSeconds: STEP_TIMEOUT_SECONDS });
    const plan: MemoryActionPlan = {
      actionId,
      label: options.labels[actionId],
      steps: steps.map((step) => ({ display: step.display, account: step.account })),
      timeoutSeconds: STEP_TIMEOUT_SECONDS,
      planDigest: createHash('sha256').update(identity).digest('hex').slice(0, 16),
      accounts: [],
      service: null,
      dataDir: null,
      deletes: [],
      keeps: [],
      needsAcknowledgment: false,
      startNeedsActivation: false,
      ...extra,
    };
    return { plan, steps };
  }

  /** The activate plan: one `setup --plan` read per registered folder, then the steps in order (#740/AC-1). */
  async function activate(): Promise<Building> {
    const registered = await registeredAccounts();
    const folders = registered.map((account) => account.folder);
    if (folders.length === 0) return { kind: 'not-offered', reason: 'no-accounts' };
    const accounts: MemoryPlanAccount[] = [];
    let configPath: string | null = null;
    let service: MemoryActionPlan['service'] = null;
    let dataDir: string | null = null;
    for (const folder of folders) {
      const read = await options.memory.setupPlanWithLocalFor(folder);
      if (!read.ok) return { kind: 'unreadable', reason: read.reason };
      accounts.push({ dir: folder, setup: read.value.plan });
      configPath ??= read.value.local.config_path;
      dataDir ??= read.value.local.data_dir;
      service ??= { action: read.value.plan.service.action, manager: read.value.plan.service.manager };
    }
    // The path comes out of the embedded binary's own plan; it is the config.toml or nothing is written (#740/AC-2).
    if (configPath === null || !isAbsolute(configPath) || basename(configPath) !== CONFIG_FILE) return { kind: 'unreadable', reason: 'rejected' };
    // Why this order (#740): `init` creates the data folder and a config.toml in which `embedding_provider` is only a commented example, and downloads nothing.
    // Embeddings go off and auth goes on before the first `setup`, because that setup installs and starts the service (#740).
    // So its first boot downloads no model and serves with authentication, and its closing self-check passes (#740).
    // Confirmed on the real binary in a temporary folder: `init` exits 0 on its own, and `auth enable --no-mcp` exits 0 with no server running (#740).
    // Upstream v3.5.1: `init` is the `Command::Init(InitArgs)` subcommand (crates/ai-memory-cli/src/cli.rs:153-155, InitArgs at 2150-2156), run by commands/init.rs:155 (#740).
    // Without `--force` it leaves an existing config.toml untouched (init.rs:190-193), so running it again is safe; it is passed no flag (#740).
    // The `setup` of each account is the same idempotent command: the first installs and starts the service, the others wire their folder (#740).
    const steps: Step[] = [
      ai(['init'], null, null),
      { display: ['core', 'write-config', 'embedding_provider=none'], account: null, run: { kind: 'write-config', configPath } },
      ai(['auth', 'enable', '--no-mcp'], null, null),
      ...registered.map(({ folder, name }, index) => ai(['setup', '--yes', '--agent', 'claude-code'], index, folder, name)),
    ];
    return { kind: 'built', built: finish('activate', steps, { accounts, service, dataDir }) };
  }

  /** `uninstall --apply --yes`, once per registered account folder, never with `--purge-data` (upstream cli.rs:1530, 1550; uninstall.rs:217 reads CLAUDE_CONFIG_DIR) (#740). */
  async function deactivate(): Promise<Building> {
    const registered = await registeredAccounts();
    const steps = registered.length === 0 ? [ai(['uninstall', '--apply', '--yes'], null, null)] : registered.map(({ folder, name }, index) => ai(['uninstall', '--apply', '--yes'], index, folder, name));
    return { kind: 'built', built: finish('deactivate', steps, { startNeedsActivation: true }) };
  }

  async function launchd(actionId: 'stop' | 'start'): Promise<Building> {
    const domain = userDomain();
    if (domain === null) return { kind: 'not-offered', reason: 'unsupported-platform' };
    const target = `${domain}/${LAUNCHD_LABEL}`;
    const bootout: Step = { display: ['launchctl', 'bootout', target], account: null, run: { kind: 'command', argv: [LAUNCHCTL, 'bootout', target], folder: null } };
    if (actionId === 'stop') return { kind: 'built', built: finish(actionId, [bootout]) };
    const bootstrap: Step = { display: ['launchctl', 'bootstrap', domain, `~/${[...LAUNCH_AGENTS, `${LAUNCHD_LABEL}.plist`].join('/')}`], account: null, run: { kind: 'command', argv: [LAUNCHCTL, 'bootstrap', domain, plistPath()], folder: null } };
    // (#740) The plan rebuilds at confirm, so a load state that changed since the plan makes the digest differ: stale.
    const loaded = await options.launchdLoaded(target);
    return { kind: 'built', built: finish(actionId, loaded ? [bootout, bootstrap] : [bootstrap]) };
  }

  /** `reset --confirm` (upstream src/cli.rs:2441-2444; src/commands/reset.rs:26, 40), offered only with the server stopped (#740/AC-4). */
  function deleteData(): Building {
    return { kind: 'built', built: finish('delete-data', [ai(['reset', '--confirm'], null, null)], { deletes: DELETES, keeps: KEEPS, needsAcknowledgment: true }) };
  }

  async function build(actionId: MemoryActionId): Promise<Building> {
    const reason = await offering(actionId);
    if (reason !== null) return { kind: 'not-offered', reason };
    if (actionId === 'activate') return activate();
    if (actionId === 'deactivate') return deactivate();
    if (actionId === 'delete-data') return deleteData();
    return launchd(actionId);
  }

  function runOf(step: Step): StepRun {
    if (step.run.kind === 'command') return { argv: step.run.argv, env: embeddedAiMemoryEnv(options.env, step.run.folder ?? undefined), ...(step.accountName === undefined ? {} : { account: step.accountName }) };
    const { configPath } = step.run;
    return {
      inline: async (line) => {
        try {
          await files.writeEmbeddingsOff(configPath);
          return 0;
        } catch (error) {
          options.log?.(`memory: write-config failed ${typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'error'}`);
          line('Não deu para gravar a configuração.');
          return 1;
        }
      },
    };
  }

  return {
    async plan(actionId) {
      const result = await build(actionId);
      return result.kind === 'built' ? { kind: 'plan', plan: result.built.plan } : result;
    },
    async act(actionId, planDigest, acknowledged) {
      const result = await build(actionId);
      if (result.kind !== 'built') return result;
      const { plan, steps } = result.built;
      if (plan.planDigest !== planDigest) return { kind: 'stale', plan };
      if (plan.needsAcknowledgment && !acknowledged) return { kind: 'acknowledgment-required', plan };
      const queued = options.queue.enqueue(MACHINE, {
        toolId: TOOL_ID,
        actionId,
        label: plan.label,
        steps: plan.steps.map((step) => step.display),
        runs: steps.map(runOf),
        quiet: true,
        timeoutSeconds: plan.timeoutSeconds,
        targetVersion: null,
        key: `${TOOL_ID} ${actionId}`,
      });
      options.log?.(`memory: ${actionId} queued (job ${queued.job.id})`);
      return queued;
    },
  };
}
