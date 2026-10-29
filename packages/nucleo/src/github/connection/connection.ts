// The console's GitHub connection (#241, decision 0011): the state machine behind /api/connections and
// the one credential provider every GitHub source takes its token from.
//
// Sources (§5): `console` (default: the device flow and the vault) or `gh` (opt-in: `gh auth token`).
// `AHRENA_CONSOLE_GITHUB_SOURCE` > settings `github.source` > `console`.
//
// Console source: the active login is the setting `github.login`; its secret is read from the vault
// once, on first need, and kept in memory. With no login, a vault holding exactly one account is
// adopted (one connection per machine, §3). After a credential is loaded, `/user` is called once to
// learn the granted scopes, and the organizations are checked in the background, best effort: the
// ones the token sees, and the ones known to restrict the app (#336). Every call to the GitHub API goes through the single call queue (0001).
//
// Device flow: one at a time; the device code lives only here, in memory, and is dropped when the
// flow ends for any reason. Polls honour `interval` and `slow_down`; expiry, `access_denied` and
// GitHub errors end the flow with a machine code in `lastError`. Reconnecting while connected keeps
// the old credential serving until the new one replaces it; reconnecting as another login then deletes
// the previous login's vault entry.
//
// Nothing here ever logs, returns or throws the credential or the device code.

import { GithubCallQueue } from '../call-queue.ts';
import { ghCliToken } from '../github-source.ts';
import { SemGithubError } from '../repos-source.ts';
import type { GithubCredentialSource, InstallationSettings } from '../../settings/installation-settings.ts';
import { GITHUB_SCOPES, GithubAuthError, GithubDeviceFlowClient, resolveGithubClientId, type DeviceFlowClient } from './device-flow.ts';
import { findOnPath } from './run-command.ts';
import { isValidAccount, type CredentialVault, type VaultKind } from './vault.ts';

export type GithubConnectionState = 'disconnected' | 'pending' | 'connected' | 'unavailable';
export type GithubSourceFrom = 'env' | 'settings' | 'default';
export type GithubLastError = 'expired' | 'denied' | 'github-error' | 'vault-error';
export type GithubUnavailableReason = 'no-client-id' | 'no-vault' | 'gh-not-installed' | 'gh-not-authenticated' | 'github-off';

/** What GET /api/connections answers under `github`. Never the credential, never the device code. */
export interface GithubConnectionStatus {
  state: GithubConnectionState;
  source: GithubCredentialSource;
  sourceFrom: GithubSourceFrom;
  vault: VaultKind | null;
  clientId: string | null;
  ghInstalled: boolean;
  requiredScopes: string[];
  /** disconnected */
  lastError?: GithubLastError | null;
  /** pending */
  userCode?: string;
  verificationUri?: string;
  expiresAt?: string;
  interval?: number;
  /** connected (and pending while reconnecting) */
  login?: string | null;
  scopes?: string[];
  missingScopes?: string[];
  /** Whether `/user` answered, so `scopes` and `missingScopes` are known. */
  scopesChecked?: boolean;
  /** The orgs the token sees (`granted`) and the ones that restrict the app (`pending`). */
  orgs?: GithubOrg[];
  orgsChecked?: boolean;
  /** The last org check failed (GitHub down, rate limit): `orgs` is what an earlier check found. */
  orgsFailed?: boolean;
  revokeUrl?: string;
  /** unavailable */
  reason?: GithubUnavailableReason;
}

/**
 * An organization on the screen. `pending`: it restricts OAuth Apps and has not approved this one; an
 * owner approves it at `approvalUrl`, anyone grants or requests it at `requestUrl`.
 */
export type GithubOrg = { login: string; access: 'granted' } | { login: string; access: 'pending'; approvalUrl: string; requestUrl: string };

/** No GitHub credential: the source is unavailable or not connected. A `SemGithubError`, so the services treat it as "no GitHub". */
export class GithubNotConnectedError extends SemGithubError {
  readonly code = 'github-not-connected';

