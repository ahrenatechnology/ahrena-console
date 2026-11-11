// The remote owner's proof, Mac side (decision 0020, #388): this Mac's core obtains a short credential from
// the remote core by running the user's `connection.credential` command (an SSH that already entered there),
// keeps it in memory only, and signs every request it sends through the tunnel port with it.
//
// - The command runs with its OWN runner, not the reconnect one: no shell, its own process group, the
//   request as one JSON line on stdin (`{version, nonce, revoke}`, never this Mac's token), stdout piped to
//   memory with a 4 KiB cap, stderr discarded, a timeout that kills the group. Nothing of its output goes to
//   reconnect.log, the core's log or an HTTP answer: the log line is `credential (<machine id>): ok` or
//   `failed (<why>)`, with fixed words only.
// - The key lives in a private field of this module, outside every projection (`GET /api/machines`, the
//   registry, the /ui). What crosses the port is `AhrenaRemote id, ts, nonce, sig`, never the key.
// - The first good credential of a machine pins `{ machineIdentity, uid }` for the life of the process; a later
//   one that differs is refused (`owner-auth-mismatch`) and nothing is signed. After each issue, the anonymous
//   `GET /api/overview` on the tunnel port must answer the credential's `corePid`, or the credential is
//   dropped (`owner-auth-failed`): the port leads to another core.
// - `ts` is the remote clock as this Mac counts it: `issuedAt` plus this Mac's MONOTONIC time since the answer
//   arrived, so neither a clock skew between the machines nor a change of this Mac's clock matters.
// - Renewal: when less than 2 min are left, and on a 401 `credential-unknown`, `credential-expired` or
//   `credential-clock` (then the request is repeated once). Never on 401 `credential-signature` nor on
//   429 `credential-busy`: a new credential fixes neither, and it would only cost one SSH per request.
// - One issue per machine at a time; a failed one waits 30 s, 60 s, then 5 min before the next try. No issue
//   at all while the tunnel port does not answer `/api/overview`: a closed or silent tunnel never costs an SSH.
// - Dropped: on a start, stop or reconnect of the machine's connection, on `port-closed` after a signed
//   request, on an invalid answer, on a renewable 401 and when the identity changes. Dropped credentials that
//   may still live over there go in the `revoke` of the next issue (at most 3).
// - `no-response` after a signed request does NOT drop the credential (Argos note on #450): a slow tunnel
//   would otherwise cost one SSH per 30 s poll. The request that did not arrive is the residue the record
//   declares (section 3): one delivery of exactly that request, within its 10 s window, whether or not the
//   Mac keeps the credential; dropping it would revoke it only at the next issue, minutes later.
// - Fail closed: without a credential the request goes WITHOUT any proof. A core that requires one answers
//   403 and the machine stays `owner-auth-required` (no command) or `owner-auth-failed`; a core older than
//   #391 (the Workstation's 81251bd) answers 200 and keeps working. Nothing ever falls back to Origin or to
//   "came through the tunnel".

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import type { ReconnectConfig } from './machines-config.ts';
import type { RemoteGet, RemoteGetResult } from './ports.ts';
import { reconnectEnv } from './reconnect.ts';
import type { UnreachableReason } from './model.ts';

export const MAX_CREDENTIAL_OUTPUT_BYTES = 4096;
/** Renew when the credential has less than this left. */
export const RENEW_BEFORE_MS = 2 * 60_000;
/** The wait before the next issue after the 1st, 2nd and 3rd (and later) failure in a row. */
export const ISSUE_BACKOFF_MS = [30_000, 60_000, 5 * 60_000] as const;
export const MAX_REVOKE = 3;
/** The 401 reasons a new credential fixes (decision 0020 section 4). */
export const RENEWABLE_REASONS = ['credential-unknown', 'credential-expired', 'credential-clock'] as const;
export const OVERVIEW_PATH = '/api/overview';

const HEX32 = /^[0-9a-f]{32}$/;

/** The issue answer, as the remote CLI relays it (src/owner/remote-credential.ts `relay`). */
export interface IssuedCredential {
  credentialId: string;
  key: string;
  machineIdentity: string;
  uid: number;
  corePid: number;
  corePort: number;
  generation: string;
  issuedAt: number;
  expiresAt: number;
}

export type CredentialRunResult = { kind: 'ok'; stdout: string } | { kind: 'failed'; why: string };
export type CredentialRunner = (config: ReconnectConfig, input: string) => Promise<CredentialRunResult>;

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface CredentialRunnerOptions {
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Tests shorten the time unit; 1000 in production. */
  msPerSecond?: number;
}

