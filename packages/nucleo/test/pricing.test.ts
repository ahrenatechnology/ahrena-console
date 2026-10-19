import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { estimateCost, resolvePricing } from '../src/pricing.ts';
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
    assert.deepEqual(c, { estimate: true, priced: false, pattern: null, costUsd: null });
  });
});
