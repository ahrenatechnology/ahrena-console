// O diff unificado da prévia (C36): LCS por linha, em trechos (`@@ -a,b +c,d @@`) com 3 linhas de
// contexto, como o `git diff`. Só as linhas perto do que muda aparecem; o resto do arquivo não.

/** Linhas de contexto em volta de cada mudança. */
export const DIFF_CONTEXT = 3;
/** Acima disso (linhas de antes × depois), o diff troca o arquivo inteiro em vez de calcular o LCS. */
const MAX_CELLS = 4_000_000;

export interface UnifiedDiff {
  text: string;
  add: number;
  del: number;
}

type Op = { kind: ' ' | '+' | '-'; line: string };

const linesOf = (t: string | null | undefined) => (t == null || t === '' ? [] : t.replace(/\n$/, '').split('\n'));

function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return [...a.map((line) => ({ kind: '-' as const, line })), ...b.map((line) => ({ kind: '+' as const, line }))];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  // No empate, a linha que sai vem antes da que entra, como no `git diff`.
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: ' ', line: a[i++] });
      j++;
    } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) out.push({ kind: '-', line: a[i++] });
    else out.push({ kind: '+', line: b[j++] });
  }
  return out;
}

/** O diff de `path` de `before` (`null`: arquivo novo) para `after`. Sem mudança, `text` é `''`. */
export function unifiedDiff(path: string, before: string | null | undefined, after: string | null | undefined, context = DIFF_CONTEXT): UnifiedDiff {
  const all = ops(linesOf(before), linesOf(after));
  const add = all.filter((o) => o.kind === '+').length;
  const del = all.filter((o) => o.kind === '-').length;
  if (add === 0 && del === 0) return { text: '', add, del };
  const lines = [`--- ${before == null ? '/dev/null' : `a/${path}`}`, `+++ ${after == null ? '/dev/null' : `b/${path}`}`];
  // Posição de cada op nas linhas de antes e de depois (1-based), para os cabeçalhos dos trechos.
  const pos: { a: number; b: number }[] = [];
  let pa = 1;
  let pb = 1;
  for (const o of all) {
    pos.push({ a: pa, b: pb });
    if (o.kind !== '+') pa++;
    if (o.kind !== '-') pb++;
  }
  const changed = all.map((o, k) => (o.kind !== ' ' ? k : -1)).filter((k) => k >= 0);
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - context);
    let end = Math.min(all.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) end = Math.min(all.length - 1, changed[++k] + context);
    k++;
    const slice = all.slice(start, end + 1);
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    const aStart = aCount === 0 ? pos[start].a - 1 : pos[start].a;
    const bStart = bCount === 0 ? pos[start].b - 1 : pos[start].b;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) lines.push(`${o.kind}${o.line}`);
  }
  return { text: lines.join('\n'), add, del };
}
