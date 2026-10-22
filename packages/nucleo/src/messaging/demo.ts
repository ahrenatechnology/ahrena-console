// The messaging of the demo core (`--demo`, #61): synthetic, so the /ui can show the compose box and
// its states without any real session. Nothing is written to any socket and nothing is audited.
// An active session has one live "Claude Desktop" process with Remote Control; any other has none.
// A message is confirmed 1.2 s after it is sent, except a text containing "sem confirmação", which
// is never confirmed (the 60 s window then runs as in the real core).

import type { StoragePort } from '../storage-port.ts';
import { Messaging } from './service.ts';

const CONFIRM_AFTER_MS = 1200;
const NEVER = 'sem confirmação';

export function demoMessaging(storage: Pick<StoragePort, 'getSession'>, log?: (message: string) => void): Messaging {
  let hold = false;
  return new Messaging({
    live: {
      async find(sessionId) {
        const s = await storage.getSession(sessionId);
        return s?.status === 'active' ? [{ pid: 1, socketPath: '/demo/inbox.sock', configDir: '/demo/.claude', accountId: null, entrypoint: 'claude-desktop', remoteControl: true }] : [];
      },
    },
    inbox: {
      async deliver(_socketPath, text) {
        hold = text.includes(NEVER);
        return { ok: true };
      },
    },
    turns: {
      async open() {
        const openedAt = Date.now();
        return { poll: async () => (!hold && Date.now() - openedAt >= CONFIRM_AFTER_MS ? Date.now() : null), close() {} };
      },
    },
    audit: { record() {} },
    log,
  });
}
