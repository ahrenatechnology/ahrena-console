// Editable price table: the code's defaults with the user's overrides on top.
// The overrides are the prices written through the port; the same pattern written wins over the code's.

import { validateModelPricing, type ModelPricing } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { DEFAULT_PRICES, type DefaultPrice } from './default-prices.ts';

export type PriceOrigin = 'default' | 'user';

export interface PriceTableRow extends ModelPricing {
  origin: PriceOrigin;
  /** The model's name, when the default comes from the code. */
  name: string | null;
  /** The code's price the user overrode, for the screen to show and restore. */
  defaultPrice: DefaultPrice | null;
}

type PricePort = Pick<StoragePort, 'listModelPricing' | 'putModelPricing' | 'deleteModelPricing'>;

/** Merges the defaults and the overrides. `defaults` allows testing with another table. */
export function mergePrices(
  stored: readonly ModelPricing[],
  defaults: readonly DefaultPrice[] = DEFAULT_PRICES,
): PriceTableRow[] {
  const rows = new Map<string, PriceTableRow>();
  for (const p of defaults) rows.set(p.pattern, { ...p, origin: 'default', defaultPrice: null });
  for (const s of stored) {
    const base = defaults.find((p) => p.pattern === s.pattern) ?? null;
    rows.set(s.pattern, { ...s, origin: 'user', name: base?.name ?? null, defaultPrice: base });
  }
  return [...rows.values()].sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** The table in force now, with each row's origin. */
export async function priceTable(port: Pick<StoragePort, 'listModelPricing'>, defaults?: readonly DefaultPrice[]): Promise<PriceTableRow[]> {
  return mergePrices(await port.listModelPricing(), defaults);
}

/** Only the prices, in the shape `estimateCost` takes. */
export async function currentPrices(port: Pick<StoragePort, 'listModelPricing'>, defaults?: readonly DefaultPrice[]): Promise<ModelPricing[]> {
  return (await priceTable(port, defaults)).map(({ origin: _o, name: _n, defaultPrice: _d, ...price }) => price);
}

/** Writes the user's override (a new row or a change to a default). */
export async function setPrice(port: PricePort, price: ModelPricing): Promise<void> {
  validateModelPricing(price);
  await port.putModelPricing(price);
}

/**
 * Goes back to the code's default. With `pattern`, only that row (a user-only row is deleted);
 * without, deletes every override. Returns how many were deleted.
 */
export async function restoreDefault(port: PricePort, pattern?: string): Promise<number> {
  const targets = pattern === undefined ? (await port.listModelPricing()).map((p) => p.pattern) : [pattern];
  let deleted = 0;
  for (const p of targets) if (await port.deleteModelPricing(p)) deleted++;
  return deleted;
}
