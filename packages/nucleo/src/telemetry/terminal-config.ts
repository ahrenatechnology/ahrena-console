// The terminal sessions' settings (#350), from `config.json` in the installation's data folder:
//
//   { "terminal": { "interactiveCommands": ["npm", "vite"] } }
//
// Accepting a terminal action that comes through the tunnel (a loopback write with no `Origin`) is not
// set here: it is the núcleo's own `--accept-remote-actions` / `AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1`,
// the switch the port release (#286) and Docker (#288) already use (`cli-options.ts`).
//
// - `interactiveCommands`: more commands that wait for the person on purpose, so a terminal running
//   one of them is never "presa" (a dev server left in the foreground, say).
//
// Read again at most every 5 s; a missing or invalid file is the defaults.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TerminalSettings {
  interactiveCommands: string[];
}

const DEFAULTS: TerminalSettings = { interactiveCommands: [] };
const COMMAND_NAME = /^[A-Za-z0-9._+-]{1,64}$/;

export function parseTerminalSettings(text: string): TerminalSettings {
  const defaults = DEFAULTS;
  try {
    const t = (JSON.parse(text) as { terminal?: unknown }).terminal;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) return defaults;
    const { interactiveCommands } = t as Record<string, unknown>;
    return {
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
