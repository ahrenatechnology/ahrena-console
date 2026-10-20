// The reading side of the Agent Config screen (#63): skills, subagents, commands, memory, hooks,
// MCP, plugins and settings files of each user configuration folder (profile, decision 0006) and
// of the project's `.claude`. Reads only what the contract asks for (model.ts): the frontmatter of
// skills and subagents, the hook event names, the keys of `mcpServers` and `enabledPlugins`. Never
// opens `.credentials.json`, never returns a settings value and does not read memory content. An
// unreadable file or broken JSON drops only that part of the response. The frontmatter of a `.md`
// that is a symlink out of its own folder is not read: the `description` would carry the target's text.

import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ConfigFolder } from '../profiles/discovery.ts';
import { readFrontmatter } from './frontmatter.ts';
import {
  AgentConfigError,
  type AgentConfig,
  type AgentConfigRoot,
  type AgentConfigScope,
  type Count,
  type ListedCommand,
  type ListedHook,
  type ListedMemory,
  type ListedSettings,
  type ListedSkill,
  type ListedSubagent,
} from './model.ts';
import { isSkillEditable } from './skills.ts';

/** The most entries read per folder (skills, agents, commands, memory): a huge folder does not stall the response. */
const MAX_PER_FOLDER = 500;
/** How much of the start of a `.md` is read to find the frontmatter. */
const MAX_FRONTMATTER = 32 * 1024;
const MAX_JSON = 8 * 1024 * 1024;
const MAX_COMMAND_DEPTH = 5;

export interface AgentConfigRequest {
  /** The known user configuration folders (profiles), in discovery order. */
  folders: readonly Pick<ConfigFolder, 'dir' | 'claudeJson'>[];
  /** The known project directories, most recent first (projects.ts). */
  projects: readonly string[];
  /** The request's `?project=`; `null` picks the most recent. */
  project?: string | null;
}

/**
 * The request's project root: `?project=` is only valid if it is among the known ones (else 400);
 * without it, the most recent, or none.
 */
export function chooseProject(requested: string | null | undefined, projects: readonly string[]): string | null {
  if (requested === null || requested === undefined || requested === '') return projects[0] ?? null;
  if (!projects.includes(requested)) throw new AgentConfigError(400, 'project: só um dos diretórios conhecidos (veja `projects`)');
  return requested;
}

/**
 * The root cards, with the contract's opaque ids. A project that is the parent folder of a home
 * (the project opened at `$HOME` itself) does not get the `p` root: `<project>/.claude` would be the
 * home again, everything would show up twice as Project and "New → Project" would write to the user.
 */
/**
 * A root's id: the kind's letter (`u` home, `c` `.claude.json`, `p` the project's `.claude`, `r` the
 * project) and a short hash of the real path. It does not depend on the discovery order: the id the
 * screen got still names the same folder on the POST, and a folder that is gone takes its id with
 * it (400), instead of the next one in the list taking its place.
 */
export async function rootIdFor(letter: 'u' | 'c' | 'p' | 'r', path: string): Promise<string> {
  return `${letter}-${createHash('sha256').update(await stablePath(resolve(path))).digest('hex').slice(0, 12)}`;
}

/**
 * The real path, also for a path that does not exist yet (the project's `.claude` before the first
 * "New"): the real path of the nearest existing parent plus the rest. Creating the folder keeps the id.
 */
async function stablePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await stablePath(parent), basename(path));
  }
}

export async function rootsFor(folders: AgentConfigRequest['folders'], project: string | null): Promise<AgentConfigRoot[]> {
  const several = folders.length > 1;
  const roots: AgentConfigRoot[] = [];
  for (const f of folders) {
    const suffix = several ? ` · ${basename(f.dir)}` : '';
    roots.push({ id: await rootIdFor('u', f.dir), scope: 'user', kind: 'home', label: `Claude home${suffix}`, path: f.dir });
    if (await isFile(f.claudeJson)) roots.push({ id: await rootIdFor('c', f.claudeJson), scope: 'user', kind: 'claude-json', label: `.claude.json${suffix}`, path: f.claudeJson });
  }
  if (project) {
    const projectClaude = join(project, '.claude');
    const real = await realPath(projectClaude);
    const isHome = (await Promise.all(folders.map((f) => realPath(f.dir)))).includes(real);
    if (!isHome) roots.push({ id: await rootIdFor('p', projectClaude), scope: 'project', kind: 'project-claude', label: '.claude do projeto', path: projectClaude });
    roots.push({ id: await rootIdFor('r', project), scope: 'project', kind: 'project', label: `Projeto · ${basename(project)}`, path: project });
  }
  return roots;
}

