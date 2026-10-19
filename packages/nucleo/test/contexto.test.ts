// Medidor de contexto e estouros (item 1.7) com transcripts sintéticos e hooks.
// Os campos seguem a estrutura do transcript do Claude Code (`message.usage`, `compact_boundary` com
// `compactMetadata`); nenhum conteúdo real entra no repositório.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage, type SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../src/adapters/sqlite/migrations.ts';
import { Contas, MontadorDoPainel } from '../src/api/index.ts';
import { reprocessarContexto } from '../src/api/reprocessamento.ts';
import {
  JANELA_LONGA,
  JANELA_PADRAO,
  alertaDeContexto,
  aplicarAoMedidor,
  medidorVazio,
  atualizarContexto,
  rotuloDoContexto,
  validateContextMeter,
  type ContextMeter,
} from '../src/contexto/index.ts';
import { importHistory } from '../src/ingest/historico/importer.ts';
import { ingestHook } from '../src/ingest/hooks/index.ts';
import { at, event } from './fixtures.ts';

let store: SqliteStorage;
beforeEach(() => {
  store = openSqliteStorage({ path: ':memory:' });
});

const tmp = mkdtempSync(join(tmpdir(), 'ahrena-contexto-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let linha = 0;
const uuid = () => `00000000-0000-4000-9000-${String(++linha).padStart(12, '0')}`;
const A = 'a7777777777777777';

interface Uso {
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

function mensagem(sid: string, m: number, uso: Uso, extra: { agentId?: string; model?: string } = {}): string {
  return JSON.stringify({
    type: 'assistant', uuid: uuid(), parentUuid: null, timestamp: at(m), sessionId: sid, cwd: '/repo/app',
    ...(extra.agentId ? { isSidechain: true, agentId: extra.agentId } : {}),
    message: {
      id: `msg_${linha}`, model: extra.model ?? 'claude-opus-5-5', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: uso.input,
        cache_read_input_tokens: uso.cacheRead ?? 0,
        cache_creation_input_tokens: uso.cacheWrite ?? 0,
        output_tokens: uso.output ?? 10,
      },
    },
  });
}

function compactacao(sid: string, m: number, trigger: 'auto' | 'manual', preTokens: number, postTokens: number): string {
  return JSON.stringify({
    type: 'system', subtype: 'compact_boundary', uuid: uuid(), parentUuid: null, timestamp: at(m), sessionId: sid,
    cwd: '/repo/app', content: 'Conversation compacted', level: 'info',
    compactMetadata: { trigger, preTokens, postTokens, durationMs: 1000 },
  });
}

/** Grava o transcript da sessão (e do subagente, se houver) e importa. */
async function importar(nome: string, sid: string, linhas: string[], sub: string[] = []): Promise<{ root: string; arquivo: string }> {
  const root = join(tmp, nome);
  mkdirSync(join(root, '-repo-app', sid, 'subagents'), { recursive: true });
  const arquivo = join(root, '-repo-app', `${sid}.jsonl`);
  writeFileSync(arquivo, linhas.map((l) => `${l}\n`).join(''));
  if (sub.length > 0) writeFileSync(join(root, '-repo-app', sid, 'subagents', `agent-${A}.jsonl`), sub.map((l) => `${l}\n`).join(''));
  await importHistory({ storage: store, root });
  return { root, arquivo };
}

const principal = async (sid: string) => (await store.listContextMeters(sid)).find((m) => m.agentId === null)!;
const resumo = (m: ContextMeter) => ({ usados: m.usedTokens, janela: m.windowTokens, estouros: m.compactions, rotulo: rotuloDoContexto(m) });

describe('medidor pelo transcript', () => {
  test('sessão normal: a última mensagem do assistente, input mais cache, na janela de 200k', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c1';
    await importar('normal', sid, [
      mensagem(sid, 1, { input: 3, cacheRead: 10_000, cacheWrite: 2_000, output: 500 }),
      mensagem(sid, 2, { input: 600, cacheRead: 60_000, cacheWrite: 2_000, output: 900 }),
    ]);
    const m = await principal(sid);
    assert.deepEqual(resumo(m), { usados: 62_600, janela: JANELA_PADRAO, estouros: 0, rotulo: '62.6k / 200k (31%)' });
    assert.equal(m.windowSource, 'modelo');
    assert.equal(m.model, 'claude-opus-5-5');
    assert.equal(m.measuredAt, at(2));
  });

  test('1 compactação: conta um estouro, sem alerta, e o contexto cai para o de depois', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c2';
    await importar('uma', sid, [
      mensagem(sid, 1, { input: 1_000, cacheRead: 180_000 }),
      compactacao(sid, 2, 'auto', 181_000, 9_000),
    ]);
    let m = await principal(sid);
    assert.deepEqual(resumo(m), { usados: 9_000, janela: JANELA_PADRAO, estouros: 1, rotulo: '9k / 200k (5%)' });
    assert.equal(alertaDeContexto(m), false, 'o alerta é a partir de 2');
    assert.equal(m.lastCompactionTrigger, 'auto');
    assert.equal(m.lastCompactionAt, at(2));

    // A próxima mensagem volta a mandar a medição; o estouro fica.
    const root = join(tmp, 'uma');
    const arquivo = join(root, '-repo-app', `${sid}.jsonl`);
    appendFileSync(arquivo, `${mensagem(sid, 3, { input: 200, cacheRead: 15_000 })}\n`);
    await importHistory({ storage: store, root });
    m = await principal(sid);
    assert.deepEqual([m.usedTokens, m.compactions], [15_200, 1]);
  });

  test('3 compactações automáticas: três estouros e o alerta; a manual fica à parte; reimportar não conta de novo', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c3';
    const { root } = await importar('tres', sid, [
      mensagem(sid, 1, { input: 1_000, cacheRead: 150_000 }),
      compactacao(sid, 2, 'auto', 160_000, 10_000),
      mensagem(sid, 3, { input: 1_000, cacheRead: 150_000 }),
      compactacao(sid, 4, 'auto', 151_000, 8_000),
      mensagem(sid, 5, { input: 1_000, cacheRead: 150_000 }),
      compactacao(sid, 6, 'manual', 151_000, 9_000),
      mensagem(sid, 7, { input: 1_000, cacheRead: 150_000 }),
      compactacao(sid, 8, 'auto', 158_000, 12_000),
      mensagem(sid, 9, { input: 500, cacheRead: 40_000 }),
    ]);
    let m = await principal(sid);
    assert.deepEqual([m.compactions, m.compactionsTranscript, m.manualCompactions, m.usedTokens, m.lastCompactionTrigger], [3, 3, 1, 40_500, 'auto']);
    assert.equal(alertaDeContexto(m), true);
    await importHistory({ storage: store, root });
    m = await principal(sid);
    assert.equal(m.compactions, 3, 'o mesmo transcript não conta duas vezes');
  });

  test('subagente: medidor próprio, sem mudar o do principal', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c4';
    await importar('sub', sid, [mensagem(sid, 1, { input: 100, cacheRead: 50_000 })], [
      mensagem(sid, 2, { input: 50, cacheRead: 20_000 }, { agentId: A, model: 'claude-haiku-5-5' }),
      compactacao(sid, 3, 'auto', 20_050, 4_000).replace('"sessionId"', `"isSidechain":true,"agentId":"${A}","sessionId"`),
    ]);
    const medidores = await store.listContextMeters(sid);
    assert.deepEqual(medidores.map((m) => m.agentId), [null, `${sid}:${A}`], 'o principal primeiro');
    const [p, s] = medidores;
    assert.deepEqual([p.usedTokens, p.compactions], [50_100, 0]);
    assert.deepEqual([s.usedTokens, s.compactions, s.model], [4_000, 1, 'claude-haiku-5-5']);
  });

  test('modelo de 1M: pelo sufixo [1m] da sessão, e pelo contexto que passou de 200k', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c5';
    // O hook SessionStart traz o modelo com o sufixo; o transcript, sem.
    await ingestHook(store, { session_id: sid, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5[1m]' }, { receivedAt: at(0) });
    await importar('longo', sid, [mensagem(sid, 1, { input: 2_000, cacheRead: 60_000 })]);
    let m = await principal(sid);
    assert.deepEqual([m.usedTokens, m.windowTokens, m.windowSource, rotuloDoContexto(m)], [62_000, JANELA_LONGA, 'sufixo', '62k / 1M (6%)']);

    const sid2 = '00000000-0000-4000-8000-0000000000c6';
    await importar('observado', sid2, [
      mensagem(sid2, 1, { input: 1_000, cacheRead: 150_000 }),
      mensagem(sid2, 2, { input: 1_000, cacheRead: 320_000 }),
      mensagem(sid2, 3, { input: 1_000, cacheRead: 100_000 }),
    ]);
    m = await principal(sid2);
    assert.deepEqual([m.usedTokens, m.windowTokens, m.windowSource], [101_000, JANELA_LONGA, 'observado'], 'a janela não encolhe');
  });
});

