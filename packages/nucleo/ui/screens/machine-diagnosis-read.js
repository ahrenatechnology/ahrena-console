// The read of one diagnosis, bound to the route and to docs/contracts/diagnosis.md (issue 566). The state
// (`machine-diagnosis-state.js`) calls this through its `read` seam: it gives the alert and a signal and gets an outcome,
// `{ state: 'ready', diagnosis } | { state: 'failed', failure } | { state: 'closed' } | { state: 'unsupported' }`.
// A 200 is checked against the contract (a body that is not a diagnosis of this alert is a failure), and each status
// becomes the state wireframe 566-18 draws for it; the fields decide, never the text of a message. A read that was aborted
// goes on as the abort, for the state to drop.

import { ReadError } from '../api.js';
import { diagnosisRoute } from './machine-diagnosis-state.js';

const SECTION_STATUSES = ['ok', 'unavailable', 'timeout'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSection = (s) => isObject(s) && typeof s.id === 'string' && SECTION_STATUSES.includes(s.status) && Array.isArray(s.items);

/**
 * The 200 body when it is a diagnosis of this alert by the contract (kind, alert id, `takenAt`, a list of sections that
 * each have an id, a status and a list of items), `null` otherwise. A section id the screen does not know passes: the
 * screen leaves it out (issue 566).
 */
export function normalizeDiagnosis(body, alert) {
  if (!isObject(body) || typeof body.takenAt !== 'string' || !Array.isArray(body.sections)) return null;
  if (body.kind !== alert?.kind || body.alertId !== alert?.id) return null;
  return body.sections.every(isSection) ? body : null;
}

/** The two reasons the contract gives a 502 (the remote machine did not answer, or answered what is not a diagnosis) (issue 566). */
const BAD_GATEWAY_REASONS = ['unreachable', 'bad-response'];

/** The outcome of a route that answered with an error status (wireframe 566-18); never a body text (issue 566). */
function outcomeOfStatus(status, body) {
  if (status === 404 && body?.reason === 'alert-not-open') return { state: 'closed' };
  if (status === 501 && body?.error === 'diagnosis-unsupported') return { state: 'unsupported' };
  const reason = status === 502 && BAD_GATEWAY_REASONS.includes(body?.reason) ? { reason: body.reason } : {};
  return { state: 'failed', failure: { status, ...reason } };
}

const FAILED = { state: 'failed', failure: { status: null } };

/** `(alert, { signal }) => Promise<outcome>` for this screen's machine (issue 566). */
export const diagnosisReader = (ctx, machineId) => async (alert, { signal }) => {
  try {
    const body = await ctx.read(diagnosisRoute(machineId, alert.id), { signal });
    const diagnosis = normalizeDiagnosis(body, alert);
    return diagnosis ? { state: 'ready', diagnosis } : FAILED;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (error instanceof ReadError && Number.isInteger(error.status) && error.status > 0) return outcomeOfStatus(error.status, error.body);
    return FAILED;
  }
};
