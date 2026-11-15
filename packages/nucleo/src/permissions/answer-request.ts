// The owner's answer from the /ui: allow or deny once, with a reason on a deny (decision 0025, #618/AC-1, AC-6).
import { expireIfDue, mustFind, recordChange, refusing } from './internal.ts';
import { PermissionRefusal, type Channel, type Decision } from './model.ts';
import type { PermissionDeps } from './ports.ts';

export interface AnswerRequestInput {
  sessionId: string;
  requestId: string;
  decision: Decision;
  reason?: string;
  answeredBy: string;
  channel: Channel;
}

export function answerRequest(deps: PermissionDeps, input: AnswerRequestInput): void {
  refusing(deps, 'answer', input.sessionId, input.requestId, () => {
    const request = mustFind(deps, input.sessionId, input.requestId);
    // An overdue request is settled before it is refused, so what the screen reads next is `expired`, not `pending`. (#618)
    if (expireIfDue(deps, request)) throw new PermissionRefusal('gone');
    request.answer({ decision: input.decision, reason: input.reason, answeredBy: input.answeredBy, channel: input.channel, now: deps.clock.now() });
    recordChange(deps, request, 'answered');
  });
}
