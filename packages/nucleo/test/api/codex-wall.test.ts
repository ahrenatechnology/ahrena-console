import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { session } from '../fixtures.ts';
import type { CodexIndex, CodexThread } from '../../src/api/codex-index.ts';
import { describeOpenAction, openedText } from '../../ui/open-action.js';
import { cardContent } from '../../ui/screens/wall.js';

const ID = '01a15e4a-c337-7f23-b905-728305a91a8a';
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
test('wall labels both providers and routes opening only to the verified local source', async () => {
  const now = Date.now();
  const recent = new Date(now - 1000).toISOString();
  const thread: CodexThread = { id: ID, title: 'Codex PM', cwd: '/work', group: 'Ahrena', createdAt: recent, updatedAt: recent };
  let available = true;
  let launcherFails = false;
  const source = { list: () => available ? [thread] : [], find: (id: string) => available && id === ID ? thread : null, error: null } as CodexIndex;
  const storage = openSqliteStorage({ path: ':memory:' });
  await storage.putSession(session({ id: CLAUDE_ID, status: 'active', updatedAt: recent }));
  const panel = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null, agora: () => now });
  const opened: string[] = [];
  const api = await startLocalApi({ panelBuilder: panel, hooks: { storage }, port: 0, log: () => {}, codex: source,
    localOf: () => 'local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    openInDesktop: async url => { if (launcherFails) throw new Error('missing app'); opened.push(url); } });
  const url = api.url;
  const open = (id: string, origin = url) => fetch(`${url}/api/${id === ID ? 'codex/' : ''}sessions/${id}/open`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://untrusted.example', provider: 'claude' }),
  });
  try {
    const wall = await (await fetch(`${url}/api/wall`)).json();
    const codex = wall.cards.find(c => c.id === ID);
    const claude = wall.cards.find(c => c.id === CLAUDE_ID);
    assert.equal(codex.provider, 'codex');
    assert.equal(codex.group, 'Ahrena');
    assert.equal(codex.status, 'unknown');
    assert.equal(codex.open.target, 'codex-desktop');
    assert.equal(claude.provider, 'claude');
    assert.equal(cardContent(codex).href, null, 'Codex does not link to an unavailable Claude detail route');
    assert.equal(cardContent(codex).grade.find(([label]) => label === 'Agentes')[1], '—');
    assert.equal(describeOpenAction(codex.open).label, 'Abrir no Codex');
    assert.equal(openedText('codex-desktop'), 'Abertura solicitada ao Codex');
    assert.equal((await open(ID)).status, 200);
    assert.deepEqual(opened, [`codex://threads/${ID}`]);
    await storage.putSession(session({ id: ID, status: 'active', updatedAt: recent }));
    assert.equal((await open(ID)).status, 200);
    assert.equal(opened.pop(), `codex://threads/${ID}`, 'provider namespace prevents a same-UUID Claude collision');
    assert.equal((await open(CLAUDE_ID)).status, 200);
    assert.match(opened[1], /^claude:\/\/claude.ai\/epitaxy\/local_/);
    assert.equal((await open(ID, 'https://untrusted.example')).status, 403);
    assert.equal(opened.length, 2);
    launcherFails = true;
    assert.equal((await open(ID)).status, 502);
    source.error = 'Índice Codex indisponível';
    assert.equal((await open(ID)).status, 503);
    source.error = null;
    available = false;
    assert.equal((await open(ID)).status, 404, 'removed/archived threads cannot be launched');
  } finally { await api.close(); await storage.close(); }
});
