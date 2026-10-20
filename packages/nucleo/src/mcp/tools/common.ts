// The account as the tools show it: the label and the color, never the id (which carries the
// account and org UUIDs). The `account` filter takes the id, for whoever has it from another source.

import type { ContaDoPainel } from '../../api/tipos.ts';

export interface OutputAccount {
  label: string;
  color: string;
  /** Where the account came from (decision 0006): `env`, `config`, `transcript`, `desktop` or `profile`. */
  source: string;
}

export function outputAccount(c: ContaDoPainel | null): OutputAccount | null {
  return c ? { label: c.label, color: c.color, source: c.source } : null;
}

export function accountLabel(c: OutputAccount | null): string {
  return c?.label ?? 'Sem conta';
}

export function dollars(usd: number | null): string {
  return usd === null ? 'sem preço' : `US$ ${usd.toFixed(2)}`;
}
