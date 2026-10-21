// The installation's settings (#241, decision 0011 §8): the active GitHub login, the credential source
// and the chosen Project, in the SQLite table `installation_settings`. Never a credential.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MIGRATIONS, migrate, schemaVersion } from '../../src/adapters/sqlite/migrations.ts';
import { openSqliteStorage } from '../../src/index.ts';
import {
  INSTALLATION_SETTING_KEYS,
  MemoryInstallationSettings,
  SqliteInstallationSettings,
  type InstallationSettings,
} from '../../src/settings/installation-settings.ts';

const T = Date.parse('2026-10-21T12:00:00.000Z');

function contract(name: string, make: () => InstallationSettings) {
  describe(`#241/AC-3 installation settings contract: ${name}`, () => {
    test('round trip of each key; a missing key reads null', () => {
      const s = make();
      assert.equal(s.get('github.login'), null);
      s.set('github.login', 'octo-cat');
      s.set('github.source', 'gh');
      s.set('project.selection', { owner: 'exemplo', number: 3, field: 'Status' });
      assert.equal(s.get('github.login'), 'octo-cat');
      assert.equal(s.get('github.source'), 'gh');
      assert.deepEqual(s.get('project.selection'), { owner: 'exemplo', number: 3, field: 'Status' });
      s.set('github.login', 'other');
      assert.equal(s.get('github.login'), 'other');
    });

    test('#241/AC-4 github.login may be stored as null (after a disconnect): has() tells it from absent', () => {
      const s = make();
      assert.equal(s.has('github.login'), false);
      s.set('github.login', null);
      assert.equal(s.has('github.login'), true);
      assert.equal(s.get('github.login'), null);
      s.delete('github.login');
      assert.equal(s.has('github.login'), false);
    });

    test('delete removes the key; deleting a missing key is fine', () => {
      const s = make();
      s.set('github.login', 'octo-cat');
      s.delete('github.login');
      s.delete('github.login');
      assert.equal(s.get('github.login'), null);
    });

    test('only the known keys exist: anything else is refused', () => {
      const s = make();
      assert.deepEqual([...INSTALLATION_SETTING_KEYS], ['github.login', 'github.source', 'project.selection']);
      assert.throws(() => s.set('github.token' as never, 'x' as never));
      assert.throws(() => s.get('github.credential' as never));
      assert.throws(() => s.set('github.source', 'keychain' as never));
      // a token-shaped value is not a login: no key can hold a credential
      assert.throws(() => s.set('github.login', 'gho_FAKEfake0123456789abcdef' as never));
      assert.throws(() => s.set('project.selection', { owner: 'x', number: -1, field: 'Status' }));
    });
  });
}

contract('memory', () => new MemoryInstallationSettings());

describe('#241/AC-3 installation_settings in a real SQLite file', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'installation-settings-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  contract('sqlite', () => {
    const store = openSqliteStorage({ path: join(dir, `c-${Math.random().toString(16).slice(2)}.sqlite`) });
    return new SqliteInstallationSettings(store.db, { now: () => T });
  });

  test('the migration is additive: a database at the previous version gains an empty STRICT table', () => {
    const path = join(dir, 'previous.sqlite');
    const db = new DatabaseSync(path);
    const latest = MIGRATIONS.at(-1)!.version;
    migrate(db, MIGRATIONS.filter((m) => m.version < latest));
    assert.equal(schemaVersion(db), latest - 1);
    assert.deepEqual(migrate(db), [latest]);
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'installation_settings'`).get() as { sql: string }).sql;
    assert.match(sql, /STRICT/);
    const cols = (db.prepare('PRAGMA table_info(installation_settings)').all() as { name: string; pk: number; notnull: number }[]).map((c) => [c.name, c.pk, c.notnull]);
    assert.deepEqual(cols, [['key', 1, 1], ['value_json', 0, 1], ['updated_at', 0, 1]]);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM installation_settings').get() as { n: number }).n, 0);
    db.close();
  });

  test('values survive reopening the file; each row stores JSON and its update time', () => {
    const path = join(dir, 'reopen.sqlite');
    const a = openSqliteStorage({ path });
    new SqliteInstallationSettings(a.db, { now: () => T }).set('project.selection', { owner: 'exemplo', number: 3, field: 'Status' });
    a.close();
    const b = openSqliteStorage({ path });
    const s = new SqliteInstallationSettings(b.db);
    assert.deepEqual(s.get('project.selection'), { owner: 'exemplo', number: 3, field: 'Status' });
    const row = b.db.prepare(`SELECT value_json, updated_at FROM installation_settings WHERE key = 'project.selection'`).get() as { value_json: string; updated_at: string };
    assert.equal(row.value_json, '{"owner":"exemplo","number":3,"field":"Status"}');
    assert.equal(row.updated_at, '2026-10-21T12:00:00.000Z');
    s.delete('project.selection');
    assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM installation_settings').get()!.n, 0);
    b.close();
  });
});
