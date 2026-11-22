/*
 * The file side of the memory actions (#740): the checks the actions make on folders and the atomic write of `embedding_provider = "none"`
 * into ai-memory's config.toml (temp file in the same folder, then rename, so a reader never sees half a file). It touches that one file
 * name and nothing else in ai-memory's data folder (#719/AC-10, #740/AC-5).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { MemoryActionFiles } from '../memory/actions.ts';
import { withEmbeddingsOff } from '../memory/config-toml.ts';

const CONFIG_FILE = 'config.toml';
const OWNER_ONLY = 0o600;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function readCurrent(path: string): Promise<{ text: string; mode: number }> {
  try {
    const info = await stat(path);
    return { text: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    if (isMissing(error)) return { text: '', mode: OWNER_ONLY };
    throw error;
  }
}

async function writeEmbeddingsOff(configPath: string): Promise<void> {
  if (!isAbsolute(configPath) || basename(configPath) !== CONFIG_FILE) throw new TypeError('only an absolute config.toml may be written');
  const current = await readCurrent(configPath);
  const temp = join(dirname(configPath), `${CONFIG_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, withEmbeddingsOff(current.text), { mode: current.mode, flag: 'wx' });
    await chmod(temp, current.mode);
    await rename(temp, configPath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export function createMemoryActionFiles(): MemoryActionFiles {
  return {
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    exists: (path) => existsSync(path),
    writeEmbeddingsOff,
  };
}
