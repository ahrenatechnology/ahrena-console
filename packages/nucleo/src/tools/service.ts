// The Tools screen's data (#280, decision 0014): `overview()` is the body of `GET /api/tools`, and
// `check()` is Verificar agora (layer 2's `POST /api/tools/checks`).
//
// - `overview()` is local: the probes and the containers card (cached 30 s), the managers present, and
//   the latest versions from the `tool_checks` cache when still valid (6 h). With no valid cache the
//   latest is `null` and the state `checking`, never `ok`. No network read happens here.
// - `check()` runs `brew update` when Homebrew is present (no password), then every latest reader
//   (latest.ts), and replaces the machine's cache. One check at a time: a second call gets the first.
// - Each action carries its plan (plan.ts): the steps, the timeout, the target version and the
//   `planDigest`; `runnable` is false with a `blockedReason` when it asks for sudo, has no valid
//   version, the machine is offline or the source's manager is missing.
// - Layer 1 serves this machine only (`local`); `mcp` stays empty until layer 3. `jobs` is filled by
//   the executor (executor.ts, layer 2), which also asks here for the plan of a POST (`actionPlan`),
//   for the process environment and for the re-probe after a job (`verify`).
// - No automatic re-check: the network is read only on Verificar agora; after 6 h the states go back
//   to `checking` until the next one (decision of layer 2, #280).

import { readFile as fsReadFile, realpath as fsRealpath, stat } from 'node:fs/promises';
import { arch as osArch, homedir, release as osRelease } from 'node:os';
import {
  appliesTo,
  CATALOG,
  sourcesFor,
  type ActionId,
  type DetectedSourceId,
  type Platform,
  type ToolEntry,
  type ToolGroup,
  type ToolSource,
} from './catalog.ts';
import { readContainers, type ContainersView } from './containers.ts';
import { compareVersions, readLatest, usesNetwork } from './latest.ts';
import { LoginPath, which, type IsExecutable } from './login-path.ts';
import { buildPlan, sourceForAction } from './plan.ts';
import { probeAll, type Detection } from './probe.ts';
import { PROBE_TIMEOUT_MS, systemFetchText, systemToolRunner, toolsEnv, type FetchText, type ToolRunner } from './runner.ts';
import { CHECK_VALIDITY_MS, validChecks, type ToolCheck, type ToolChecksStore } from './store.ts';

export const TOOLS_API_VERSION = 1;
export const LOCAL_TOOLS_MACHINE = 'local';
const BREW_UPDATE_TIMEOUT_MS = 300_000;
const PROBE_CACHE_MS = 30_000;
const CHECK_CONCURRENCY = 4;
/** Display only: the command from brew.sh for the person to run in the Terminal. */
export const HOMEBREW_INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

export type ToolState = 'ok' | 'outdated' | 'missing' | 'manual' | 'failed' | 'checking' | 'na';
export type BlockedReason = 'admin' | 'offline' | 'no-manager' | 'remote-read-only' | 'invalid-version';
export type NetworkState = 'online' | 'offline' | 'unknown';

export interface ToolActionView {
  id: ActionId;
  runnable: boolean;
  admin: boolean;
  blockedReason: BlockedReason | null;
  steps: string[][];
  timeoutSeconds: number;
  targetVersion: string | null;
  planDigest: string;
}

export interface ToolItem {
  id: string;
  label: string;
  group: ToolGroup;
  inCatalog: boolean;
  binary: string | null;
  manager: string | null;
  installed: string | null;
  latest: string | null;
  latestCheckedAt: string | null;
  latestError: string | null;
  source: DetectedSourceId | null;
  state: ToolState;
  note: string | null;
  actions: ToolActionView[];
}

export interface ToolsOverview {
  version: number;
  machine: { id: string; label: string; platform: Platform; os: string | null; arch: string; host: string | null };
  checkedAt: string | null;
  nextCheckAt: string | null;
  network: NetworkState;
  managers: { homebrew: { present: boolean; install: string | null }; winget: { present: boolean }; apt: { present: boolean; listsUpdatedAt: string | null } };
  actionsAllowed: boolean;
  items: ToolItem[];
  containers: ContainersView<ToolActionView>;
  mcp: { statusCheckedAt: string | null; servers: unknown[] };
  jobs: JobsView;
}

export interface JobsView<J = unknown> {
  current: J | null;
  queue: J[];
  recent: J[];
  /** Jobs enqueued back to back (Atualizar N): opens with the first, closes when the queue drains. */
  batch: { total: number; done: number } | null;
}

const ACTION_VERBS: Record<ActionId, string> = { install: 'Instalar', update: 'Atualizar', start: 'Iniciar', stop: 'Parar' };

