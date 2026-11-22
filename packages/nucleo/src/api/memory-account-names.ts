// The Claude account folders of the registry with the name the screens give each account, for the memory actions (#740).
import type { RegistryAccount } from '../memory/actions.ts';
import type { Accounts } from './accounts.ts';

/**
 * Each folder with its account's registry label (`Accounts.ofId`, the one every screen shows, without e-mail, decision 0006).
 * A folder with no account has the empty name, so the failure line says "conta N" by its place (#740).
 */
export async function registryAccounts(
  profiles: { list(): Promise<readonly { dir: string; accountId: string | null }[]> },
  accounts: Pick<Accounts, 'ofId'>,
): Promise<RegistryAccount[]> {
  const folders = await profiles.list();
  return Promise.all(folders.map(async ({ dir, accountId }) => ({ dir, name: accountId === null ? '' : (await accounts.ofId(accountId)).label })));
}
