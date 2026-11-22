// The bundled ai-memory: its absolute path from this module, never by PATH (#725), and the environment it runs with (#733).

import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
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

// The only variables the embedded binary receives. The repo documents no other variable ai-memory needs, and the core fixes `--data-dir` itself, so no `AI_MEMORY_*` is passed (#727/AC-2, #733/AC-5).
const ENV_ALLOWLIST: ReadonlySet<string> = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER']);
const ENV_ALLOWED_PREFIX = 'LC_';

/** The allowlisted part of an environment, for every run of the embedded binary: PATH, HOME, TMPDIR, LANG, USER and `LC_*`; nothing else (#727/AC-2, #733/AC-5). */
export function embeddedAiMemoryEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(key) || key.startsWith(ENV_ALLOWED_PREFIX)) out[key] = value;
  }
  return out;
}