  constructor() {
    super('GitHub não conectado');
    this.name = 'GithubNotConnectedError';
  }
}

export type GithubConnectionErrorCode = 'github-unavailable' | 'source-is-gh' | 'github-error' | 'invalid' | 'gh-not-installed';

/** A refused connection action; the API maps `code` (and `reason`) to its answer. */
export class GithubConnectionError extends Error {
  readonly code: GithubConnectionErrorCode;
  readonly reason: GithubUnavailableReason | null;

  constructor(code: GithubConnectionErrorCode, reason: GithubUnavailableReason | null = null) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'GithubConnectionError';
    this.code = code;
    this.reason = reason;
  }
}

/** Where an org owner approves the OAuth Apps that org restricts. */
export function githubOrgPolicyUrl(org: string): string {
  return `https://github.com/organizations/${encodeURIComponent(org)}/settings/oauth_application_policy`;
}

/** Where a person approves (or revokes) the OAuth App: the same page on github.com. */
export function githubApplicationUrl(clientId: string): string {
  return `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`;
}

/** The required scopes the granted ones do not cover. `admin:org` and `write:org` cover `read:org`. */
export function missingScopes(granted: readonly string[], required: readonly string[] = GITHUB_SCOPES): string[] {
  const has = new Set(granted);
  const covers: Record<string, string[]> = { 'read:org': ['read:org', 'write:org', 'admin:org'] };
  return required.filter((scope) => !(covers[scope] ?? [scope]).some((s) => has.has(s)));
}

/** The most organizations of each list (granted, pending), and the most checked for OAuth App restrictions. */
export const MAX_CHECKED_ORGS = 30;

export interface GithubConnectionOptions {
  /** `null`: this machine has nowhere safe to keep the credential (unavailable `no-vault`). */
  vault: CredentialVault | null;
  settings: InstallationSettings;
  /** The OAuth App's client id; `undefined` resolves it from `env` and the constant, `null` means none. */
  clientId?: string | null;
  /** The device-flow and REST client; built from `fetch`/`oauthUrl`/`apiUrl` when absent. */
  client?: DeviceFlowClient;
  fetch?: typeof fetch;
  oauthUrl?: string;
  apiUrl?: string;
  /** For `AHRENA_CONSOLE_GITHUB_SOURCE` (and the client id when not given). */
  env?: NodeJS.ProcessEnv;
  /** The gh source's credential. Default `gh auth token`, refused under `node --test`. */
  ghToken?: () => Promise<string>;
  /** Whether a `gh` executable is on PATH. Never runs it. */
  ghInstalled?: () => boolean;
  /** `--no-github`: unavailable `github-off`. */
  off?: boolean;
  /** The shortest poll interval honoured, in seconds. Default 5; the demo lowers it. */
  minIntervalS?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** The single GitHub call queue of decision 0001. */
  queue?: GithubCallQueue;
  /** A status transition (recorded as a change for the /ui). */
  onChange?: () => void;
  /** The identity behind the credential changed: data read with the previous one must go. */
  onIdentityChange?: () => void;
  log?: (line: string) => void;
}

interface Flow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
  timer: unknown;
  hasTimer: boolean;
}

export class GithubConnection {
  readonly clientId: string | null;
  private readonly vault: CredentialVault | null;
  private readonly settings: InstallationSettings;
  private readonly client: DeviceFlowClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ghToken: () => Promise<string>;
  private readonly ghInstalled: () => boolean;
  private readonly off: boolean;
  private readonly minIntervalS: number;
  /** Whether the default gh token function is refused (the injected env has NODE_TEST_CONTEXT). */
  readonly ghGuarded: boolean;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly queue: GithubCallQueue;
  private readonly onChange: () => void;
  private readonly onIdentityChange: () => void;
  private readonly log: (line: string) => void;

