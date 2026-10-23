// The AWS connector (#277, decision 0013 sections 2 and 3): what this machine's AWS CLI knows, its SSO
// sessions and their state, and the login. Served by src/api/clouds.ts as one item of
// `GET /api/connectors`.
//
// - The CLI: `aws` in the login shell's PATH (src/tools/login-path.ts), and its major version from
//   `aws --version`. v1 is shown (`cli: { found: true, version: 1 }`) but nothing runs with it.
//   `deviceCodeSupported` (2.22 and later) says whether `--use-device-code` exists.
// - The configuration: ~/.aws/config (or AWS_CONFIG_FILE), re-read when its modification time or
//   size changes, on every read and right before a login. A parse error keeps the last good reading
//   and reports the line; a file that is gone empties the list.
// - The state of each session, from two sources:
//   - the probe, `aws sts get-caller-identity --profile <first profile of the session with a
//     supported name>`, every 5 min, right after a login that exited 0, at most one per session at a
//     time, 15 s timeout. Only ok / expired / unknown is kept: the output is never logged, stored or
//     returned (stderr is only matched against `EXPIRED_PATTERNS` to tell expired from unknown);
//   - the token cache's `expiresAt` (variant A, aws-sso-cache.ts).
//   `valid` (probe ok, more than 15 min left), `expiring` (probe ok, 15 min or less, or already past
//   the token's end while the CLI still answers), `expired` (the probe says so, or no probe yet and
//   the cache's end is past), `never` (no cache file: never logged in on this machine), `unknown`
//   (the probe failed for another reason: network, a timeout). Without a v2 CLI nothing is probed and
//   the state comes from the cache alone.
// - The connector's own `state`: `missing-cli`, `unsupported-cli` (v1), `not-configured` (no SSO
//   session in the file), or the worst session state (expired > expiring > unknown > never > valid).
// - Every change of what `GET /api/connectors` shows (a probe, a login moving, the file changing)
//   calls `onChange`, published as `{ type: 'connector', key: 'aws' }` on /api/changes.
// - With `wakeOnView` (the núcleo, cli.ts) the probing starts on the first read of the connector (a
//   screen or the tray asked), not at boot: a núcleo nobody looks at, and every test núcleo, never
//   runs `aws`. `stop()` does not wait for a probe in flight (each has its own 15 s timeout).

import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { ChangeCursor } from '../changes/cursor.ts';
import { LoginPath, which } from '../tools/login-path.ts';
import { systemToolRunner, toolsEnv, type ToolRunner } from '../tools/runner.ts';
import { reconnectEnv } from '../telemetry/reconnect.ts';
import { awsConfigPath, awsSsoCacheDir, parseAwsConfig, SAFE_CLI_NAME, type AwsConfig, type AwsOutOfScopeProfile, type AwsProfile, type AwsSsoSession } from './aws-config.ts';
import { readSsoExpiresAt } from './aws-sso-cache.ts';
import { AwsLoginRunner, loginArgv, type AwsLoginRunnerOptions, type LoginCancelResult, type LoginMode, type LoginStarter, type LoginStartResult, type LoginStatus } from './aws-login.ts';

export const PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 15_000;
export const EXPIRING_MS = 15 * 60 * 1000;

/** What the CLI prints when the SSO token is gone (matched on stderr only, never kept). */
export const EXPIRED_PATTERNS = [/Token has expired/i, /Error loading SSO Token/i, /SSO session .*(has expired|is invalid)/i, /token .*(is expired|has expired)/i, /UnauthorizedException/, /refresh failed/i, /ExpiredToken/];

export const SESSION_STATES = ['valid', 'expiring', 'expired', 'never', 'unknown'] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export const CONNECTOR_STATES = ['missing-cli', 'unsupported-cli', 'not-configured', ...SESSION_STATES] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];
type ProbeResult = 'ok' | 'expired' | 'unknown';

export interface CliInfo {
  found: boolean;
  version: number | null;
  deviceCodeSupported: boolean;
}

export interface ConfigFileStatus {
  status: 'ok' | 'missing' | 'error';
  error?: { line: number; message: string };
}

