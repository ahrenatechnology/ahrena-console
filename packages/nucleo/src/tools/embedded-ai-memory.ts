// The bundled ai-memory, by absolute path from this module, never by PATH (#725).

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
