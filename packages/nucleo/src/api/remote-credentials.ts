// The remote owner credential's table (decision 0020, #388): what the core of a remote machine keeps in
// memory about the short credentials it issued to its owner's Mac, and nothing else.
//
// - Memory only. A restart drops the table and draws a new `generation`, so every older credential is
//   `credential-unknown`: nothing survives on disk.
// - At most `MAX_LIVE` live credentials; issuing one more evicts the oldest. `revoke` at issue time drops
//   the listed ids first.
// - A credential lives `TTL_MS` (10 min). An expired one stays in the table for one more TTL (at most
//   `MAX_KEPT` entries in all) only so the answer can say `credential-expired`; after that it is unknown.
// - Per credential, the nonces of the signed requests seen in the last `NONCE_RETENTION_MS`, at most
//   `MAX_NONCES`. A nonce is recorded only after the signature checked (api/remote-auth.ts).
// - Everything that tells time or draws randomness is injectable, so tests never wait or guess.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

export const CREDENTIAL_TTL_MS = 10 * 60_000;
export const MAX_LIVE_CREDENTIALS = 3;
/** The signed request's `ts` must be this close to the core's clock. */
export const CLOCK_WINDOW_MS = 10_000;
/** A nonce is remembered for twice the window: a `ts` up to 10 s ahead stays acceptable for 10 s after. */
export const NONCE_RETENTION_MS = 2 * CLOCK_WINDOW_MS;
export const MAX_NONCES = 10_000;
const MAX_KEPT = 16;

export const CREDENTIAL_ID = /^[0-9a-f]{32}$/;
export const REQUEST_NONCE = /^[0-9a-f]{32}$/;

export interface RemoteCredential {
  credentialId: string;
  /** 32 random bytes, base64url. Never leaves the core except in the issue answer. */
  key: string;
  uid: number;
  corePid: number;
  corePort: number;
  generation: string;
  machineIdentity: string;
  issuedAt: number;
  expiresAt: number;
}

export type Lookup = { kind: 'live'; credential: RemoteCredential } | { kind: 'expired' } | { kind: 'unknown' };

/** `machineIdentity`: the SHA-256 of `ahrena-console-machine-v1\n` and the machine's own id. Not a secret; stable. */
export function machineIdentity(read: () => string = readMachineId): string {
  return createHash('sha256').update(`ahrena-console-machine-v1\n${read()}`).digest('hex');
}

/** `/etc/machine-id` (Linux), `IOPlatformUUID` (macOS). Without either, the host name: stable enough for a tag. */
export function readMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m) return m[1]!;
    } else {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const text = readFileSync(file, 'utf8').trim();
          if (text) return text;
        } catch {
          /* try the next one */
        }
      }
    }
  } catch {
    /* falls through */
  }
  return `host:${hostname()}`;
}

export interface RemoteCredentialStoreOptions {
  now?: () => number;
  /** 16 bytes of randomness; default `crypto.randomBytes`. */
  random?: (bytes: number) => Buffer;
  generation?: string;
  machineIdentity?: string;
  uid?: number;
  corePid?: number;
  ttlMs?: number;
  maxLive?: number;
  maxNonces?: number;
}

export type NonceResult = 'recorded' | 'replayed' | 'full';

interface Entry {
  credential: RemoteCredential;
  /** nonce -> when it stops mattering; insertion order is time order, so the oldest are in front. */
  nonces: Map<string, number>;
}

export class RemoteCredentialStore {
  readonly now: () => number;
  readonly uid: number;
  readonly corePid: number;
  #machineIdentity: string | undefined;
  readonly #readIdentity: () => string;
  #generation: string;
  readonly #random: (bytes: number) => Buffer;
  readonly #ttl: number;
  readonly #maxLive: number;
  readonly #maxNonces: number;
  readonly #entries = new Map<string, Entry>();

  constructor(o: RemoteCredentialStoreOptions = {}) {
    this.now = o.now ?? Date.now;
    this.#random = o.random ?? randomBytes;
    this.#generation = o.generation ?? this.#random(16).toString('hex');
    this.#machineIdentity = o.machineIdentity;
    this.#readIdentity = () => machineIdentity();
    this.uid = o.uid ?? process.getuid?.() ?? -1;
    this.corePid = o.corePid ?? process.pid;
    this.#ttl = o.ttlMs ?? CREDENTIAL_TTL_MS;
    this.#maxLive = o.maxLive ?? MAX_LIVE_CREDENTIALS;
    this.#maxNonces = o.maxNonces ?? MAX_NONCES;
  }

  /** Computed on first use: reading the machine id can spawn `ioreg`. */
  get machineIdentity(): string {
    return (this.#machineIdentity ??= this.#readIdentity());
  }

  get generation(): string {
    return this.#generation;
  }

  /** A restart, for tests and for nothing else: the table goes and the generation changes. */
  restart(generation = this.#random(16).toString('hex')): void {
    this.#entries.clear();
    this.#generation = generation;
  }

  /** Drops `revoke` first, then the expired ones past their keeping time, then evicts the oldest live ones to make room. */
  issue(o: { port: number; revoke?: readonly string[] }): RemoteCredential {
    for (const id of o.revoke ?? []) this.#entries.delete(id);
    const now = this.now();
    this.#prune(now);
    const live = [...this.#entries.values()].filter((e) => e.credential.expiresAt > now);
    for (let i = 0; i <= live.length - this.#maxLive; i++) this.#entries.delete(live[i]!.credential.credentialId);
    const credential: RemoteCredential = {
      credentialId: this.#random(16).toString('hex'),
      key: this.#random(32).toString('base64url'),
      uid: this.uid,
      corePid: this.corePid,
      corePort: o.port,
      generation: this.#generation,
      machineIdentity: this.machineIdentity,
      issuedAt: now,
      expiresAt: now + this.#ttl,
    };
    this.#entries.set(credential.credentialId, { credential, nonces: new Map() });
    return credential;
  }

  lookup(id: string): Lookup {
    const e = this.#entries.get(id);
    if (!e || e.credential.generation !== this.#generation) return { kind: 'unknown' };
    return e.credential.expiresAt > this.now() ? { kind: 'live', credential: e.credential } : { kind: 'expired' };
  }

  /** Still good right now: what an open response asks at every output boundary. */
  isLive(id: string): boolean {
    return this.lookup(id).kind === 'live';
  }

  /** Records a nonce of a request whose signature already checked. `replayed` if seen; `full` at the cap. */
  recordNonce(id: string, nonce: string): NonceResult {
    const e = this.#entries.get(id);
    if (!e) return 'full';
    const now = this.now();
    for (const [n, until] of e.nonces) {
      if (until > now) break;
      e.nonces.delete(n);
    }
    if (e.nonces.has(nonce)) return 'replayed';
    if (e.nonces.size >= this.#maxNonces) return 'full';
    e.nonces.set(nonce, now + NONCE_RETENTION_MS);
    return 'recorded';
  }

  /** How many credentials are live now (tests and the cap). */
  liveCount(): number {
    const now = this.now();
    let n = 0;
    for (const e of this.#entries.values()) if (e.credential.expiresAt > now) n++;
    return n;
  }

  #prune(now: number): void {
    for (const [id, e] of this.#entries) if (e.credential.expiresAt + this.#ttl <= now) this.#entries.delete(id);
    while (this.#entries.size >= MAX_KEPT) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
