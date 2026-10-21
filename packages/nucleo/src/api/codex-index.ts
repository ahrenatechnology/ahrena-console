// Read-only adapter for the installed Codex desktop index. Its schema is versioned and
// private: fail visibly on incompatibility, never migrate or write the source database.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { SESSION_ID_PATTERN, isUsableCwd, shellQuote } from './session-open.ts';

export interface CodexThread {
  id: string; title: string; cwd: string; createdAt: string; updatedAt: string;
  group: string; command: string | null;
}
export class CodexIndex {
  readonly path: string;
  error: string | null = null;
  constructor(path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'state_5.sqlite')) { this.path = path; }
  list(): CodexThread[] {
    this.error = null;
    if (!existsSync(this.path)) return [];
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
      const rows = db.prepare(`SELECT t.id, COALESCE(NULLIF(t.name, ''), t.title) AS title, t.cwd,
        t.created_at, t.updated_at, t.source, s.name AS group_name FROM threads t
        LEFT JOIN thread_sections s ON s.id = t.thread_section_id
        WHERE t.archived = 0 ORDER BY t.updated_at DESC, t.id`).all();
      return rows.filter(r => {
        if (!SESSION_ID_PATTERN.test(String(r.id))) return false;
        try { return !JSON.parse(String(r.source))?.subagent; } catch { return true; }
      }).map(r => ({
        id: String(r.id), title: String(r.title), cwd: String(r.cwd),
        createdAt: new Date(Number(r.created_at) * 1000).toISOString(),
        updatedAt: new Date(Number(r.updated_at) * 1000).toISOString(),
        group: typeof r.group_name === 'string' ? r.group_name : 'Sem grupo',
        command: isUsableCwd(String(r.cwd)) ? `cd ${shellQuote(String(r.cwd))} && codex resume ${r.id}` : null,
      }));
    } catch {
      this.error = 'Não foi possível ler o índice local do Codex. Verifique a versão e o acesso ao arquivo.';
      return [];
    } finally { db?.close(); }
  }
}
