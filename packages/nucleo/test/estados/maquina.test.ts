// A máquina de ponta a ponta: hooks pelo receptor HTTP, gravação no SQLite, vigia com relógio e sonda falsos.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { MaquinaDeEstados, lerInbox, lerMemoria, sondaFixa, type Mudanca } from '../../src/estados/index.ts';
import { importHistory } from '../../src/ingest/historico/importer.ts';
import { ingestHook, startHookReceiver, type HookReceiver } from '../../src/ingest/hooks/index.ts';
import { displayStatus } from '../../src/model.ts';
import { at } from '../fixtures.ts';
import { HOOK_PAYLOADS } from '../ingest/hook-payloads.ts';

const SID = 'sess-hooks-1';
const segundos = (s: number) => new Date(Date.parse(at(0)) + s * 1000).toISOString();

describe('máquina com SQLite', () => {
  let store: SqliteStorage;
  let relogio: Date;
  let vivos: string[] | null;
  let mudancas: Mudanca[];
  let maquina: MaquinaDeEstados;

  beforeEach(() => {
    store = openSqliteStorage({ path: ':memory:' });
    relogio = new Date(at(0));
    vivos = ['/repo/app'];
    mudancas = [];
    maquina = new MaquinaDeEstados({
      storage: store,
      agora: () => relogio,
      sonda: { diretoriosVivos: async () => (vivos ? new Set(vivos) : null) },
      aoMudar: (m) => mudancas.push(m),
      log: () => {},
    });
  });
  afterEach(() => store.close());

  /** Grava o hook como o receptor faria e passa pela máquina. */
  async function hook(payload: object, quando: string) {
    const r = await ingestHook(store, payload, { receivedAt: quando, deliveryId: `${quando}-${JSON.stringify(payload).length}` });
    return maquina.aplicar(r.event);
  }
  const sessao = async () => (await store.getSession(SID))!;
  const agentes = () => store.listAgents(SID);

  test('ciclo de vida: início, prompt, permissão, ferramenta, fim de turno, encerramento', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, segundos(0));
    assert.equal((await sessao()).awaitingReason, 'session_start');
    assert.equal((await agentes())[0].id, `${SID}:main`);

    await hook(HOOK_PAYLOADS.UserPromptSubmit, segundos(5));
    assert.equal(displayStatus(await sessao()), 'active');

    await hook(HOOK_PAYLOADS.PreToolUse, segundos(6));
    await hook(HOOK_PAYLOADS.Notification, segundos(7));
    let s = await sessao();
    assert.equal(s.awaitingReason, 'notification');
    assert.equal(lerInbox(s, await agentes()).urgente, true);

    await hook(HOOK_PAYLOADS.PostToolUse, segundos(20));
    assert.equal((await sessao()).awaitingReason, null);

    await hook(HOOK_PAYLOADS.Stop, segundos(30));
    s = await sessao();
    assert.equal(s.awaitingReason, 'stop');
    assert.equal(s.status, 'active');

    await hook(HOOK_PAYLOADS.SessionEnd, segundos(40));
    s = await sessao();
    assert.equal(s.status, 'completed');
    assert.equal(s.endedAt, segundos(40));
    assert.ok((await agentes()).every((a) => a.status === 'completed'));

    assert.deepEqual(
      mudancas.map((m) => `${m.antes}→${m.depois}`),
      ['active→waiting', 'waiting→active', 'active→waiting', 'waiting→active', 'active→waiting', 'waiting→completed'],
    );
  });

  test('a máquina preserva o que o receptor e o importador gravam', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, segundos(0));
    const s = await sessao();
    assert.equal(s.metadata.transcriptPath, HOOK_PAYLOADS.SessionStart.transcript_path);
    assert.equal(s.cwd, '/repo/app');
    assert.equal(s.model, 'claude-opus-5-5');
    assert.ok(lerMemoria(s).ultimoEvento);
  });

  test('vigia: turno morto vira waiting interrupted e deixa um evento Interrupted', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, segundos(0));
    await hook(HOOK_PAYLOADS.UserPromptSubmit, segundos(5));

    relogio = new Date(segundos(100));
    assert.deepEqual(await maquina.varrer(), []);

    relogio = new Date(segundos(125));
    const [m] = await maquina.varrer();
    assert.equal(m.regra, 'turno_morto');
    assert.equal(m.depois, 'waiting');
    const s = await sessao();
    assert.equal(s.awaitingReason, 'interrupted');
    assert.equal(s.updatedAt, segundos(5), 'vigia não conta como atividade');
    const eventos = (await store.listEvents(SID)).items;
    assert.equal(eventos.at(-1)?.type, 'Interrupted');

    // O vigia não repete.
    relogio = new Date(segundos(200));
    assert.deepEqual(await maquina.varrer(), []);

    // O turno estava vivo: chega o PostToolUse.
    await hook(HOOK_PAYLOADS.PostToolUse, segundos(210));
    assert.equal((await sessao()).awaitingReason, null);
  });

  test('vigia: sonda sem processo encerra com SessionEnd sintético', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, segundos(0));
    vivos = [];
    relogio = new Date(segundos(10));
    assert.deepEqual(await maquina.varrer(), [], 'dentro da carência');

    relogio = new Date(segundos(40));
    const [m] = await maquina.varrer();
    assert.equal(m.regra, 'sonda');
    assert.equal((await sessao()).status, 'completed');
    const fim = (await store.listEvents(SID)).items.at(-1);
    assert.equal(fim?.type, 'SessionEnd');
    assert.deepEqual(fim?.data, { sintetico: true, reason: 'processo_encerrado' });

    // Era engano (cwd diferente, por exemplo): o próximo hook reabre.
    await hook(HOOK_PAYLOADS.UserPromptSubmit, segundos(50));
    assert.equal((await sessao()).status, 'active');
  });

  test('vigia: sonda desligada não encerra; abandono depois de 180 min', async () => {
    vivos = null;
    await hook(HOOK_PAYLOADS.SessionStart, segundos(0));
    await hook(HOOK_PAYLOADS.Stop, segundos(5));
    relogio = new Date(at(180));
    assert.deepEqual(await maquina.varrer(), []);
    relogio = new Date(Date.parse(at(180)) + 5_000);
    const [m] = await maquina.varrer();
    assert.equal(m.regra, 'abandono');
    const s = await sessao();
    assert.equal(s.status, 'abandoned');
    assert.equal(s.awaitingInputSince, null);
  });

  test('cura de erro: o transcript seguiu depois do erro', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, segundos(0));
    await hook(HOOK_PAYLOADS.UserPromptSubmit, segundos(5));
    await hook({ ...HOOK_PAYLOADS.Stop, stop_reason: 'error' }, segundos(10));
    assert.equal((await sessao()).status, 'error');

    // O importador (ou o tempo real) grava o que o transcript tem depois do erro, sem passar pela máquina.
    await store.appendEvent({ id: 'jsonl:retry', sessionId: SID, agentId: `${SID}:main`, type: 'AssistantMessage', toolName: null, summary: 'ok', data: null, createdAt: segundos(20) });
    await store.putSession({ ...(await sessao()), updatedAt: segundos(20) });

    relogio = new Date(segundos(25));
    const [m] = await maquina.varrer();
    assert.equal(m.antes, 'error');
    assert.equal(m.depois, 'active');
    assert.equal((await sessao()).status, 'active');
  });

  test('sincronizar aplica os eventos ainda não vistos, em ordem', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, segundos(0));
    for (const [i, type] of ['UserPrompt', 'ToolUse', 'ToolResult', 'TurnDuration'].entries()) {
      await store.appendEvent({ id: `jsonl:${i}`, sessionId: SID, agentId: null, type, toolName: null, summary: null, data: null, createdAt: segundos(10 + i) });
    }
    const m = await maquina.sincronizar(SID);
    assert.equal(m?.causa, 'TurnDuration');
    assert.equal((await sessao()).awaitingReason, 'stop');
    assert.equal(await maquina.sincronizar(SID), null, 'nada novo na segunda vez');
  });

  test('backfill do histórico não mexe no estado ao vivo nem reabre sessão importada', async () => {
    const root = join(import.meta.dirname, '..', 'fixtures', 'historico', 'projects');
    await importHistory({ storage: store, root });
    const importadas = (await store.listSessions()).items;
    assert.ok(importadas.length > 0);
    relogio = new Date('2030-01-01T00:00:00.000Z');
    assert.deepEqual(await maquina.varrer(), []);
    for (const s of importadas) assert.equal((await store.getSession(s.id))?.status, 'completed');
  });

  test('evento de sessão que não existe é ignorado', async () => {
    assert.equal(
      await maquina.aplicar({ id: 'x', sessionId: 'nao-existe', agentId: null, type: 'Stop', toolName: null, summary: null, data: null, createdAt: at(0) }),
      null,
    );
  });
});

