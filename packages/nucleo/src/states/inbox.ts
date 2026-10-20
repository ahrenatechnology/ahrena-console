// Reading for the inbox ("who needs me"): the displayed status plus Podium's two states,
// "delegating" and "waiting on a background process", which do not count as "waiting for you".

import { displayStatus, isUrgent, type Agent, type AwaitingReason, type DisplayStatus, type Session } from '../model.ts';
import { DELEGATION_TOOLS, readMemory, mainAgentOf, workingSubagents } from './rules.ts';

/**
 * - `delegating`: the main agent is idle, waiting on the subagents it launched;
 * - `background`: the turn ended, but a process keeps running behind it (`Bash` in background).
 */
export type InboxState = DisplayStatus | 'delegating' | 'background';

/** What the inbox shows for a session. Internal: the API and MCP map these fields to their own keys. */
export interface InboxReading {
  /** The same as `displayStatus()`. */
  status: DisplayStatus;
  state: InboxState;
  reason: AwaitingReason | null;
  urgent: boolean;
  /** Goes into the inbox: waiting for you, or in error. Delegating and background do not. */
  needsYou: boolean;
  activeSubagents: number;
  backgroundProcesses: number;
}

/** Reads the inbox state of a session from its record and agents. */
export function readInbox(session: Session, agents: readonly Agent[]): InboxReading {
  const state = { session, agents: [...agents] };
  const status = displayStatus(session);
  const subagents = workingSubagents(state).length;
  const memory = readMemory(session);
  const background = Object.keys(memory.background).length;
  const main = mainAgentOf(state);
  const delegating = Object.keys(memory.delegacoes).length > 0 || (main?.currentTool != null && DELEGATION_TOOLS.includes(main.currentTool));

  let inbox: InboxState = status;
  if (status === 'waiting' && session.awaitingReason === 'stop') {
    // The turn ended, but work is still running: it is not really your turn.
    if (subagents > 0) inbox = 'delegating';
    else if (background > 0) inbox = 'background';
  } else if (status === 'active' && (subagents > 0 || delegating)) {
    const otherTool = main?.currentTool != null && !DELEGATION_TOOLS.includes(main.currentTool);
    if (!otherTool) inbox = 'delegating';
  }

  return {
    status,
    state: inbox,
    reason: session.awaitingReason,
    urgent: isUrgent(session),
    needsYou: inbox === 'waiting' || inbox === 'error',
    activeSubagents: subagents,
    backgroundProcesses: background,
  };
}
