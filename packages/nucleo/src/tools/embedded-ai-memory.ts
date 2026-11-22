// The bundled ai-memory: its absolute path from this module, never by PATH (#725), and the environment it runs with (#733).

import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Four levels up from this module is Contents/Resources (#725).
const RESOURCES_FROM_MODULE = ['..', '..', '..', '..'];
const EMBEDDED_DIR = 'ai-memory';
const EMBEDDED_BINARY = 'ai-memory';

/** The embedded binary's absolute path (#725), or null when this core does not run from a bundle that has it. */
export function embeddedAiMemoryPath(moduleUrl: string = import.meta.url): string | null {
  const moduleDir = fileURLToPath(new URL('.', moduleUrl));
  const binary = join(moduleDir, ...RESOURCES_FROM_MODULE, EMBEDDED_DIR, EMBEDDED_BINARY);
  try {
    if (!statSync(binary).isFile()) return null;
    accessSync(binary, constants.X_OK);
    return binary;
  } catch (error) {
    if (isAbsentOrUnusable(error)) return null;
    throw error;
  }
}

function isAbsentOrUnusable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES';
}

// The only variables the embedded binary receives. The repo documents no other variable ai-memory needs, and the core passes no `--data-dir` (ai-memory's default folder is used, #735), so no `AI_MEMORY_*` is passed (#727/AC-2, #733/AC-5).
const ENV_ALLOWLIST: ReadonlySet<string> = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER']);
const ENV_ALLOWED_PREFIX = 'LC_';

declare const registeredFolder: unique symbol;
/** A Claude account folder the core's registry knows, absolute and existing: the only value `CLAUDE_CONFIG_DIR` may take (#740/AC-7). */
export type RegisteredAccountFolder = string & { readonly [registeredFolder]: true };

/** The folder as a `RegisteredAccountFolder`, or null when it is not (#740/AC-7). */
export function registeredAccountFolder(dir: string, registered: readonly string[], isDirectory: (path: string) => boolean = isExistingDirectory): RegisteredAccountFolder | null {
  if (dir.includes('\0') || !isAbsolute(dir) || normalize(dir) !== dir) return null;
  if (!registered.includes(dir) || !isDirectory(dir)) return null;
  return dir as RegisteredAccountFolder;
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The one variable added to the allowlist (#740/AC-7): its value is a RegisteredAccountFolder, never a string from the environment or a request.
const ACCOUNT_FOLDER_VARIABLE = 'CLAUDE_CONFIG_DIR';

/** The allowlisted part of an environment, for every run of the embedded binary: PATH, HOME, TMPDIR, LANG, USER and `LC_*`; nothing else (#727/AC-2, #733/AC-5). With a registered account folder, also `CLAUDE_CONFIG_DIR` set to it, and only to it (#740/AC-7). */
export function embeddedAiMemoryEnv(env: NodeJS.ProcessEnv = process.env, folder?: RegisteredAccountFolder): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(key) || key.startsWith(ENV_ALLOWED_PREFIX)) out[key] = value;
  }
  if (folder !== undefined) out[ACCOUNT_FOLDER_VARIABLE] = folder;
  return out;
}