/**
 * The credential command's own runner: no shell, its own process group, `input` on stdin and stdin closed,
 * stdout to memory up to 4 KiB, stderr discarded. Past the cap or the timeout the group is killed. Never
 * rejects, and its `why` is a fixed word or an exit code: never the command's output.
 */
export function credentialRunner(o: CredentialRunnerOptions = {}): CredentialRunner {
  return (config, input) =>
    new Promise<CredentialRunResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = (o.spawn ?? (nodeSpawn as Spawn))(config.command[0]!, config.command.slice(1), {
          shell: false,
          detached: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: reconnectEnv(o.env),
          cwd: o.cwd ?? homedir(),
        });
      } catch {
        return resolve({ kind: 'failed', why: 'spawn-error' });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      };
      const finish = (r: CredentialRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        killGroup();
        finish({ kind: 'failed', why: 'timeout' });
      }, config.timeoutSeconds * (o.msPerSecond ?? 1000));
      timer.unref?.();
      child.on('error', () => finish({ kind: 'failed', why: 'spawn-error' }));
      child.stdout?.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_CREDENTIAL_OUTPUT_BYTES) {
          chunks.length = 0;
          killGroup();
          return finish({ kind: 'failed', why: 'invalid-output' });
        }
        chunks.push(c);
      });
      child.on('close', (code) => {
        if (code === 0) finish({ kind: 'ok', stdout: Buffer.concat(chunks).toString('utf8') });
        else finish({ kind: 'failed', why: `exit ${code ?? 'signal'}` });
        chunks.length = 0;
      });
      // A command that exits without reading its stdin: EPIPE is not an error of ours.
      child.stdin?.on('error', () => {});
      child.stdin?.end(`${input}\n`);
    });
}

/** The command's stdout as a credential for `nonce`; otherwise why not. Pure. */
export function parseIssued(stdout: string, nonce: string): IssuedCredential | 'invalid-output' | 'nonce-mismatch' {
  const line = stdout.trim();
  if (!line || line.includes('\n')) return 'invalid-output';
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return 'invalid-output';
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'invalid-output';
  const a = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  if (a.version !== 1) return 'invalid-output';
  if (typeof a.credentialId !== 'string' || !HEX32.test(a.credentialId) || typeof a.generation !== 'string' || !HEX32.test(a.generation)) return 'invalid-output';
  if (typeof a.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(a.key) || typeof a.machineIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(a.machineIdentity)) return 'invalid-output';
  if (!num(a.uid) || !num(a.corePid) || !num(a.corePort) || a.corePort < 1 || a.corePort > 65_535 || !num(a.issuedAt) || !num(a.expiresAt) || a.expiresAt <= a.issuedAt) return 'invalid-output';
  if (a.nonce !== nonce) return 'nonce-mismatch';
  return {
    credentialId: a.credentialId,
    key: a.key,
    machineIdentity: a.machineIdentity,
    uid: a.uid,
    corePid: a.corePid,
    corePort: a.corePort,
    generation: a.generation,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
  };
}

/** The `AhrenaRemote` header for one request (the string of api/remote-auth.ts `signingString`). */
export function signRequest(c: Pick<IssuedCredential, 'credentialId' | 'key' | 'generation'>, p: { method: string; target: string; host: string; ts: number; nonce: string; body: string }): string {
  const bodyHash = createHash('sha256').update(p.body).digest('hex');
  const text = `ahrena-remote-v1\n${p.method}\n${p.target}\n${p.host}\n${c.generation}\n${p.ts}\n${p.nonce}\n${bodyHash}`;
  const sig = createHmac('sha256', c.key).update(text).digest('hex');
  return `AhrenaRemote id=${c.credentialId}, ts=${p.ts}, nonce=${p.nonce}, sig=${sig}`;
}

/** What the transport adds to a signed request. Opaque to it: only `authorization` and `host` go on the wire. */
export interface SignedRequest {
  readonly authorization: string;
  /** The remote core's own Host, from the credential (`127.0.0.1:<corePort>`). */
  readonly host: string;
  readonly machineId: string;
  readonly credentialId: string;
  /** This is the one repeat after a renewal. */
  readonly retried: boolean;
}

/** The proof the loopback transports consult (adapters/loopback-http.ts). */
export interface RemoteProof {
  /** The signature for this request, or `null` to send it without proof. Never rejects. */
  authorize(port: number, method: string, target: string, body: string, retried?: boolean): Promise<SignedRequest | null>;
  /** After the answer: `retry` once after a renewal, or `done`. */
  settle(signed: SignedRequest, result: RemoteGetResult): 'retry' | 'done';
}

/** A machine as the proof needs it: its id and its credential command, from the freshest reading of machines.json. */
export interface ProofMachine {
  id: string;
  credential: ReconnectConfig | null;
}

