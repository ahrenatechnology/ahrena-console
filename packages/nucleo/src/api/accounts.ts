// The account of each session for the panel (decision 0006). The source with the lowest order wins, among:
//
// - the account stored on the session (`Session.accountId` and `accountSource`, from the port);
// - `env`: the session's own environment, which the panel reads (`CLAUDE_CODE_ACCOUNT_UUID` and
//   `CLAUDE_CODE_ORGANIZATION_UUID`) and sends in the request; it is remembered in memory for when
//   another session asks about it (storing it on the session is the hooks' job, #110);
// - `desktop`: the Claude Desktop index, only when the session is in a folder with a single account/org.
//
// With none, the session stays under "Sem conta": it is never assigned to another by guess.
// Label and color: those of `~/.ahrena-console/contas.json` (`{ "<conta>/<org>": { "rotulo", "cor" } }`,
// color in hex), which override; otherwise those of the `ClaudeAccount`: the edited label, otherwise the
// org's current name (the profiles, #109, store the name and a brand color); otherwise "conta 1", "conta 2"…
// in the order they appear, with the brand colors. The id is never shown, nor the e-mail: the personal
// org ("<e-mail>'s Organization") becomes "conta pessoal".

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accountSourceRank, claudeAccountId, type AccountSource, type ClaudeAccount, type Session } from '../model.ts';
import { ACCOUNT_COLORS } from '../profiles/colors.ts';
import type { StoragePort } from '../storage-port.ts';
import type { DesktopSession } from './desktop-index.ts';
import type { PanelAccount } from './types.ts';

export { ACCOUNT_COLORS };
const UUID = /^[0-9a-f-]{8,64}$/i;
const HEX = /^#[0-9a-f]{6}$/i;

/** The name Claude gives the personal org: "<e-mail>'s Organization". */
const PERSONAL_ORG = /^\S+@\S+'s Organization$/i;

/**
 * The org name for the label, without e-mail (decision 0006): the personal org becomes "conta pessoal";
 * a name with an e-mail that is not that pattern does not serve as a label.
 */
export function orgLabel(name: string | null | undefined): string | null {
  if (!name) return null;
  if (PERSONAL_ORG.test(name.trim())) return 'conta pessoal';
  return name.includes('@') ? null : name;
}

/** The label file, `~/.ahrena-console/contas.json` (its name on disk stays). */
export function defaultAccountsFile(): string {
  return join(homedir(), '.ahrena-console', 'contas.json');
}

/** `file: null` reads no label file (the demo, tests); `intervalMs` is the minimum time between two reads. */
export interface AccountsOptions {
  storage?: Pick<StoragePort, 'listAccounts'> | null;
  file?: string | null;
  intervalMs?: number;
  now?: () => number;
}

/** The account of each session for the panel and the MCP, with its label and color (decision 0006). */
export class Accounts {
  private readonly storage: Pick<StoragePort, 'listAccounts'> | null;
  private readonly file: string | null;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private configured = new Map<string, { label?: string; color?: string }>();
  private fromPort = new Map<string, ClaudeAccount>();
  private readonly order: string[] = [];
  /** The account each session's panel reported from its environment. */
  private readonly fromEnv = new Map<string, string>();
  private mtimeMs = -1;
  private checkedAt = -Infinity;

  constructor({ storage = null, file = defaultAccountsFile(), intervalMs = 30_000, now = Date.now }: AccountsOptions = {}) {
    this.storage = storage;
    this.file = file;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  /** Re-reads the port's accounts and the label file; at most every `intervalMs`. */
  async refresh(): Promise<void> {
    if (this.now() - this.checkedAt < this.intervalMs) return;
    this.checkedAt = this.now();
    if (this.storage) this.fromPort = new Map((await this.storage.listAccounts()).map((a) => [a.id, a]));
    if (!this.file) return;
    try {
      const { mtimeMs } = await stat(this.file);
      if (mtimeMs === this.mtimeMs) return;
      this.mtimeMs = mtimeMs;
      const o = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, { rotulo?: unknown; cor?: unknown }>;
      const read = new Map<string, { label?: string; color?: string }>();
      for (const [id, v] of Object.entries(o ?? {})) {
        read.set(id, {
          label: typeof v?.rotulo === 'string' && v.rotulo.trim() ? v.rotulo.trim().slice(0, 24) : undefined,
          color: typeof v?.cor === 'string' && HEX.test(v.cor) ? v.cor : undefined,
        });
      }
      this.configured = read;
    } catch {
      // No file, or an invalid one: the default labels hold.
    }
  }

  /** Records the account the panel read from its own session's environment. Ignores what does not look like a UUID. */
  reportEnv(sessionId: string, account: string | null, org: string | null): void {
    if (!account || !org || !UUID.test(account) || !UUID.test(org)) return;
    this.fromEnv.set(sessionId, claudeAccountId(account, org));
  }

  /** The session's account: the lowest-order source among the port, the environment and the Desktop index. */
  ofSession(session: Pick<Session, 'id' | 'accountId' | 'accountSource'>, desktop: DesktopSession | null): PanelAccount | null {
    const candidates: { id: string; source: AccountSource }[] = [];
    if (session.accountId && session.accountSource) candidates.push({ id: session.accountId, source: session.accountSource });
    const env = this.fromEnv.get(session.id);
    if (env) candidates.push({ id: env, source: 'env' });
    if (desktop && desktop.accounts.length === 1) candidates.push({ id: desktop.accounts[0], source: 'desktop' });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => accountSourceRank(a.source) - accountSourceRank(b.source));
    return this.build(candidates[0].id, candidates[0].source);
  }

  /** The account's label and color: the label file, then the port's account, then "conta N". */
  private build(id: string, source: AccountSource): PanelAccount {
    if (!this.order.includes(id)) this.order.push(id);
    const i = this.order.indexOf(id);
    const a = this.fromPort.get(id);
    const c = this.configured.get(id);
    const color = c?.color ?? (a?.color && HEX.test(a.color) ? a.color : null) ?? ACCOUNT_COLORS[i % ACCOUNT_COLORS.length];
    return { id, label: c?.label ?? a?.label ?? orgLabel(a?.organizationName) ?? `conta ${i + 1}`, color, source };
  }
}