describe('estouros pelo hook PreCompact', () => {
  const pre = (sid: string, m: number, trigger: string, id: string) =>
    ingestHook(store, { session_id: sid, hook_event_name: 'PreCompact', trigger, custom_instructions: '' }, { receivedAt: at(m), deliveryId: id });

  test('o hook automático conta, o manual fica à parte, e a entrega repetida não', async () => {
    const sid = 'sess-hook-1';
    await pre(sid, 1, 'auto', 'd1');
    await pre(sid, 1, 'auto', 'd1');
    await pre(sid, 2, 'manual', 'd2');
    await pre(sid, 3, 'auto', 'd4');
    const m = await principal(sid);
    assert.deepEqual([m.compactions, m.compactionsHook, m.manualCompactions, m.lastCompactionTrigger, m.measuredAt], [2, 2, 1, 'auto', null]);
  });

  test('medidor só do PreCompact: o card não mostra "0 / 200k"', async () => {
    const sid = 'sess-hook-2';
    await pre(sid, 1, 'auto', 'd5');
    const montador = new MontadorDoPainel({ storage: store, contas: new Contas({ storage: store, arquivo: null }), desktop: null, trabalho: null, agora: () => Date.parse(at(10)) });
    assert.equal((await montador.montar({ sessionId: sid })).contexto, null);
  });

  test('hook e transcript veem a mesma compactação: vale o maior, nunca a soma', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c7';
    await pre(sid, 2, 'auto', 'd3');
    await importar('ambos', sid, [mensagem(sid, 1, { input: 1_000, cacheRead: 170_000 }), compactacao(sid, 2, 'auto', 171_000, 9_000)]);
    const m = await principal(sid);
    assert.deepEqual([m.compactions, m.compactionsHook, m.compactionsTranscript], [1, 1, 1]);
  });
});

