// As ligações entre os registros de um repositório (#174), portadas do `linkAll` do spike
// (spikes/adr-extractor/extract.mjs): resolve cada alvo (pelo arquivo do link ou pelo número) e cria a
// volta. Se A substitui B, B é substituída por A, mesmo que B não diga. Uma ligação "relacionada" para
// algo que não é registro (o backlog) é descartada; com verbo, ela fica, solta, sem alvo.

import type { ChainNode, DecisionLink, LinkKind, ParsedDecision } from './model.ts';

const INVERSE: Record<LinkKind, LinkKind> = {
  supersedes: 'superseded-by',
  'superseded-by': 'supersedes',
  amends: 'amended-by',
  'amended-by': 'amends',
  clarifies: 'clarified-by',
  'clarified-by': 'clarifies',
  related: 'related',
};

/** `id`s únicos no repositório: o mesmo nome em duas pastas ganha `--2`, `--3`. */
export function uniqueIds(records: ParsedDecision[]): ParsedDecision[] {
  const seen = new Map<string, number>();
  return records.map((r) => {
    const n = (seen.get(r.id) ?? 0) + 1;
    seen.set(r.id, n);
    return n === 1 ? r : { ...r, id: `${r.id}--${n}` };
  });
}

/**
 * Resolve e completa as ligações de um conjunto (um repositório). Não muda a entrada: devolve cópias.
 * Um alvo pelo arquivo prefere o registro da mesma pasta; pelo número, o do mesmo tipo.
 */
export function linkAll(input: ParsedDecision[]): ParsedDecision[] {
  const records = input.map((r) => ({ ...r, links: r.links.map((l) => ({ ...l })), statusConflict: null as string | null }));
  const folder = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const resolve = (from: ParsedDecision, l: DecisionLink): ParsedDecision | undefined => {
    if (l.file) {
      const same = records.filter((r) => base(r.path) === l.file);
      return same.find((r) => folder(r.path) === folder(from.path)) ?? same[0];
    }
    if (l.number !== undefined) {
      const same = records.filter((r) => r.number === l.number && r !== from);
      return same.find((r) => r.kind === from.kind) ?? same[0];
    }
    return undefined;
  };
  for (const a of records) {
    for (const l of a.links) l.target = resolve(a, l)?.id ?? null;
    a.links = a.links.filter((l) => (l.target || l.kind !== 'related') && l.target !== a.id);
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const a of records) {
    for (const l of [...a.links]) {
      if (!l.target) continue;
      const t = byId.get(l.target);
      if (!t) continue;
      const kind = INVERSE[l.kind];
      if (!t.links.some((x) => x.kind === kind && x.target === a.id)) t.links.push({ kind, target: a.id, via: 'inverse' });
    }
  }
  for (const a of records) {
    if (a.links.some((l) => l.kind === 'superseded-by' && l.target) && a.status !== 'superseded') a.statusConflict = `superseded-by link, status says ${a.status}`;
  }
  return records;
}

const node = (r: ParsedDecision): ChainNode => ({ id: r.id, number: r.number, title: r.title, kind: r.kind, status: r.status });

/**
 * A cadeia de substituição que passa por `id`: para trás pelos "substitui", para frente pelos
 * "substituída por", da mais antiga à que vale hoje. Um ciclo para na primeira repetição.
 */
export function chainOf(records: ParsedDecision[], id: string): ChainNode[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const start = byId.get(id);
  if (!start) return [];
  const seen = new Set([id]);
  const back: ParsedDecision[] = [];
  for (let cur = start; ; ) {
    const prev = cur.links.find((l) => l.kind === 'supersedes' && l.target && !seen.has(l.target));
    const r = prev ? byId.get(prev.target!) : undefined;
    if (!r) break;
    seen.add(r.id);
    back.unshift(r);
    cur = r;
  }
  const forward: ParsedDecision[] = [];
  for (let cur = start; ; ) {
    const next = cur.links.find((l) => l.kind === 'superseded-by' && l.target && !seen.has(l.target));
    const r = next ? byId.get(next.target!) : undefined;
    if (!r) break;
    seen.add(r.id);
    forward.push(r);
    cur = r;
  }
  return [...back, start, ...forward].map(node);
}

/** As cadeias com dois ou mais registros, sem repetir: uma por registro que ninguém substitui por último. */
export function chains(records: ParsedDecision[]): ChainNode[][] {
  const out: ChainNode[][] = [];
  const covered = new Set<string>();
  for (const r of records) {
    if (covered.has(r.id)) continue;
    const c = chainOf(records, r.id);
    if (c.length < 2) continue;
    c.forEach((n) => covered.add(n.id));
    out.push(c);
  }
  return out;
}
