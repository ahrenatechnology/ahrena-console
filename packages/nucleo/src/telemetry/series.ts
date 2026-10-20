// As séries dos gráficos a partir das amostras (#175). Em 1 h, cada amostra é um ponto (120 a cada
// 30 s); em 12 h, as amostras viram baldes de tempo, com a média de cada métrica no balde, para a
// resposta não passar de `MAX_SERIES_POINTS` pontos. Buraco (o núcleo parado) não é preenchido: o
// balde sem amostra não entra.

import { MAX_SERIES_POINTS, type SamplePoint, type TelemetrySeries } from './model.ts';

type Metrica = Exclude<keyof TelemetrySeries, 'at'>;
const METRICAS: readonly Metrica[] = ['cpuUsedPct', 'load1', 'memoryUsedBytes', 'swapUsedBytes', 'rxBytesPerSec', 'txBytesPerSec', 'gpuUsedPct'];

export function emptySeries(): TelemetrySeries {
  return { at: [], cpuUsedPct: [], load1: [], memoryUsedBytes: [], swapUsedBytes: [], rxBytesPerSec: [], txBytesPerSec: [], gpuUsedPct: [] };
}

function media(valores: (number | null)[]): number | null {
  const ns = valores.filter((v): v is number => v !== null);
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/**
 * `points` em qualquer ordem; só entram os de `(fromMs, toMs]` (1 h são 120 amostras, não 121).
 * Com até `maxPoints`, um ponto por amostra; acima disso, baldes de `(toMs - fromMs) / maxPoints`,
 * cada um na hora do seu começo.
 */
export function buildSeries(points: readonly SamplePoint[], fromMs: number, toMs: number, maxPoints = MAX_SERIES_POINTS): TelemetrySeries {
  const dentro = points.filter((p) => p.takenAt > fromMs && p.takenAt <= toMs).sort((a, b) => a.takenAt - b.takenAt);
  const s = emptySeries();
  if (dentro.length <= maxPoints) {
    for (const p of dentro) {
      s.at.push(new Date(p.takenAt).toISOString());
      for (const m of METRICAS) s[m].push(p[m]);
    }
    return s;
  }
  const balde = Math.ceil((toMs - fromMs + 1) / maxPoints);
  const grupos = new Map<number, SamplePoint[]>();
  for (const p of dentro) {
    const i = Math.floor((p.takenAt - fromMs) / balde);
    const g = grupos.get(i);
    if (g) g.push(p);
    else grupos.set(i, [p]);
  }
  for (const [i, g] of [...grupos].sort((a, b) => a[0] - b[0])) {
    s.at.push(new Date(fromMs + i * balde).toISOString());
    for (const m of METRICAS) s[m].push(media(g.map((p) => p[m])));
  }
  return s;
}
