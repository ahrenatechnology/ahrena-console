// The session's account from the hooks (decision 0006, section 1, orders 1 and 2).
//
// - Order 1, `env`: `CLAUDE_CODE_ACCOUNT_UUID` and `CLAUDE_CODE_ORGANIZATION_UUID` from the hook's
//   environment, which Claude Desktop passes to the CLI it launches.
// - Order 2, `config`: the account logged in to the hook's configuration folder (`CLAUDE_CONFIG_DIR`,
//   or the root of the `transcript_path`).
// - Session over SSH: the remote CLI runs, with the remote machine's login. The account variables,
//   when they arrive, are Desktop's: they go to `metadata.desktopScope`, and the session's account
//   comes from the configuration folder. If the two orgs differ, the session is marked with
//   `metadata.desktopScopeConflict` ("Desktop in one org, remote CLI in another").

import { claudeAccountId, type AccountSource, type ClaudeAccount } from '../../model.ts';
import type { Profiles } from '../../profiles/profiles.ts';
import type { HookEnv } from './normalize.ts';

export interface ResolvedAccount {
  /** The account, already written to the port by the profiles (#109). */
  account: ClaudeAccount;
  source: Extract<AccountSource, 'env' | 'config'>;
}

/** What the receiver uses from the profiles (#109): read a folder's account and register the environment's. */
export type HookProfiles = Pick<Profiles, 'accountForFolder' | 'register'>;

export interface AccountResolution {
  resolved: ResolvedAccount | null;
  /** Desktop's `<account>/<org>` in a session over SSH, when the environment brought it. */
  desktopScope: string | null;
  /** `true`/`false` when Desktop's org can be compared with the remote CLI's; otherwise `null`. */
  desktopScopeConflict: boolean | null;
}

const TRANSCRIPT_IN_CONFIG_DIR = /^(\/.*)\/projects\/[^/]+\/[^/]+\.jsonl$/;

/** The hook's configuration folder: `CLAUDE_CONFIG_DIR`, or the root of `<folder>/projects/<project>/<session>.jsonl`. */
export function hookConfigDir(env: HookEnv | null, transcriptPath: string | null): string | null {
  if (env?.configDir?.startsWith('/')) return env.configDir.replace(/\/+$/, '') || '/';
  const m = transcriptPath ? TRANSCRIPT_IN_CONFIG_DIR.exec(transcriptPath) : null;
  return m ? m[1] : null;
}

export async function resolveAccount(
  env: HookEnv | null,
  transcriptPath: string | null,
  profiles: HookProfiles,
): Promise<AccountResolution> {
  const configDir = hookConfigDir(env, transcriptPath);
  const fromEnv = env?.accountUuid && env.organizationUuid ? { accountUuid: env.accountUuid, organizationUuid: env.organizationUuid } : null;
  const ssh = env?.ssh === true;

  if (fromEnv && !ssh) {
    const account = await profiles.register({ ...fromEnv, organizationName: null, organizationType: null }, configDir);
    return { resolved: { account, source: 'env' }, desktopScope: null, desktopScopeConflict: null };
  }

  // A pasta é lida na máquina do núcleo. Numa sessão SSH, o certo é o núcleo da máquina remota
  // receber os hooks (decisão 0006): aí a pasta é a do CLI remoto. Se os hooks remotos chegarem ao
  // núcleo do Mac por um túnel reverso, o caminho é da máquina remota e quase nunca existe no Mac:
  // a sessão fica em "Sem conta", só com o `desktopScope`. Um caminho que por acaso exista nas duas
  // máquinas daria a conta do Mac; não há como o receptor distinguir, e esse arranjo não é suportado.
  const fromFolder = configDir ? await profiles.accountForFolder(configDir) : null;
  const resolved: ResolvedAccount | null = fromFolder ? { account: fromFolder, source: 'config' } : null;
  const desktopScope = ssh && fromEnv ? claudeAccountId(fromEnv.accountUuid, fromEnv.organizationUuid) : null;
  const desktopScopeConflict = desktopScope && fromEnv && resolved ? fromEnv.organizationUuid !== resolved.account.organizationUuid : null;
  return { resolved, desktopScope, desktopScopeConflict };
}