/** What a POST asks to run, rebuilt from this núcleo's own detection and catalog. */
export type ActionPlanResult =
  | { kind: 'unknown-machine' }
  | { kind: 'unknown' }
  /** The tool is known but the action is not offered right now (e.g. update when already up to date). */
  | { kind: 'not-offered' }
  | { kind: 'plan'; toolId: string; actionId: ActionId; label: string; action: ToolActionView };

export interface ToolsServiceOptions {
  store: ToolChecksStore;
  catalog?: readonly ToolEntry[];
  platform?: Platform;
  arch?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  run?: ToolRunner;
  fetchText?: FetchText;
  /** The login shell's PATH; read once through `run` when absent. */
  loginPath?: () => Promise<string>;
  realpath?: (path: string) => Promise<string>;
  isExecutable?: IsExecutable;
  readFile?: (path: string) => Promise<string | null>;
  /** Modification time (epoch ms) of a path, or `null`: the age of the apt lists. */
  mtime?: (path: string) => Promise<number | null>;
  now?: () => number;
  probeCacheMs?: number;
  log?: (message: string) => void;
}

interface LocalSnapshot {
  takenAt: number;
  path: string;
  detections: Map<string, Detection>;
  /** Manager executables on the login PATH: name → full path or null. */
  managers: Map<string, string | null>;
  /** The containers card, read once per snapshot (and network state) so a request does not run docker. */
  containers?: { network: NetworkState; view: Promise<ContainersView<ToolActionView>> };
}

const ITEM_GROUPS: readonly ToolGroup[] = ['cli', 'runtime'];
const MANAGER_LABEL_FOR_NODE: Partial<Record<DetectedSourceId, string>> = { fnm: 'Node do fnm', homebrew: 'Node do Homebrew' };

export class ToolsService {
  private readonly o: ToolsServiceOptions;
  private readonly catalog: readonly ToolEntry[];
  readonly platform: Platform;
  private readonly arch: string;
  private readonly home: string;
  private readonly run: ToolRunner;
  private readonly loginPath: () => Promise<string>;
  private snapshot: LocalSnapshot | null = null;
  private snapshotting: Promise<LocalSnapshot> | null = null;
  private checking: Promise<ToolsOverview> | null = null;
  private network: NetworkState = 'unknown';
  private osName: Promise<string | null> | null = null;

  constructor(options: ToolsServiceOptions) {
    this.o = options;
    this.catalog = options.catalog ?? CATALOG;
    this.platform = options.platform ?? (process.platform as Platform);
    this.arch = options.arch ?? osArch();
    this.home = options.home ?? homedir();
    this.run = options.run ?? systemToolRunner;
    const lp = new LoginPath({ run: this.run, platform: this.platform, home: this.home, ...(options.env ? { env: options.env } : {}) });
    this.loginPath = options.loginPath ?? (() => lp.get());
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The body of `GET /api/tools`; `null` for a machine this layer does not serve. */
  async overview(machine: string = LOCAL_TOOLS_MACHINE): Promise<ToolsOverview | null> {
    if (machine !== LOCAL_TOOLS_MACHINE) return null;
    return this.build(await this.local(false));
  }

  /** The action of a tool as the screen sees it now (same plan, same `planDigest`), for a POST. */
  async actionPlan(machine: string, toolId: string, actionId: string): Promise<ActionPlanResult> {
    if (machine !== LOCAL_TOOLS_MACHINE) return { kind: 'unknown-machine' };
    const entry = this.catalog.find((e) => e.id === toolId);
    const verb = ACTION_VERBS[actionId as ActionId];
    if (!entry || !verb || (entry.group !== 'container' && !ITEM_GROUPS.includes(entry.group))) return { kind: 'unknown' };
    const o = await this.build(await this.local(false));
    const actions = entry.group === 'container' ? (o.containers.id === toolId ? o.containers.actions : []) : (o.items.find((i) => i.id === toolId)?.actions ?? []);
    const action = actions.find((a) => a.id === actionId);
    if (!action) return { kind: 'not-offered' };
    return { kind: 'plan', toolId, actionId: action.id, label: `${verb} ${entry.label}`, action };
  }

  /** Drops the probe cache: the next overview probes again. */
  invalidate(): void {
    this.snapshot = null;
  }

  /**
   * After a job: probes again and records the new installed version in the machine's `tool_checks`
   * row (its latest and time are kept). Returns the installed version now, or `null`.
   */
  async verify(machine: string, toolId: string): Promise<string | null> {
    if (machine !== LOCAL_TOOLS_MACHINE) return null;
    const snap = await this.local(true);
    const installed = snap.detections.get(toolId)?.installed ?? null;
    const rows = this.o.store.list(LOCAL_TOOLS_MACHINE);
    if (rows.some((r) => r.toolId === toolId && r.installed !== installed)) {
      this.o.store.replace(LOCAL_TOOLS_MACHINE, rows.map((r) => (r.toolId === toolId ? { ...r, installed } : r)));
    }
    return installed;
  }

  /** The environment of a tools process: `toolsEnv` with the login PATH. */
  async processEnv(): Promise<NodeJS.ProcessEnv> {
    return this.env(await this.loginPath());
  }

  /** An executable as a step names it: its path on the login PATH and that path's realpath (`null` when not found). */
  async resolveExecutable(name: string): Promise<{ path: string | null; realPath: string | null }> {
    const absolute = name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name);
    const path = absolute ? name : await this.which(name, await this.loginPath());
    if (!path) return { path: null, realPath: null };
    const realPath = await (this.o.realpath ?? fsRealpath)(path).catch(() => null);
    return { path, realPath };
  }

