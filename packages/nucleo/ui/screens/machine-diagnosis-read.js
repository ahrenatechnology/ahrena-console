// The read of one diagnosis, bound to the route (issue 566). The state (`machine-diagnosis-state.js`) calls this
// through its `read` seam: it gives the alert and a signal and gets an outcome or an error. Here the body goes to the
// panel as it came and every error is a failure with the error's `status`. What the route's answer is checked against
// and how each status becomes a state (404 closed, 501 unsupported, 502 the Workstation) is the contract layer's:
// it replaces this function and nothing else.

import { diagnosisRoute } from './machine-diagnosis-state.js';

/** `(alert, { signal }) => Promise<outcome>` for this screen's machine. */
export const diagnosisReader = (ctx, machineId) => async (alert, { signal }) => ({ state: 'ready', diagnosis: await ctx.read(diagnosisRoute(machineId, alert.id), { signal }) });
