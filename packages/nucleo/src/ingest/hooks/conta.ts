// Conta da sessão pelos hooks (decisão 0006, seção 1, ordens 1 e 2).
//
// - Ordem 1, `env`: `CLAUDE_CODE_ACCOUNT_UUID` e `CLAUDE_CODE_ORGANIZATION_UUID` do ambiente do hook,
//   que o Claude Desktop passa ao CLI que lança.
// - Ordem 2, `config`: a conta logada na pasta de configuração do hook (`CLAUDE_CONFIG_DIR`, ou a raiz
//   do `transcript_path`).
// - Sessão por SSH: quem roda é o CLI remoto, com o login da máquina remota. As variáveis de conta,
//   quando chegam, são as do Desktop: vão para `metadata.desktopScope`, e a conta da sessão sai da
//   pasta de configuração. Se a org das duas diferir, a sessão fica marcada com
//   `metadata.desktopScopeConflict` ("Desktop numa org, CLI remoto em outra").

import { claudeAccountId, type AccountSource } from '../../model.ts';
import type { ContaDaPasta } from './conta-da-pasta.ts';
import type { HookEnv } from './normalize.ts';

export interface ContaResolvida extends ContaDaPasta {
  id: string;
  source: Extract<AccountSource, 'env' | 'config'>;
  /** Pasta de configuração do hook, quando se sabe qual é. */
  configDir: string | null;
}

export interface ResolucaoDaConta {
  conta: ContaResolvida | null;
  /** `<conta>/<org>` do Desktop numa sessão por SSH, quando o ambiente trouxe. */
  desktopScope: string | null;
  /** `true`/`false` quando dá para comparar a org do Desktop com a do CLI remoto; senão `null`. */
  desktopScopeConflict: boolean | null;
}

export type LerContaDaPasta = (pasta: string) => Promise<ContaDaPasta | null>;

const TRANSCRIPT_NA_PASTA = /^(\/.*)\/projects\/[^/]+\/[^/]+\.jsonl$/;

/** Pasta de configuração do hook: `CLAUDE_CONFIG_DIR`, ou a raiz de `<pasta>/projects/<projeto>/<sessão>.jsonl`. */
export function pastaDoHook(env: HookEnv | null, transcriptPath: string | null): string | null {
  if (env?.configDir?.startsWith('/')) return env.configDir.replace(/\/+$/, '') || '/';
  const m = transcriptPath ? TRANSCRIPT_NA_PASTA.exec(transcriptPath) : null;
  return m ? m[1] : null;
}

export async function resolverConta(
  env: HookEnv | null,
  transcriptPath: string | null,
  lerContaDaPasta: LerContaDaPasta,
): Promise<ResolucaoDaConta> {
  const configDir = pastaDoHook(env, transcriptPath);
  const doAmbiente = env?.accountUuid && env.organizationUuid ? { accountUuid: env.accountUuid, organizationUuid: env.organizationUuid } : null;
  const ssh = env?.ssh === true;

  if (doAmbiente && !ssh) {
    return { conta: { ...doAmbiente, id: claudeAccountId(doAmbiente.accountUuid, doAmbiente.organizationUuid), source: 'env', configDir }, desktopScope: null, desktopScopeConflict: null };
  }

  // A pasta é lida na máquina do núcleo. Numa sessão SSH, o certo é o núcleo da máquina remota
  // receber os hooks (decisão 0006): aí a pasta é a do CLI remoto. Se os hooks remotos chegarem ao
  // núcleo do Mac por um túnel reverso, o caminho é da máquina remota e quase nunca existe no Mac:
  // a sessão fica em "Sem conta", só com o `desktopScope`. Um caminho que por acaso exista nas duas
  // máquinas daria a conta do Mac; não há como o receptor distinguir, e esse arranjo não é suportado.
  const daPasta = configDir ? await lerContaDaPasta(configDir) : null;
  const conta: ContaResolvida | null = daPasta
    ? { ...daPasta, id: claudeAccountId(daPasta.accountUuid, daPasta.organizationUuid), source: 'config', configDir }
    : null;
  const desktopScope = ssh && doAmbiente ? claudeAccountId(doAmbiente.accountUuid, doAmbiente.organizationUuid) : null;
  const desktopScopeConflict = desktopScope && doAmbiente && conta ? doAmbiente.organizationUuid !== conta.organizationUuid : null;
  return { conta, desktopScope, desktopScopeConflict };
}
