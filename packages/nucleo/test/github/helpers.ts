// Apoio dos testes do GitHub: respostas gravadas (fixtures), relógio controlado e uma
// fonte falsa que conta chamadas.

import { readFileSync } from 'node:fs';
import type { ChildrenResult, WorkDetail, WorkNode, WorkSource } from '../../src/index.ts';

export const REPO = 'ahrenatechnology/ahrena-console';
export const FILTER = `repo:${REPO} is:issue is:open`;
export const k = (n: number) => `${REPO}#${n}`;

export interface Recorded {
  operation: string;
  variables: Record<string, unknown>;
  status: number;
  body: { data?: Record<string, unknown> & { rateLimit?: { cost: number } }; errors?: unknown[] };
}

/** Respostas reais do GitHub, gravadas por `record-fixtures.ts`. */
export const recorded: Recorded[] = JSON.parse(readFileSync(new URL('./fixtures/responses.json', import.meta.url), 'utf8'));

export interface ReplayFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: { operation: string; variables: Record<string, unknown>; headers: Record<string, string> }[];
}

/** `fetch` que devolve a resposta gravada para a mesma operação e variáveis. */
export function replayFetch(responses: readonly Recorded[] = recorded): ReplayFetch {
  const f = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? '?';
    f.calls.push({ operation, variables, headers: init?.headers as Record<string, string> });
    const hit = responses.find((r) => r.operation === operation && JSON.stringify(r.variables) === JSON.stringify(variables));
    if (!hit) throw new Error(`sem resposta gravada para ${operation} ${JSON.stringify(variables)}`);
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
  }) as ReplayFetch;
  f.calls = [];
  return f;
}

export interface Clock {
  (): number;
  add(ms: number): void;
}

export function clock(start = Date.parse('2026-10-18T12:00:00Z')): Clock {
  let t = start;
  const c = (() => t) as Clock;
  c.add = (ms) => {
    t += ms;
  };
  return c;
}

export function node(n: number, over: Partial<WorkNode> = {}): WorkNode {
  return {
    key: k(n),
    repo: REPO,
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    state: 'OPEN',
    updatedAt: '2026-10-18T10:00:00Z',
    type: null,
    parent: null,
    progress: null,
    ...over,
  };
}

export function detail(n: number, over: Partial<WorkDetail> = {}): WorkDetail {
  return { key: k(n), state: 'OPEN', pullRequests: [], stage: 'a fazer', ...over };
}

/** Fonte em memória que registra cada chamada. `fail` faz a próxima chamada falhar. */
export class FakeSource implements WorkSource {
  calls: { op: string; arg: unknown }[] = [];
  list: WorkNode[] = [];
  delta: WorkNode[] = [];
  extra = new Map<string, WorkNode>();
  childrenOf = new Map<string, ChildrenResult>();
  details = new Map<string, WorkDetail>();
  fail: Error | null = null;

  private check(op: string, arg: unknown): void {
    this.calls.push({ op, arg });
    if (this.fail) throw this.fail;
  }

  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  async listShallow(filter: string, since?: number): Promise<WorkNode[]> {
    this.check(since === undefined ? 'listShallow' : 'delta', { filter, since });
    return since === undefined ? this.list : this.delta;
  }
  async nodes(keys: readonly string[]): Promise<WorkNode[]> {
    this.check('nodes', keys);
    // Como o adaptador real: cada chave vem com os pais acima dela.
    const out = new Map<string, WorkNode>();
    for (let key of keys) {
      while (this.extra.has(key) && !out.has(key)) {
        const n = this.extra.get(key)!;
        out.set(key, n);
        if (!n.parent) break;
        key = n.parent;
      }
    }
    return [...out.values()];
  }
  async children(key: string): Promise<ChildrenResult> {
    this.check('children', key);
    return this.childrenOf.get(key) ?? { children: [], details: [] };
  }
  async detail(key: string): Promise<WorkDetail> {
    this.check('detail', key);
    return this.details.get(key) ?? { key, state: 'OPEN', pullRequests: [], stage: 'a fazer' };
  }
}