  /** Bumped on every identity change: async work of an older generation writes nothing. */
  private generation = 0;
  /** Reading the credential (vault or gh); `null` until first needed, or to read it again. */
  private credentialLoad: Promise<void> | null = null;
  /** The `/user` call after a credential was loaded. */
  private profileLoad: Promise<void> | null = null;
  private credential: string | null = null;
  private login: string | null = null;
  private scopes: string[] = [];
  private scopesChecked = false;
  private ghFailed = false;
  private lastError: GithubLastError | null = null;
  private orgs: { checked: boolean; failed: boolean; granted: string[]; pending: string[] } = { checked: false, failed: false, granted: [], pending: [] };
  /** The generation whose org check is running: a recheck of it waits instead of starting another. */
  private orgsRunning: number | null = null;
  private flow: Flow | null = null;
  private starting: Promise<void> | null = null;
  /** Bumped by cancel, disconnect and setSource: a flow being started or finished behind them gives up. */
  private actions = 0;
  private readonly background = new Set<Promise<unknown>>();

  constructor(o: GithubConnectionOptions) {
    this.env = o.env ?? process.env;
    this.clientId = o.clientId === undefined ? resolveGithubClientId(this.env) : o.clientId || null;
    this.vault = o.vault;
    this.settings = o.settings;
    this.client = o.client ?? new GithubDeviceFlowClient({ clientId: this.clientId ?? '', fetch: o.fetch, oauthUrl: o.oauthUrl, apiUrl: o.apiUrl });
    // Only the injected env decides: cli.ts passes process.env, tests pass their own.
    this.ghGuarded = !o.ghToken && Boolean(this.env.NODE_TEST_CONTEXT);
    this.ghToken = o.ghToken ?? (this.ghGuarded ? () => Promise.reject(new Error('gh is not run under node --test')) : () => ghCliToken());
    this.ghInstalled = o.ghInstalled ?? (() => findOnPath('gh', this.env) !== null);
    this.off = o.off ?? false;
    this.minIntervalS = o.minIntervalS ?? 5;
    this.now = o.now ?? Date.now;
    this.setTimer =
      o.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    this.queue = o.queue ?? new GithubCallQueue();
    this.onChange = o.onChange ?? (() => undefined);
    this.onIdentityChange = o.onIdentityChange ?? (() => undefined);
    this.log = o.log ?? (() => undefined);
  }

  // ---- credential provider ----

  /** The active source's credential, or `GithubNotConnectedError`. No network call, except `gh auth token` under the gh source. */
  async token(): Promise<string> {
    if (this.staticUnavailable()) throw new GithubNotConnectedError();
    await this.ensureCredential();
    if (this.credential === null) throw new GithubNotConnectedError();
    return this.credential;
  }

  async connected(): Promise<boolean> {
    try {
      await this.token();
      return true;
    } catch {
      return false;
    }
  }

  /** The source in use now (env > settings > console); no I/O. */
  credentialSource(): GithubCredentialSource {
    return this.sourceInfo().source;
  }

  // ---- status ----

  async status(): Promise<GithubConnectionStatus> {
    if (!this.staticUnavailable()) {
      await this.ensureCredential();
      if (this.profileLoad) await this.profileLoad;
    }
    this.expireIfDue();
    return this.snapshot();
  }

  // ---- actions ----

  /** Starts the device flow, or returns the one already pending. */
  async start(): Promise<GithubConnectionStatus> {
    if (this.sourceInfo().source === 'gh') throw new GithubConnectionError('source-is-gh');
    const reason = this.staticUnavailable();
    if (reason) throw new GithubConnectionError('github-unavailable', reason);
    this.expireIfDue();
    if (!this.flow) {
      this.starting ??= this.beginFlow().finally(() => {
        this.starting = null;
      });
      await this.starting;
    }
    return this.status();
  }

  /** Drops the pending flow (no-op without one). */
  async cancel(): Promise<GithubConnectionStatus> {
    this.actions++;
    if (this.flow) {
      this.dropFlow();
      this.log('github: device flow cancelled');
      this.onChange();
    }
    return this.status();
  }

