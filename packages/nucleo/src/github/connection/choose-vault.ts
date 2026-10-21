// Which vault this machine has (decision 0011 §3). `AHRENA_CONSOLE_VAULT` (keychain | secret-service |
// memory | none) overrides. Under `node --test` (NODE_TEST_CONTEXT, inherited by every child process
// the tests spawn) the default is the in-memory vault, so no test can reach the real `security` or
// `secret-tool`. Otherwise: macOS with /usr/bin/security → Keychain; Linux with `secret-tool` on PATH
// and a session bus → Secret Service; else none (`null`: the connection is unavailable, `no-vault`).
// Choosing runs nothing: the vault is touched only when the connection first needs it.

import { KeychainVault } from './keychain-vault.ts';
import { findOnPath, isExecutable } from './run-command.ts';
import { SecretServiceVault } from './secret-service-vault.ts';
import { MemoryVault, type CredentialVault } from './vault.ts';

export const SECURITY_BIN = '/usr/bin/security';

export interface ChooseVaultOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether an executable exists at a path (never runs it). */
  exists?: (path: string) => boolean;
}

export function chooseVault({ platform = process.platform, env = process.env, exists = isExecutable }: ChooseVaultOptions = {}): CredentialVault | null {
  const secretService = () => new SecretServiceVault({ bin: findOnPath('secret-tool', env, exists) ?? 'secret-tool' });
  switch (env.AHRENA_CONSOLE_VAULT) {
    case 'none':
      return null;
    case 'memory':
      return new MemoryVault();
    case 'keychain':
      return new KeychainVault({ bin: SECURITY_BIN });
    case 'secret-service':
      return secretService();
  }
  if (env.NODE_TEST_CONTEXT) return new MemoryVault();
  if (platform === 'darwin') return exists(SECURITY_BIN) ? new KeychainVault({ bin: SECURITY_BIN }) : null;
  if (platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS) {
    const bin = findOnPath('secret-tool', env, exists);
    return bin ? new SecretServiceVault({ bin }) : null;
  }
  return null;
}
