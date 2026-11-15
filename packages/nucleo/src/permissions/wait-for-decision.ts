// The long poll of the hook: waits for the owner's answer, delivers it once, and says "still pending" at the deadline
// of the slice. It waits on the clock's timer and the notifier, so a test never waits for real (decision 0025, #618/AC-2, AC-3).
import { expireIfDue, mustFind, recordChange, refusingAsync } from './internal.ts';
import type { Channel, Decision } from './model.ts';
import type { PermissionDeps } from './ports.ts';

/** The longest one slice of the long poll waits (decision 0025: `wait=25`). */
export const MAX_WAIT_MS = 25_000;

export type WaitOutcome =
  | { kind: 'decision'; requestId: string; digest: string; decision: Decision; reason: string | null; answeredBy: string; channel: Channel }
  | { kind: 'pending' };

export function waitForDecision(deps: PermissionDeps, input: { sessionId: string; requestId: string; waitMs: number }): Promise<WaitOutcome> {
  return refusingAsync(deps, 'wait', input.sessionId, input.requestId, async () => {
    const slice = Math.min(Math.max(Number.isFinite(input.waitMs) ? input.waitMs : 0, 0), MAX_WAIT_MS);
    const deadline = deps.clock.now() + slice;
    for (;;) {
      const request = mustFind(deps, input.sessionId, input.requestId);
      expireIfDue(deps, request);
      const now = deps.clock.now();
      if (request.state === 'pending') {
        if (now >= deadline) return { kind: 'pending' };
        await changeOrTimeout(deps, request.id, Math.min(deadline, request.expiresAt) - now);
        continue;
      }
      // Answered: delivered now, once. Delivered, or closed without a delivery: the aggregate refuses (409 or 410).
      request.deliver(now);
      recordChange(deps, request, 'delivered');
      const { decision, answeredBy, channel } = request;
      if (decision === null || answeredBy === null || channel === null) throw new Error('a delivered request carries its answer');
      return { kind: 'decision', requestId: request.id, digest: request.digest, decision, reason: request.reason, answeredBy, channel };
    }
  });
}

/** Resolves on the first change of the request or when the time runs out, and leaves neither a timer nor a listener behind. */
async function changeOrTimeout(deps: PermissionDeps, requestId: string, ms: number): Promise<void> {
  const timer = deps.clock.timer(ms);
  let stop: () => void = () => {};
  const changed = new Promise<void>((resolve) => {
    stop = deps.notifier.subscribe(requestId, resolve);
  });
  try {
    await Promise.race([timer.elapsed, changed]);
  } finally {
    timer.cancel();
    stop();
  }
}
