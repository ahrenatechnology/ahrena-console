// Account colors, from the brand palette. Orange and red are kept for status.

import { paleta } from '../../../marca/gerado/marca.ts';

/** Colors for accounts without one of their own, in the order they are handed out. */
export const ACCOUNT_COLORS: readonly string[] = [paleta.rose['500'], paleta.yellow['500'], paleta.gray['200']];

/** The first color no account uses; with all of them in use, the least repeated one. */
export function freeColor(used: readonly (string | null)[]): string {
  const counts = new Map(ACCOUNT_COLORS.map((c) => [c, 0]));
  for (const c of used) if (c && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  let best = ACCOUNT_COLORS[0];
  for (const c of ACCOUNT_COLORS) if (counts.get(c)! < counts.get(best)!) best = c;
  return best;
}

/** The green accounts used to get; accounts that still carry it are given a current color when read (#699). */
const RETIRED_ACCOUNT_COLOR = '#1baf7a';

/** A stored color as it leaves the core: the retired green becomes what `freeColor` gives over the other accounts' colors. */
export function resolveStoredColor(stored: string | null | undefined, others: readonly (string | null)[]): string | null {
  if (!stored) return null;
  return stored.toLowerCase() === RETIRED_ACCOUNT_COLOR ? freeColor(others) : stored;
}