export interface SessionView {
  name: string;
  kind: AwsSsoSession['kind'];
  startUrlHost: string | null;
  region: string | null;
  loginSupported: boolean;
  state: SessionState;
  expiresAt: string | null;
  checkedAt: string | null;
  profiles: AwsProfile[];
  login: LoginStatus;
}

export interface AwsConnectorView {
  kind: 'aws';
  state: ConnectorState;
  cli: CliInfo;
  configFile: ConfigFileStatus;
  sessions: SessionView[];
  outOfScope: AwsOutOfScopeProfile[];
}

export type LoginRefusal = 'unknown' | 'invalid-file' | 'cli-missing' | 'cli-unsupported' | 'device-code-unsupported' | 'name-not-supported';

export interface SamplerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const systemTimers: SamplerTimers = {
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface AwsConnectorOptions {
  logFile: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
  cacheDir?: string;
  run?: ToolRunner;
  /** The login shell's PATH; tests point it at a folder with a fake `aws`. */
  loginPath?: () => Promise<string>;
  now?: () => number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  timers?: SamplerTimers;
  onChange?: () => void;
  log?: (message: string) => void;
  /** Start probing (`start()`) on the first `view()`. */
  wakeOnView?: boolean;
  /** The login runner's own knobs (tests: msPerSecond, killGraceMs, onSpawn). */
  login?: Partial<Omit<AwsLoginRunnerOptions, 'logFile' | 'onChange' | 'onSucceeded'>>;
}

/** `aws-cli/2.22.1 Python/…` → major and minor; `null` when it is not the CLI's banner. */
export function parseAwsVersion(text: string): { major: number; minor: number } | null {
  const m = /aws-cli\/(\d+)\.(\d+)/.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

const ORDER: SessionState[] = ['expired', 'expiring', 'unknown', 'never', 'valid'];

export class AwsConnector {
  readonly logins: AwsLoginRunner;
  private readonly o: AwsConnectorOptions;
  private readonly run: ToolRunner;
  private readonly path: () => Promise<string>;
  private readonly configFile: string;
  private readonly cacheDir: string;
  private config: AwsConfig = { sessions: [], outOfScope: [] };
  private fileStatus: ConfigFileStatus = { status: 'missing' };
  private fileStamp: string | null = null;
  private cli: (CliInfo & { path: string | null }) | null = null;
  private readonly probes = new Map<string, { result: ProbeResult; at: string }>();
  private readonly probing = new Map<string, Promise<void>>();
  private timer: unknown = null;
  private round: Promise<void> | null = null;
  private lastView = '';
  private stopped = false;

  constructor(options: AwsConnectorOptions) {
    this.o = options;
    const home = options.home ?? homedir();
    const env = options.env ?? process.env;
    this.run = options.run ?? systemToolRunner;
    const lp = new LoginPath({ run: this.run, home, env });
    this.path = options.loginPath ?? (() => lp.get());
    this.configFile = options.configFile ?? awsConfigPath(env, home);
    this.cacheDir = options.cacheDir ?? awsSsoCacheDir(home);
    this.logins = new AwsLoginRunner({
      logFile: options.logFile,
      env: options.env ? reconnectEnv(options.env) : reconnectEnv(),
      cwd: home,
      log: options.log,
      now: options.now,
      ...options.login,
      onChange: () => this.changed(true),
      onSucceeded: (name) => void this.probe(name),
    });
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Probes now and every 5 min. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = (this.o.timers ?? systemTimers).setInterval(() => void this.probeAll(), this.o.intervalMs ?? PROBE_INTERVAL_MS);
    void this.probeAll();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) (this.o.timers ?? systemTimers).clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    await this.logins.stopAll();
  }

  /** One round: the CLI, the file, then each session's probe, one after the other. */
  probeAll(): Promise<void> {
    if (this.round) return this.round;
    this.round = (async () => {
      await this.detectCli(true);
      await this.refreshConfig();
      for (const s of this.config.sessions) await this.probe(s.name);
      await this.changed(false);
    })().finally(() => {
      this.round = null;
    });
    return this.round;
  }

  /** Probes one session (joins a probe of it already in flight). */
  probe(name: string): Promise<void> {
    const pending = this.probing.get(name);
    if (pending) return pending;
    const p = this.probeOnce(name).finally(() => this.probing.delete(name));
    this.probing.set(name, p);
    return p;
  }

  private async probeOnce(name: string): Promise<void> {
    const cli = await this.detectCli(false);
    const session = this.config.sessions.find((s) => s.name === name);
    const profile = session?.profiles.find((p) => SAFE_CLI_NAME.test(p.name));
    if (!session || !profile || !cli.found || cli.version !== 2 || !cli.path) return;
    const r = await this.run([cli.path, 'sts', 'get-caller-identity', '--profile', profile.name, '--output', 'json'], {
      timeoutMs: this.o.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      env: toolsEnv(await this.path(), this.o.env ?? process.env),
    }).catch(() => null);
    // Only the outcome is kept; stdout (account, ARN) and stderr are dropped here.
    const result: ProbeResult = !r ? 'unknown' : r.code === 0 ? 'ok' : EXPIRED_PATTERNS.some((p) => p.test(r.stderr)) ? 'expired' : 'unknown';
    this.probes.set(name, { result, at: new Date(this.now()).toISOString() });
    await this.changed(false);
  }

  private async detectCli(again: boolean): Promise<CliInfo & { path: string | null }> {
    // Found once, kept; looked for again each round while it is missing or v1 (it may get installed).
    if (this.cli && !(again && (!this.cli.found || this.cli.version !== 2))) return this.cli;
    const path = await which('aws', await this.path()).catch(() => null);
    if (!path) return (this.cli = { found: false, version: null, deviceCodeSupported: false, path: null });
    const r = await this.run([path, '--version'], { timeoutMs: this.o.probeTimeoutMs ?? PROBE_TIMEOUT_MS, env: toolsEnv(await this.path(), this.o.env ?? process.env) }).catch(() => null);
    // v1 prints its banner on stderr.
    const v = r ? parseAwsVersion(`${r.stdout}\n${r.stderr}`) : null;
    const prev = this.cli;
    this.cli = { found: true, version: v ? v.major : null, deviceCodeSupported: !!v && (v.major > 2 || (v.major === 2 && v.minor >= 22)), path };
    if (prev && (prev.found !== this.cli.found || prev.version !== this.cli.version)) this.o.log?.(`aws connector: cli ${this.cli.version === null ? 'found (version unknown)' : `v${this.cli.version}`}`);
    return this.cli;
  }

  /** Re-reads the file when its modification time or size changed. */
  async refreshConfig(): Promise<void> {
    let stamp: string;
    try {
      const s = await stat(this.configFile);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      if (this.fileStamp !== 'missing') {
        this.config = { sessions: [], outOfScope: [] };
        this.fileStatus = { status: 'missing' };
        this.fileStamp = 'missing';
      }
      return;
    }
    if (stamp === this.fileStamp) return;
    this.fileStamp = stamp;
    let text: string;
    try {
      text = await readFile(this.configFile, 'utf8');
    } catch {
      this.fileStatus = { status: 'error', error: { line: 0, message: 'não deu para ler o arquivo' } };
      return;
    }
    const parsed = parseAwsConfig(text);
    if (!parsed.ok) {
      this.fileStatus = { status: 'error', error: { line: parsed.line, message: parsed.message } };
      this.o.log?.(`aws connector: the config file does not parse (line ${parsed.line}); keeping the last good reading`);
      return;
    }
    this.config = parsed.config;
    this.fileStatus = { status: 'ok' };
    for (const name of this.probes.keys()) if (!parsed.config.sessions.some((s) => s.name === name)) this.probes.delete(name);
  }

  async view(): Promise<AwsConnectorView> {
    if (this.o.wakeOnView && !this.stopped) this.start();
    await this.refreshConfig();
    const cli = await this.detectCli(false);
    return this.compose(cli);
  }

  private async compose(cli: CliInfo): Promise<AwsConnectorView> {
    const now = this.now();
    const sessions: SessionView[] = [];
    for (const s of this.config.sessions) {
      const expiresAt = await readSsoExpiresAt(this.cacheDir, { kind: s.kind, name: s.name, startUrl: s.startUrl });
      const probe = this.probes.get(s.name) ?? null;
      sessions.push({
        name: s.name,
        kind: s.kind,
        startUrlHost: s.startUrlHost,
        region: s.region,
        loginSupported: s.loginSupported,
        state: sessionState(probe?.result ?? null, expiresAt, now),
        expiresAt,
        checkedAt: probe?.at ?? null,
        profiles: s.profiles.map((p) => ({ ...p })),
        login: this.logins.status(s.name),
      });
    }
    let state: ConnectorState;
    if (!cli.found) state = 'missing-cli';
    else if (cli.version !== null && cli.version < 2) state = 'unsupported-cli';
    else if (sessions.length === 0) state = 'not-configured';
    else state = ORDER.find((o) => sessions.some((s) => s.state === o)) ?? 'unknown';
    return {
      kind: 'aws',
      state,
      cli: { found: cli.found, version: cli.version, deviceCodeSupported: cli.deviceCodeSupported },
      configFile: { ...this.fileStatus, ...(this.fileStatus.error ? { error: { ...this.fileStatus.error } } : {}) },
      sessions,
      outOfScope: this.config.outOfScope.map((p) => ({ ...p })),
    };
  }

  /** Publishes when what the screen shows changed (always on a login move). */
  private async changed(force: boolean): Promise<void> {
    if (!this.o.onChange) return;
    const cli = this.cli ?? { found: false, version: null, deviceCodeSupported: false };
    const v = await this.compose(cli).catch(() => null);
    const key = v ? JSON.stringify(v, (k, val) => (k === 'checkedAt' ? undefined : val)) : '';
    if (!force && key === this.lastView) return;
    this.lastView = key;
    this.o.onChange();
  }

  /** Entrar: refreshes the file, checks the CLI and the name, and starts `aws sso login`. */
  async login(name: string, mode: LoginMode, startedBy: LoginStarter): Promise<LoginStartResult | { kind: 'refused'; reason: LoginRefusal }> {
    if (this.logins.running(name)) return { kind: 'already-running', status: this.logins.status(name) };
    await this.refreshConfig();
    const cli = await this.detectCli(true);
    return this.logins.start(name, mode, startedBy, () => {
      const session = this.config.sessions.find((s) => s.name === name);
      if (!session) return { kind: 'refused', reason: 'unknown' };
      if (this.fileStatus.status === 'error') return { kind: 'refused', reason: 'invalid-file' };
      if (!cli.found || !cli.path) return { kind: 'refused', reason: 'cli-missing' };
      if (cli.version !== 2) return { kind: 'refused', reason: 'cli-unsupported' };
      if (!session.loginSupported) return { kind: 'refused', reason: 'name-not-supported' };
      if (mode === 'device-code' && !cli.deviceCodeSupported) return { kind: 'refused', reason: 'device-code-unsupported' };
      return { kind: 'ok', target: { argv: loginArgv(cli.path, session, mode) } };
    }) as LoginStartResult | { kind: 'refused'; reason: LoginRefusal };
  }

  /** Cancelar: `unknown` for a session the file does not have. */
  async cancel(name: string): Promise<LoginCancelResult | { kind: 'unknown' }> {
    const r = this.logins.cancel(name);
    if (r.kind === 'canceled') return r;
    await this.refreshConfig();
    return this.config.sessions.some((s) => s.name === name) ? r : { kind: 'unknown' };
  }
}

export function sessionState(probe: ProbeResult | null, expiresAt: string | null, now: number): SessionState {
  const left = expiresAt ? Date.parse(expiresAt) - now : null;
  if (probe === 'ok') return left !== null && left <= EXPIRING_MS ? 'expiring' : 'valid';
  if (probe === 'expired') return expiresAt ? 'expired' : 'never';
  if (probe === 'unknown') return 'unknown';
  // Not probed yet (or the CLI cannot probe): the cache alone.
  if (left === null) return 'never';
  if (left <= 0) return 'expired';
  return left <= EXPIRING_MS ? 'expiring' : 'valid';
}

/** Each change of the connector as `{ type: 'connector', key: 'aws' }` on /api/changes. */
export function publishConnectorChanges(cursor: ChangeCursor, key = 'aws'): () => void {
  return () => {
    cursor.record({ type: 'connector', key, sessionId: null, accountId: null });
  };
}
