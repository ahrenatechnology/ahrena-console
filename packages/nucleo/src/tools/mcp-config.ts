// The MCP servers of Claude Code for the Tools screen (#280, decision 0014 section 6): read from
// `~/.claude.json` (user scope `mcpServers`, local scope `projects[<path>].mcpServers`) and from the
// `.mcp.json` of each project the núcleo knows (the sessions' cwd, capped).
//
// SECRETS ARE DROPPED HERE, AT PARSE. Each server becomes a fresh object with only:
// - the name, the scope and the project's folder name (never its path);
// - the transport (stdio | http | sse);
// - the command's basename (not its args), and the npm package pinned in the args
//   (`@playwright/mcp@0.0.41` → `@playwright/mcp`, `0.0.41`);
// - the URL's host (with its port), never its path, query, fragment or userinfo;
// - the NAMES of `env` and `headers` and their counts.
// Every value of `env` and `headers`, every other arg and the rest of the URL are never copied,
// stored, cached, logged or returned. The parsed JSON is a local of the parse and is dropped with it.
//
// Files: `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) up to 32 MB; `.mcp.json` up to 256 KB,
// read only when it is a file inside the project (a symlink that leaves the project is not followed);
// at most 30 projects and 100 servers per file. A missing file is no error; a malformed or oversized
// one is skipped with a log line that names the file, never its content.

import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

export type McpScope = 'user' | 'local' | 'project';
export type McpTransport = 'stdio' | 'http' | 'sse';

/** One server as parsed: names and counts only. `key` is opaque (a hash of scope, project path and name). */
export interface McpServerConfig {
  key: string;
  name: string;
  scope: McpScope;
  project: string | null;
  transport: McpTransport;
  command: string | null;
  package: string | null;
  version: string | null;
  host: string | null;
  envCount: number;
  envNames: string[];
  headerCount: number;
  headerNames: string[];
}

export const MAX_CLAUDE_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_MCP_JSON_BYTES = 256 * 1024;
export const MAX_MCP_PROJECTS = 30;
export const MAX_SERVERS_PER_FILE = 100;
const MAX_NAMES = 64;

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** An npm package spec: `@scope/name` or `name`, then `@<version or tag>` (optional for a scoped one). */
const PACKAGE_SPEC = /^((?:@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213})(?:@([A-Za-z0-9._+-]{1,64}))?$/;
const PINNED_VERSION = /^\d+(\.\d+){0,3}$/;
const HOST = /^[A-Za-z0-9.:[\]-]{1,260}$/;

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

/** The folder name of a project (`~` for the home itself); never the path. */
function projectLabel(path: string, home: string): string {
  if (path.replace(/[\\/]+$/, '') === home.replace(/[\\/]+$/, '')) return '~';
  const name = baseName(path).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128);
  return name || '?';
}

/** The first npm package spec in the args, with its version only when it is a plain pinned one. */
export function packageOf(args: readonly unknown[]): { package: string | null; version: string | null } {
  for (const a of args) {
    if (typeof a !== 'string') continue;
    const m = PACKAGE_SPEC.exec(a);
    if (!m) continue;
    const [, name, version] = m;
    // An unscoped bare word (`-y`, `stdio`, a path) could be anything: only `name@version` counts.
    if (!name!.startsWith('@') && version === undefined) continue;
    return { package: name!, version: version !== undefined && PINNED_VERSION.test(version) ? version : null };
  }
  return { package: null, version: null };
}

/** The host (and port) of an http(s) URL; nothing else of it. */
function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return HOST.test(u.host) ? u.host : null;
  } catch {
    return null;
  }
}

/** Names of an object's keys that match `pattern` (capped), and how many keys it has. */
function namesOf(v: unknown, pattern: RegExp): { count: number; names: string[] } {
  const o = asObject(v);
  if (!o) return { count: 0, names: [] };
  const keys = Object.keys(o);
  return { count: keys.length, names: keys.filter((k) => pattern.test(k)).slice(0, MAX_NAMES) };
}

/** One server entry into a fresh object of names and counts; `null` when it is not a server. */
export function parseServer(name: string, raw: unknown, scope: McpScope, projectPath: string | null, home: string): McpServerConfig | null {
  if (!SERVER_NAME.test(name)) return null;
  const o = asObject(raw);
  if (!o) return null;
  const type = o.type;
  let transport: McpTransport;
  if (type === 'stdio' || type === 'http' || type === 'sse') transport = type;
  else if (type !== undefined) return null; // sse-ide, ws-ide…: Claude Code's own, not configured servers
  else if (typeof o.command === 'string') transport = 'stdio';
  else if (typeof o.url === 'string') transport = 'http';
  else return null;

  let command: string | null = null;
  let pkg = { package: null as string | null, version: null as string | null };
  let host: string | null = null;
  if (transport === 'stdio') {
    if (typeof o.command !== 'string') return null;
    const base = baseName(o.command.trim()).replace(/\.(exe|cmd|bat)$/i, '');
    command = COMMAND_NAME.test(base) ? base : null;
    pkg = packageOf(Array.isArray(o.args) ? o.args : []);
  } else {
    host = hostOf(o.url);
  }
  const env = namesOf(o.env, ENV_NAME);
  const headers = transport === 'stdio' ? { count: 0, names: [] } : namesOf(o.headers, HEADER_NAME);
  const key = createHash('sha256').update(`${scope}\0${projectPath ?? ''}\0${name}`).digest('hex').slice(0, 12);
  return {
    key,
    name,
    scope,
    project: projectPath === null ? null : projectLabel(projectPath, home),
    transport,
    command,
    package: pkg.package,
    version: pkg.version,
    host,
    envCount: env.count,
    envNames: env.names,
    headerCount: headers.count,
    headerNames: headers.names,
  };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function serversOf(v: unknown, scope: McpScope, projectPath: string | null, home: string): McpServerConfig[] {
  const o = asObject(v);
  if (!o) return [];
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(o)) {
    if (out.length >= MAX_SERVERS_PER_FILE) break;
    const s = parseServer(name, raw, scope, projectPath, home);
    if (s) out.push(s);
  }
  return out;
}