  /** Deletes the vault entry of the active login and forgets it here (console source only). */
  async disconnect(): Promise<GithubConnectionStatus> {
    if (this.sourceInfo().source === 'gh') throw new GithubConnectionError('source-is-gh');
    if (this.off) throw new GithubConnectionError('github-unavailable', 'github-off');
    this.actions++;
    const hadFlow = this.flow !== null;
    this.dropFlow();
    const login = this.settings.get('github.login') ?? this.login;
    // A stored null survives a restart: the single vault entry is adopted only on a first boot.
    this.settings.set('github.login', null);
    if (!login && this.credential === null) {
      // A first-boot adoption may still be waiting on the vault: a new generation makes it give up.
      this.forget();
      this.credentialLoad = Promise.resolve();
      if (hadFlow) this.onChange();
      return this.status();
    }
    this.forget();
    this.credentialLoad = Promise.resolve(); // known: nothing; no adoption again in this process
    if (login && this.vault) {
      try {
        await this.vault.delete(login);
      } catch {
        this.lastError = 'vault-error';
        this.log('github: the vault entry could not be deleted');
      }
    }
    this.log('github: disconnected');
    this.onIdentityChange();
    this.onChange();
    return this.status();
  }

  /** Chooses the credential source; drops the in-memory credentials of both. */
  async setSource(source: GithubCredentialSource): Promise<GithubConnectionStatus> {
    if (source !== 'console' && source !== 'gh') throw new GithubConnectionError('invalid');
    if (source === 'gh' && !this.ghInstalled()) throw new GithubConnectionError('gh-not-installed');
    if ((this.settings.get('github.source') ?? 'console') === source) return this.status();
    this.actions++;
    this.settings.set('github.source', source);
    this.dropFlow();
    this.forget();
    this.credentialLoad = null;
    this.log(`github: source set to ${source}`);
    this.onIdentityChange();
    this.onChange();
    return this.status();
  }

  /** Checks the organizations again (an owner just approved the app); console source, connected only. */
  async recheckOrgs(): Promise<GithubConnectionStatus> {
    if (this.sourceInfo().source === 'gh') throw new GithubConnectionError('source-is-gh');
    const reason = this.staticUnavailable();
    if (reason) throw new GithubConnectionError('github-unavailable', reason);
    await this.ensureCredential();
    if (this.profileLoad) await this.profileLoad;
    const token = this.credential;
    if (token && this.login && this.orgsRunning !== this.generation) {
      this.orgs = { ...this.orgs, checked: false, failed: false };
      this.checkOrgs(this.generation, token, this.login);
      this.onChange();
    }
    return this.status();
  }

  /** Clears the poll timer (shutdown, tests). */
  close(): void {
    this.dropFlow();
  }

  /** Resolves when no background work (load, poll, org check) is running. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // ---- internals ----

  private sourceInfo(): { source: GithubCredentialSource; from: GithubSourceFrom } {
    const fromEnv = this.env.AHRENA_CONSOLE_GITHUB_SOURCE;
    if (fromEnv === 'gh' || fromEnv === 'console') return { source: fromEnv, from: 'env' };
    const stored = this.settings.get('github.source');
    if (stored) return { source: stored, from: 'settings' };
    return { source: 'console', from: 'default' };
  }

  /** Unavailable for a reason known without touching the vault or gh. */
  private staticUnavailable(): GithubUnavailableReason | null {
    if (this.off) return 'github-off';
    if (this.sourceInfo().source === 'gh') return this.ghInstalled() ? null : 'gh-not-installed';
    if (!this.clientId) return 'no-client-id';
    if (!this.vault) return 'no-vault';
    return null;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.background.add(p);
    const remove = () => void this.background.delete(p);
    p.then(remove, remove);
    return p;
  }

  private ensureCredential(): Promise<void> {
    this.credentialLoad ??= this.track(this.loadCredential(this.generation));
    return this.credentialLoad;
  }

