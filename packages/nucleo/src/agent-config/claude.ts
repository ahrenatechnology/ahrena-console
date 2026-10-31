// Read-only declarations, never runtime or billing evidence. Raw values stay inside this module.
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Session } from '../model.ts';
import { rootIdFor } from './reading.ts';
import type { ConfigFolder } from '../profiles/discovery.ts';

const MASK = '••••';
const MAX_BYTES = 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export interface Declaration { itemCount?: number; key: string; value: string | number | boolean | null; sources: string[]; overridden: string[]; resolution: 'declared' | 'unknown'; confirmed: 'unknown' }
export interface ConfigLayer { id: string; kind: string; path: string | null; status: 'read' | 'absent' | 'unknown'; settings: Declaration[] }
const MODELS = /^(?:default|best|opusplan|sonnet|opus|haiku|fable|claude-(?:sonnet|opus|haiku|fable)-[0-9]+(?:-[0-9]+){0,3})(?:\[1m\])?$/;
const MODEL_KEYS = new Set(['model', 'env.ANTHROPIC_MODEL', 'env.ANTHROPIC_DEFAULT_MODEL', 'env.CLAUDE_CODE_SUBAGENT_MODEL']);
const NUMBER_KEYS = new Set(['autoCompactWindow', 'env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS']);
const AUTH_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const TOP_KEYS = new Set(['env', 'model', 'permissions', 'hooks', 'enabledPlugins', 'mcpServers', 'statusLine', 'outputStyle', 'apiKeyHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'availableModels', 'deniedModels', 'fallbackModel', 'modelPicker', 'modelSettings', 'autoCompactWindow', 'effortLevel', 'sandbox', 'disableAllHooks', 'allowManagedHooksOnly', 'allowManagedPermissionRulesOnly', 'allowManagedMcpServersOnly']);

function safeValue(key: string, value: unknown): Declaration['value'] {
  if (MODEL_KEYS.has(key) && typeof value === 'string' && MODELS.test(value)) return value;
  if (NUMBER_KEYS.has(key) && /^(?:\d{1,7})(?:\.\d{1,2})?$/.test(String(value)) && Number(value) > 0 && Number(value) <= (key.endsWith('PCT_OVERRIDE') ? 100 : 1000000)) return Number(value);
  // Even a benign-looking command, URL, custom model or unknown scalar can hold credentials.
  if (['disableAllHooks', 'allowManagedHooksOnly', 'allowManagedPermissionRulesOnly', 'allowManagedMcpServersOnly'].includes(key) && typeof value === 'boolean') return value;
  return MASK;
}

const SAFE_SEGMENTS = new Set([...TOP_KEYS, ...AUTH_KEYS, 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'allow', 'deny', 'ask', 'defaultMode', 'additionalDirectories', 'disableBypassPermissionsMode', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd', 'Notification', 'SubagentStart', 'SubagentStop', 'type', 'command', 'padding', 'url', 'headers', 'args', 'enabled', 'name']);
function declarations(raw: Record<string, unknown>, id: string, aliases: Map<string, string>): Declaration[] {
  const rows: Declaration[] = [];
  let visited = 0;
  const visit = (value: unknown, parts: string[], display: string[], depth: number) => {
    if (++visited > 2000) return;
    const key = display.join('.');
    if (depth < 8 && object(value) && Object.keys(value).length) {
      for (const [name, child] of Object.entries(value)) {
        const path = JSON.stringify([...parts, name]);
        let label = SAFE_SEGMENTS.has(name) ? name : aliases.get(path);
        if (!label) { label = `[entry ${aliases.size + 1}]`; aliases.set(path, label); }
        visit(child, [...parts, name], [...display, label], depth + 1);
      }
    } else {
      const entry = row(key, safeValue(parts.join('.'), value), id);
      if (Array.isArray(value)) entry.itemCount = value.length;
      if (Array.isArray(value) || object(value)) entry.resolution = 'unknown';
      rows.push(entry);
    }
  };
  visit(raw, [], [], 0);
  if (visited > 2000) rows.push({ ...row('[truncated]', MASK, id), resolution: 'unknown' });
  return rows;
}
function row(key: string, value: Declaration['value'], id: string): Declaration {
  return { key, value, sources: [id], overridden: [], resolution: 'declared', confirmed: 'unknown' };
}

async function readObject(path: string): Promise<{ status: ConfigLayer['status']; raw?: Record<string, unknown> }> {
  let file;
  try {
    // No devices, FIFOs, final symlinks or unbounded reads; parser errors never escape to HTTP/logs.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return { status: 'unknown' };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return { status: 'unknown' };
    const raw: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    return object(raw) ? { status: 'read', raw } : { status: 'unknown' };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' };
  } finally { await file?.close(); }
}

export function mergeDeclarations(layers: ConfigLayer[]): Declaration[] {
  const merged = new Map<string, Declaration>();
  for (const layer of layers) for (const next of layer.settings) {
    const previous = merged.get(next.key);
    // Compound settings have key-specific merge/trust/version rules. Do not invent a final value.
    const scalar = MODEL_KEYS.has(next.key) || NUMBER_KEYS.has(next.key) || next.key.startsWith('env.');
    merged.set(next.key, { ...next, itemCount: previous && !scalar ? undefined : next.itemCount, sources: scalar ? next.sources : [...(previous?.sources ?? []), ...next.sources], overridden: scalar ? [...(previous?.overridden ?? []), ...(previous?.sources ?? [])] : [], resolution: scalar ? 'declared' : 'unknown' });
  }
  return [...merged.values()];
}
/** Resolve an observed transcript origin, never an account's current login or an arbitrary request path. */
export async function sessionProfile(session: Session, folders: ClaudeConfigRequest['folders']): Promise<string | null> {
  const profiles = await Promise.all(folders.map(async f => ({ ...f, id: await rootIdFor('u', f.dir) })));
  if (session.identity?.profileId) return profiles.find(p => p.id === session.identity?.profileId)?.id ?? null;
  const metadata = session.metadata;
  const imported = object(metadata.import) ? metadata.import.file : null;
  const transcript = typeof metadata.transcriptPath === 'string' ? metadata.transcriptPath : typeof imported === 'string' && isAbsolute(imported) ? imported : null;
  if (!transcript || !isAbsolute(transcript)) return null;
  const matches = profiles.filter(p => {
    const path = relative(resolve(p.dir, 'projects'), resolve(transcript));
    return /^[^/\\]+[/\\][^/\\]+\.jsonl$/.test(path) && !path.startsWith('..');
  });
  return matches.length === 1 ? matches[0].id : null;
}
export interface ClaudeConfigRequest {
  folders: readonly Pick<ConfigFolder, 'dir' | 'claudeJson'>[];
  project: string | null;
  profile?: string | null;
  session?: boolean;
  unavailable?: boolean;
  home?: string;
  managedDir?: string;
  platform?: NodeJS.Platform;
}
export async function readClaudeConfig(opts: ClaudeConfigRequest) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const profiles = await Promise.all(opts.folders.map(async f => ({ id: await rootIdFor('u', f.dir), path: f.dir })));
  // An observed session without a proven profile does not inherit whichever login happens to be first.
  const selected = opts.profile ? profiles.find(p => p.id === opts.profile) : opts.session ? undefined : profiles.length === 1 ? profiles[0] : undefined;
  const layers: ConfigLayer[] = [];
  const aliases = new Map<string, string>();
  const diagnostics: { source: string; kind: string; present: true }[] = [];
  const add = async (id: string, kind: string, path: string, auxiliary = false) => {
    const result = await readObject(path);
    const raw = result.raw;
    const settings = raw ? auxiliary ? declarations(Object.fromEntries(Object.entries(raw).filter(([key]) => !['oauthAccount', 'userID', 'projects'].includes(key))), id, aliases) : declarations(raw, id, aliases) : [];
    layers.push({ id, kind, path, status: settings.some(r => r.key === '[truncated]') ? 'unknown' : result.status, settings });
    if (raw && !auxiliary) {
      const env = object(raw.env) ? raw.env : {};
      for (const key of AUTH_KEYS) if (Object.hasOwn(env, key)) diagnostics.push({ source: id, kind: key, present: true });
      if (Object.hasOwn(raw, 'apiKeyHelper')) diagnostics.push({ source: id, kind: 'apiKeyHelper', present: true });
    }
  };
  if (!opts.unavailable) {
    if (selected) await add('user', 'user', join(selected.path, 'settings.json'));
    else layers.push({ id: 'user', kind: 'user', path: null, status: 'unknown', settings: [] });
    if (opts.project) {
      await add('project', 'project', join(opts.project, '.claude', 'settings.json'));
      await add('local', 'local', join(opts.project, '.claude', 'settings.local.json'));
    }
    const managed = opts.managedDir ?? (platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code');
    await add('managed', 'managed', join(managed, 'managed-settings.json'));
    try {
      const files = (await readdir(join(managed, 'managed-settings.d'))).filter(n => !n.startsWith('.') && n.endsWith('.json')).sort();
      if (files.length > 50) layers.push({ id: 'managed-dropins', kind: 'managed', path: join(managed, 'managed-settings.d'), status: 'unknown', settings: [] });
      else for (const [i, name] of files.entries()) await add(`managed-${i}`, 'managed', join(managed, 'managed-settings.d', name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') layers.push({ id: 'managed-dropins', kind: 'managed', path: join(managed, 'managed-settings.d'), status: 'unknown', settings: [] });
    }
  }
  const declared = mergeDeclarations(layers);
  if (!opts.unavailable) {
    if (selected) {
      const path = opts.folders[profiles.indexOf(selected)].claudeJson;
      await add('global', 'auxiliary', path, true);
      if (opts.project) {
        const data = await readObject(path);
        const projects = data.raw && object(data.raw.projects) ? data.raw.projects : {};
        const project = object(projects[opts.project]) ? projects[opts.project] : {};
        if (object(project.mcpServers)) layers.push({ id: 'local-mcp', kind: 'auxiliary', path, status: data.status, settings: declarations({ mcpServers: project.mcpServers }, 'local-mcp', aliases) });
      }
    }
    if (opts.project) await add('project-mcp', 'auxiliary', join(opts.project, '.mcp.json'), true);
    if (platform === 'darwin') await add('desktop', 'auxiliary', join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), true);
  }
  return {
    version: 1, provider: 'claude', machine: 'local', readOnly: true, generatedAt: new Date().toISOString(),
    project: opts.unavailable ? null : opts.project, profiles: opts.unavailable ? [] : profiles, profile: selected?.id ?? null,
    availability: opts.unavailable ? 'unavailable' : 'available', layers, declared,
    runtime: { status: 'unknown', model: null, contextWindow: null, contextUsed: null, compactAt: null, remaining: null },
    diagnostics: { status: 'unknown', strictEligible: false, authSources: diagnostics, reasons: ['runtime-unobserved', 'launch-environment-unobserved', 'managed-policy-unobserved', ...(selected ? [] : ['profile-unresolved'])] },
  };
}
