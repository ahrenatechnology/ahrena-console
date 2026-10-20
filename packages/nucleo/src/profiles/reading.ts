// Current account and org of a configuration folder, from the `oauthAccount` of its `.claude.json`
// (decision 0006, section 1, orders 2 and 5). Only `accountUuid`, `organizationUuid`,
// `organizationName` and `organizationType` leave here. E-mail, tokens and keys never come in: the
// parse drops every field outside the list before the object exists.

import { readFile } from 'node:fs/promises';

export interface ProfileAccount {
  accountUuid: string;
  organizationUuid: string;
  organizationName: string | null;
  /** Tipo da org como o Claude informa (ex.: `claude_max`, `claude_team`). */
  organizationType: string | null;
}

const FIELDS = new Set(['', 'oauthAccount', 'accountUuid', 'organizationUuid', 'organizationName', 'organizationType']);
const UUID = /^[0-9a-f-]{8,64}$/i;

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Extracts the account from a `.claude.json` content; `null` without a valid `oauthAccount` (no login, or an API key). */
export function accountFromClaudeJson(content: string): ProfileAccount | null {
  let o: { oauthAccount?: Record<string, unknown> } | null;
  try {
    o = JSON.parse(content, (k, v) => (FIELDS.has(k) ? v : undefined));
  } catch {
    return null;
  }
  const a = o?.oauthAccount;
  if (!a || typeof a !== 'object') return null;
  const accountUuid = text(a.accountUuid);
  const organizationUuid = text(a.organizationUuid);
  if (!accountUuid || !organizationUuid || !UUID.test(accountUuid) || !UUID.test(organizationUuid)) return null;
  return { accountUuid, organizationUuid, organizationName: text(a.organizationName), organizationType: text(a.organizationType) };
}

/** Reads the account of a `.claude.json` on disk; `null` without a file or without a login. */
export async function readClaudeJsonAccount(file: string): Promise<ProfileAccount | null> {
  try {
    return accountFromClaudeJson(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
