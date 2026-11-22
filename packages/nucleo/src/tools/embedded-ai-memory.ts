// The ai-memory binary the app bundle carries (#725, #719): the build puts it in
// Contents/Resources/ai-memory/ai-memory, beside Contents/Resources/packages/nucleo, so the core
// reaches it by absolute path from its own location. There is no PATH lookup: a binary the user
// installed elsewhere is never taken for the pinned one.

import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This module is Resources/packages/nucleo/src/tools/embedded-ai-memory.ts: four levels up is Resources/.
// (The folder and the file name match scripts/fetch-ai-memory.mjs and tauri.conf.json bundle.resources.)
const RESOURCES_FROM_MODULE = ['..', '..', '..', '..'];
const EMBEDDED_DIR = 'ai-memory';
const EMBEDDED_BINARY = 'ai-memory';

/** The embedded binary's absolute path, or null when this core does not run from a bundle that has it. */
export function embeddedAiMemoryPath(moduleUrl: string = import.meta.url): string | null {
  const moduleDir = fileURLToPath(new URL('.', moduleUrl));
  const binary = join(moduleDir, ...RESOURCES_FROM_MODULE, EMBEDDED_DIR, EMBEDDED_BINARY);
  try {
    if (!statSync(binary).isFile()) return null;
    accessSync(binary, constants.X_OK);
    return binary;
  } catch {
    return null;
  }
}