describe('aplicarAoMedidor', () => {
  test('o preTokens da compactação não muda a janela ("prompt too long" acima de 200k)', () => {
    const c = event({ id: 'c1', type: 'Compaction', createdAt: at(1), data: { subtype: 'compact_boundary', compact: { trigger: 'auto', preTokens: 260_000, postTokens: 20_000 } } });
    const m = aplicarAoMedidor(medidorVazio('s1', null, at(0)), c, null)!;
    assert.deepEqual([m.windowTokens, m.windowSource, m.usedTokens, m.compactions], [JANELA_PADRAO, 'modelo', 20_000, 1]);
  });

  test('datas com precisões diferentes são comparadas como instante', async () => {
    const uso = (id: string, createdAt: string, input: number) =>
      event({ id, type: 'AssistantMessage', createdAt, data: { usage: { model: 'claude-opus-5-5', tokens: { input, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } } });
    // Como texto, "12:00:00Z" vem depois de "12:00:00.500Z"; como instante, antes.
    const gravados: ContextMeter[] = [];
    const porta = { getSession: async () => null, listContextMeters: async () => [], putContextMeter: async (m: ContextMeter) => void gravados.push(m) };
    await atualizarContexto(porta, 's1', [uso('b', '2026-11-02T12:00:00.500Z', 5_000), uso('a', '2026-11-02T12:00:00Z', 3_000)]);
    assert.deepEqual([gravados[0].usedTokens, gravados[0].measuredAt], [5_000, '2026-11-02T12:00:00.500Z']);
    const m = aplicarAoMedidor(gravados[0], uso('c', '2026-11-02T12:00:00Z', 1_000), null)!;
    assert.equal(m.usedTokens, 5_000, 'a mensagem mais velha não substitui');
  });

  test('mensagem mais velha que a medição não a substitui', () => {
    let m = medidorVazio('s1', null, at(0));
    const uso = (minuto: number, input: number) =>
      event({ id: `e${minuto}`, type: 'AssistantMessage', createdAt: at(minuto), data: { usage: { model: 'claude-opus-5-5', tokens: { input, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } } });
    m = aplicarAoMedidor(m, uso(5, 5_000), null)!;
    m = aplicarAoMedidor(m, uso(3, 3_000), null)!;
    assert.deepEqual([m.usedTokens, m.measuredAt], [5_000, at(5)]);
    assert.equal(aplicarAoMedidor(m, event({ type: 'ToolResult', createdAt: at(6) }), null), null);
    validateContextMeter(m);
  });

  test('rótulo como no Podium', () => {
    assert.equal(rotuloDoContexto({ usedTokens: 62_600, windowTokens: 200_000 }), '62.6k / 200k (31%)');
    assert.equal(rotuloDoContexto({ usedTokens: 950, windowTokens: 200_000 }), '950 / 200k (0%)');
  });
});

describe('migração e porta', () => {
  test('a migração 7 cria context_meters num banco da versão 6', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 6));
    assert.deepEqual(migrate(db, MIGRATIONS.filter((m) => m.version <= 7)), [7]);
    assert.equal(schemaVersion(db), 7);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_meters'").get());
    db.close();
  });

  test('medidor inválido não é gravado', async () => {
    const m = { ...medidorVazio('s1', null, at(0)), compactions: 2 };
    await assert.rejects(store.putContextMeter(m), /compactions/);
  });
});

