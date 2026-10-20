// Reading and writing a skill (#63, wireframe C17): the only content the Agent Config screen opens
// and the only file it writes. The defenses apply to both routes:
//
// - the name matches `SKILL_NAME` and has no `..`: it is never a path;
// - the root is a known id, of kind `home` or `project-claude` (never a path from the request);
// - the `skills` folder, the skill folder and any existing `SKILL.md` have their `realpath` inside
//   the root's `realpath`: a symlink pointing out is refused (403);
// - a `SKILL.md` that is a symlink is refused (403) on read and on write, even pointing inside the
//   root (a link to the home's `.credentials.json` would leak through the GET), and its `realpath`
//   stays inside the skill folder's; reading opens with `O_NOFOLLOW` (macOS and Linux; the flag
//   does not exist on Windows); a hardlink (`nlink > 1`) is refused too (403);
// - only a file named `SKILL.md` is written, at most `MAX_CONTENT` bytes, through the atomic path
//   (temporary file in the same folder + `rename`; on `create`, `link`, which does not overwrite);
// - an existing skill gets a backup first, in the core's backups folder; a `version` that came and
//   does not match the current one gives 409 without writing (someone edited it elsewhere); `create`
//   with the skill already existing also gives 409, checked inside the file's queue.
//
// Deleting is out of scope (#63): too risky for this delivery.

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { AgentConfigError, type AgentConfigScope, type AgentConfigRoot } from './model.ts';

/** Writable skill name: lowercase, digits, `.`, `_` and `-`; up to 64; no `..` (checked separately). */
export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The largest accepted `SKILL.md`, in bytes. */
export const MAX_CONTENT = 256 * 1024;
/** A hardlink passes `lstat` and `realpath`; only `nlink` gives it away (a link to `.credentials.json`). */
const HARDLINK = 'SKILL.md tem outro nome no disco (hardlink): edite o arquivo de origem';

export function defaultBackupsDir(home = homedir()): string {
  return join(home, '.ahrena-console', 'backups');
}

export interface ReadSkill {
  root: string;
  name: string;
  scope: AgentConfigScope;
  path: string;
  content: string;
  /** sha256 of the content, in hex: what the `POST` sends back to prove it read the latest. */
  version: string;
  editedAt: number;
}

export interface SavedSkill {
  ok: true;
  path: string;
  backup: string | null;
  version: string;
  editedAt: number;
}

export interface WriteRequest {
  root: AgentConfigRoot;
  name: unknown;
  content: unknown;
  version?: unknown;
  /** Create only (the screen's "Nova"): an existing skill gives 409 instead of being replaced. */
  create?: boolean;
  /** The backups folder (default `~/.ahrena-console/backups`). */
  backups: string;
  now?: () => Date;
}

export const versionOf = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

/** The validated name, or 400. */
export function validateName(name: unknown): string {
  if (typeof name !== 'string' || !SKILL_NAME.test(name) || name.includes('..')) {
    throw new AgentConfigError(400, 'name: minúsculas, dígitos, ".", "_" e "-", até 64, sem ".."');
  }
  return name;
}

/** The root by id, among the known ones; only `home` and `project-claude` take skills. */
export function skillRoot(id: unknown, roots: readonly AgentConfigRoot[]): AgentConfigRoot {
  const root = typeof id === 'string' ? roots.find((r) => r.id === id) : undefined;
  if (!root || (root.kind !== 'home' && root.kind !== 'project-claude')) throw new AgentConfigError(400, 'root: um id de `roots` do tipo home ou project-claude');
  return root;
}

/** The real path of `path`, which must stay inside `realRoot`; `null` if it does not exist. */
async function realInside(realRoot: string, path: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (!real.startsWith(realRoot + sep)) throw new AgentConfigError(403, 'fora da raiz: a skill aponta (symlink) para fora da pasta de configuração');
  return real;
}

