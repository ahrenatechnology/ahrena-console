// Árvore iniciativa → épico → item a partir de nós rasos: cada issue traz só a chave
// do pai e o resumo das filhas. Nada de consulta aninhada; as filhas chegam quando o
// card é expandido, e as mudanças chegam por delta (updated:>=última leitura).

export const keyOf = (n) => `${n.repository.nameWithOwner}#${n.number}`;

export function toNode(raw) {
  return {
    key: keyOf(raw), number: raw.number, title: raw.title, state: raw.state, updatedAt: raw.updatedAt,
    type: raw.issueType?.name ?? null,
    parent: raw.parent ? keyOf({ ...raw.parent, repository: raw.parent.repository ?? raw.repository }) : null,
    childCount: raw.subIssuesSummary?.total ?? 0,
    childrenLoaded: false,
  };
}

// Mescla nós novos no mapa; o mais recente (updatedAt) vence.
export function merge(nodes, raws) {
  const out = new Map(nodes);
  for (const raw of raws) {
    const n = toNode(raw);
    const old = out.get(n.key);
    if (!old || Date.parse(n.updatedAt) >= Date.parse(old.updatedAt)) out.set(n.key, { ...n, childrenLoaded: old?.childrenLoaded ?? false });
  }
  return out;
}

// Ao expandir: grava as filhas e marca o pai como carregado.
export function mergeChildren(nodes, parentKey, raws) {
  const out = merge(nodes, raws.map((r) => ({ ...r, parent: r.parent ?? { number: Number(parentKey.split('#')[1]), repository: { nameWithOwner: parentKey.split('#')[0] } } })));
  const p = out.get(parentKey);
  if (p) out.set(parentKey, { ...p, childrenLoaded: true });
  return out;
}

// Pais citados que ainda não estão no mapa: buscar só esses, numa consulta por lote.
export function missingParents(nodes) {
  const miss = new Set();
  for (const n of nodes.values()) if (n.parent && !nodes.has(n.parent)) miss.add(n.parent);
  return [...miss];
}

export function tree(nodes) {
  const children = new Map();
  const roots = [];
  for (const n of nodes.values()) {
    if (n.parent && nodes.has(n.parent)) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n.key);
    } else roots.push(n.key);
  }
  return { roots, children };
}

// Busca incremental: o filtro de data da busca do GitHub, em UTC e sem milissegundos.
export const deltaQuery = (base, since) => `${base} updated:>=${new Date(since).toISOString().slice(0, 19)}Z`;
