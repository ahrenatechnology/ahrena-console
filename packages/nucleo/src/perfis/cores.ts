// Cores das contas, da paleta da marca. Laranja e vermelho ficam para status.

import { paleta } from '../../../marca/gerado/marca.ts';

/** Cores das contas sem cor própria, na ordem em que são dadas. */
export const CORES_DAS_CONTAS: readonly string[] = [paleta.rose['500'], paleta.green['500'], paleta.yellow['500'], paleta.gray['200']];

/** A primeira cor que nenhuma conta usa; com todas em uso, a que se repete menos. */
export function corLivre(usadas: readonly (string | null)[]): string {
  const vezes = new Map(CORES_DAS_CONTAS.map((c) => [c, 0]));
  for (const c of usadas) if (c && vezes.has(c)) vezes.set(c, vezes.get(c)! + 1);
  let melhor = CORES_DAS_CONTAS[0];
  for (const c of CORES_DAS_CONTAS) if (vezes.get(c)! < vezes.get(melhor)!) melhor = c;
  return melhor;
}
