import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexIndex } from '../../src/api/codex-index.ts';
import { ListaDeSessoes, pedidoDeSessoes } from '../../src/api/sessions.ts';
import { Accounts } from '../../src/api/accounts.ts';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
const id = '01a15e4a-c337-7f23-b905-728305a91a8a';
test('real-shaped Codex index stays read-only, excludes archives, preserves groups and finds by id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-index-'));
  const path = join(dir, 'index.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE thread_sections (id TEXT, name TEXT);
    CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, thread_section_id TEXT, source TEXT DEFAULT 'vscode');
    INSERT INTO thread_sections VALUES ('ahrena', 'Ahrena');`);
  const cwd = "/work/a'$(touch bad)";
  const insert = db.prepare('INSERT INTO threads (id,name,title,cwd,created_at,updated_at,archived,thread_section_id) VALUES (?, ?, ?, ?, 1000, 2000, ?, ?)');
  insert.run(id, 'PM Codex', 'Old title', cwd, 0, 'ahrena');
  insert.run('01a15e4a-c337-7f23-b905-728305a91a8b', '', 'Archived', '/work', 1, null);
  insert.run('not-a-uuid', '', 'Invalid id', '/work', 0, null);
  db.close();
  const before = readFileSync(path);
  const index = new CodexIndex(path);
  const storage = openSqliteStorage({ path: ':memory:' });
  try {
    const rows = index.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'PM Codex');
    assert.equal(rows[0].identity.provider, 'codex');
    assert.equal(index.find(rows[0].id)?.title, 'PM Codex');
    assert.equal(index.find('00000000-0000-4000-8000-000000000000'), null);
    const list = new ListaDeSessoes({ storage, contas: new Accounts({ storage, file: null }), codex: index });
    const result = await list.listar(pedidoDeSessoes(new URL('http://localhost/api/sessions?provider=codex&group=section%3AAhrena')));
    assert.equal(result.total, 1);
    assert.equal(result.items[0].identity.provider, 'codex');
    assert.equal(result.items[0].status, 'unknown');
    assert.equal(result.items[0].costUsd, null);
    assert.equal(result.items[0].open.target, 'none');
    assert.equal(result.counts.active, 0);
    assert.equal((await list.listar(pedidoDeSessoes(new URL('http://localhost/api/sessions?provider=claude')))).total, 0);
    assert.deepEqual(readFileSync(path), before);
  } finally { await storage.close(); rmSync(dir, { recursive: true }); }
});
test('missing and incompatible indexes report a source error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-index-'));
  try {
    const path = join(dir, 'missing.sqlite');
    const missing = new CodexIndex(path);
    assert.deepEqual(missing.list(), []);
    assert.ok(missing.error);
    new DatabaseSync(path).close();
    const index = new CodexIndex(path);
    assert.deepEqual(index.list(), []);
    assert.ok(index.error);
  } finally { rmSync(dir, { recursive: true }); }
});
