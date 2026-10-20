// The chart series built from the samples (#175). At 1 h, each sample is a point (120 at 30 s each);
// at 12 h, the samples become time buckets, with each metric's mean in the bucket, so the response
// stays within `MAX_SERIES_POINTS` points. Gaps (the núcleo was down) are not filled: a bucket with
// no sample is left out.

import { MAX_SERIES_POINTS, type SamplePoint, type TelemetrySeries } from './model.ts';

type Metric = Exclude<keyof TelemetrySeries, 'at'>;
const METRICS: readonly Metric[] = ['cpuUsedPct', 'load1', 'memoryUsedBytes', 'swapUsedBytes', 'rxBytesPerSec', 'txBytesPerSec', 'gpuUsedPct'];

export function emptySeries(): TelemetrySeries {
  return { at: [], cpuUsedPct: [], load1: [], memoryUsedBytes: [], swapUsedBytes: [], rxBytesPerSec: [], txBytesPerSec: [], gpuUsedPct: [] };
}

function mean(values: (number | null)[]): number | null {
  const ns = values.filter((v): v is number => v !== null);
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/**
 * `points` in any order; only those in `(fromMs, toMs]` count (1 h is 120 samples, not 121).
 * Up to `maxPoints`, one point per sample; above that, buckets of `(toMs - fromMs) / maxPoints`,
 * each at the time it starts.
 */
export function buildSeries(points: readonly SamplePoint[], fromMs: number, toMs: number, maxPoints = MAX_SERIES_POINTS): TelemetrySeries {
  const inWindow = points.filter((p) => p.takenAt > fromMs && p.takenAt <= toMs).sort((a, b) => a.takenAt - b.takenAt);
  const s = emptySeries();
  if (inWindow.length <= maxPoints) {
    for (const p of inWindow) {
      s.at.push(new Date(p.takenAt).toISOString());
      for (const m of METRICS) s[m].push(p[m]);
    }
    return s;
  }
  const bucketMs = Math.ceil((toMs - fromMs + 1) / maxPoints);
  const groups = new Map<number, SamplePoint[]>();
  for (const p of inWindow) {
    const i = Math.floor((p.takenAt - fromMs) / bucketMs);
    const g = groups.get(i);
    if (g) g.push(p);
    else groups.set(i, [p]);
  }
  for (const [i, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    s.at.push(new Date(fromMs + i * bucketMs).toISOString());
    for (const m of METRICS) s[m].push(mean(g.map((p) => p[m])));
  }
  return s;
}
