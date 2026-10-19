// Piso depois da compactação: o total efetivo (`tokens + baseline`) de um bucket nunca diminui.
//
// Quando a contagem viva cai (compactação, transcript reescrito menor), o que sumiu vira piso:
// `baseline' = baseline + (vivo_antigo − vivo_novo)`. Enquanto a contagem só cresce, o piso fica como está.
// É a regra de high-water mark do Agent Monitor (benchmark interno do Agent Monitor), aplicada
// só na queda; aplicada a cada leitura, ela descontaria do piso o que o vivo voltou a crescer.

import { emptyTokenCounts, type TokenCounts, type TokenUsage } from '../model.ts';

const CHAVES = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

/** Piso novo do bucket, dado o gravado antes (ou nada) e a contagem viva nova. Vale por categoria de token. */
export function aplicarPiso(anterior: Pick<TokenUsage, 'tokens' | 'baseline'> | null | undefined, vivo: TokenCounts): TokenCounts {
  const piso = emptyTokenCounts();
  if (!anterior) return piso;
  for (const k of CHAVES) {
    piso[k] = anterior.baseline[k] + Math.max(anterior.tokens[k] - vivo[k], 0);
  }
  return piso;
}
