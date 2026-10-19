import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LONG_CONTEXT, contextSizeFor, estimateCost, resolvePricing } from '../src/pricing.ts';
import { pricing, usage } from './fixtures.ts';

describe('preço', () => {
  const geral = pricing({ pattern: 'claude-%', inputPerMTok: 1 });
  const opus = pricing({ pattern: 'claude-opus-5%' });
  const opus55 = pricing({ pattern: 'claude-opus-5-5', inputPerMTok: 7 });

  test('vale o padrão mais longo que casa', () => {
    assert.equal(resolvePricing('claude-opus-5-5', [geral, opus, opus55])?.pattern, 'claude-opus-5-5');
    assert.equal(resolvePricing('claude-opus-5-1', [geral, opus, opus55])?.pattern, 'claude-opus-5%');
    assert.equal(resolvePricing('claude-haiku-5-5', [geral, opus, opus55])?.pattern, 'claude-%');
  });

  test('padrão é LIKE: % e _ são curingas, o resto é literal', () => {
    assert.equal(resolvePricing('claude-opus-5-5', [pricing({ pattern: 'claude_opus%' })])?.pattern, 'claude_opus%');
    assert.equal(resolvePricing('claudeXopus', [pricing({ pattern: 'claude.opus' })]), null);
  });

  test('sem padrão que case, devolve null', () => {
    assert.equal(resolvePricing('gpt-5', [geral, opus]), null);
  });
});

describe('custo estimado', () => {
  test('soma os buckets, com cache de 5 min e 1 h pelos multiplicadores padrão', () => {
    // input 10, output 50 por MTok; cache read 1, write 5m 12,5, write 1h 20.
    const c = estimateCost(usage(), [pricing()]);
    assert.equal(c.priced, true);
    assert.equal(c.estimate, true);
    const esperado = (1000 * 10 + 500 * 50 + 20_000 * 1 + 3000 * 12.5 + 4000 * 20) / 1e6;
    assert.ok(Math.abs((c.costUsd ?? NaN) - esperado) < 1e-12);
  });

  test('preço de cache explícito vence o multiplicador', () => {
    const u = usage({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 1_000_000 } });
    assert.equal(estimateCost(u, [pricing({ cacheWrite1hPerMTok: 15 })]).costUsd, 15);
    assert.equal(estimateCost(u, [pricing()]).costUsd, 20);
  });

  test('conta o piso da compactação', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const u = usage({ tokens: zero, baseline: { ...zero, output: 1_000_000 } });
    assert.equal(estimateCost(u, [pricing()]).costUsd, 50);
  });

  test('modelo sem preço é "sem preço", não custo zero', () => {
    const c = estimateCost(usage({ model: 'modelo-novo' }), [pricing()]);
    assert.deepEqual(c, { estimate: true, priced: false, pattern: null, costUsd: null, reason: 'model' });
  });
});

describe('modificadores de preço', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const milhaoDeInput = usage({ tokens: { ...zero, input: 1_000_000 } });
  const p = [pricing()]; // input 10 por MTok

  test('batch custa metade', () => {
    assert.equal(estimateCost({ ...milhaoDeInput, serviceTier: 'batch' }, p).costUsd, 5);
  });

  test('inferência nos EUA custa 1,1x, inclusive o cache', () => {
    const u = usage({ inferenceGeo: 'us', tokens: { ...zero, input: 1_000_000, cacheRead: 1_000_000 } });
    assert.ok(Math.abs((estimateCost(u, p).costUsd ?? NaN) - 11 * 1.1) < 1e-9);
  });

  test('fast custa 2x no Opus 5.5 e fica "sem preço" em modelo sem preço de fast', () => {
    assert.equal(estimateCost({ ...milhaoDeInput, speed: 'fast' }, p).costUsd, 20);
    const c = estimateCost({ ...milhaoDeInput, model: 'claude-opus-5-1', speed: 'fast' }, p);
    assert.equal(c.priced, false);
    assert.equal(c.costUsd, null);
    assert.equal(c.priced ? null : c.reason, 'fast');
    assert.equal(c.pattern, 'claude-opus-5%');
  });

  test('modificadores se acumulam', () => {
    const u = { ...milhaoDeInput, speed: 'fast', inferenceGeo: 'us', serviceTier: 'batch' };
    assert.ok(Math.abs((estimateCost(u, p).costUsd ?? NaN) - 10 * 2 * 1.1 * 0.5) < 1e-9);
  });

  test('contexto longo do Haiku 5.5 custa 5x', () => {
    const haiku = [pricing({ pattern: 'claude-haiku-5-5', inputPerMTok: 0.1 })];
    const u = { ...milhaoDeInput, model: 'claude-haiku-5-5' };
    assert.ok(Math.abs((estimateCost({ ...u, contextSize: LONG_CONTEXT }, haiku).costUsd ?? NaN) - 0.5) < 1e-12);
    assert.ok(Math.abs((estimateCost(u, haiku).costUsd ?? NaN) - 0.1) < 1e-12);
  });

  test('faixa de contexto pelo tamanho do prompt, só nos modelos que têm faixa', () => {
    const grande = { ...zero, input: 10, cacheRead: 100_000 };
    assert.equal(contextSizeFor('claude-haiku-5-5', grande), LONG_CONTEXT);
    assert.equal(contextSizeFor('claude-haiku-5-5', { ...zero, cacheRead: 100_000 }), '');
    assert.equal(contextSizeFor('claude-opus-5-5', grande), '');
  });

  test('busca na web custa US$ 10 por mil, sem os modificadores de token', () => {
    const u = usage({ tokens: zero, webSearchRequests: 3, serviceTier: 'batch' });
    assert.ok(Math.abs((estimateCost(u, p).costUsd ?? NaN) - 0.03) < 1e-12);
  });
});