/** The skill's paths, checked against the root. `create` makes the missing folders. */
async function skillPaths(root: AgentConfigRoot, name: string, create: boolean): Promise<{ folder: string; file: string } | null> {
  if (create && root.kind === 'project-claude') {
    // The project's `.claude` may not exist yet: it is born inside the project, which must exist.
    if (!(await stat(dirname(root.path)).catch(() => null))?.isDirectory()) throw new AgentConfigError(404, 'o projeto não existe mais');
    await mkdir(root.path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }
  const realRoot = await realpath(root.path).catch(() => null);
  if (!realRoot) {
    if (create) throw new AgentConfigError(404, 'a pasta da raiz não existe');
    return null;
  }
  // The project's `.claude` as a symlink out of the project (a cloned repository may bring one)
  // would land the "project" skill in another folder, even the user's.
  if (root.kind === 'project-claude') {
    const realProject = await realpath(dirname(root.path)).catch(() => null);
    if (!realProject || !realRoot.startsWith(realProject + sep)) throw new AgentConfigError(403, 'fora da raiz: a .claude do projeto aponta (symlink) para fora dele');
  }
  const skills = join(root.path, 'skills');
  const folder = join(skills, name);
  for (const p of [skills, folder]) {
    if (await realInside(realRoot, p)) {
      if (!(await stat(p)).isDirectory()) throw new AgentConfigError(400, `${basename(p)} não é uma pasta`);
      continue;
    }
    if (!create) return null;
    await mkdir(p).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    // Created just now (or by someone else at the same time): check again.
    await realInside(realRoot, p);
  }
  const file = join(folder, 'SKILL.md');
  const info = await lstat(file).catch(() => null);
  if (info?.isSymbolicLink()) throw new AgentConfigError(403, 'SKILL.md é um symlink: edite o arquivo de destino');
  if (info && !info.isFile()) throw new AgentConfigError(400, 'SKILL.md não é um arquivo');
  if (info && info.nlink > 1) throw new AgentConfigError(403, HARDLINK);
  // The file stays inside the skill folder, not only inside the root.
  if (info) await realInside(await realpath(folder), file);
  return { folder, file };
}

/**
 * Whether writing would accept this skill: the name passes, the folders stay inside the root and
 * `SKILL.md` is not a symlink. It is the listing's `editable`, with the same rules as writing.
 */
export async function isSkillEditable(root: AgentConfigRoot, name: string): Promise<boolean> {
  try {
    validateName(name);
    return (await skillPaths(root, name, false)) !== null;
  } catch {
    return false;
  }
}

/** Writes queued per file: two on the same `SKILL.md` do not pass the version check together. */
const queues = new Map<string, Promise<unknown>>();

export async function readSkill(root: AgentConfigRoot, requestedName: unknown): Promise<ReadSkill | null> {
  const name = validateName(requestedName);
  const c = await skillPaths(root, name, false);
  if (!c) return null;
  // `O_NOFOLLOW`: a symlink placed between the check and the open is not followed (ELOOP).
  let f: Awaited<ReturnType<typeof open>>;
  try {
    f = await open(c.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new AgentConfigError(403, 'SKILL.md é um symlink: edite o arquivo de destino');
    throw e;
  }
  let bytes: Buffer;
  let info: Awaited<ReturnType<typeof f.stat>>;
  try {
    info = await f.stat();
    if (!info.isFile()) throw new AgentConfigError(400, 'SKILL.md não é um arquivo');
    if (info.nlink > 1) throw new AgentConfigError(403, HARDLINK);
    bytes = await f.readFile();
  } finally {
    await f.close();
  }
  return { root: root.id, name, scope: root.scope, path: c.file, content: bytes.toString('utf8'), version: versionOf(bytes), editedAt: Math.round(info.mtimeMs) };
}

/**
 * Writes `SKILL.md`: creates a skill that does not exist (the "Nova", `backup: null`), or backs up
 * the current one and replaces it. A `version` that came and does not match the current one (or
 * came for a skill that does not exist): 409, nothing written.
 */
export async function writeSkill(p: WriteRequest): Promise<SavedSkill> {
  const name = validateName(p.name);
  if (typeof p.content !== 'string') throw new AgentConfigError(400, 'content: o texto do SKILL.md');
  if (Buffer.byteLength(p.content) > MAX_CONTENT) throw new AgentConfigError(413, `content: no máximo ${MAX_CONTENT / 1024} KiB`);
  if (p.version !== undefined && p.version !== null && typeof p.version !== 'string') throw new AgentConfigError(400, 'version: a `version` lida no GET');
  const requestedVersion = typeof p.version === 'string' ? p.version : null;

  const { folder, file } = (await skillPaths(p.root, name, true))!;
  const previous = queues.get(file) ?? Promise.resolve();
  // The `create` check lives in `writeNow`, already inside the queue: outside it, two "Nova" at once
  // would both pass the check and the second would replace the first.
  const done = previous.catch(() => undefined).then(() => writeNow(p, name, folder, file, requestedVersion, p.content as string));
  const end = done.catch(() => undefined);
  queues.set(file, end);
  void end.then(() => {
    if (queues.get(file) === end) queues.delete(file);
  });
  return done;
}

async function writeNow(p: WriteRequest, name: string, folder: string, file: string, requestedVersion: string | null, content: string): Promise<SavedSkill> {
  const current = await readFile(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (p.create && current) throw new AgentConfigError(409, 'a skill já existe');
  if (requestedVersion !== null && (!current || versionOf(current) !== requestedVersion)) {
    throw new AgentConfigError(409, current ? 'a skill mudou desde a leitura: releia antes de gravar' : 'a skill não existe mais');
  }

  let backup: string | null = null;
  if (current) {
    const now = (p.now ?? (() => new Date()))();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    backup = join(p.backups, stamp.slice(0, 10), safeFolderFor(p.root), name, `SKILL.md.bak-${stamp}-${randomBytes(3).toString('hex')}`);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await writeFile(backup, current, { flag: 'wx', mode: 0o600 });
  }

  const tmp = join(folder, `.SKILL.md.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmp, content, { flag: 'wx', mode: 0o644 });
    // On `create`, `link` instead of `rename`: fails (EEXIST) if another process created the skill
    // after the check, instead of overwriting it.
    if (p.create) {
      await link(tmp, file).catch((e: NodeJS.ErrnoException) => {
        throw e.code === 'EEXIST' ? new AgentConfigError(409, 'a skill já existe') : e;
      });
    } else await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  const info = await stat(file);
  return { ok: true, path: file, backup, version: versionOf(content), editedAt: Math.round(info.mtimeMs) };
}

/**
 * A folder name for a root's backups: the last two parts of the path, readable, and a piece of the
 * hash of the whole path (two roots with the same name do not mix). The id is short and opaque; the
 * readable part says which folder it is.
 */
function safeFolderFor(root: AgentConfigRoot): string {
  const readable = `${basename(dirname(root.path))}_${basename(root.path)}`.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return `${readable.slice(0, 80)}-${versionOf(root.path).slice(0, 8)}`;
}