  private async loadCredential(generation: number): Promise<void> {
    const stale = () => generation !== this.generation;
    if (this.sourceInfo().source === 'gh') {
      try {
        const token = await this.ghToken();
        if (stale()) return;
        this.credential = token.trim() || null;
        this.ghFailed = this.credential === null;
      } catch {
        if (stale()) return;
        this.ghFailed = true;
        this.log('github: gh has no credential');
      }
      if (this.credential) this.profileLoad = this.track(this.loadProfile(generation, 'gh'));
      return;
    }
    const vault = this.vault!;
    try {
      let login = this.settings.get('github.login');
      if (!login) {
        // Adopt only on a first boot: a stored null is a disconnect (or a vanished entry).
        if (this.settings.has('github.login')) return;
        const accounts = await vault.list();
        if (stale()) return;
        if (accounts.length !== 1) return;
        login = accounts[0];
        this.settings.set('github.login', login);
        this.log(`github: adopted the vault entry of ${login}`);
      }
      const secret = await vault.get(login);
      if (stale()) return;
      if (!secret) {
        this.settings.set('github.login', null);
        this.log(`github: the vault has no entry for ${login}`);
        return;
      }
      this.credential = secret;
      this.login = login;
      if (this.lastError === 'vault-error') this.lastError = null;
    } catch {
      if (stale()) return;
      this.lastError = 'vault-error';
      this.credentialLoad = null; // try again on the next need
      this.log('github: the vault could not be read');
      return;
    }
    this.profileLoad = this.track(this.loadProfile(generation, 'console'));
  }

  /** `/user` once, for the scopes (and the login under gh); then the org check under the console source. */
  private async loadProfile(generation: number, source: GithubCredentialSource): Promise<void> {
    const token = this.credential;
    if (!token) return;
    try {
      const user = await this.queue.run(() => this.client.user(token));
      if (generation !== this.generation || this.credential !== token) return;
      this.scopes = user.scopes;
      this.scopesChecked = true;
      if (source === 'gh') this.login = user.login;
      if (source === 'console' && this.login) this.checkOrgs(generation, token, this.login);
    } catch (err) {
      if (generation !== this.generation || this.credential !== token) return;
      if (err instanceof GithubAuthError && err.status === 401) {
        this.credential = null;
        if (source === 'gh') this.ghFailed = true;
        else this.lastError = 'github-error';
        this.log('github: GitHub rejected the credential (401)');
        this.onChange();
        return;
      }
      this.scopesChecked = false;
      this.log(`github: could not read the scopes (${err instanceof GithubAuthError ? err.code : 'error'})`);
    }
  }

  /**
   * Best effort, in the background (#336). `/user/orgs` lists only the orgs that let this app in, so
   * the public memberships it leaves out are checked one by one: GitHub refuses their membership read
   * while they restrict the app. A private membership of such an org is invisible to the token.
   */
  private checkOrgs(generation: number, token: string, login: string): void {
    if (!this.clientId) return;
    const run = async () => {
      const current = () => generation === this.generation && this.credential === token;
      this.orgsRunning = generation;
      try {
        const granted = (await this.queue.run(() => this.client.orgs(token))).slice(0, MAX_CHECKED_ORGS);
        if (!current()) return;
        // The public list is a hint: without it, the orgs the token sees still go to the screen.
        const publicOrgs = await this.queue.run(() => this.client.publicOrgs(token, login)).catch(() => [] as string[]);
        const seen = new Set(granted.map((o) => o.toLowerCase()));
        const candidates = publicOrgs.filter((o) => !seen.has(o.toLowerCase())).slice(0, MAX_CHECKED_ORGS);
        const pending: string[] = [];
        let unknown = 0;
        for (const org of candidates) {
          if (!current()) return;
          const access = await this.queue.run(() => this.client.orgAccess(token, org));
          if (access === 'blocked') pending.push(org);
          else if (access === 'ok') granted.push(org);
          else unknown++;
        }
        if (!current()) return;
        if (unknown > 0) this.log(`github: ${unknown} public organization(s) could not be checked`);
        this.orgs = { checked: true, failed: false, granted: granted.slice(0, MAX_CHECKED_ORGS), pending };
        this.onChange();
      } catch (err) {
        this.log(`github: could not check the organizations (${err instanceof GithubAuthError ? err.code : 'error'})`);
        if (!current()) return;
        // Ended, so the screen offers the recheck; what an earlier check found stays.
        this.orgs = { ...this.orgs, checked: true, failed: true };
        this.onChange();
      } finally {
        if (this.orgsRunning === generation) this.orgsRunning = null;
      }
    };
    void this.track(run());
  }

