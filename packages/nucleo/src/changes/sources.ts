// Where the changes come from: the writes through the ports and the state machine.
//
// - `withChanges(storage, cursor)` wraps the port (Proxy): `putSession`, `putPlan` and `putAccount`
//   record a change after writing; the rest goes straight through (including SQLite's `db`).
//   `putSession` only records when a field the screens show changes (`visibleFields`): every hook
//   writes the session to move `updatedAt` forward, and that alone wakes nobody up. New activity
//   (events) is not a change: state, plan and decisions have their own types.
// - `putAgent` records `session` (the agent's session) when what the Kanban shows of the agent
//   changes (`visibleAgentFields`): a subagent that starts or ends touches the Agents view (#31).
// - `decisionsWithChanges(port, cursor, accounts)` does the same with `putDecision`.
// - `onMachineChange(cursor, accounts)` goes into the machine's `onChange`: it records `state` and,
//   when the session enters or leaves the inbox, `needs-you`.
//
// Each session's account comes from `SessionAccounts`: learnt on every `putSession`, and only read
// from the port when the session has not come through here yet.

import type { StateChange } from '../states/machine.ts';
import type { InboxState } from '../states/inbox.ts';
import type { DecisionPort } from '../decisions/port.ts';
import type { Agent, Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { ChangeCursor } from './cursor.ts';

/** What the screens show of the session. Left out is what changes on every hook: `updatedAt` and `metadata`. */
export function visibleFields(s: Session): string {
  return JSON.stringify([s.name, s.status, s.cwd, s.model, s.endedAt, s.awaitingInputSince, s.awaitingReason, s.accountId, s.identity, s.capabilities, s.accountSource, s.accountConfidence]);
}

/** What the screens show of the agent: it enters, changes status or ends. */
export function visibleAgentFields(a: Agent): string {
  return JSON.stringify([a.type, a.status, a.name, a.subagentType, a.task, a.endedAt]);
}

export class SessionAccounts {
  private readonly accounts = new Map<string, string | null>();
  /** `visibleFields` of each session's last write, to know whether the next one changes anything. */
  readonly seen = new Map<string, string>();
  /** The same for the agents, by the key `<session>\0<agent>`. */
  readonly seenAgents = new Map<string, string>();
  private readonly storage: Pick<StoragePort, 'getSession'>;

  constructor(storage: Pick<StoragePort, 'getSession'>) {
    this.storage = storage;
  }

  learn(sessionId: string, accountId: string | null): void {
    this.accounts.set(sessionId, accountId);
  }

  async accountOf(sessionId: string): Promise<string | null> {
    if (this.accounts.has(sessionId)) return this.accounts.get(sessionId) ?? null;
    const s = await this.storage.getSession(sessionId).catch(() => null);
    const account = s?.accountId ?? null;
    if (s) this.accounts.set(sessionId, account);
    return account;
  }
}

export function withChanges<T extends StoragePort>(storage: T, cursor: ChangeCursor, accounts = new SessionAccounts(storage)): T {
  const wrappers: Partial<StoragePort> = {
    async putSession(session) {
      await storage.putSession(session);
      accounts.learn(session.id, session.accountId);
      const visible = visibleFields(session);
      if (accounts.seen.get(session.id) === visible) return;
      accounts.seen.set(session.id, visible);
      cursor.record({ type: 'session', key: session.id, sessionId: session.id, accountId: session.accountId });
    },
    async putAgent(agent) {
      await storage.putAgent(agent);
      const key = `${agent.sessionId}\0${agent.id}`;
      const visible = visibleAgentFields(agent);
      if (accounts.seenAgents.get(key) === visible) return;
      accounts.seenAgents.set(key, visible);
      const accountId = await accounts.accountOf(agent.sessionId);
      cursor.record({ type: 'session', key: agent.sessionId, sessionId: agent.sessionId, accountId });
    },
    async putPlan(plan) {
      await storage.putPlan(plan);
      const accountId = await accounts.accountOf(plan.sessionId);
      cursor.record({ type: 'plan', key: plan.sessionId, sessionId: plan.sessionId, accountId });
    },
    async putAccount(account) {
      await storage.putAccount(account);
      cursor.record({ type: 'account', key: account.id, sessionId: null, accountId: account.id });
    },
  };
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(wrappers, prop)) return wrappers[prop as keyof StoragePort];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function decisionsWithChanges<T extends DecisionPort>(port: T, cursor: ChangeCursor, accounts: SessionAccounts): T {
  const putDecision: DecisionPort['putDecision'] = async (d) => {
    await port.putDecision(d);
    const accountId = await accounts.accountOf(d.sessionId);
    cursor.record({ type: 'decision', key: d.id, sessionId: d.sessionId, accountId });
  };
  return new Proxy(port, {
    get(target, prop, receiver) {
      if (prop === 'putDecision') return putDecision;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** Goes into the inbox: waiting for you, or in error (the same as `readInbox().needsYou`). */
const inInbox = (e: InboxState) => e === 'waiting' || e === 'error';

export function onMachineChange(cursor: ChangeCursor, accounts: SessionAccounts): (m: StateChange) => void {
  return (m) => {
    // The machine calls synchronously; the account is almost always in the map already (the machine just wrote it).
    void accounts.accountOf(m.sessionId).then((accountId) => {
      cursor.record({ type: 'state', key: m.sessionId, sessionId: m.sessionId, accountId });
      if (inInbox(m.before) !== inInbox(m.after)) {
        cursor.record({ type: 'needs-you', key: m.sessionId, sessionId: m.sessionId, accountId });
      }
    });
  };
}
