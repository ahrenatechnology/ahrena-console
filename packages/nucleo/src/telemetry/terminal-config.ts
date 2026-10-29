// The terminal sessions' settings (#350), from `config.json` in the installation's data folder:
//
//   { "terminal": { "acceptRemoteActions": true, "interactiveCommands": ["npm", "vite"] } }
//
// - `acceptRemoteActions` (default false): this núcleo accepts a terminal action that comes through
//   the tunnel (a loopback write with no `Origin`). Whoever sits on this machine turns it on, not the Mac.
//   `AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1` turns it on too: the same switch the port release (#286,
//   decision 0016) uses, so one setting over there covers both.
// - `interactiveCommands`: more commands that wait for the person on purpose, so a terminal running
//   one of them is never "presa" (a dev server left in the foreground, say).
//
// Read again at most every 5 s; a missing or invalid file is the defaults.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TerminalSettings {
  acceptRemoteActions: boolean;
  interactiveCommands: string[];
}

const DEFAULTS: TerminalSettings = { acceptRemoteActions: false, interactiveCommands: [] };
const COMMAND_NAME = /^[A-Za-z0-9._+-]{1,64}$/;

export function parseTerminalSettings(text: string, env: NodeJS.ProcessEnv = process.env): TerminalSettings {
  const fromEnv = env.AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS === '1';
  const defaults = fromEnv ? { ...DEFAULTS, acceptRemoteActions: true } : DEFAULTS;
  try {
    const t = (JSON.parse(text) as { terminal?: unknown }).terminal;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) return defaults;
    const { acceptRemoteActions, interactiveCommands } = t as Record<string, unknown>;
    return {
      acceptRemoteActions: fromEnv || acceptRemoteActions === true,
      interactiveCommands: Array.isArray(interactiveCommands) ? interactiveCommands.filter((c): c is string => typeof c === 'string' && COMMAND_NAME.test(c)).slice(0, 64) : [],
    };
  } catch {
    return defaults;
  }
}

export function terminalSettings(dataDir: string, now: () => number = Date.now): () => TerminalSettings {
  const file = join(dataDir, 'config.json');
  let at = -Infinity;
  let cached = DEFAULTS;
  return () => {
    if (now() - at >= 5_000) {
      at = now();
      try {
        cached = parseTerminalSettings(readFileSync(file, 'utf8'));
      } catch {
        cached = parseTerminalSettings('{}');
      }
    }
    return cached;
  };
}