  private async beginFlow(): Promise<void> {
    const actions = this.actions;
    const generation = this.generation;
    let code;
    try {
      code = await this.client.requestCode();
    } catch (err) {
      this.log(`github: the device code request failed (${err instanceof GithubAuthError ? err.code : 'error'})`);
      throw new GithubConnectionError('github-error');
    }
    // Cancelled, disconnected or switched to gh while the code was requested: no flow starts.
    if (actions !== this.actions || generation !== this.generation || this.sourceInfo().source !== 'console') return;
    const flow: Flow = {
      deviceCode: code.deviceCode,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresAt: this.now() + code.expiresIn * 1000,
      interval: Math.max(this.minIntervalS, code.interval),
      timer: null,
      hasTimer: false,
    };
    this.flow = flow;
    this.lastError = null;
    this.schedule(flow);
    this.log('github: device flow started');
    this.onChange();
  }

  private schedule(flow: Flow): void {
    flow.timer = this.setTimer(() => {
      flow.hasTimer = false;
      void this.track(this.poll(flow));
    }, flow.interval * 1000);
    flow.hasTimer = true;
  }

  private async poll(flow: Flow): Promise<void> {
    if (this.flow !== flow) return;
    if (this.now() >= flow.expiresAt) return this.endFlow(flow, 'expired');
    let result;
    try {
      result = await this.client.pollToken(flow.deviceCode);
    } catch {
      if (this.flow === flow) this.schedule(flow); // a network blip does not end the flow
      return;
    }
    if (this.flow !== flow) return;
    switch (result.kind) {
      case 'pending':
        return this.schedule(flow);
      case 'slow-down':
        flow.interval = Math.max(flow.interval + 5, result.interval);
        return this.schedule(flow);
      case 'expired':
        return this.endFlow(flow, 'expired');
      case 'denied':
        return this.endFlow(flow, 'denied');
      case 'error':
        if (/^http-5\d\d$/.test(result.code)) return this.schedule(flow); // GitHub having a bad moment, like a network blip
        this.log(`github: the device flow failed (${result.code})`);
        return this.endFlow(flow, 'github-error');
      case 'token':
        return this.complete(flow, result.token, result.scopes);
    }
  }

  private async complete(flow: Flow, token: string, tokenScopes: string[]): Promise<void> {
    let user;
    try {
      user = await this.queue.run(() => this.client.user(token));
    } catch {
      return this.endFlow(flow, 'github-error');
    }
    if (this.flow !== flow) return;
    if (!isValidAccount(user.login)) return this.endFlow(flow, 'github-error');
    const actions = this.actions;
    try {
      await this.vault!.set(user.login, token);
    } catch {
      this.log('github: the vault could not store the credential');
      return this.endFlow(flow, 'vault-error');
    }
    if (this.flow !== flow || actions !== this.actions) {
      // An action ended this flow during the write: undo it, unless it is the active login's entry.
      if (user.login !== this.login) {
        await this.vault!.delete(user.login).catch(() => this.log('github: the vault entry could not be deleted'));
      }
      return;
    }
    const changed = this.login !== user.login || this.credential !== token;
    const previous = this.login;
    this.dropFlow();
    this.generation++;
    this.credentialLoad = Promise.resolve();
    this.profileLoad = null;
    this.settings.set('github.login', user.login);
    this.credential = token;
    this.login = user.login;
    this.scopes = user.scopes.length > 0 ? user.scopes : tokenScopes;
    this.scopesChecked = true;
    this.lastError = null;
    this.orgs = { checked: false, failed: false, granted: [], pending: [] };
    this.checkOrgs(this.generation, token, user.login);
    this.log(`github: connected as ${user.login}`);
    // Reconnected as another login: the previous entry goes, so no live token outlives its use.
    if (previous && previous !== user.login) {
      await this.vault!.delete(previous).catch(() => this.log('github: the previous vault entry could not be deleted'));
    }
    if (changed) this.onIdentityChange();
    this.onChange();
  }