  /** Verificar agora: `brew update`, every latest reader, the cache replaced. One at a time. */
  check(machine: string = LOCAL_TOOLS_MACHINE): Promise<ToolsOverview | null> {
    if (machine !== LOCAL_TOOLS_MACHINE) return Promise.resolve(null);
    this.checking ??= this.runCheck().finally(() => (this.checking = null));
    return this.checking;
  }

  private async local(fresh: boolean): Promise<LocalSnapshot> {
    const s = this.snapshot;
    if (!fresh && s && this.now() - s.takenAt < (this.o.probeCacheMs ?? PROBE_CACHE_MS)) return s;
    if (!fresh && this.snapshotting) return this.snapshotting;
    const p = this.takeSnapshot().finally(() => {
      if (this.snapshotting === p) this.snapshotting = null;
    });
    this.snapshotting = p;
    this.snapshot = await p;
    return this.snapshot;
  }

  private async takeSnapshot(): Promise<LocalSnapshot> {
    const path = await this.loginPath();
    const fs = { ...(this.o.realpath ? { realpath: this.o.realpath } : {}), ...(this.o.isExecutable ? { isExecutable: this.o.isExecutable } : {}) };
    const detections = await probeAll(this.catalog, { platform: this.platform, arch: this.arch, home: this.home, path, run: this.run, ...(this.o.env ? { env: this.o.env } : {}), ...fs });
    const names = new Set<string>(['brew', 'winget', 'apt-get', 'apt-cache']);
    for (const e of this.catalog) for (const s of e.sources) if (s.manager) names.add(s.manager);
    const managers = new Map<string, string | null>();
    await Promise.all([...names].map(async (n) => managers.set(n, await this.which(n, path))));
    return { takenAt: this.now(), path, detections, managers };
  }

  private which(name: string, path: string): Promise<string | null> {
    return which(name, path, { platform: this.platform, ...(this.o.isExecutable ? { isExecutable: this.o.isExecutable } : {}) });
  }

  private env(path: string): NodeJS.ProcessEnv {
    return toolsEnv(path, this.o.env);
  }

  private hasManager(snap: LocalSnapshot, source: ToolSource): boolean {
    return !source.manager || snap.managers.get(source.manager) != null;
  }

  /** The source a tool is (or would be) installed from: the detected one, else the install source. */
  private sourceOf(entry: ToolEntry, d: Detection | undefined, snap: LocalSnapshot): ToolSource | null {
    if (d?.installed || d?.binaryPath) {
      if (!d.sourceId || d.sourceId === 'manual') return null;
      return sourcesFor(entry, this.platform, this.arch).find((s) => s.id === d.sourceId) ?? null;
    }
    return sourceForAction(entry, 'install', { installed: null, sourceId: null }, this.platform, { arch: this.arch, hasManager: (s) => this.hasManager(snap, s) });
  }