/** `~/.claude.json`: the user scope, then each project's local scope (at most `maxProjects` projects with servers). */
export function parseClaudeJson(text: string, o: { home: string; maxProjects?: number }): McpServerConfig[] {
  const json = parseJson(text);
  return json ? claudeJsonServers(json, o) : [];
}

function claudeJsonServers(json: Record<string, unknown>, o: { home: string; maxProjects?: number }): McpServerConfig[] {
  const out = serversOf(json.mcpServers, 'user', null, o.home);
  const projects = asObject(json.projects);
  let taken = 0;
  for (const [path, p] of Object.entries(projects ?? {})) {
    if (taken >= (o.maxProjects ?? MAX_MCP_PROJECTS)) break;
    const servers = serversOf(asObject(p)?.mcpServers, 'local', path, o.home);
    if (servers.length === 0) continue;
    taken++;
    out.push(...servers);
  }
  return out;
}

/** A project's `.mcp.json`: the project scope. */
export function parseMcpJson(text: string, projectPath: string, home: string): McpServerConfig[] {
  const json = parseJson(text);
  return json ? serversOf(json.mcpServers, 'project', projectPath, home) : [];
}

/** `null` when the text is not a JSON object. */
function parseMcpJsonOrNull(text: string, projectPath: string, home: string): McpServerConfig[] | null {
  const json = parseJson(text);
  return json ? serversOf(json.mcpServers, 'project', projectPath, home) : null;
}

export interface ReadMcpOptions {
  home: string;
  /** `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`. */
  claudeJsonPath: string;
  /** The projects whose `.mcp.json` is read (the sessions' cwd, most recent first). */
  projects: readonly string[];
  maxProjects?: number;
  maxClaudeJsonBytes?: number;
  log?: (message: string) => void;
}

type Read = { text: string } | { skipped: 'missing' | 'not-a-file' | 'too-large' | 'outside' | 'unreadable' };

/** Reads at most `max` bytes of a regular file; more than that is `too-large` (also when it grew after the stat). */
async function readCapped(path: string, max: number): Promise<Read> {
  const st = await stat(path).catch(() => null);
  if (!st) return { skipped: 'missing' };
  if (!st.isFile()) return { skipped: 'not-a-file' };
  if (st.size > max) return { skipped: 'too-large' };
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return { skipped: 'unreadable' };
  try {
    const buf = Buffer.alloc(Math.min(max, st.size) + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total >= buf.length) return { skipped: 'too-large' };
    }
    return { text: buf.subarray(0, total).toString('utf8') };
  } catch {
    return { skipped: 'unreadable' };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A project's `.mcp.json`, only when it is (or links to) a file inside the project. */
async function readProjectFile(project: string): Promise<Read> {
  const path = join(project, '.mcp.json');
  const l = await lstat(path).catch(() => null);
  if (!l) return { skipped: 'missing' };
  if (l.isSymbolicLink()) {
    const [target, root] = await Promise.all([realpath(path).catch(() => null), realpath(project).catch(() => null)]);
    if (!target || !root) return { skipped: 'missing' };
    if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) return { skipped: 'outside' };
    return readCapped(target, MAX_MCP_JSON_BYTES);
  }
  return readCapped(path, MAX_MCP_JSON_BYTES);
}

const SKIP_REASON: Record<string, string> = {
  'not-a-file': 'is not a file',
  'too-large': 'is larger than the limit',
  outside: 'links outside the project',
  unreadable: 'could not be read',
};

/** Every server of Claude Code's configuration, deduplicated, in file order (user, local, project). */
export async function readMcpServers(o: ReadMcpOptions): Promise<McpServerConfig[]> {
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  const add = (list: McpServerConfig[]) => {
    for (const s of list) if (!seen.has(s.key)) (seen.add(s.key), out.push(s));
  };
  const skipped = (file: string, r: Read) => {
    if ('skipped' in r && r.skipped !== 'missing') o.log?.(`tools: MCP config ${file} ${SKIP_REASON[r.skipped]}; skipped`);
  };

  const claude = await readCapped(o.claudeJsonPath, o.maxClaudeJsonBytes ?? MAX_CLAUDE_JSON_BYTES);
  if ('text' in claude) {
    const json = parseJson(claude.text);
    if (json) add(claudeJsonServers(json, { home: o.home, maxProjects: o.maxProjects ?? MAX_MCP_PROJECTS }));
    else o.log?.('tools: MCP config .claude.json is not a JSON object; skipped');
  } else skipped('.claude.json', claude);

  const projects = [...new Set(o.projects)].slice(0, o.maxProjects ?? MAX_MCP_PROJECTS);
  for (const project of projects) {
    const r = await readProjectFile(project);
    const label = `.mcp.json of ${projectLabel(project, o.home)}`;
    if (!('text' in r)) {
      skipped(label, r);
      continue;
    }
    const list = parseMcpJsonOrNull(r.text, project, o.home);
    if (list) add(list);
    else o.log?.(`tools: MCP config ${label} is not a JSON object; skipped`);
  }
  return out;
}