  private endFlow(flow: Flow, error: GithubLastError): void {
    if (this.flow !== flow) return;
    this.dropFlow();
    this.lastError = error;
    this.log(`github: device flow ended (${error})`);
    this.onChange();
  }

  private expireIfDue(): void {
    if (this.flow && this.now() >= this.flow.expiresAt) this.endFlow(this.flow, 'expired');
  }

  /** Drops the pending flow and its timer; the device code goes with it. */
  private dropFlow(): void {
    const flow = this.flow;
    if (!flow) return;
    if (flow.hasTimer) this.clearTimer(flow.timer);
    flow.hasTimer = false;
    flow.deviceCode = '';
    this.flow = null;
  }

  /** Forgets every in-memory credential and what was learned with it. */
  private forget(): void {
    this.generation++;
    this.credential = null;
    this.login = null;
    this.scopes = [];
    this.scopesChecked = false;
    this.ghFailed = false;
    this.lastError = null;
    this.orgs = { checked: false, failed: false, granted: [], pending: [] };
    this.profileLoad = null;
  }

  private snapshot(): GithubConnectionStatus {
    const { source, from } = this.sourceInfo();
    const common = (state: GithubConnectionState): GithubConnectionStatus => ({
      state,
      source,
      sourceFrom: from,
      vault: this.vault?.kind ?? null,
      clientId: this.clientId,
      ghInstalled: this.ghInstalled(),
      requiredScopes: [...GITHUB_SCOPES],
    });
    const reason = this.staticUnavailable() ?? (source === 'gh' && this.ghFailed ? 'gh-not-authenticated' : null);
    if (reason) return { ...common('unavailable'), reason };
    const connected = this.credential !== null ? this.connectedFields(source) : null;
    if (this.flow) {
      const f = this.flow;
      return {
        ...common('pending'),
        userCode: f.userCode,
        verificationUri: f.verificationUri,
        expiresAt: new Date(f.expiresAt).toISOString(),
        interval: f.interval,
        ...connected,
      };
    }
    if (connected) return { ...common('connected'), ...connected };
    return { ...common('disconnected'), lastError: this.lastError };
  }

  /** The pending orgs first: they are the ones that need a click. */
  private orgList(clientId: string): GithubOrg[] {
    const requestUrl = githubApplicationUrl(clientId);
    return [
      ...this.orgs.pending.map((login): GithubOrg => ({ login, access: 'pending', approvalUrl: githubOrgPolicyUrl(login), requestUrl })),
      ...this.orgs.granted.map((login): GithubOrg => ({ login, access: 'granted' })),
    ];
  }

  private connectedFields(source: GithubCredentialSource): Partial<GithubConnectionStatus> {
    const consoleSource = source === 'console' && this.clientId !== null;
    return {
      login: this.login,
      scopes: [...this.scopes],
      missingScopes: this.scopesChecked ? missingScopes(this.scopes) : [],
      scopesChecked: this.scopesChecked,
      orgs: consoleSource ? this.orgList(this.clientId!) : [],
      orgsChecked: consoleSource && this.orgs.checked,
      orgsFailed: consoleSource && this.orgs.failed,
      ...(consoleSource ? { revokeUrl: githubApplicationUrl(this.clientId!) } : {}),
    };
  }
}
