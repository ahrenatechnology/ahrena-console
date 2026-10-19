// O que o painel e o MCP usam: a árvore do trabalho, montada no núcleo a partir da
// leitura rasa, com filhas, PR, CI e review dos cards expandidos. Segue a decisão 0001:
// - leitura inicial rasa (custo 1) + pais que faltam num lote (custo 1);
// - filhas e detalhe só ao expandir;
// - delta `updated:>=` a cada 60 s enquanto alguém pede a árvore;
// - tudo pelo cache (TTL, leitura velha, uma chamada por chave), em série;
// - escrita do console atualiza o cache na hora (`patchNode`).

import { DELTA_INTERVAL_MS, GITHUB_TTL, NoDataError, type GithubCache } from './cache.ts';
import type { ChildrenResult, WorkSource } from './source.ts';
import { buildTree, countTree, findInTree, mergeNodes, missingParents, withoutOpenQualifier } from './tree.ts';
import type { WorkDetail, WorkNode, WorkTree, WorkTreeNode } from './work.ts';

/** Folga do delta: relê um pouco antes da última leitura, contra relógio fora de sincronia. */
export const DELTA_OVERLAP_MS = 30_000;

/** Lotes de pais no máximo por leitura: iniciativa → épico → item → plano cabe em um. */
export const MAX_PARENT_ROUNDS = 2;

export interface IssuesValue {
  nodes: WorkNode[];
  /** Início da última leitura (inteira ou delta), em ms; o próximo delta parte daqui. */
  readAt: number;
}

export interface DeltaValue {
  readAt: number;
  changed: number;
}

export interface GithubWorkOptions {
  source: WorkSource;
  cache: GithubCache;
  /** Busca do GitHub, ex.: `repo:dono/repo is:issue is:open`. */
  filter: string;
  now?: () => number;
  deltaIntervalMs?: number;
}

export interface TreeOptions {
  /** Botão de atualizar: relê, respeitando o intervalo mínimo de 30 s. */
  force?: boolean;
}

export const cacheKeys = {
  issues: (filter: string) => `github:issues:${filter}`,
  delta: (filter: string) => `github:delta:${filter}`,
  children: (key: string) => `github:children:${key}`,
  detail: (key: string) => `github:detail:${key}`,
};

export class GithubWork {
  readonly filter: string;
  private readonly source: WorkSource;
  private readonly cache: GithubCache;
  private readonly now: () => number;
  private readonly deltaIntervalMs: number;
  private readonly expanded = new Set<string>();

  constructor({ source, cache, filter, now = Date.now, deltaIntervalMs = DELTA_INTERVAL_MS }: GithubWorkOptions) {
    this.source = source;
    this.cache = cache;
    this.filter = filter;
    this.now = now;
    this.deltaIntervalMs = deltaIntervalMs;
  }

  /** Cards abertos, cujas filhas e detalhe entram na árvore. */
  get expandedKeys(): string[] {
    return [...this.expanded];
  }

  /** A árvore inteira. Sem nada no cache e com o GitHub fora, lança `NoDataError`. */
  async tree({ force = false }: TreeOptions = {}): Promise<WorkTree> {
    const reasons: string[] = [];
    const issuesKey = cacheKeys.issues(this.filter);
    const list = await this.cache.get<IssuesValue>(issuesKey, GITHUB_TTL.issues, async () => ({ value: await this.loadAll() }), { force });
    if (list.stale) reasons.push(list.staleReason ?? 'dado velho');
    let issues = list.value;

    if (!list.stale) {
      try {
        const d = await this.cache.get<DeltaValue>(cacheKeys.delta(this.filter), this.deltaIntervalMs, async () => ({ value: await this.applyDelta() }));
        if (d.stale) reasons.push(`delta: ${d.staleReason}`);
        issues = (await this.cache.peek<IssuesValue>(issuesKey))?.value ?? issues;
      } catch (err) {
        reasons.push(`delta: ${message(err)}`);
      }
    }

    let nodes = new Map(issues.nodes.map((n) => [n.key, n]));
    const loaded = new Set<string>();
    const details = new Map<string, WorkDetail>();
    // Em série: a decisão proíbe consultas paralelas ao GitHub.
    for (const key of this.expanded) {
      try {
        const ch = await this.cache.get<ChildrenResult>(cacheKeys.children(key), GITHUB_TTL.children, async () => ({ value: await this.source.children(key) }), { force });
        if (ch.stale) reasons.push(`filhas de ${key}: ${ch.staleReason}`);
        nodes = mergeNodes(nodes, ch.value.children);
        for (const d of ch.value.details) if (!details.has(d.key)) details.set(d.key, d);
        loaded.add(key);
      } catch (err) {
        reasons.push(`filhas de ${key}: ${message(err)}`);
      }
      try {
        const det = await this.detail(key, { force });
        details.set(key, det);
      } catch (err) {
        reasons.push(`detalhe de ${key}: ${message(err)}`);
      }
    }

    const roots = buildTree({ nodes, loaded, details });
    return {
      roots,
      count: countTree(roots),
      fetchedAt: issues.readAt,
      stale: reasons.length > 0,
      staleReason: reasons.length ? reasons.join('; ') : null,
    };
  }

