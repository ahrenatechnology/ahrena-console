// The Dev Console contexts (#177/AC-1): from `dev-console.json`, with the path injected, and with
// no file one per repository with a session in the last 7 days. Files in a temporary folder.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { contextsFromRepos, DevConsoleContexts, parseContexts } from '../../src/dev-console/contexts.ts';
import { recentRepos } from '../../src/dev-console/sessions.ts';
import { session } from '../fixtures.ts';
import { hoursAgo, NOW, OTHER_REPO, REPO } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-dev-console-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, json: unknown) => {
  const file = join(dir, name);
  writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  return file;
};

describe('contexts from the file', () => {
  test('#177/AC-1 reads the contexts from dev-console.json at the injected path', async () => {
    const file = write('ok.json', { contexts: [{ id: 'loja', name: 'Loja', repos: [REPO, OTHER_REPO] }] });
    const contexts = new DevConsoleContexts({ file, recentRepos: async () => assert.fail('with a file, the sessions do not count') });
    assert.deepEqual(await contexts.list(), [{ id: 'loja', name: 'Loja', repos: [REPO, OTHER_REPO], blockedLabels: ['blocked', 'bloqueada'], source: 'file' }]);
    assert.equal((await contexts.get('loja'))?.name, 'Loja');
    assert.equal(await contexts.get('outro'), null);
  });

  test('#177/AC-1 an invalid context is left out without dropping the others; configurable blocked label', () => {
    const parsed = parseContexts({
      blockedLabels: ['bloqueada'],
      contexts: [
        { id: 'a', repos: [REPO], blockedLabels: ['espera'] },
        { id: 'sem repos', repos: [REPO] },
        { id: 'b', repos: ['não é repo', 42] },
        { id: 'a', repos: [OTHER_REPO] },
        { id: 'c', name: '  Motor  ', repos: [OTHER_REPO, OTHER_REPO] },
      ],
    });
    assert.deepEqual(
      parsed.map((c) => [c.id, c.name, c.repos, c.blockedLabels]),
      [
        ['a', 'a', [REPO], ['espera']],
        ['c', 'Motor', [OTHER_REPO], ['bloqueada']],
      ],
    );
    assert.deepEqual(parseContexts(null), []);
    assert.deepEqual(parseContexts({ contexts: 'x' }), []);
  });

  test('#177/AC-1 owner/repo in any case becomes a single lower-case key', () => {
    const [c] = parseContexts({ contexts: [{ id: 'loja', repos: ['Dev-Sintetico/Catalogo-Exemplo', REPO] }] });
    assert.deepEqual(c.repos, [REPO]);
    assert.deepEqual(contextsFromRepos(['DEV-SINTETICO/catalogo-exemplo', REPO]).map((x) => x.id), [REPO]);
  });

  test('#177/AC-1 re-reads the file when it changes', async () => {
    let t = NOW;
    const file = write('muda.json', { contexts: [{ id: 'um', repos: [REPO] }] });
    const contexts = new DevConsoleContexts({ file, recentRepos: async () => [], intervalMs: 1000, now: () => t });
    assert.deepEqual((await contexts.list()).map((c) => c.id), ['um']);
    writeFileSync(file, JSON.stringify({ contexts: [{ id: 'dois', repos: [REPO] }] }));
    utimesSync(file, new Date(NOW + 5000), new Date(NOW + 5000));
    assert.deepEqual((await contexts.list()).map((c) => c.id), ['um'], 'within the interval it does not re-read');
    t += 1000;
    assert.deepEqual((await contexts.list()).map((c) => c.id), ['dois']);
  });
});

describe('contexts without a file', () => {
  test('#177/AC-1 with no file, one context per repository that had a session in the last 7 days', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    try {
      await storage.putSession(session({ id: 'a', cwd: '/w/catalogo', updatedAt: hoursAgo(2) }));
      await storage.putSession(session({ id: 'b', cwd: '/w/motor', status: 'completed', updatedAt: hoursAgo(24 * 6) }));
      await storage.putSession(session({ id: 'c', cwd: '/w/catalogo', updatedAt: hoursAgo(5) }));
      await storage.putSession(session({ id: 'velha', cwd: '/w/antigo', status: 'completed', updatedAt: hoursAgo(24 * 8) }));
      await storage.putSession(session({ id: 'sem-git', cwd: '/w/sem-remote', updatedAt: hoursAgo(1) }));
      const repoOf: Record<string, string> = { '/w/catalogo': REPO, '/w/motor': OTHER_REPO, '/w/antigo': 'dev-sintetico/antigo' };
      const seen: string[] = [];
      const where = async (s: { cwd: string | null }) => {
        seen.push(s.cwd!);
        return { repo: repoOf[s.cwd!] ?? null, branch: null };
      };
      const contexts = new DevConsoleContexts({ file: join(dir, 'nao-existe.json'), recentRepos: () => recentRepos(storage, where, { now: NOW }) });
      assert.deepEqual(await contexts.list(), contextsFromRepos([REPO, OTHER_REPO]));
      assert.deepEqual((await contexts.list())[0], { id: REPO, name: 'catalogo-exemplo', repos: [REPO], blockedLabels: ['blocked', 'bloqueada'], source: 'sessions' });
      // Each folder once; the one from 8 days ago is not even read.
      assert.deepEqual(seen.sort(), ['/w/catalogo', '/w/motor', '/w/sem-remote']);
    } finally {
      await storage.close();
    }
  });

  test('#177/AC-1 an invalid file falls back to the sessions', async () => {
    const file = write('quebrado.json', '{ isto não é json');
    const contexts = new DevConsoleContexts({ file, recentRepos: async () => [REPO] });
    assert.deepEqual((await contexts.list()).map((c) => [c.id, c.source]), [[REPO, 'sessions']]);
  });

  test('#177/AC-6 contexts given up front (the simulator) replace the file', async () => {
    const fixed = contextsFromRepos([OTHER_REPO]);
    const contexts = new DevConsoleContexts({ file: write('ignorado.json', { contexts: [{ id: 'x', repos: [REPO] }] }), fixed, recentRepos: async () => [] });
    assert.deepEqual(await contexts.list(), fixed);
  });
});
