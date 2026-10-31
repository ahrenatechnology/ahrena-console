import { SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { providerSessionKey, providerAccountKey, unknownCapabilities } from '../../src/identity.ts';
import { account, session } from '../fixtures.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { SqliteRuntimeStore } from '../../src/runtime/sqlite.ts';
import type { RuntimeScope } from '../../src/runtime/contracts.ts';

export async function fixture(provider: 'claude' | 'codex' = 'claude', path = ':memory:') {
  const storage = new SqliteStorage({ path });
  const identity = { provider, providerSessionId: 'synthetic-session', profileId: 'personal', machineId: null, environmentId: null };
  const accountIdentity = { provider, profileId: identity.profileId, machineId: identity.machineId,
    environmentId: identity.environmentId, providerAccountId: 'synthetic-account', organizationId: 'synthetic-org' };
  const accountId = providerAccountKey(accountIdentity);
  const sessionId = providerSessionKey(identity);
  await storage.putAccount(account({ id: accountId, identity: accountIdentity,
    accountUuid: accountIdentity.providerAccountId, organizationUuid: accountIdentity.organizationId,
    confidence: 'confirmed', configDirs: ['/nonexistent-synthetic-profile'] }));
  await storage.putSession(session({ id: sessionId, identity, accountId, accountSource: 'transcript', accountConfidence: 'confirmed',
    capabilities: { ...unknownCapabilities(), mode: 'managed' } }));
  const changes = new ChangeCursor({ minIntervalMs: 0 });
  const runs = new SqliteRuntimeStore(storage.db, changes);
  const scope: RuntimeScope = { provider, accountId, profileId: 'personal', sessionId };
  return { storage, changes, runs, scope };
}
