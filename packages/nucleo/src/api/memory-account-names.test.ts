// The names the memory actions give the registry's accounts: the screens' label, never the raw organization name (#740).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProviderAccount } from '../model.ts';
import { Accounts } from './accounts.ts';
import { registryAccounts } from './memory-account-names.ts';

describe('#740/AC-3 the registry names of the memory actions', () => {
  test('#740/AC-3 Given a personal organization name with an e-mail, When the registry is read, Then the name is the screens label without the e-mail', async () => {
    const accounts = new Accounts({ storage: { listAccounts: async () => [{ id: 'u/o', organizationName: "x@y's Organization", label: null } as ProviderAccount] }, file: null });
    const read = await registryAccounts({ list: async () => [{ dir: '/a', accountId: 'u/o' }] }, accounts);
    assert.deepEqual(read, [{ dir: '/a', name: 'conta pessoal' }]);
  });

  test('#740/AC-3 Given a folder with no account, When the registry is read, Then its name is empty so the failure line gives its place', async () => {
    const read = await registryAccounts({ list: async () => [{ dir: '/a', accountId: null }] }, new Accounts({ file: null }));
    assert.deepEqual(read, [{ dir: '/a', name: '' }]);
  });
});
