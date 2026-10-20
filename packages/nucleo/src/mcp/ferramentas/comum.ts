// A conta como as ferramentas mostram: o rótulo e a cor, nunca o id (que tem os UUIDs da conta
// e da org). O filtro `account` aceita o id, para quem o tiver de outra fonte.

import type { ContaDoPainel } from '../../api/tipos.ts';

export interface ContaDeSaida {
  label: string;
  color: string;
  /** De onde veio a conta (decisão 0006): `env`, `config`, `transcript`, `desktop` ou `profile`. */
  source: string;
}

export function contaDeSaida(c: ContaDoPainel | null): ContaDeSaida | null {
  return c ? { label: c.label, color: c.color, source: c.source } : null;
}

export function linhaDeConta(c: ContaDeSaida | null): string {
  return c?.label ?? 'Sem conta';
}

export function dolares(usd: number | null): string {
  return usd === null ? 'sem preço' : `US$ ${usd.toFixed(2)}`;
}