export interface RemoteProofsOptions {
  /** The machine whose tunnel is this local port; `undefined` for any other port. */
  machineFor: (port: number) => ProofMachine | undefined;
  /** The anonymous `GET /api/overview` through the tunnel port: the pid it answers, or `null`. */
  overviewPid: (port: number) => Promise<number | null>;
  run?: CredentialRunner;
  /** Monotonic milliseconds (default `process.hrtime`); never this Mac's wall clock. */
  monotonic?: () => number;
  random?: (bytes: number) => Buffer;
  log?: (message: string) => void;
}

interface Held {
  c: IssuedCredential;
  /** Monotonic time when the answer arrived. */
  receivedAt: number;
}

interface MachineProof {
  held: Held | null;
  pinned: { machineIdentity: string; uid: number } | null;
  revoke: string[];
  outcome: 'none' | 'ok' | 'failed' | 'mismatch';
  failures: number;
  retryAt: number;
  issuing: Promise<Held | null> | null;
}

const hrtimeMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** The overview pid through a plain, unsigned `RemoteGet`. */
export function overviewPidVia(get: RemoteGet): (port: number) => Promise<number | null> {
  return async (port) => {
    const r = await get(port, OVERVIEW_PATH);
    if (r.kind !== 'response' || r.status !== 200 || typeof r.body !== 'object' || r.body === null) return null;
    const pid = (r.body as { pid?: unknown }).pid;
    return Number.isSafeInteger(pid) ? (pid as number) : null;
  };
}

export class RemoteProofs implements RemoteProof {
  readonly #o: RemoteProofsOptions;
  readonly #machines = new Map<string, MachineProof>();

  constructor(options: RemoteProofsOptions) {
    this.#o = options;
  }

  #now(): number {
    return (this.#o.monotonic ?? hrtimeMs)();
  }