  /** Abre um card: busca filhas e detalhe (se não estiverem no cache) e devolve o nó com elas. */
  async expand(key: string): Promise<WorkTreeNode | null> {
    this.expanded.add(key);
    return findInTree((await this.tree()).roots, key);
  }

  collapse(key: string): void {
    this.expanded.delete(key);
  }

  /** PR, CI e review de um card (TTL de 60 s). */
  async detail(key: string, { force = false }: TreeOptions = {}): Promise<WorkDetail> {
    const r = await this.cache.get<WorkDetail>(cacheKeys.detail(key), GITHUB_TTL.detail, async () => ({ value: await this.source.detail(key) }), { force });
    return r.value;
  }

  /**
   * Escrita do próprio console: aplica a mudança no nó guardado, na lista e nas filhas
   * dos cards abertos, sem reler o GitHub. Devolve `false` se o nó não estava no cache.
   */
  async patchNode(key: string, update: (node: WorkNode) => WorkNode): Promise<boolean> {
    let found = false;
    const apply = (nodes: WorkNode[]) =>
      nodes.map((n) => {
        if (n.key !== key) return n;
        found = true;
        return update(n);
      });
    await this.cache.patch<IssuesValue>(cacheKeys.issues(this.filter), (v) => ({ ...v, nodes: apply(v.nodes) }));
    for (const parent of this.expanded) await this.cache.patch<ChildrenResult>(cacheKeys.children(parent), (v) => ({ ...v, children: apply(v.children) }));
    return found;
  }

  /** Leitura inteira: busca rasa e, numa consulta só, os pais que não vieram nela. */
  private async loadAll(): Promise<IssuesValue> {
    const readAt = this.now();
    const nodes = await this.withParents(new Map((await this.source.listShallow(this.filter)).map((n) => [n.key, n])));
    // O delta conta a partir daqui; a primeira leitura não dispara um delta logo em seguida.
    await this.cache.put<DeltaValue>(cacheKeys.delta(this.filter), { readAt, changed: 0 });
    return { nodes: [...nodes.values()], readAt };
  }

  /**
   * Pais citados que não vieram: um lote só, que já traz os avós. Só uma árvore mais funda
   * que isso pede outro lote, até `MAX_PARENT_ROUNDS`.
   */
  private async withParents(nodes: Map<string, WorkNode>): Promise<Map<string, WorkNode>> {
    for (let round = 0; round < MAX_PARENT_ROUNDS; round++) {
      const miss = missingParents(nodes);
      if (!miss.length) break;
      const before = nodes.size;
      nodes = mergeNodes(nodes, await this.source.nodes(miss));
      if (nodes.size === before) break;
    }
    return nodes;
  }

  /** Delta: o que mudou desde a última leitura, mesclado no cache da lista e das filhas abertas. */
  private async applyDelta(): Promise<DeltaValue> {
    const issuesKey = cacheKeys.issues(this.filter);
    const cur = await this.cache.peek<IssuesValue>(issuesKey);
    if (!cur) throw new NoDataError('sem lista para aplicar o delta');
    const readAt = this.now();
    const { filter, onlyOpen } = withoutOpenQualifier(this.filter);
    const changed = await this.source.listShallow(filter, cur.value.readAt - DELTA_OVERLAP_MS);

    const before = new Map(cur.value.nodes.map((n) => [n.key, n]));
    let nodes = mergeNodes(before, changed);
    const isParent = (key: string) => [...nodes.values()].some((n) => n.parent === key);
    for (const c of changed) {
      // Fechou e a lista é só de abertas: sai, a menos que ainda seja pai de alguém da lista.
      if (onlyOpen && c.state === 'CLOSED' && !isParent(c.key)) nodes.delete(c.key);
      const old = before.get(c.key);
      if (old && old.parent !== c.parent) {
        // Mudou de pai: as filhas dos dois pais se refazem na próxima expansão.
        if (old.parent) await this.cache.invalidate(cacheKeys.children(old.parent));
        if (c.parent) await this.cache.invalidate(cacheKeys.children(c.parent));
      }
    }
    for (const parent of this.expanded) {
      await this.cache.patch<ChildrenResult>(cacheKeys.children(parent), (v) => ({ ...v, children: [...mergeNodes(new Map(v.children.map((n) => [n.key, n])), changed.filter((c) => v.children.some((n) => n.key === c.key))).values()] }));
    }
    nodes = await this.withParents(nodes);

    await this.cache.patch<IssuesValue>(issuesKey, () => ({ nodes: [...nodes.values()], readAt }));
    return { readAt, changed: changed.length };
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
