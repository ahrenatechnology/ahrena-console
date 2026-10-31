import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The public demo must not project private provider metadata, even when CODEX_HOME is explicitly set.
test('demo CLI never discovers a real-profile Codex index', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-demo-isolation-'));
  const home = join(root, 'home');
  const codexHome = join(root, 'private-profile');
  mkdirSync(home); mkdirSync(codexHome);
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, archived INTEGER);
    INSERT INTO threads VALUES ('11111111-1111-4111-8111-111111111111', 'PRIVATE_CODEX_SENTINEL', '/synthetic/private', 1000, 2000, 'vscode', 0);`);
  db.close();
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  for (const key of Object.keys(env)) if (key.startsWith('AHRENA_CONSOLE_')) delete env[key];
  const ownerFile = join(root, 'owner-proof');
  writeFileSync(ownerFile, OWNER_TOKEN, { mode: 0o600 });
  env.AHRENA_CONSOLE_OWNER_TOKEN_FILE = ownerFile;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../../src/api/cli.ts', import.meta.url)), '--demo', '--port', '0', '--data-dir', join(root, 'data'), '--no-history', '--no-desktop', '--no-github', '--no-telemetry'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let logs = '';
      const timer = setTimeout(() => reject(new Error('Demo did not become ready')), 20_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Demo exited ${code}: ${logs.slice(-1500)}`)); });
      const read = (chunk: Buffer) => {
        logs += chunk.toString();
        const match = /local API at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', read); child.stderr.on('data', read);
    });
    const response = await fetch(`${url}/api/sessions?provider=codex`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 0);
    assert.deepEqual(body.items, []);
    assert.equal(body.sources.codex.error, null);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_CODEX_SENTINEL|private-profile/);
  } finally {
    child.kill('SIGTERM');
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
