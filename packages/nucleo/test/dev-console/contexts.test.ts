// Os contextos do Dev Console (#177/AC-1): do `dev-console.json`, com o caminho injetado, e sem
// arquivo um por repositório com sessão nos últimos 7 dias. Arquivos numa pasta temporária.
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

describe('contextos do arquivo', () => {
  test('#177/AC-1 lê os contextos de dev-console.json, no caminho injetado', async () => {
    const file = write('ok.json', { contexts: [{ id: 'loja', name: 'Loja', repos: [REPO, OTHER_REPO] }] });
    const contexts = new DevConsoleContexts({ file, recentRepos: async () => assert.fail('com arquivo, as sessões não contam') });
    assert.deepEqual(await contexts.list(), [{ id: 'loja', name: 'Loja', repos: [REPO, OTHER_REPO], blockedLabels: ['blocked'], source: 'file' }]);
    assert.equal((await contexts.get('loja'))?.name, 'Loja');
    assert.equal(await contexts.get('outro'), null);
  });

  test('#177/AC-1 contexto inválido fica de fora sem derrubar os outros; etiqueta de bloqueio configurável', () => {
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

  test('#177/AC-1 relê o arquivo quando ele muda', async () => {
    let t = NOW;
    const file = write('muda.json', { contexts: [{ id: 'um', repos: [REPO] }] });
    const contexts = new DevConsoleContexts({ file, recentRepos: async () => [], intervalMs: 1000, now: () => t });
    assert.deepEqual((await contexts.list()).map((c) => c.id), ['um']);
    writeFileSync(file, JSON.stringify({ contexts: [{ id: 'dois', repos: [REPO] }] }));
    utimesSync(file, new Date(NOW + 5000), new Date(NOW + 5000));
    assert.deepEqual((await contexts.list()).map((c) => c.id), ['um'], 'dentro do intervalo, não relê');
    t += 1000;
    assert.deepEqual((await contexts.list()).map((c) => c.id), ['dois']);
  });
});

describe('contextos sem arquivo', () => {
  test('#177/AC-1 sem arquivo, um contexto por repositório que teve sessão nos últimos 7 dias', async () => {
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
      assert.deepEqual((await contexts.list())[0], { id: REPO, name: 'catalogo-exemplo', repos: [REPO], blockedLabels: ['blocked'], source: 'sessions' });
      // Cada pasta uma vez; a de 8 dias atrás nem é lida.
      assert.deepEqual(seen.sort(), ['/w/catalogo', '/w/motor', '/w/sem-remote']);
    } finally {
      await storage.close();
    }
  });

  test('#177/AC-1 arquivo inválido cai nas sessões', async () => {
    const file = write('quebrado.json', '{ isto não é json');
    const contexts = new DevConsoleContexts({ file, recentRepos: async () => [REPO] });
    assert.deepEqual((await contexts.list()).map((c) => [c.id, c.source]), [[REPO, 'sessions']]);
  });

  test('#177/AC-6 contextos dados de antemão (o simulador) valem no lugar do arquivo', async () => {
    const fixed = contextsFromRepos([OTHER_REPO]);
    const contexts = new DevConsoleContexts({ file: write('ignorado.json', { contexts: [{ id: 'x', repos: [REPO] }] }), fixed, recentRepos: async () => [] });
    assert.deepEqual(await contexts.list(), fixed);
  });
});
