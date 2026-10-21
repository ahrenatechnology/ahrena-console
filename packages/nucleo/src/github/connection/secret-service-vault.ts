// The Linux Secret Service adapter (decision 0011 §3), through `secret-tool`: `store` reads the secret
// from stdin, never from argv. Items carry the attributes `service dev.ahrena.console.github` and
// `account <login>`. Errors carry the exit code only; the tool's output is never logged.

import { runCommand, type RunCommand } from './run-command.ts';
import { assertAccount, assertSecret, GITHUB_VAULT_SERVICE, isValidAccount, VaultError, type CredentialVault } from './vault.ts';

const LABEL = 'Ahrena Console (GitHub)';

export interface SecretServiceVaultOptions {
  /** The `secret-tool` executable (tests inject a fake by absolute path). */
  bin?: string;
  run?: RunCommand;
}

export class SecretServiceVault implements CredentialVault {
  readonly kind = 'secret-service' as const;
  readonly bin: string;
  private readonly run: RunCommand;

  constructor({ bin = 'secret-tool', run = runCommand }: SecretServiceVaultOptions = {}) {
    this.bin = bin;
    this.run = run;
  }

  async get(account: string): Promise<string | null> {
    assertAccount(account);
    const r = await this.exec(['lookup', 'service', GITHUB_VAULT_SERVICE, 'account', account]);
    // `lookup` exits 1 with no output when nothing matches.
    if (r.code !== 0) {
      if (r.code === 1 && r.stdout === '') return null;
      throw new VaultError(`secret service: read failed (exit ${r.code})`);
    }
    const secret = r.stdout.replace(/\r?\n$/, '');
    return secret === '' ? null : secret;
  }

  async set(account: string, secret: string): Promise<void> {
    assertAccount(account);
    assertSecret(secret);
    const r = await this.exec(['store', `--label=${LABEL}`, 'service', GITHUB_VAULT_SERVICE, 'account', account], secret);
    if (r.code !== 0) throw new VaultError(`secret service: write failed (exit ${r.code})`);
  }

  async delete(account: string): Promise<void> {
    assertAccount(account);
    const r = await this.exec(['clear', 'service', GITHUB_VAULT_SERVICE, 'account', account]);
    if (r.code !== 0 && r.code !== 1) throw new VaultError(`secret service: delete failed (exit ${r.code})`);
  }

  /** `search --all` prints the secrets too: only the `attribute.account = …` lines are read. */
  async list(): Promise<string[]> {
    const r = await this.exec(['search', '--all', 'service', GITHUB_VAULT_SERVICE]);
    if (r.code !== 0 && !(r.code === 1 && r.stdout === '')) throw new VaultError(`secret service: list failed (exit ${r.code})`);
    const accounts = new Set<string>();
    for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
      const account = /^attribute\.account = (.*)$/.exec(line.trim())?.[1];
      if (isValidAccount(account)) accounts.add(account);
    }
    return [...accounts];
  }

  private async exec(args: string[], input?: string) {
    try {
      return await this.run(this.bin, args, { input });
    } catch {
      throw new VaultError('secret service: secret-tool did not run');
    }
  }
}