export async function readAgentConfig(request: AgentConfigRequest): Promise<AgentConfig> {
  const project = chooseProject(request.project, request.projects);
  const roots = await rootsFor(request.folders, project);
  const r: Omit<AgentConfig, 'summary'> = {
    project,
    projects: [...request.projects],
    roots,
    skills: [],
    subagents: [],
    commands: [],
    memory: [],
    mcp: [],
    plugins: [],
    hooks: [],
    settings: [],
    editing: true,
  };
  const hooks = new Map<string, ListedHook>();
  const seen = new Set<string>();
  const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));

  // The folders holding skills, agents, commands and settings: each home and the project's `.claude`.
  const claudeFolders = roots.filter((x) => x.kind === 'home' || x.kind === 'project-claude');
  for (const root of claudeFolders) {
    r.skills.push(...(await readSkills(root)));
    r.subagents.push(...(await readSubagents(root)));
    r.commands.push(...(await readCommands(root)));
    for (const file of ['settings.json', 'settings.local.json'] as const) {
      const path = join(root.path, file);
      const settings = await readJsonWithoutValues(path);
      if (settings === undefined) continue;
      r.settings.push({ file, scope: root.scope, path });
      if (!settings) continue;
      for (const [event, count] of hooksOf(settings)) {
        const k = `${root.scope}\0${event}`;
        const h = hooks.get(k) ?? { event, count: 0, scope: root.scope };
        h.count += count;
        hooks.set(k, h);
      }
      for (const name of pluginsOf(settings)) if (once(`plugin\0${root.scope}\0${name}`)) r.plugins.push({ name, scope: root.scope });
    }
  }

  // Each user folder: its CLAUDE.md, the `.claude.json` (user and project MCP) and the project's
  // automatic memory, which Claude Code keeps inside it.
  for (const f of request.folders) {
    const claudeMd = join(f.dir, 'CLAUDE.md');
    if (await isFile(claudeMd)) r.memory.push({ name: 'CLAUDE.md', scope: 'user', path: claudeMd, kind: 'instructions' });
    const claudeJson = await readJsonWithoutValues(f.claudeJson);
    if (claudeJson !== undefined) r.settings.push({ file: '.claude.json', scope: 'user', path: f.claudeJson });
    if (claudeJson) {
      for (const name of keysOf(claudeJson.mcpServers)) if (once(`mcp\0user\0.claude.json\0${name}`)) r.mcp.push({ name, scope: 'user', source: '.claude.json' });
      const ofProject = project ? object(object(claudeJson.projects)?.[project]) : null;
      for (const name of keysOf(ofProject?.mcpServers)) if (once(`mcp\0project\0.claude.json\0${name}`)) r.mcp.push({ name, scope: 'project', source: '.claude.json' });
    }
    if (project) r.memory.push(...(await readAutoMemory(f.dir, project)));
  }

  if (project) {
    // Without the `p` root (the project's `.claude` is a home), `.claude/CLAUDE.md` already came in as the user's.
    const hasProjectClaude = roots.some((x) => x.kind === 'project-claude');
    for (const path of [join(project, 'CLAUDE.md'), join(project, 'CLAUDE.local.md'), ...(hasProjectClaude ? [join(project, '.claude', 'CLAUDE.md')] : [])]) {
      if (await isFile(path)) r.memory.push({ name: relative(project, path), scope: 'project', path, kind: 'instructions' });
    }
    const mcpJson = await readJsonWithoutValues(join(project, '.mcp.json'));
    if (mcpJson) for (const name of keysOf(mcpJson.mcpServers)) if (once(`mcp\0project\0.mcp.json\0${name}`)) r.mcp.push({ name, scope: 'project', source: '.mcp.json' });
  }
  r.hooks.push(...hooks.values());

  const count = (list: readonly { scope: AgentConfigScope }[], weight: (x: never) => number = () => 1): Count => {
    const c = { total: 0, user: 0, project: 0 };
    for (const x of list) {
      const n = weight(x as never);
      c.total += n;
      c[x.scope] += n;
    }
    return c;
  };
  return {
    ...r,
    summary: {
      skills: count(r.skills),
      subagents: count(r.subagents),
      commands: count(r.commands),
      mcp: count(r.mcp),
      plugins: count(r.plugins),
      hooks: count(r.hooks, (h: ListedHook) => h.count),
      memory: count(r.memory),
      settings: count(r.settings),
    },
  };
}

async function readSkills(root: AgentConfigRoot): Promise<ListedSkill[]> {
  const folder = join(root.path, 'skills');
  const skills: ListedSkill[] = [];
  for (const name of (await entries(folder)).sort()) {
    const path = join(folder, name, 'SKILL.md');
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const fm = readFrontmatter(await headInside(path));
    const declared = text(fm.name);
    skills.push({
      name,
      declaredName: declared && declared !== name ? declared : null,
      description: text(fm.description),
      scope: root.scope,
      root: root.id,
      path,
      editedAt: Math.round(info.mtimeMs),
      editable: await isSkillEditable(root, name),
    });
  }
  return skills;
}

