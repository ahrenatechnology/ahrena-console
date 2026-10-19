// PROVISÓRIO até a #109 (perfis, src/perfis/) chegar ao main: aí este arquivo sai e o receptor passa a
// usar a função "conta da pasta" de lá. Isolado de propósito, para a troca ser de um import.
//
// Lê do `.claude.json` da pasta de configuração só `oauthAccount.accountUuid` e
// `oauthAccount.organizationUuid`. Nada mais do arquivo é guardado, e nele não há token (as
// credenciais ficam no Keychain ou em `.credentials.json`, que nunca é lido).

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ContaDaPasta {
  accountUuid: string;
  organizationUuid: string;
}

const UUID = /^[0-9a-f-]{8,64}$/i;

/**
 * Onde fica o `.claude.json` da pasta: dentro dela, salvo a pasta padrão (`~/.claude`), cujo arquivo
 * é o `~/.claude.json`, como no Claude Code sem `CLAUDE_CONFIG_DIR`.
 */
export function arquivoDaConta(pasta: string, home: string = homedir()): string {
  const dir = resolve(pasta);
  return dir === join(resolve(home), '.claude') ? join(resolve(home), '.claude.json') : join(dir, '.claude.json');
}

/** Conta e org logadas agora na pasta; `null` sem arquivo, sem login OAuth ou com formato inesperado. */
export async function contaDaPasta(pasta: string, opts: { home?: string } = {}): Promise<ContaDaPasta | null> {
  if (!isAbsolute(pasta)) return null;
  let texto: string;
  try {
    texto = await readFile(arquivoDaConta(pasta, opts.home), 'utf8');
  } catch {
    return null;
  }
  try {
    const oauth = (JSON.parse(texto) as { oauthAccount?: Record<string, unknown> } | null)?.oauthAccount;
    const accountUuid = oauth?.accountUuid;
    const organizationUuid = oauth?.organizationUuid;
    if (typeof accountUuid !== 'string' || !UUID.test(accountUuid)) return null;
    if (typeof organizationUuid !== 'string' || !UUID.test(organizationUuid)) return null;
    return { accountUuid, organizationUuid };
  } catch {
    return null;
  }
}
