// One core per installation (decision 0010, issue #221): the app, the development checkout (and the
// terminal) and the `.mcpb` extension each run their own core, with their own data folder and a
// random port. This file says which folder and which port.
//
//   - `consoleHome()`: the per-user folder, `~/.ahrena-console` (or `AHRENA_CONSOLE_HOME`). It keeps
//     what is not one core's data: the instance registry, contas.json, machines.json,
//     dev-console.json, backups, hooks.log.
//   - `defaultDataDir(installation)`: where a core keeps its database, log, clients and lock.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const INSTALLATIONS = ['app', 'dev', 'mcpb'] as const;
export type Installation = (typeof INSTALLATIONS)[number];
export const DEFAULT_INSTALLATION: Installation = 'dev';

/** The app's bundle identifier: its data folder has this name (decision 0010, item 2). */
export const APP_IDENTIFIER = 'dev.ahrena.console';

export function isInstallation(value: unknown): value is Installation {
  return typeof value === 'string' && (INSTALLATIONS as readonly string[]).includes(value);
}

/** `--installation`: one of app, dev, mcpb (default dev). Throws on anything else. */
export function parseInstallation(value: string | undefined): Installation {
  if (value === undefined || value === '') return DEFAULT_INSTALLATION;
  if (!isInstallation(value)) throw new Error(`--installation: one of ${INSTALLATIONS.join(', ')} (got "${value}")`);
  return value;
}

/** The per-user folder: `AHRENA_CONSOLE_HOME`, or `~/.ahrena-console`. */
export function consoleHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AHRENA_CONSOLE_HOME;
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.ahrena-console');
}

/** Where the OS keeps an application's data, for the `app` installation. */
function appDataRoot(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

/**
 * The data folder of an installation, when neither `--data-dir` nor `AHRENA_CONSOLE_DATA_DIR` says
 * otherwise:
 *
 * | installation | folder |
 * | --- | --- |
 * | `dev` | `~/.ahrena-console` (as before #221: its database stays where it was) |
 * | `app` | `~/Library/Application Support/dev.ahrena.console` (XDG or APPDATA elsewhere) |
 * | `mcpb` | `~/.ahrena-console/installations/mcpb`; the extension may pass its own with `--data-dir` |
 */
export function defaultDataDir(installation: Installation, env: NodeJS.ProcessEnv = process.env): string {
  if (installation === 'app') return join(appDataRoot(env), APP_IDENTIFIER);
  if (installation === 'mcpb') return join(consoleHome(env), 'installations', 'mcpb');
  return consoleHome(env);
}

/** `--data-dir`, else `AHRENA_CONSOLE_DATA_DIR`, else the installation's default. Always absolute. */
export function resolveDataDir(o: { installation?: Installation; dataDir?: string }, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = o.dataDir || env.AHRENA_CONSOLE_DATA_DIR;
  return chosen ? resolve(chosen) : defaultDataDir(o.installation ?? DEFAULT_INSTALLATION, env);
}

/**
 * The port to listen on: the option if given, else `AHRENA_CONSOLE_CORE_PORT`, else the older
 * `AHRENA_CONSOLE_PORT`, else `0` (the system picks a free one, decision 0010, item 1).
 */
export function resolvePort(option: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = option ?? (env.AHRENA_CONSOLE_CORE_PORT || undefined) ?? (env.AHRENA_CONSOLE_PORT || undefined);
  if (raw === undefined) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port: a port from 0 to 65535 (got "${raw}")`);
  return port;
}