  private async runCheck(): Promise<ToolsOverview> {
    const snap = await this.local(true);
    const deps = { run: this.run, fetchText: this.o.fetchText ?? systemFetchText, path: snap.path, resolve: async (n: string) => snap.managers.get(n) ?? (await this.which(n, snap.path)), env: this.env(snap.path) };
    const brew = snap.managers.get('brew');
    if (brew && this.catalog.some((e) => appliesTo(e, this.platform) && sourcesFor(e, this.platform, this.arch).some((s) => s.id === 'homebrew' && s.latest))) {
      const r = await this.run([brew, 'update'], { timeoutMs: BREW_UPDATE_TIMEOUT_MS, env: this.env(snap.path) }).catch(() => null);
      if (r?.code !== 0) this.o.log?.(`tools: brew update did not finish (${r?.error ?? `exit ${r?.code ?? 'none'}`}); reading the local cache`);
    }
    const entries = this.catalog.filter((e) => e.group !== 'container' && appliesTo(e, this.platform));
    const checks: ToolCheck[] = [];
    let networkOk = 0;
    let networkFailed = 0;
    await pool(entries, CHECK_CONCURRENCY, async (entry) => {
      const d = snap.detections.get(entry.id);
      const source = entry.probe ? this.sourceOf(entry, d, snap) : (sourcesFor(entry, this.platform, this.arch)[0] ?? null);
      let latest: string | null = null;
      let error: string | null = null;
      if (source?.latest) {
        const r = await readLatest(source.latest, deps);
        latest = r.version;
        error = r.error;
        if (usesNetwork(source.latest) && r.error !== 'no-manager') {
          if (r.version) networkOk++;
          else networkFailed++;
        }
      }
      checks.push({ toolId: entry.id, sourceId: source?.id ?? d?.sourceId ?? null, installed: d?.installed ?? null, latest, checkedAt: this.now(), error });
    });
    this.network = networkOk > 0 ? 'online' : networkFailed > 0 ? 'offline' : 'unknown';
    checks.sort((a, b) => a.toolId.localeCompare(b.toolId));
    this.o.store.replace(LOCAL_TOOLS_MACHINE, checks);
    return this.build(snap);
  }

  private async build(snap: LocalSnapshot): Promise<ToolsOverview> {
    const now = this.now();
    const checks = new Map(validChecks(this.o.store.list(LOCAL_TOOLS_MACHINE), now).map((c) => [c.toolId, c]));
    const checkedAtMs = checks.size > 0 ? Math.max(...[...checks.values()].map((c) => c.checkedAt)) : null;
    const network = this.network;
    const actionView = (entry: ToolEntry, actionId: ActionId, d: { installed: string | null; sourceId: DetectedSourceId | null }, latest: string | null): ToolActionView | null => {
      const plan = buildPlan(entry, actionId, d, latest, this.platform, { machine: LOCAL_TOOLS_MACHINE, arch: this.arch, hasManager: (s) => this.hasManager(snap, s) });
      if (!plan) return null;
      const needsNetwork = actionId === 'install' || actionId === 'update';
      const blockedReason: BlockedReason | null = plan.admin
        ? 'admin'
        : !plan.versionOk
          ? 'invalid-version'
          : needsNetwork && network === 'offline'
            ? 'offline'
            : !this.hasManager(snap, plan.source)
              ? 'no-manager'
              : null;
      return { id: actionId, runnable: blockedReason === null, admin: plan.admin, blockedReason, steps: plan.steps, timeoutSeconds: plan.timeoutSeconds, targetVersion: plan.targetVersion, planDigest: plan.planDigest };
    };

    const nodeSource = snap.detections.get('node')?.sourceId ?? null;
    const items = this.catalog.filter((e) => ITEM_GROUPS.includes(e.group)).map((entry) => this.item(entry, snap, checks.get(entry.id), nodeSource, actionView));

    if (!snap.containers || snap.containers.network !== network) snap.containers = { network, view: readContainers<ToolActionView>({
      platform: this.platform,
      detections: snap.detections,
      run: this.run,
      env: this.env(snap.path),
      resolve: async (n) => snap.managers.get(n) ?? (await this.which(n, snap.path)),
      action: (toolId, actionId) => {
        const entry = this.catalog.find((e) => e.id === toolId);
        const d = snap.detections.get(toolId);
        return entry ? actionView(entry, actionId, { installed: d?.installed ?? null, sourceId: d?.sourceId ?? null }, null) : null;
      },
    }) };
    const containers = await snap.containers.view;

    return {
      version: TOOLS_API_VERSION,
      machine: { id: LOCAL_TOOLS_MACHINE, label: 'Esta máquina', platform: this.platform, os: await this.os(), arch: this.arch, host: null },
      checkedAt: checkedAtMs === null ? null : new Date(checkedAtMs).toISOString(),
      nextCheckAt: checkedAtMs === null ? null : new Date(checkedAtMs + CHECK_VALIDITY_MS).toISOString(),
      network,
      managers: {
        homebrew: this.homebrew(snap),
        winget: { present: this.platform === 'win32' && snap.managers.get('winget') != null },
        apt: await this.apt(snap),
      },
      actionsAllowed: network !== 'offline',
      items,
      containers,
      mcp: { statusCheckedAt: null, servers: [] },
      jobs: { current: null, queue: [], recent: [], batch: null },
    };
  }

