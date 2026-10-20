// The Claude Desktop session index: `claude-code-sessions/<account>/<org>/local_*.json`.
// Gives the panel what the transcript lacks: the sidebar title, the branch, the parent session
// (`spawnedFrom.sessionId`, for the family), the account by folder (order 4 of decision 0006) and the
// effort chosen in the Desktop (`effort`, for the wall of #34).
//
// Cost: the first read reads each file once; after that, only the `stat` of the folders and the
// files, at most every `intervalMs`, and it re-reads only the file whose mtime changed. Never on
// every panel request. It reads only the fields below; the rest of the JSON is ignored.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One session of the Desktop index, merged across the account/org folders it appears in. */
export interface DesktopSession {
  /** `local_…`: the Desktop id. */
  localId: string;
  /** The transcript's `sessionId` (what the core uses). */
  cliSessionId: string | null;
  /** The sidebar title. */
  title: string | null;
  branch: string | null;
  cwd: string | null;
  /** `local_…` of the session that opened this one, when another one opened it. */
  parentLocalId: string | null;
  /** Archived in the Claude Desktop (#145). */
  archived: boolean;
  /** The session's effort (`effort`) in the Desktop: `low`, `medium`, `high`…; absent or `null` when unknown. */
  effort?: string | null;
  /** The `<account>/<org>` folders the session appears in. More than one: the folder does not tell the account. */
  accounts: string[];
}

/** `~/Library/Application Support/Claude/claude-code-sessions`, the Desktop's folder on macOS. */
export function defaultDesktopRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}

/** A read file: its mtime, its `<account>/<org>` folder and the session it holds. */
interface IndexedFile {
  mtimeMs: number;
  scope: string;
  session: DesktopSession;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The names in a folder, or none when it cannot be read. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export interface DesktopIndexOptions {
  root?: string;
  /** Minimum time between two disk checks. Default 30 s. */
  intervalMs?: number;
  now?: () => number;
}

/** The index, re-read at most every `intervalMs`; see the top of the file. */
export class DesktopIndex {
  readonly root: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly files = new Map<string, IndexedFile>();
  private byCli = new Map<string, DesktopSession>();
  private byLocal = new Map<string, DesktopSession>();
  private children = new Map<string, DesktopSession[]>();
  private checkedAt = -Infinity;
  private pending: Promise<void> | null = null;
  /** Files read since the start (for the load measurement). */
  filesRead = 0;

  constructor({ root = defaultDesktopRoot(), intervalMs = 30_000, now = Date.now }: DesktopIndexOptions = {}) {
    this.root = root;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  /** Checks the disk if the interval passed; concurrent requests wait for the same round. */
  async refresh(force = false): Promise<void> {
    if (!force && this.now() - this.checkedAt < this.intervalMs) return;
    this.pending ??= this.scan().finally(() => {
      this.checkedAt = this.now();
      this.pending = null;
    });
    return this.pending;
  }

  /** The session by its transcript id. */
  sessionByCli(cliSessionId: string): DesktopSession | null {
    return this.byCli.get(cliSessionId) ?? null;
  }

  /** The session by its Desktop id. */
  sessionByLocal(localId: string): DesktopSession | null {
    return this.byLocal.get(localId) ?? null;
  }

  /** The sessions this one opened; the archived ones come along, with `archived` (#145). */
  childrenOf(localId: string): DesktopSession[] {
    return this.children.get(localId) ?? [];
  }

  /** Walks `<account>/<org>/local_*.json`, re-reading only the files whose mtime changed. */
  private async scan(): Promise<void> {
    const seen = new Set<string>();
    for (const account of await listDir(this.root)) {
      for (const org of await listDir(join(this.root, account))) {
        const dir = join(this.root, account, org);
        for (const name of await listDir(dir)) {
          if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
          const path = join(dir, name);
          seen.add(path);
          let mtimeMs: number;
          try {
            mtimeMs = (await stat(path)).mtimeMs;
          } catch {
            continue;
          }
          const previous = this.files.get(path);
          if (previous && previous.mtimeMs === mtimeMs) continue;
          const session = await this.read(path, name.slice(0, -'.json'.length));
          if (session) this.files.set(path, { mtimeMs, scope: `${account}/${org}`, session });
        }
      }
    }
    for (const path of [...this.files.keys()]) if (!seen.has(path)) this.files.delete(path);
    this.reindex();
  }

  /** One `local_*.json`: only the fields above, or `null` if it is not JSON. */
  private async read(path: string, localId: string): Promise<DesktopSession | null> {
    try {
      const o = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      this.filesRead++;
      const parent = o.spawnedFrom && typeof o.spawnedFrom === 'object' ? str((o.spawnedFrom as Record<string, unknown>).sessionId) : null;
      return {
        localId: str(o.sessionId) ?? localId,
        cliSessionId: str(o.cliSessionId),
        title: str(o.title),
        branch: str(o.branch),
        cwd: str(o.cwd),
        parentLocalId: parent,
        archived: o.isArchived === true,
        effort: str(o.effort),
        accounts: [],
      };
    } catch {
      return null;
    }
  }

  // The same session can be in several account/org folders (sync between orgs): merged by id.
  private reindex(): void {
    const byLocal = new Map<string, DesktopSession>();
    for (const { scope, session } of this.files.values()) {
      const current = byLocal.get(session.localId);
      if (current) {
        if (!current.accounts.includes(scope)) current.accounts.push(scope);
      } else byLocal.set(session.localId, { ...session, accounts: [scope] });
    }
    const byCli = new Map<string, DesktopSession>();
    const children = new Map<string, DesktopSession[]>();
    for (const s of byLocal.values()) {
      if (s.cliSessionId) byCli.set(s.cliSessionId, s);
      if (s.parentLocalId) children.set(s.parentLocalId, [...(children.get(s.parentLocalId) ?? []), s]);
    }
    this.byLocal = byLocal;
    this.byCli = byCli;
    this.children = children;
  }
}
