// The credential vault (decision 0011 §3): where the GitHub credential lives, and only there. One
// item per GitHub account, under the service `dev.ahrena.console.github`, account = the login. The
// adapters are the user's Keychain (macOS, keychain-vault.ts), the Secret Service (Linux,
// secret-service-vault.ts) and an in-memory one for tests and the demo, which never persists.

import { isGithubLogin } from '../login.ts';

export const GITHUB_VAULT_SERVICE = 'dev.ahrena.console.github';

export type VaultKind = 'keychain' | 'secret-service' | 'memory';

export interface CredentialVault {
  readonly kind: VaultKind;
  /** The secret of `account`, or `null` when there is none. */
  get(account: string): Promise<string | null>;
  /** Creates or replaces the secret of `account`. */
  set(account: string, secret: string): Promise<void>;
  /** Deletes the item of `account`; a missing one is not an error. */
  delete(account: string): Promise<void>;
  /** The accounts stored under `GITHUB_VAULT_SERVICE`. */
  list(): Promise<string[]>;
}

/** A vault operation that failed. The message carries an exit code at most, never a value. */
export class VaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VaultError';
  }
}

/** The token charset: tight enough that no quoting or injection is possible in `security -i`. */
const SECRET = /^[A-Za-z0-9_.-]{1,255}$/;

/** A vault account is a GitHub login (src/github/login.ts). */
export function isValidAccount(account: unknown): account is string {
  return isGithubLogin(account);
}

export function assertAccount(account: string): void {
  if (!isValidAccount(account)) throw new VaultError('vault: invalid account');
}

export function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || !SECRET.test(secret)) throw new VaultError('vault: invalid secret');
}

export class MemoryVault implements CredentialVault {
  readonly kind = 'memory' as const;
  private readonly items = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [account, secret] of Object.entries(seed)) this.items.set(account, secret);
  }

  async get(account: string): Promise<string | null> {
    assertAccount(account);
    return this.items.get(account) ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    assertAccount(account);
    assertSecret(secret);
    this.items.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    assertAccount(account);
    this.items.delete(account);
  }

  async list(): Promise<string[]> {
    return [...this.items.keys()];
  }
}