  private item(
    entry: ToolEntry,
    snap: LocalSnapshot,
    check: ToolCheck | undefined,
    nodeSource: DetectedSourceId | null,
    actionView: (entry: ToolEntry, actionId: ActionId, d: { installed: string | null; sourceId: DetectedSourceId | null }, latest: string | null) => ToolActionView | null,
  ): ToolItem {
    const base = { id: entry.id, label: entry.label, group: entry.group, inCatalog: true, binary: entry.probe?.argv[0] ?? null };
    if (!appliesTo(entry, this.platform)) {
      return { ...base, manager: null, installed: null, latest: null, latestCheckedAt: null, latestError: null, source: null, state: 'na', note: entry.naNote ?? null, actions: [] };
    }
    const d = snap.detections.get(entry.id);
    const installed = d?.installed ?? null;
    const source = this.sourceOf(entry, d, snap);
    const sourceId: DetectedSourceId | null = d?.binaryPath ? (d.sourceId ?? 'manual') : (source?.id ?? null);
    // The cache counts only for the same source: a tool moved from the .pkg to Homebrew is read again.
    const usable = check && check.sourceId === (source?.id ?? sourceId) ? check : undefined;
    const latest = usable?.latest ?? null;
    const latestError = usable?.error ?? null;
    let manager = source?.label ?? null;
    if (manager && source?.id === 'npm' && nodeSource && MANAGER_LABEL_FOR_NODE[nodeSource]) manager = `${manager} · ${MANAGER_LABEL_FOR_NODE[nodeSource]}`;

    let state: ToolState;
    let note: string | null = entry.note ?? null;
    if (d?.probeError === 'shim-not-readable') {
      state = 'manual';
      note = 'no Windows a sonda não lê esta ferramenta (atalho .cmd)';
    } else if (d?.binaryPath && !installed) {
      state = 'failed';
      note = 'a sonda não leu a versão instalada';
    } else if (!installed) state = 'missing';
    else if (sourceId === 'manual' || !source?.latest) state = 'manual';
    else if (latest === null) state = latestError ? 'failed' : 'checking';
    else if (compareVersions(installed, latest) >= 0) state = 'ok';
    else state = source.id === 'official' ? 'manual' : 'outdated';
    if (state === 'failed' && installed) note = 'não deu para ler a versão mais recente';

    const actions: ToolActionView[] = [];
    if (state === 'missing') {
      const a = actionView(entry, 'install', { installed: null, sourceId: null }, latest);
      if (a) actions.push(a);
    } else if (installed && latest && compareVersions(installed, latest) < 0) {
      const a = actionView(entry, 'update', { installed, sourceId }, latest);
      if (a) actions.push(a);
    }
    return {
      ...base,
      manager,
      installed,
      latest,
      latestCheckedAt: usable ? new Date(usable.checkedAt).toISOString() : null,
      latestError,
      source: sourceId,
      state,
      note,
      actions,
    };
  }

  /** Homebrew's own installer asks for the admin password: shown to copy (display only, never run). */
  private homebrew(snap: LocalSnapshot): { present: boolean; install: string | null } {
    const present = snap.managers.get('brew') != null;
    return { present, install: !present && this.platform === 'darwin' ? HOMEBREW_INSTALL_COMMAND : null };
  }

  private async apt(snap: LocalSnapshot): Promise<{ present: boolean; listsUpdatedAt: string | null }> {
    const present = this.platform === 'linux' && snap.managers.get('apt-get') != null;
    if (!present) return { present, listsUpdatedAt: null };
    const mtime = this.o.mtime ?? (async (p: string) => (await stat(p).catch(() => null))?.mtimeMs ?? null);
    const ms = await mtime('/var/lib/apt/lists');
    return { present, listsUpdatedAt: ms === null ? null : new Date(ms).toISOString() };
  }

  private os(): Promise<string | null> {
    this.osName ??= (async () => {
      if (this.platform === 'darwin') {
        const r = await this.run(['/usr/bin/sw_vers', '-productVersion'], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
        const v = r?.code === 0 ? r.stdout.trim() : '';
        return v ? `macOS ${v}` : 'macOS';
      }
      if (this.platform === 'linux') {
        const text = await (this.o.readFile ?? ((p: string) => fsReadFile(p, 'utf8').catch(() => null)))('/etc/os-release');
        return (text && /^PRETTY_NAME="?([^"\n]+)"?\s*$/m.exec(text)?.[1]) || 'Linux';
      }
      return `Windows ${osRelease()}`;
    })();
    return this.osName;
  }
}

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
