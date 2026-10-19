// Seguidor dos transcripts (item 1.3), com diretório temporário e escritas sintéticas.
// Nenhum transcript real: as linhas são montadas aqui.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { classifyTranscript } from '../src/ingest/historico/files.ts';
import { followTranscripts, type FollowOptions, type TranscriptFollower } from '../src/ingest/historico/follower.ts';
import { eventId, subagentId } from '../src/ingest/historico/importer.ts';
import type { StoragePort } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ahrena-seguidor-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function newRoot(): string {
  const dir = join(tmp, `projects-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const PROJECT = '-sintetico-app';

let clock = Date.parse('2026-11-02T12:00:00.000Z');
function line(sessionId: string, uuid: string, extra: Record<string, unknown> = {}): string {
  clock += 1000;
  return (
    JSON.stringify({
      sessionId,
      type: 'user',
      uuid,
      cwd: '/sintetico/app',
      isSidechain: false,
      timestamp: new Date(clock).toISOString(),
      message: { role: 'user', content: `linha ${uuid}` },
      ...extra,
    }) + '\n'
  );
}

function mainFile(root: string, sessionId: string): string {
  mkdirSync(join(root, PROJECT), { recursive: true });
  return join(root, PROJECT, `${sessionId}.jsonl`);
}

async function hasEvent(store: StoragePort, sessionId: string, uuid: string): Promise<boolean> {
  const page = await store.listEvents(sessionId, { limit: 500 });
  return page.items.some((e) => e.id === eventId(uuid));
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 4000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`não chegou em ${timeoutMs} ms: ${what}`);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const open: TranscriptFollower[] = [];
// Teste que falha no meio não deixa watch nem intervalo segurando o processo.
afterEach(async () => {
  for (const f of open.splice(0)) await f.stop();
});

function setup(opts: Partial<FollowOptions> = {}) {
  const root = newRoot();
  const store = openSqliteStorage({ path: ':memory:' });
  const errors: unknown[] = [];
  const follower = followTranscripts({ storage: store, root, onError: (e) => errors.push(e), ...opts });
  open.push(follower);
  return { root, store, follower, errors };
}

describe('seguidor: classificação dos caminhos avisados', () => {
  test('reconhece os três layouts e ignora o resto', () => {
    const root = '/raiz';
    const none = () => false;
    assert.equal(classifyTranscript(root, join('p', `${sid(1)}.jsonl`), none)?.kind, 'main');
    assert.equal(classifyTranscript(root, join('p', `${sid(1)}.jsonl`), none)?.sessionId, sid(1));
    const old = classifyTranscript(root, join('p', 'agent-a1.jsonl'), none);
    assert.deepEqual([old?.kind, old?.sessionId, old?.agentId], ['subagent', null, 'a1']);
    const sub = classifyTranscript(root, join('p', sid(1), 'subagents', 'agent-a2.jsonl'), () => true);
    assert.deepEqual([sub?.kind, sub?.sessionId, sub?.agentId], ['subagent', sid(1), 'a2']);
    assert.equal(sub?.metaPath, join(root, 'p', sid(1), 'subagents', 'agent-a2.meta.json'));
    assert.equal(classifyTranscript(root, join('p', `${sid(1)}.superseded-1.jsonl`), none), null);
    assert.equal(classifyTranscript(root, join('p', sid(1), 'subagents', 'agent-a2.meta.json'), none), null);
    assert.equal(classifyTranscript(root, 'p', none), null);
  });
});

describe('seguidor: tempo real', () => {
  test('importa o que já existe ao começar e segue o que é acrescentado pelo watch', async () => {
    const { root, store, follower, errors } = setup({ scanIntervalMs: 60_000 });
    const file = mainFile(root, sid(1));
    writeFileSync(file, line(sid(1), 'a1'));
    const first = await follower.start();
    assert.equal(first.eventsAdded, 1);
    assert.ok(follower.stats().watching, 'watch ativo');

    appendFileSync(file, line(sid(1), 'a2'));
    const ms = await waitFor('linha nova pelo watch', () => hasEvent(store, sid(1), 'a2'), 3000);
    assert.ok(ms < 3000, `latência ${ms} ms`);
    assert.equal(follower.stats().scans, 1, 'chegou pelo aviso, sem varredura');
    await follower.stop();
    assert.deepEqual(errors, []);
    await store.close();
  });

  test('sessão nova em projeto novo chega pela varredura, com o watch desligado', async () => {
    const { root, store, follower } = setup({ watch: false, scanIntervalMs: 100 });
    await follower.start();
    assert.equal(follower.stats().watching, false);
    writeFileSync(mainFile(root, sid(2)), line(sid(2), 'b1'));
    await waitFor('sessão nova', async () => (await store.getSession(sid(2))) !== null);
    assert.ok(await hasEvent(store, sid(2), 'b1'));
    await follower.stop();
    await store.close();
  });

  test('subagente novo, numa pasta criada depois, chega pelo watch', async () => {
    const { root, store, follower } = setup({ scanIntervalMs: 60_000 });
    writeFileSync(mainFile(root, sid(3)), line(sid(3), 'c1'));
    await follower.start();

    const dir = join(root, PROJECT, sid(3), 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Explorar', toolUseId: 'toolu_1' }));
    writeFileSync(join(dir, 'agent-x1.jsonl'), line(sid(3), 'c2', { isSidechain: true, agentId: 'x1' }));

    const id = subagentId(sid(3), 'x1');
    await waitFor('subagente novo', async () => (await store.listAgents(sid(3))).some((a) => a.id === id));
    const agent = (await store.listAgents(sid(3))).find((a) => a.id === id)!;
    assert.equal(agent.subagentType, 'Explore');
    assert.equal(agent.name, 'Explorar');
    assert.ok(await hasEvent(store, sid(3), 'c2'));
    await follower.stop();
    await store.close();
  });

  test('raiz que ainda não existe: começa pela varredura e liga o watch quando ela aparece', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    const root = join(tmp, `ainda-nao-${n++}`);
    const follower = followTranscripts({ storage: store, root, scanIntervalMs: 100 });
    open.push(follower);
    const first = await follower.start();
    assert.equal(first.filesFound, 0);
    assert.equal(follower.stats().watching, false);
    writeFileSync(mainFile(root, sid(4)), line(sid(4), 'd1'));
    await waitFor('sessão na raiz criada depois', () => hasEvent(store, sid(4), 'd1'));
    await waitFor('watch ligado', async () => follower.stats().watching);
    await follower.stop();
    await store.close();
  });
});

describe('seguidor: arquivos que mudam de jeito estranho', () => {
  // Aqui sem watch e sem intervalo: cada rodada é um `sync()`, para o teste ser determinístico.
  const manual = () => setup({ watch: false, scanIntervalMs: 3_600_000 });

  test('linha pela metade espera o resto', async () => {
    const { root, store, follower } = manual();
    const file = mainFile(root, sid(5));
    writeFileSync(file, line(sid(5), 'e1'));
    await follower.start();

    const half = line(sid(5), 'e2');
    appendFileSync(file, half.slice(0, 40));
    const partial = await follower.sync();
    assert.equal(partial.filesRead, 1);
    assert.equal(partial.eventsAdded, 0);
    assert.equal(await hasEvent(store, sid(5), 'e2'), false);

    appendFileSync(file, half.slice(40));
    const rest = await follower.sync();
    assert.equal(rest.eventsAdded, 1);
    assert.equal(rest.eventsExisting, 0, 'continuou do cursor');
    assert.ok(await hasEvent(store, sid(5), 'e2'));
    await follower.stop();
    await store.close();
  });

  test('arquivo truncado e reescrito menor é relido do início', async () => {
    const { root, store, follower } = manual();
    const file = mainFile(root, sid(6));
    writeFileSync(file, line(sid(6), 'f1') + line(sid(6), 'f2') + line(sid(6), 'f3'));
    await follower.start();

    truncateSync(file, 0);
    writeFileSync(file, line(sid(6), 'f9'));
    const report = await follower.sync();
    assert.equal(report.filesRewound, 1);
    assert.equal(report.eventsAdded, 1);
    assert.ok(await hasEvent(store, sid(6), 'f9'));
    await follower.stop();
    await store.close();
  });

  test('arquivo reescrito com tamanho maior é relido do início, pela impressão digital do cursor', async () => {
    const { root, store, follower } = manual();
    const file = mainFile(root, sid(7));
    writeFileSync(file, line(sid(7), 'g1') + line(sid(7), 'g2'));
    await follower.start();

    // Conteúdo novo e maior: só pelo tamanho, o importador continuaria do meio de uma linha.
    writeFileSync(file, line(sid(7), 'g7', { message: { role: 'user', content: 'x'.repeat(50) } }) + line(sid(7), 'g8') + line(sid(7), 'g9'));
    const report = await follower.sync();
    assert.equal(report.filesRewound, 1);
    assert.equal(report.linesInvalid, 0);
    assert.equal(report.eventsAdded, 3);
    for (const u of ['g7', 'g8', 'g9']) assert.ok(await hasEvent(store, sid(7), u), u);
    await follower.stop();
    await store.close();
  });

  test('arquivo apagado sai da lista e, se voltar, é lido de novo', async () => {
    const { root, store, follower } = manual();
    const file = mainFile(root, sid(8));
    writeFileSync(file, line(sid(8), 'h1'));
    await follower.start();
    assert.equal(follower.stats().filesKnown, 1);
    rmSync(file);
    await follower.sync();
    assert.equal(follower.stats().filesKnown, 0);
    writeFileSync(file, line(sid(8), 'h1') + line(sid(8), 'h2'));
    const report = await follower.sync();
    assert.equal(report.filesRead, 1);
    assert.ok(await hasEvent(store, sid(8), 'h2'));
    await follower.stop();
    await store.close();
  });
});

describe('seguidor: parar, começar e custo', () => {
  test('parado não importa; ao recomeçar, pega o que ficou para trás', async () => {
    const { root, store, follower } = setup({ scanIntervalMs: 100 });
    const file = mainFile(root, sid(9));
    writeFileSync(file, line(sid(9), 'i1'));
    await follower.start();
    await follower.stop();
    assert.equal(follower.running, false);
    assert.equal(follower.stats().watching, false);

    appendFileSync(file, line(sid(9), 'i2'));
    await pause(400);
    assert.equal(await hasEvent(store, sid(9), 'i2'), false, 'parado');

    const again = await follower.start();
    assert.equal(again.eventsAdded, 1);
    assert.ok(await hasEvent(store, sid(9), 'i2'));
    assert.equal((await follower.start()).filesRead, 0, 'start de novo com ele rodando não reimporta');
    await follower.stop();
    await store.close();
  });

  test('com centenas de sessões, uma rodada sem mudança não lê nada e a mudança lê um arquivo', async () => {
    const { root, store, follower } = setup({ watch: false, scanIntervalMs: 3_600_000 });
    const SESSIONS = 300;
    for (let i = 0; i < SESSIONS; i++) writeFileSync(mainFile(root, sid(1000 + i)), line(sid(1000 + i), `k${i}`));
    const first = await follower.start();
    assert.equal(first.filesRead, SESSIONS);

    const t0 = performance.now();
    const idle = await follower.sync();
    const idleMs = performance.now() - t0;
    assert.equal(idle.filesFound, 0, 'nada entregue ao importador');
    assert.ok(idleMs < 1000, `rodada parada levou ${idleMs.toFixed(0)} ms`);

    const file = mainFile(root, sid(1042));
    appendFileSync(file, line(sid(1042), 'k-novo'));
    // mtime explícito: num sistema de arquivos com mtime grosso, o tamanho já basta, mas fica claro.
    utimesSync(file, new Date(), new Date(Date.now() + 1000));
    const one = await follower.sync();
    assert.equal(one.filesFound, 1);
    assert.equal(one.filesRead, 1);
    assert.equal(one.eventsAdded, 1);
    await follower.stop();
    await store.close();
  });
});
