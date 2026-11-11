// Adapter v1 for state_5.sqlite (user_version 0). Never migrate the provider database.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { providerSessionKey, type SessionIdentity, type SessionCapabilities } from '../identity.ts';
import { SESSION_ID_PATTERN } from './session-open.ts';

export interface CodexThread {
  id: string; identity: SessionIdentity; capabilities: SessionCapabilities;
  title: string; cwd: string; createdAt: string; updatedAt: string; group: string | null;
}
const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
const defaultPath = () => join(homedir(), '.codex', 'state_5.sqlite');
export class CodexIndex {
  readonly path: string;
  readonly nativeOpen: boolean;
  error: string | null = null;
  constructor(path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'state_5.sqlite')) {
    this.path = canonical(path);
    // The native deep link has no profile selector. Never open another index in the default app.
    this.nativeOpen = this.path === canonical(defaultPath());
  }
  find(id: string): CodexThread | null { return this.list().find(t => t.id === id) ?? null; }
  list(): CodexThread[] {
    this.error = null;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 1000');
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 0) throw new Error('Unsupported schema');
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(r => r.name));
      for (const name of ['id', 'title', 'cwd', 'created_at', 'updated_at', 'source', 'archived']) {
        if (!columns.has(name)) throw new Error('Unsupported schema');
      }
      const named = columns.has('name');
      const rows = db.prepare(`SELECT id, ${named ? "COALESCE(NULLIF(name, ''), title)" : 'title'} AS title,
        cwd, created_at, updated_at, source FROM threads WHERE archived = 0 ORDER BY updated_at DESC, id`).all();
      return rows.filter(r => {
        if (!SESSION_ID_PATTERN.test(String(r.id))) return false;
        const source = String(r.source);
        if (['cli', 'vscode', 'exec', 'appServer', 'app-server'].includes(source)) return true;
        try { const value = JSON.parse(source); return typeof value === 'string' && ['cli', 'vscode', 'exec', 'appServer', 'app-server'].includes(value); }
        catch { return false; } // Unknown/object sources may be subagents; fail closed.
      }).map(r => {
        const identity: SessionIdentity = { provider: 'codex', providerSessionId: String(r.id),
          profileId: `codex-home:${createHash('sha256').update(dirname(this.path)).digest('hex')}`, machineId: 'local', environmentId: null };
        return { id: providerSessionKey(identity), identity,
          capabilities: { mode: 'external', history: 'unavailable', nativeOpen: this.nativeOpen ? 'available' : 'unavailable', sendInput: 'unavailable', interrupt: 'unavailable', approve: 'unavailable' },
          title: String(r.title), cwd: String(r.cwd), createdAt: new Date(Number(r.created_at) * 1000).toISOString(),
          updatedAt: new Date(Number(r.updated_at) * 1000).toISOString(), group: null };
      });
    } catch {
      this.error = 'Índice do Codex indisponível: arquivo ausente, ocupado, sem acesso ou versão incompatível.';
      return [];
    } finally { db?.close(); }
  }
}
export const codexOpen = (t: CodexThread) => ({ target: t.capabilities.nativeOpen === 'available' ? 'codex-desktop' as const : 'none' as const, command: null });
