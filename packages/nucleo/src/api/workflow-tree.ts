// The tree between sessions (#332, C83) and the period of the Workflows page (C84).
//
// Who opened whom comes only from the Claude Desktop index (`spawnedFrom`, read by DesktopIndex): no tie is guessed from
// a name or a time. A session whose parent is not in the period is a root, marked `parentOutsidePeriod`, so the tree never
// hangs from a session the page does not show. A session that is `active` is always in, whatever the period.

import type { Session } from '../model.ts';

export const WORKFLOW_PERIODS = ['24h', '7d', '30d', 'all'] as const;
export type WorkflowPeriod = (typeof WORKFLOW_PERIODS)[number];
export const DEFAULT_WORKFLOW_PERIOD: WorkflowPeriod = '30d';
export const TREE_PAGE_SIZE = 50;

const PERIOD_MS: Record<Exclude<WorkflowPeriod, 'all'>, number> = { '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000, '30d': 30 * 24 * 3_600_000 };

/** The start of the period as an ISO time, or `null` for `all`. The period filters by the session's last event. */
export function periodStart(period: WorkflowPeriod, now: number): string | null {
  return period === 'all' ? null : new Date(now - PERIOD_MS[period]).toISOString();
}

/** What the tree needs from the Desktop index. */
export interface SessionLineage {
  /** The cli session id of the session that opened this one, when the index knows both. */
  parentOf(cliSessionId: string): { parentCliId: string | null; parentKnown: boolean } | null;
}

export interface TreeSession {
  id: string;
  name: string | null;
  status: Session['status'];
  startedAt: string;
  updatedAt: string;
}

export interface SessionTreeNode {
  sessionId: string;
  name: string | null;
  status: Session['status'];
  /** `root` has no parent in the page's set; `child` was opened by another session. */
  kind: 'root' | 'child';
  /** The parent is known to the Desktop but is not in the period: shown as "pai fora do período". */
  parentOutsidePeriod: boolean;
  outsidePeriod: boolean;
  startedAt: string;
  updatedAt: string;
  children: SessionTreeNode[];
}

export interface SessionTree {
  root: SessionTreeNode;
  /** The most recent activity in the whole tree; trees are ordered by it. */
  lastActivityAt: string;
  sessions: number;
}

/** Builds the forest of the sessions in scope. `outside` holds the active sessions older than the period. */
export function buildSessionTrees(sessions: readonly TreeSession[], lineage: SessionLineage | null, outside: ReadonlySet<string> = new Set()): SessionTree[] {
  const inScope = new Map(sessions.map((s) => [s.id, s]));
  const nodes = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    nodes.set(s.id, {
      sessionId: s.id, name: s.name, status: s.status, kind: 'root', parentOutsidePeriod: false, outsidePeriod: outside.has(s.id),
      startedAt: s.startedAt, updatedAt: s.updatedAt, children: [],
    });
  }
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    const id = lineage?.parentOf(s.id)?.parentCliId;
    if (id && id !== s.id && nodes.has(id)) parentOf.set(s.id, id);
  }
  // A cycle in the index would hang the tree off itself: the tie that closes it is dropped.
  for (const s of sessions) {
    const seen = new Set([s.id]);
    for (let p = parentOf.get(s.id); p; p = parentOf.get(p)) {
      if (seen.has(p)) {
        parentOf.delete(s.id);
        break;
      }
      seen.add(p);
    }
  }
  const roots: SessionTreeNode[] = [];
  for (const s of sessions) {
    const node = nodes.get(s.id)!;
    const parent = nodes.get(parentOf.get(s.id) ?? '');
    if (parent) {
      node.kind = 'child';
      parent.children.push(node);
    } else {
      const link = lineage?.parentOf(s.id) ?? null;
      node.parentOutsidePeriod = !!link?.parentKnown && !inScope.has(link.parentCliId ?? '');
      roots.push(node);
    }
  }
  const byStart = (a: SessionTreeNode, b: SessionTreeNode) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId);
  const sortDeep = (n: SessionTreeNode) => {
    n.children.sort(byStart);
    n.children.forEach(sortDeep);
  };
  const walk = (n: SessionTreeNode): { last: string; count: number } =>
    n.children.reduce((acc, c) => {
      const r = walk(c);
      return { last: r.last > acc.last ? r.last : acc.last, count: acc.count + r.count };
    }, { last: n.updatedAt, count: 1 });
  return roots
    .map((root) => {
      sortDeep(root);
      const { last, count } = walk(root);
      return { root, lastActivityAt: last, sessions: count };
    })
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.root.sessionId.localeCompare(b.root.sessionId));
}

/** One page of trees, by an offset cursor; `limit` is at most `TREE_PAGE_SIZE`. */
export function pageOfTrees<T>(trees: readonly T[], cursor: string | null, limit = TREE_PAGE_SIZE): { items: T[]; total: number; nextCursor: string | null } | null {
  let offset = 0;
  if (cursor !== null) {
    if (!/^[0-9]{1,9}$/.test(cursor)) return null;
    offset = Number(cursor);
  }
  const size = Math.min(Math.max(1, limit), TREE_PAGE_SIZE);
  const end = offset + size;
  return { items: trees.slice(offset, end), total: trees.length, nextCursor: end < trees.length ? String(end) : null };
}