describe('API do painel', () => {
  test('contexto com tokens, janela, porcentagem, estouros e alerta, e o de cada subagente', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c8';
    await importar('painel', sid, [
      mensagem(sid, 1, { input: 1_000, cacheRead: 150_000 }),
      compactacao(sid, 2, 'auto', 160_000, 10_000),
      mensagem(sid, 3, { input: 1_000, cacheRead: 150_000 }),
      compactacao(sid, 4, 'auto', 151_000, 8_000),
      compactacao(sid, 4.5, 'manual', 70_000, 7_000),
      mensagem(sid, 5, { input: 600, cacheRead: 62_000 }),
    ], [mensagem(sid, 6, { input: 50, cacheRead: 20_000 }, { agentId: A })]);
    const montador = new MontadorDoPainel({ storage: store, contas: new Contas({ storage: store, arquivo: null }), desktop: null, trabalho: null, agora: () => Date.parse(at(10)) });
    const p = await montador.montar({ sessionId: sid });
    assert.deepEqual(p.contexto, {
      usados: 62_600,
      limite: 200_000,
      pct: 31,
      estouros: 2,
      alerta: true,
      compactacoesManuais: 1,
      rotulo: '62.6k / 200k (31%)',
      agentes: [{ agenteId: `${sid}:${A}`, usados: 20_050, limite: 200_000, pct: 10, estouros: 0, alerta: false }],
    });
    assert.ok(p.subagentes.itens.some((s) => s.id === `${sid}:${A}`), 'agenteId é o id do subagente no card');
  });
});

describe('reprocessamento contexto-1', () => {
  test('refaz o medidor da sessão importada antes do 1.7, com as compactações relidas do transcript e do subagente', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c9';
    const linhas = [
      mensagem(sid, 1, { input: 1_000, cacheRead: 150_000 }),
      compactacao(sid, 2, 'auto', 160_000, 10_000),
      mensagem(sid, 3, { input: 1_000, cacheRead: 150_000 }),
      compactacao(sid, 4, 'auto', 151_000, 8_000),
      mensagem(sid, 5, { input: 600, cacheRead: 62_000 }),
    ];
    const { root, arquivo } = await importar('reprocessar', sid, linhas, [
      mensagem(sid, 6, { input: 50, cacheRead: 20_000 }, { agentId: A }),
      compactacao(sid, 7, 'auto', 20_050, 4_000).replace('"sessionId"', `"isSidechain":true,"agentId":"${A}","sessionId"`),
    ]);
    // Como a importação antiga: sem medidor, e a compactação gravada sem o compactMetadata.
    const antigo = openSqliteStorage({ path: ':memory:' });
    const sessao = (await store.getSession(sid))!;
    await antigo.putSession({ ...sessao, metadata: { ...sessao.metadata, transcriptPath: arquivo } });
    let cursor: string | null = null;
    do {
      const page = await store.listEvents(sid, { limit: 500, cursor });
      for (const e of page.items) {
        const d = e.data as Record<string, unknown>;
        await antigo.appendEvent(e.type === 'Compaction' ? { ...e, data: { ...d, compact: undefined } } : e);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(await antigo.listContextMeters(sid), []);

    const r = await reprocessarContexto({ storage: antigo, raiz: root });
    assert.deepEqual(r, { sessoes: 1, medidores: 2 });
    const [p, sub] = await antigo.listContextMeters(sid);
    assert.deepEqual([p.usedTokens, p.compactions, alertaDeContexto(p)], [62_600, 2, true]);
    assert.deepEqual([sub.agentId, sub.usedTokens, sub.compactions], [`${sid}:${A}`, 4_000, 1]);
    // Rodar de novo dá o mesmo: refaz do zero, não soma.
    await reprocessarContexto({ storage: antigo, raiz: root });
    assert.equal((await antigo.listContextMeters(sid))[0].compactions, 2);
    await antigo.close();
  });
});
