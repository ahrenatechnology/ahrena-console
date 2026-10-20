// Discovery of the Claude Code configuration folders (decision 0006, "Perfis"): `~/.claude`, the
// `~/.claude-*` that exist, the ones the person lists in `~/.ahrena-console/perfis.json` and the
// ones the hooks reveal (`CLAUDE_CONFIG_DIR`). Only the structure is read: whether the folder exists
// and has the entries of a configuration folder. No file is opened here.

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Where the core learned about the folder: the first origin that revealed it stays. */
export type ProfileOrigin = 'default' | 'name' | 'configured' | 'hook';

/** A configuration folder. */
export interface ConfigFolder {
  /** Absolute path of the folder (e.g. `/Users/x/.claude-cliente`). */
  dir: string;
  /** Where the `.claude.json` lives: `~/.claude.json` for the default folder, inside the folder for the others. */
  claudeJson: string;
  /** The transcripts folder (`<dir>/projects`). */
  projectsDir: string;
  /** The default folder (`~/.claude`), which Claude Desktop also uses. */
  isDefault: boolean;
  origin: ProfileOrigin;
}

/** Entries only a Claude Code configuration folder has. One is enough. */
const MARKERS = ['.claude.json', 'settings.json', 'projects', 'sessions'] as const;

export function defaultProfilesFile(home = homedir()): string {
  return join(home, '.ahrena-console', 'perfis.json');
}

/** Absolute path, with `~` expanded to `home`. */
export function normalizeFolder(dir: string, home = homedir()): string {
  const d = dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir;
  return isAbsolute(d) ? resolve(d) : resolve(home, d);
}

/** The folder, with where its `.claude.json` and transcripts live; does not touch the disk. */
export function configFolder(dir: string, origin: ProfileOrigin, home = homedir()): ConfigFolder {
  const abs = normalizeFolder(dir, home);
  const isDefault = abs === join(home, '.claude');
  return {
    dir: abs,
    claudeJson: isDefault ? join(home, '.claude.json') : join(abs, '.claude.json'),
    projectsDir: join(abs, 'projects'),
    isDefault,
    origin: isDefault ? 'default' : origin,
  };
}

/** Folders listed in `perfis.json` (`{ "pastas": ["~/.claude-cliente"] }`). No file, none. */
export async function configuredFolders(file: string | null, home = homedir()): Promise<string[]> {
  if (!file) return [];
  try {
    const o = JSON.parse(await readFile(file, 'utf8')) as { pastas?: unknown };
    if (!Array.isArray(o?.pastas)) return [];
    return o.pastas.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => normalizeFolder(p.trim(), home));
  } catch {
    return [];
  }
}

/** Whether the folder exists and looks like a configuration folder: only `stat` and the entry list. */
export async function looksLikeConfigFolder(p: ConfigFolder): Promise<boolean> {
  try {
    if (!(await stat(p.dir)).isDirectory()) return false;
  } catch {
    return false;
  }
  if (p.isDefault) return true;
  try {
    const entries = new Set(await readdir(p.dir));
    return MARKERS.some((m) => entries.has(m));
  } catch {
    return false;
  }
}

export interface DiscoveryOptions {
  home?: string;
  /** `perfis.json`; `null` reads no configuration. */
  file?: string | null;
  /** Folders the hooks revealed (`CLAUDE_CONFIG_DIR`). */
  revealed?: Iterable<string>;
}

/**
 * This machine's configuration folders, without repeats: the default first, then the `~/.claude-*`
 * by name, the configured ones and the ones the hooks revealed. Only the ones that exist and have
 * the structure of a configuration folder come in.
 */
export async function discoverFolders({ home = homedir(), file = defaultProfilesFile(home), revealed = [] }: DiscoveryOptions = {}): Promise<ConfigFolder[]> {
  const candidates: ConfigFolder[] = [configFolder(join(home, '.claude'), 'default', home)];
  try {
    const names = (await readdir(home)).filter((n) => n.startsWith('.claude-')).sort();
    for (const n of names) candidates.push(configFolder(join(home, n), 'name', home));
  } catch {
    // Unreadable HOME: only the configured and the revealed ones.
  }
  for (const d of await configuredFolders(file, home)) candidates.push(configFolder(d, 'configured', home));
  for (const d of revealed) candidates.push(configFolder(d, 'hook', home));

  // A symlink and its target are the same folder: the real path decides what repeats.
  const seen = new Set<string>();
  const folders: ConfigFolder[] = [];
  for (const p of candidates) {
    if (!(await looksLikeConfigFolder(p))) continue;
    const real = await realpath(p.dir).catch(() => p.dir);
    if (seen.has(real)) continue;
    seen.add(real);
    folders.push(p);
  }
  return folders;
}