async function readSubagents(root: AgentConfigRoot): Promise<ListedSubagent[]> {
  const folder = join(root.path, 'agents');
  const list: ListedSubagent[] = [];
  for (const file of (await entries(folder)).filter((a) => a.endsWith('.md')).sort()) {
    const path = join(folder, file);
    if (!(await isFile(path))) continue;
    const fm = readFrontmatter(await headInside(path));
    list.push({ name: text(fm.name) ?? file.slice(0, -3), description: text(fm.description), scope: root.scope, root: root.id, path });
  }
  return list;
}

async function readCommands(root: AgentConfigRoot): Promise<ListedCommand[]> {
  const base = join(root.path, 'commands');
  const list: ListedCommand[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    for (const name of (await entries(folder)).sort()) {
      if (list.length >= MAX_PER_FOLDER) return;
      const path = join(folder, name);
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory() && depth < MAX_COMMAND_DEPTH) await walk(path, depth + 1);
      else if (info?.isFile() && name.endsWith('.md')) list.push({ name: relative(base, path).slice(0, -3).split(sep).join(':'), scope: root.scope, root: root.id, path });
    }
  };
  await walk(base, 0);
  return list;
}

/**
 * The project's automatic memory folder: `<configuration folder>/projects/<encoded cwd>/memory`,
 * with the cwd encoded the way Claude Code does it (every character outside `[A-Za-z0-9]` becomes `-`).
 * Only name and path of the `.md` files.
 */
export function autoMemoryDir(dir: string, project: string): string {
  return join(dir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
}

async function readAutoMemory(dir: string, project: string): Promise<ListedMemory[]> {
  const folder = autoMemoryDir(dir, project);
  const list: ListedMemory[] = [];
  for (const name of (await entries(folder)).filter((a) => a.endsWith('.md')).sort()) {
    const path = join(folder, name);
    if (await isFile(path)) list.push({ name, scope: 'project', path, kind: 'auto' });
  }
  return list;
}

/** The `hooks` events and how many hooks each has (`hooks.<Event>[].hooks[]`). No command leaves. */
function hooksOf(settings: Record<string, unknown>): [string, number][] {
  const hooks = object(settings.hooks);
  if (!hooks) return [];
  const events: [string, number][] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const count = groups.reduce((n: number, g) => n + (Array.isArray(object(g)?.hooks) ? (object(g)!.hooks as unknown[]).length : 0), 0);
    if (count > 0) events.push([event, count]);
  }
  return events;
}

/** The enabled `enabledPlugins` keys. The value-free parse (below) swaps `true` for a marker. */
function pluginsOf(settings: Record<string, unknown>): string[] {
  const enabled = object(settings.enabledPlugins);
  return enabled ? Object.keys(enabled).filter((k) => enabled[k] === ENABLED) : [];
}

const ENABLED = 1;

/**
 * Reads a JSON keeping only its shape: objects, arrays, keys and the `ENABLED` marker in place of
 * `true`. Every string and number becomes nothing during the parse itself, so no value (`env`,
 * `command`, `url`, tokens, the `oauthAccount` e-mail) exists in the object that leaves here.
 * `undefined`: the file does not exist; `null`: it exists but is unreadable, too big or not a JSON object.
 */
async function readJsonWithoutValues(path: string): Promise<Record<string, unknown> | null | undefined> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return undefined;
  if (info.size > MAX_JSON) return null;
  try {
    const o: unknown = JSON.parse(await readFile(path, 'utf8'), (_k, v: unknown) => (v === true ? ENABLED : v !== null && typeof v === 'object' ? v : undefined));
    return object(o);
  } catch {
    return null;
  }
}

function object(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function keysOf(v: unknown): string[] {
  const o = object(v);
  return o ? Object.keys(o) : [];
}

function text(v: string | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

async function entries(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((n) => !n.startsWith('.')).slice(0, MAX_PER_FOLDER);
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/** The real path; the path itself, absolute, if it does not exist. */
async function realPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/**
 * The start of the file, like `head`, only if it is not a symlink out of the folder it is in
 * (`skills/<name>/` or `agents/`); else `''`. A `SKILL.md -> ../../.credentials.json` stays
 * listed, but with nothing from the target; a hardlink too.
 */
async function headInside(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    // A hardlink to `.credentials.json` passes `realpath`: only `nlink` gives it away.
    if (info.isFile() && info.nlink > 1) return '';
    if (info.isSymbolicLink()) {
      const [real, folder] = await Promise.all([realpath(path), realpath(dirname(path))]);
      if (!real.startsWith(folder + sep)) return '';
    }
  } catch {
    return '';
  }
  return head(path);
}

/** The start of the file, where the frontmatter lives; `''` if unreadable. */
async function head(path: string): Promise<string> {
  try {
    const f = await open(path, 'r');
    try {
      const buf = Buffer.alloc(MAX_FRONTMATTER);
      const { bytesRead } = await f.read(buf, 0, MAX_FRONTMATTER, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await f.close();
    }
  } catch {
    return '';
  }
}
