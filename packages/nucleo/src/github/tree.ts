// Montagem da árvore no núcleo, a partir de nós rasos (cada issue traz só a chave do pai).
// Nada aqui chama o GitHub: são funções puras sobre o que já veio.

import { levelOf, type WorkDetail, type WorkLevel, type WorkNode, type WorkTreeNode } from './work.ts';

/** Mescla nós num mapa por chave; o `updatedAt` mais novo vence. */
export function mergeNodes(into: ReadonlyMap<string, WorkNode>, nodes: Iterable<WorkNode>): Map<string, WorkNode> {
  const out = new Map(into);
  for (const n of nodes) {
    const old = out.get(n.key);
    if (!old || n.updatedAt >= old.updatedAt) out.set(n.key, n);
  }
  return out;
}

/** Pais citados que não estão no mapa: entram numa consulta por lote. */
export function missingParents(nodes: ReadonlyMap<string, WorkNode>): string[] {
  const miss = new Set<string>();
  for (const n of nodes.values()) if (n.parent && !nodes.has(n.parent)) miss.add(n.parent);
  return [...miss];
}

const levelRank = (l: WorkLevel): number => ['initiative', 'epic', 'item', 'plan'].indexOf(l);

export interface BuildTreeInput {
  nodes: ReadonlyMap<string, WorkNode>;
  /** Cards expandidos cujas filhas já vieram. */
  loaded?: ReadonlySet<string>;
  details?: ReadonlyMap<string, WorkDetail>;
}

/**
 * Árvore iniciativa → épico → item → plano. Raiz é quem não tem pai, ou cujo pai não
 * veio. Irmãos em ordem de nível e depois de número. Ciclos (não deveriam existir no
 * GitHub) viram raiz em vez de laço infinito.
 */
export function buildTree({ nodes, loaded = new Set(), details = new Map() }: BuildTreeInput): WorkTreeNode[] {
  const childrenOf = new Map<string, WorkNode[]>();
  const roots: WorkNode[] = [];
  for (const n of nodes.values()) {
    if (n.parent && nodes.has(n.parent) && !reachesSelf(nodes, n)) {
      const list = childrenOf.get(n.parent) ?? [];
      list.push(n);
      childrenOf.set(n.parent, list);
    } else roots.push(n);
  }

  const build = (n: WorkNode, parentLevel: WorkLevel | null): WorkTreeNode => {
    const level = levelOf(n.type, parentLevel);
    const children = sortSiblings((childrenOf.get(n.key) ?? []).map((c) => build(c, level)));
    return { ...n, level, childrenLoaded: loaded.has(n.key), detail: details.get(n.key) ?? null, children };
  };
  return sortSiblings(roots.map((r) => build(r, null)));
}

function reachesSelf(nodes: ReadonlyMap<string, WorkNode>, start: WorkNode): boolean {
  const seen = new Set<string>([start.key]);
  let p = start.parent;
  while (p) {
    if (seen.has(p)) return p === start.key;
    seen.add(p);
    p = nodes.get(p)?.parent ?? null;
  }
  return false;
}

function sortSiblings(list: WorkTreeNode[]): WorkTreeNode[] {
  return list.sort((a, b) => levelRank(a.level) - levelRank(b.level) || a.repo.localeCompare(b.repo) || a.number - b.number);
}

export function countTree(roots: readonly WorkTreeNode[]): number {
  return roots.reduce((n, r) => n + 1 + countTree(r.children), 0);
}

export function findInTree(roots: readonly WorkTreeNode[], key: string): WorkTreeNode | null {
  for (const r of roots) {
    if (r.key === key) return r;
    const hit = findInTree(r.children, key);
    if (hit) return hit;
  }
  return null;
}

/** Filtro de data da busca do GitHub: UTC, sem milissegundos. */
export const deltaQuery = (filter: string, since: number): string =>
  `${filter} updated:>=${new Date(since).toISOString().slice(0, 19)}Z`;

/** Tira `is:open`/`state:open` do filtro: o delta precisa ver o que fechou. */
export function withoutOpenQualifier(filter: string): { filter: string; onlyOpen: boolean } {
  const re = /(^|\s)(is|state):open(?=\s|$)/gi;
  const onlyOpen = re.test(filter);
  return { filter: filter.replace(re, ' ').replace(/\s+/g, ' ').trim(), onlyOpen };
}
