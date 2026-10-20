// The commit of this core's code, so whoever starts can compare it with the running one: the
// `API_VERSION` changes rarely, and two checkouts of the same version can be very different code.

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: HERE, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** The short commit of this file's checkout, or `null` outside a repository (the packaged app). */
export function codeCommit(): string | null {
  return git(['rev-parse', '--short', 'HEAD']);
}

/** `true` if `other` is an older commit of this checkout (an ancestor of HEAD, and not HEAD itself). */
export function isOlderCommit(other: string): boolean {
  if (!/^[0-9a-f]{4,40}$/.test(other)) return false;
  const mine = git(['rev-parse', 'HEAD']);
  const theirs = git(['rev-parse', '--verify', '--quiet', `${other}^{commit}`]);
  if (!mine || !theirs || mine === theirs) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', theirs, mine], { cwd: HERE, timeout: 2_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
