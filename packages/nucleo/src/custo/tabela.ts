// Tabela de preços editável: o padrão do código com as sobrescritas do usuário por cima.
// As sobrescritas são os preços gravados pela porta; o mesmo padrão gravado vence o do código.

import { validateModelPricing, type ModelPricing } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { PRECOS_PADRAO, type PrecoPadrao } from './precos-padrao.ts';

export type OrigemDoPreco = 'padrao' | 'usuario';

export interface LinhaDaTabela extends ModelPricing {
  origem: OrigemDoPreco;
  /** Nome do modelo, quando o padrão vem do código. */
  nome: string | null;
  /** O preço do código que o usuário sobrescreveu, para a tela mostrar e restaurar. */
  padrao: PrecoPadrao | null;
}

type PortaDePrecos = Pick<StoragePort, 'listModelPricing' | 'putModelPricing' | 'deleteModelPricing'>;

/** Junta o padrão e as sobrescritas. `padrao` permite testar com outra tabela. */
export function mesclarPrecos(
  gravados: readonly ModelPricing[],
  padrao: readonly PrecoPadrao[] = PRECOS_PADRAO,
): LinhaDaTabela[] {
  const linhas = new Map<string, LinhaDaTabela>();
  for (const p of padrao) linhas.set(p.pattern, { ...p, origem: 'padrao', padrao: null });
  for (const g of gravados) {
    const base = padrao.find((p) => p.pattern === g.pattern) ?? null;
    linhas.set(g.pattern, { ...g, origem: 'usuario', nome: base?.nome ?? null, padrao: base });
  }
  return [...linhas.values()].sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** A tabela que vale agora, com a origem de cada linha. */
export async function tabelaDePrecos(porta: Pick<StoragePort, 'listModelPricing'>, padrao?: readonly PrecoPadrao[]): Promise<LinhaDaTabela[]> {
  return mesclarPrecos(await porta.listModelPricing(), padrao);
}

/** Só os preços, no formato que `estimateCost` recebe. */
export async function precosVigentes(porta: Pick<StoragePort, 'listModelPricing'>, padrao?: readonly PrecoPadrao[]): Promise<ModelPricing[]> {
  return (await tabelaDePrecos(porta, padrao)).map(({ origem: _o, nome: _n, padrao: _p, ...preco }) => preco);
}

/** Grava a sobrescrita do usuário (nova linha ou troca de um padrão). */
export async function definirPreco(porta: PortaDePrecos, preco: ModelPricing): Promise<void> {
  validateModelPricing(preco);
  await porta.putModelPricing(preco);
}

/**
 * Volta ao padrão do código. Com `pattern`, só aquela linha (uma linha só do usuário é apagada);
 * sem, apaga todas as sobrescritas. Devolve quantas foram apagadas.
 */
export async function restaurarPadrao(porta: PortaDePrecos, pattern?: string): Promise<number> {
  const alvos = pattern === undefined ? (await porta.listModelPricing()).map((p) => p.pattern) : [pattern];
  let apagadas = 0;
  for (const p of alvos) if (await porta.deleteModelPricing(p)) apagadas++;
  return apagadas;
}