  #entry(id: string): MachineProof {
    let p = this.#machines.get(id);
    if (!p) this.#machines.set(id, (p = { held: null, pinned: null, revoke: [], outcome: 'none', failures: 0, retryAt: 0, issuing: null }));
    return p;
  }

  #log(id: string, what: string): void {
    this.#o.log?.(`credential (${id}): ${what}`);
  }

  /** The remote clock as this Mac counts it. */
  #ts(h: Held): number {
    return h.c.issuedAt + Math.max(0, this.#now() - h.receivedAt);
  }

  #drop(p: MachineProof, credentialId: string): void {
    if (p.held?.c.credentialId !== credentialId) return;
    p.held = null;
    this.#remember(p, credentialId);
  }

  #remember(p: MachineProof, credentialId: string): void {
    if (!p.revoke.includes(credentialId)) p.revoke.push(credentialId);
    if (p.revoke.length > MAX_REVOKE) p.revoke.splice(0, p.revoke.length - MAX_REVOKE);
  }

  #fail(p: MachineProof, id: string, outcome: 'failed' | 'mismatch', why: string): null {
    p.outcome = outcome;
    p.failures++;
    p.retryAt = this.#now() + ISSUE_BACKOFF_MS[Math.min(p.failures, ISSUE_BACKOFF_MS.length) - 1]!;
    this.#log(id, why);
    return null;
  }

  /** Why a machine whose core refused the request (401, 403) is unreachable (decision 0020 section 6). */
  reason(machineId: string, configured: boolean): UnreachableReason {
    if (!configured) return 'owner-auth-required';
    return this.#machines.get(machineId)?.outcome === 'mismatch' ? 'owner-auth-mismatch' : 'owner-auth-failed';
  }

  /** The machine's connection started, stopped or reconnected: its credential goes, and the next issue may run at once. */
  discard(machineId: string): void {
    const p = this.#machines.get(machineId);
    if (!p) return;
    if (p.held) this.#drop(p, p.held.c.credentialId);
    p.failures = 0;
    p.retryAt = 0;
  }

  /** Whether a credential is held for the machine (tests and the leak scan; never the credential itself). */
  holds(machineId: string): boolean {
    return this.#machines.get(machineId)?.held != null;
  }

  async authorize(port: number, method: string, target: string, body: string, retried = false): Promise<SignedRequest | null> {
    try {
      const m = this.#o.machineFor(port);
      if (!m?.credential) return null;
      const p = this.#entry(m.id);
      let held = p.held;
      if (!held || held.c.expiresAt - this.#ts(held) <= RENEW_BEFORE_MS) {
        const fresh = await this.#issue(m, p, port);
        if (fresh) held = fresh;
        else if (held && held.c.expiresAt - this.#ts(held) <= 0) held = null;
        // A pid or identity that failed after this credential was issued leaves it unusable.
        if (held && p.held !== held) held = p.held;
      }
      if (!held) return null;
      const host = `127.0.0.1:${held.c.corePort}`;
      const nonce = (this.#o.random ?? randomBytes)(16).toString('hex');
      const authorization = signRequest(held.c, { method, target, host, ts: this.#ts(held), nonce, body });
      return { authorization, host, machineId: m.id, credentialId: held.c.credentialId, retried };
    } catch {
      return null;
    }
  }

  settle(signed: SignedRequest, result: RemoteGetResult): 'retry' | 'done' {
    const p = this.#machines.get(signed.machineId);
    if (!p) return 'done';
    if (result.kind === 'unreachable') {
      // The tunnel went down: the next use issues again, and checks the pid again.
      if (result.reason === 'port-closed') this.#drop(p, signed.credentialId);
      return 'done';
    }
    if (result.status === 401) {
      const reason = typeof result.body === 'object' && result.body !== null ? (result.body as { reason?: unknown }).reason : undefined;
      if ((RENEWABLE_REASONS as readonly unknown[]).includes(reason)) {
        this.#drop(p, signed.credentialId);
        if (!signed.retried) return 'retry';
        // Refused again after a renewal.
        this.#fail(p, signed.machineId, 'failed', 'refused after renewal');
        return 'done';
      }
      // `credential-signature` or anything else: no renewal.
      p.outcome = 'failed';
      return 'done';
    }
    if (result.status === 200 && result.body === undefined) {
      // A 200 that is not JSON is not the core's answer: the request may have reached someone else.
      this.#drop(p, signed.credentialId);
      return 'done';
    }
    return 'done';
  }

  #issue(m: ProofMachine, p: MachineProof, port: number): Promise<Held | null> {
    if (p.issuing) return p.issuing;
    if (this.#now() < p.retryAt) return Promise.resolve(null);
    p.issuing = this.#issueOnce(m, p, port).finally(() => {
      p.issuing = null;
    });
    return p.issuing;
  }

  async #issueOnce(m: ProofMachine, p: MachineProof, port: number): Promise<Held | null> {
    // Only with the port answering as a core: a closed or silent tunnel never costs an SSH.
    if ((await this.#o.overviewPid(port)) === null) return null;
    const nonce = (this.#o.random ?? randomBytes)(16).toString('hex');
    const revoke = p.revoke.slice(-MAX_REVOKE);
    const run = await (this.#o.run ?? credentialRunner())(m.credential!, JSON.stringify({ version: 1, nonce, revoke }));
    if (run.kind === 'failed') return this.#fail(p, m.id, 'failed', `failed (${run.why})`);
    const c = parseIssued(run.stdout, nonce);
    if (typeof c === 'string') return this.#fail(p, m.id, 'failed', `failed (${c})`);
    const held: Held = { c, receivedAt: this.#now() };
    // The core dropped what we sent in `revoke`.
    p.revoke = p.revoke.filter((id) => !revoke.includes(id));
    if (p.pinned && (p.pinned.machineIdentity !== c.machineIdentity || p.pinned.uid !== c.uid)) {
      if (p.held) this.#drop(p, p.held.c.credentialId);
      this.#remember(p, c.credentialId);
      return this.#fail(p, m.id, 'mismatch', 'identity-mismatch');
    }
    const pid = await this.#o.overviewPid(port);
    if (pid !== c.corePid) {
      if (p.held) this.#drop(p, p.held.c.credentialId);
      this.#remember(p, c.credentialId);
      return this.#fail(p, m.id, 'failed', 'pid-mismatch');
    }
    p.pinned ??= { machineIdentity: c.machineIdentity, uid: c.uid };
    if (p.held) this.#remember(p, p.held.c.credentialId);
    p.held = held;
    p.outcome = 'ok';
    p.failures = 0;
    p.retryAt = 0;
    this.#log(m.id, 'ok');
    return held;
  }
}

/**
 * One request through the proof: signed when a credential is held (renewing first when needed), without proof
 * otherwise; repeated once, signed anew, after a renewable 401. `send` puts the request on the wire.
 */
export async function sendWithProof(
  proof: RemoteProof | null | undefined,
  port: number,
  method: string,
  target: string,
  body: string | null,
  send: (signed: SignedRequest | null) => Promise<RemoteGetResult>,
): Promise<RemoteGetResult> {
  if (!proof) return send(null);
  const signed = await proof.authorize(port, method, target, body ?? '');
  const first = await send(signed);
  if (!signed || proof.settle(signed, first) === 'done') return first;
  const again = await proof.authorize(port, method, target, body ?? '', true);
  if (!again) return first;
  const second = await send(again);
  proof.settle(again, second);
  return second;
}
