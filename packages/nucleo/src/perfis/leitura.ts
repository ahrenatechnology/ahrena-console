// Conta e org atuais de uma pasta de configuração, do `oauthAccount` do `.claude.json` dela
// (decisão 0006, seção 1, ordens 2 e 5). Só `accountUuid`, `organizationUuid`,
// `organizationName` e `organizationType` saem daqui. O e-mail serve só para sugerir o rótulo
// quando a org não tem nome, e não é devolvido. Tokens e chaves nunca entram: o parse descarta
// todo campo fora da lista antes de o objeto existir.

import { readFile } from 'node:fs/promises';

export interface ContaDoPerfil {
  accountUuid: string;
  organizationUuid: string;
  organizationName: string | null;
  /** Tipo da org como o Claude informa (ex.: `claude_max`, `claude_team`). */
  organizationType: string | null;
  /** Rótulo padrão: o nome da org; sem ele, o e-mail da conta, que fica só na máquina. */
  rotuloSugerido: string | null;
}

const CAMPOS = new Set(['', 'oauthAccount', 'accountUuid', 'organizationUuid', 'organizationName', 'organizationType', 'emailAddress']);
const UUID = /^[0-9a-f-]{8,64}$/i;

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Extrai a conta do conteúdo de um `.claude.json`; `null` sem `oauthAccount` válido (sem login ou chave de API). */
export function contaDoClaudeJson(conteudo: string): ContaDoPerfil | null {
  let o: { oauthAccount?: Record<string, unknown> } | null;
  try {
    o = JSON.parse(conteudo, (k, v) => (CAMPOS.has(k) ? v : undefined));
  } catch {
    return null;
  }
  const a = o?.oauthAccount;
  if (!a || typeof a !== 'object') return null;
  const accountUuid = texto(a.accountUuid);
  const organizationUuid = texto(a.organizationUuid);
  if (!accountUuid || !organizationUuid || !UUID.test(accountUuid) || !UUID.test(organizationUuid)) return null;
  const organizationName = texto(a.organizationName);
  return {
    accountUuid,
    organizationUuid,
    organizationName,
    organizationType: texto(a.organizationType),
    rotuloSugerido: organizationName ?? texto(a.emailAddress),
  };
}

/** Lê a conta de um `.claude.json` no disco; `null` sem arquivo ou sem login. */
export async function lerContaDoClaudeJson(arquivo: string): Promise<ContaDoPerfil | null> {
  try {
    return contaDoClaudeJson(await readFile(arquivo, 'utf8'));
  } catch {
    return null;
  }
}
