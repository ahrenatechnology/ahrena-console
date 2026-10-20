// Profiles (decision 0006, section 2): the configuration folders the core knows, the current account
// of each and where the transcripts live. Each account read becomes a `ClaudeAccount` in the port,
// with the org's current name and a brand color. The `label` stays null until the person edits it:
// the default label is derived on read (the org name, or "conta N"), so a renamed org shows up
// with the new name. The e-mail never comes in. `~/.ahrena-console/contas.json` still wins.

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeAccountId, type ClaudeAccount } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { freeColor } from './colors.ts';
import { defaultProfilesFile, discoverFolders, normalizeFolder, looksLikeConfigFolder, configFolder, type ConfigFolder } from './discovery.ts';
import { readClaudeJsonAccount, type ProfileAccount } from './reading.ts';

/** A configuration folder with its current account. Goes out as JSON in `/api/agent-config`: field names stay. */
export interface Profile extends ConfigFolder {
  /** A conta logada agora na pasta; `null` sem login OAuth (sem login, ou chave de API). */
  conta: ProfileAccount | null;
  /** `ClaudeAccount.id` da conta atual, ou `null`. */
  accountId: string | null;
}

export interface ProfilesOptions {
  storage?: Pick<StoragePort, 'getAccount' | 'putAccount' | 'listAccounts'> | null;
  home?: string;
  /** `~/.ahrena-console/perfis.json`; `null` reads no configured folders. */
  file?: string | null;
  now?: () => string;
}

export class Profiles {
  private readonly storage: ProfilesOptions['storage'];
  private readonly home: string;
  private readonly file: string | null;
  private readonly now: () => string;
  private readonly revealed = new Set<string>();
  /** Queued writes: two folders of the same account do not trample each other's `configDirs`. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ storage = null, home = homedir(), file, now = () => new Date().toISOString() }: ProfilesOptions = {}) {
    this.storage = storage;
    this.home = home;
    this.file = file === undefined ? defaultProfilesFile(home) : file;
    this.now = now;
  }

  /** Remembers a folder a hook revealed (`CLAUDE_CONFIG_DIR`), for the next listings. */
  reveal(dir: string): void {
    if (dir.trim()) this.revealed.add(normalizeFolder(dir.trim(), this.home));
  }

  /** This machine's profiles with the current account of each, writing nothing. */
  async list(): Promise<Profile[]> {
    const folders = await discoverFolders({ home: this.home, file: this.file, revealed: this.revealed });
    return Promise.all(folders.map((p) => this.readProfile(p)));
  }

  /** Lists the profiles and writes each one's account to the port. */
  async sync(): Promise<Profile[]> {
    const profiles = await this.list();
    for (const p of profiles) if (p.conta) await this.save(p.conta, p.dir);
    return profiles;
  }

  /**
   * The current account of the configuration folder `dir` (order 2, `config`, on `SessionStart`;
   * order 5, `profile`, on import), already written to the port. Reveals the folder. `null` when
   * the folder does not exist, lacks the structure of a configuration folder or has no OAuth login.
   */
  async accountForFolder(dir: string): Promise<ClaudeAccount | null> {
    const folder = configFolder(await this.canonicalPath(dir), 'hook', this.home);
    if (!(await looksLikeConfigFolder(folder))) return null;
    this.reveal(folder.dir);
    const { conta } = await this.readProfile(folder);
    return conta ? this.save(conta, folder.dir) : null;
  }

  /**
   * Writes to the port an account seen by another source (the hook environment, order 1), with the
   * configuration folder it showed up in, if any. Same write as `accountForFolder`: a single path.
   */
  async register(account: ProfileAccount, dir: string | null): Promise<ClaudeAccount> {
    return this.save(account, dir ? await this.canonicalPath(dir) : null);
  }

  /** A symlink to the default folder is the default folder; the others stay as they came. */
  private async canonicalPath(dir: string): Promise<string> {
    const abs = normalizeFolder(dir.trim(), this.home);
    const defaultDir = join(this.home, '.claude');
    const [real, realDefault] = await Promise.all([realpath(abs).catch(() => abs), realpath(defaultDir).catch(() => defaultDir)]);
    return real === realDefault ? defaultDir : abs;
  }

  private async readProfile(p: ConfigFolder): Promise<Profile> {
    const conta = await readClaudeJsonAccount(p.claudeJson);
    return { ...p, conta, accountId: conta ? claudeAccountId(conta.accountUuid, conta.organizationUuid) : null };
  }

  private save(account: ProfileAccount, dir: string | null): Promise<ClaudeAccount> {
    const done = this.queue.then(() => this.saveNow(account, dir));
    this.queue = done.catch(() => undefined);
    return done;
  }

  private async saveNow(account: ProfileAccount, dir: string | null): Promise<ClaudeAccount> {
    const id = claudeAccountId(account.accountUuid, account.organizationUuid);
    const now = this.now();
    const stored = this.storage ? await this.storage.getAccount(id) : null;
    const color = stored?.color ?? freeColor(this.storage ? (await this.storage.listAccounts()).map((a) => a.color) : []);
    const a: ClaudeAccount = {
      id,
      accountUuid: account.accountUuid,
      organizationUuid: account.organizationUuid,
      organizationName: account.organizationName ?? stored?.organizationName ?? null,
      organizationType: account.organizationType ?? stored?.organizationType ?? null,
      label: stored?.label ?? null,
      color,
      configDirs: [...new Set([...(stored?.configDirs ?? []), ...(dir ? [dir] : [])])].sort(),
      firstSeenAt: stored?.firstSeenAt ?? now,
      lastSeenAt: now,
      metadata: stored?.metadata ?? {},
    };
    // Nothing changed but `lastSeenAt`: no write, so the periodic re-read does not wake whoever
    // waits for changes in the port (long polling, #24).
    if (stored && isUnchanged(stored, a)) return stored;
    if (this.storage) await this.storage.putAccount(a);
    return a;
  }
}

function isUnchanged(before: ClaudeAccount, after: ClaudeAccount): boolean {
  return (
    before.organizationName === after.organizationName &&
    before.organizationType === after.organizationType &&
    before.color === after.color &&
    before.configDirs.length === after.configDirs.length &&
    before.configDirs.every((d, i) => d === after.configDirs[i])
  );
}
