// The chart series (#175/AC-5): one point per sample at 1 h, buckets with the mean at 12 h.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSeries } from '../../src/telemetry/series.ts';
import { iso, point, T0 } from './reading.ts';

const H = 3_600_000;

describe('#175/AC-5 series', () => {
  test('1 h: one point per sample, oldest to newest, only inside the window', () => {
    const pts = [point(T0), point(T0 - 30_000, { cpuUsedPct: null }), point(T0 - 2 * H)];
    const s = buildSeries(pts, T0 - H, T0);
    assert.deepEqual(s.at, [iso(T0 - 30_000), iso(T0)]);
    assert.deepEqual(s.cpuUsedPct, [null, 30]);
    assert.equal(s.memoryUsedBytes.length, 2);
  });

  test('12 h: buckets up to the point ceiling, with the average and nulls left out', () => {
    const pts = Array.from({ length: 12 * 120 }, (_, i) => point(T0 - i * 30_000, { cpuUsedPct: i % 2 ? 10 : 30, gpuUsedPct: null }));
    const s = buildSeries(pts, T0 - 12 * H, T0, 360);
    assert.ok(s.at.length <= 361 && s.at.length >= 359, `pontos: ${s.at.length}`);
    assert.ok(s.cpuUsedPct.every((v) => v === 20 || v === 10 || v === 30));
    assert.ok(s.gpuUsedPct.every((v) => v === null));
  });
});
