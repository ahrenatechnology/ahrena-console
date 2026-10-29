// The verdict and the findings a reviewer (Argos) writes at the end of its report (#332). Read from the full text at
// ingest, because the event summary is cut at SUMMARY_MAX and the `Verdict:` line is at the end of a long report.

export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';

const VERDICT = /Verdict:\s*\**\s*(approve|request[- ]changes|changes[- ]requested|comment)/gi;
const FINDINGS = /(\d+)\s+(?:findings?|achados)(?![\p{L}])/giu;

/** The last `Verdict: …` of a message. */
export function verdictOf(message: string | null): ReviewVerdict | null {
  if (!message) return null;
  const last = [...message.matchAll(VERDICT)].at(-1)?.[1]?.toLowerCase();
  if (!last) return null;
  if (last === 'approve') return 'approve';
  return last === 'comment' ? 'comment' : 'request-changes';
}

/** The last "N findings" / "N achados" of a message. */
export function findingsOf(message: string | null): number | null {
  if (!message) return null;
  const last = [...message.matchAll(FINDINGS)].at(-1);
  return last ? Number(last[1]) : null;
}
