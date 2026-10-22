// The macOS Keychain adapter (decision 0011 §3), through `/usr/bin/security`. The secret goes to
// `security -i` on stdin, never in argv (another process's `ps` would see it). Account and secret are
// validated against tight charsets before anything runs, so the stdin line needs no escaping.
// Errors carry the exit code only: the tool's output is never logged nor put in a message.

import { runCommand, type RunCommand } from './run-command.ts';
import { assertAccount, assertSecret, GITHUB_VAULT_SERVICE, isValidAccount, VaultError, type CredentialVault } from './vault.ts';

/** `security`'s exit code when the item does not exist (errSecItemNotFound). */
const NOT_FOUND = 44;

export interface KeychainVaultOptions {
  /** The `security` executable, by absolute path (tests inject a fake). Never resolved on PATH. */
  bin?: string;
  run?: RunCommand;
}

export class KeychainVault implements CredentialVault {
  readonly kind = 'keychain' as const;
  readonly bin: string;
  private readonly run: RunCommand;

  constructor({ bin = '/usr/bin/security', run = runCommand }: KeychainVaultOptions = {}) {
    this.bin = bin;
    this.run = run;
  }

  async get(account: string): Promise<string | null> {
    assertAccount(account);
    const r = await this.exec(['find-generic-password', '-s', GITHUB_VAULT_SERVICE, '-a', account, '-w']);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new VaultError(`keychain: read failed (exit ${r.code})`);
    const secret = r.stdout.replace(/\r?\n$/, '');
    return secret === '' ? null : secret;
  }

  async set(account: string, secret: string): Promise<void> {
    assertAccount(account);
    assertSecret(secret);
    const line = `add-generic-password -U -s "${GITHUB_VAULT_SERVICE}" -a "${account}" -w "${secret}"\n`;
    const r = await this.exec(['-i'], line);
    if (r.code !== 0) throw new VaultError(`keychain: write failed (exit ${r.code})`);
    // `security -i` may exit 0 when a command inside failed: read it back (on stdout, never argv) and compare.
    if ((await this.get(account)) !== secret) throw new VaultError('keychain: write failed (not stored)');
  }

  async delete(account: string): Promise<void> {
    assertAccount(account);
    const r = await this.exec(['delete-generic-password', '-s', GITHUB_VAULT_SERVICE, '-a', account]);
    if (r.code !== 0 && r.code !== NOT_FOUND) throw new VaultError(`keychain: delete failed (exit ${r.code})`);
  }

  /** `dump-keychain` without `-d`: attributes only, the secrets are not printed. */
  async list(): Promise<string[]> {
    const r = await this.exec(['dump-keychain']);
    if (r.code !== 0) throw new VaultError(`keychain: list failed (exit ${r.code})`);
    return parseDumpKeychain(r.stdout);
  }

  private async exec(args: string[], input?: string) {
    try {
      return await this.run(this.bin, args, { input });
    } catch {
      throw new VaultError('keychain: security did not run');
    }
  }
}

/**
 * A blob attribute of a dump item: `"acct"<blob>="text"`, or the hex form `"acct"<blob>=0x…  "text"`
 * that `security` prints when the value has bytes it will not show plainly (then the text carries
 * escapes and is not a valid login anyway).
 */
function attribute(item: string, name: string): string | undefined {
  const m = new RegExp(`^\\s*"${name}"<blob>=(?:"([^"]*)"|0x[0-9A-Fa-f]+\\s+"([^"]*)")\\s*$`, 'm').exec(item);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** The accounts of the generic items of `GITHUB_VAULT_SERVICE` in a `security dump-keychain` output. */
export function parseDumpKeychain(text: string): string[] {
  const accounts = new Set<string>();
  for (const item of text.split(/^keychain: /m)) {
    if (!/^class: "genp"$/m.test(item)) continue;
    const service = attribute(item, 'svce');
    const account = attribute(item, 'acct');
    if (service === GITHUB_VAULT_SERVICE && isValidAccount(account)) accounts.add(account);
  }
  return [...accounts];
}
