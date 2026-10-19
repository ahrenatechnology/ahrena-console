// Porta da fonte do trabalho (decisão 0001, "Como se encaixa nas portas"). O adaptador
// local chama o GitHub; o remoto (7.9) vai ler do hub. Quem monta a árvore depende só disto.

import type { WorkDetail, WorkNode } from './work.ts';

export interface ChildrenResult {
  children: WorkNode[];
  /** PR, CI e review de cada filha, que vêm na mesma consulta. */
  details: WorkDetail[];
}

export interface WorkSource {
  /** Leitura rasa: issues do filtro (busca do GitHub) com a chave do pai e o resumo das filhas. `since` faz o delta. */
  listShallow(filter: string, since?: number): Promise<WorkNode[]>;
  /** Issues pelas chaves, numa consulta só, com os pais delas até a raiz. Para os pais que não vieram na busca. */
  nodes(keys: readonly string[]): Promise<WorkNode[]>;
  /** Filhas de um card, ao expandir. */
  children(key: string): Promise<ChildrenResult>;
  /** PR, CI e review de um card. */
  detail(key: string): Promise<WorkDetail>;
}