describe('pendurada no receptor de hooks', () => {
  let store: SqliteStorage;
  let receiver: HookReceiver;
  let pendente: Promise<void>;

  beforeEach(async () => {
    store = openSqliteStorage({ path: ':memory:' });
    const maquina = new MaquinaDeEstados({ storage: store, sonda: sondaFixa(null), log: () => {} });
    pendente = Promise.resolve();
    receiver = await startHookReceiver({
      storage: store,
      port: 0,
      log: () => {},
      onEvent: (r) => {
        pendente = pendente.then(() => maquina.aoReceberHook(r));
        return pendente;
      },
    });
  });
  afterEach(async () => {
    await receiver.close();
    store.close();
  });

  async function post(payload: object, quando: string) {
    const res = await fetch(`${receiver.url}/api/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ahrena-hook-at': quando, 'x-ahrena-delivery-id': `${quando}-${Math.random()}` },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 202);
    // O onEvent roda depois da resposta.
    await new Promise((r) => setTimeout(r, 20));
    await pendente;
  }

  test('subagente: delegando enquanto roda, esperando você depois do SubagentStop', async () => {
    await post(HOOK_PAYLOADS.SessionStart, segundos(0));
    await post(HOOK_PAYLOADS.UserPromptSubmit, segundos(1));
    await post({ ...HOOK_PAYLOADS.PreToolUse, tool_name: 'Agent', tool_use_id: 'tu-ag', tool_input: { description: 'explorar' } }, segundos(2));
    await post({ ...HOOK_PAYLOADS.PreToolUse, tool_use_id: 'tu-sub', agent_id: 'agent-7', agent_type: 'Explore' }, segundos(3));

    let s = (await store.getSession(SID))!;
    let ag = await store.listAgents(SID);
    assert.equal(lerInbox(s, ag).estado, 'delegating');
    assert.ok(ag.some((a) => a.id === `${SID}:agent-7` && a.status === 'working'));

    await post(HOOK_PAYLOADS.SubagentStop, segundos(10));
    await post({ ...HOOK_PAYLOADS.PostToolUse, tool_name: 'Agent', tool_use_id: 'tu-ag' }, segundos(11));
    await post(HOOK_PAYLOADS.Stop, segundos(12));

    s = (await store.getSession(SID))!;
    ag = await store.listAgents(SID);
    assert.equal(ag.find((a) => a.id === `${SID}:agent-7`)?.status, 'completed');
    const leitura = lerInbox(s, ag);
    assert.equal(leitura.estado, 'waiting');
    assert.equal(leitura.precisaDeVoce, true);
  });
});
