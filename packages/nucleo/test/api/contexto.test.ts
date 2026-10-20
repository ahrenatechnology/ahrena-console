// O contexto da sessão depois de compactar: o uso de antes (o pico) não vale, e a janela longa
// continua a mesma. Eventos sintéticos.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextoDe } from '../../src/api/painel.ts';
import { aplicarEvento, resumoVazio } from '../../src/api/resumo.ts';
import { at, event } from '../fixtures.ts';

const S = 'sess-contexto';
const resposta = (minuto: number, contexto: number) =>
  event({
    sessionId: S, agentId: `${S}:main`, type: 'AssistantMessage', toolName: null, createdAt: at(minuto),
    data: { usage: { tokens: { input: 1_000, output: 500, cacheRead: contexto - 1_500, cacheWrite5m: 0, cacheWrite1h: 0 } } },
  });
const compactou = (minuto: number) => event({ sessionId: S, agentId: `${S}:main`, type: 'Compaction', toolName: null, createdAt: at(minuto), data: { subtype: 'compact_boundary' } });
const sessao = { metadata: {}, model: 'claude-opus-5-5' };

test('compactar derruba o contexto: sem o pico até a próxima resposta, e depois o uso novo, na mesma janela de 1M', () => {
  const r = resumoVazio();
  aplicarEvento(r, resposta(1, 852_000));
  assert.equal(contextoDe(sessao, r)?.pct, 85);
  aplicarEvento(r, compactou(2));
  // Logo depois do /compact: desconhecido (o painel usa a fonte do engine), nunca os 85% de antes.
  assert.equal(contextoDe(sessao, r), null);
  aplicarEvento(r, resposta(3, 105_000));
  const depois = contextoDe(sessao, r)!;
  // 105 mil na janela de 1M: 11%, e não 53% de uma janela de 200 mil.
  assert.equal(depois.limit, 1_000_000);
  assert.equal(depois.pct, 11);
});

test('sessão que nunca passou de 200 mil continua na janela padrão', () => {
  const r = resumoVazio();
  aplicarEvento(r, resposta(1, 150_000));
  assert.equal(contextoDe(sessao, r)?.limit, 200_000);
  assert.equal(contextoDe({ metadata: {}, model: 'claude-sonnet-4-6[1m]' }, r)?.limit, 1_000_000);
});
