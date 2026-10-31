// Passive filesystem inspection only. Never import runtime probes or return raw config values.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { which } from '../tools/login-path.ts';
import { passiveCodexVersion } from '../tools/probe.ts';
import { parse } from '../vendor/smol-toml/index.js';

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 200;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const opaque = (kind: string, value: string) => `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
const MASK = '••••';
type Status = 'read' | 'absent' | 'unknown';
export interface CodexDeclaration { key: string; value: string | boolean | number; source: string; confirmed: 'unknown' }
interface Layer { id: string; kind: string; path: string; status: Status; settings: CodexDeclaration[] }
interface Asset { id: string; kind: string; source: string; location: string; status: Status; applicability: 'unknown' }

/** Bound reads and reject links, devices and FIFOs. Raw parse errors never cross this boundary. */
async function textFile(path: string): Promise<{ status: Status; text?: string }> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES) return { status: 'unknown' };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return { status: 'unknown' };
    return { status: 'read', text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch (e) { return { status: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' }; }
  finally { await file?.close(); }
}
async function config(path: string) {
  const file = await textFile(path);
  if (file.text === undefined) return { status: file.status, raw: {} as Record<string, unknown> };
  try { return { status: 'read' as Status, raw: parse(file.text, { maxDepth: 64 }) as Record<string, unknown> }; }
  catch { return { status: 'unknown' as Status, raw: {} as Record<string, unknown> }; }
}
const ENUMS: Record<string, readonly string[]> = {
  approval_policy: ['untrusted', 'on-failure', 'on-request', 'never'],
  sandbox_mode: ['read-only', 'workspace-write', 'danger-full-access'],
  model_reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  web_search: ['disabled', 'cached', 'live'],
};
const KNOWN = new Set(['model', 'model_provider', 'model_providers', 'model_context_window', 'model_auto_compact_token_limit', 'model_instructions_file', 'developer_instructions', 'instructions', 'profile', 'profiles', 'mcp_servers', 'features', 'tools', 'skills', 'plugins', 'hooks', 'notify', 'shell_environment_policy', 'projects', 'permissions', 'sandbox_workspace_write', 'cli_auth_credentials_store', 'forced_login_method', ...Object.keys(ENUMS)]);
function declarations(raw: Record<string, unknown>, source: string): CodexDeclaration[] {
  return Object.entries(raw).slice(0, MAX_ENTRIES).map(([key, value]) => {
    let safe: CodexDeclaration['value'] = MASK;
    if (typeof value === 'string' && Object.hasOwn(ENUMS, key) && ENUMS[key].includes(value)) safe = value;
    if (['model_context_window', 'model_auto_compact_token_limit'].includes(key) && typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10000000) safe = value;
    return { key: KNOWN.has(key) ? key : opaque('entry', key), value: safe, source, confirmed: 'unknown' };
  });
}
async function entries(path: string): Promise<{ names: string[]; status: Status }> {
  try {
    // Parent directory links are not followed for asset enumeration.
    if (!(await lstat(path)).isDirectory()) return { names: [], status: 'unknown' };
    const names = await readdir(path);
    return { names: names.sort().slice(0, MAX_ENTRIES), status: names.length > MAX_ENTRIES ? 'unknown' : 'read' };
  } catch (e) { return { names: [], status: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' }; }
}
/** Find the nearest repository boundary without spawning git; never infer a root from an absent marker. */
async function projectChain(cwd: string): Promise<{ paths: string[]; complete: boolean }> {
  const paths: string[] = [];
  for (let path = resolve(cwd); paths.length < 32; path = dirname(path)) {
    paths.push(path);
    if (await lstat(join(path, '.git')).catch(() => null)) return { paths: paths.reverse(), complete: true };
    if (dirname(path) === path) break;
  }
  return { paths: [resolve(cwd)], complete: false };
}
export interface CodexConfigRequest {
  project: string | null;
  home?: string;
  codexHome?: string;
  systemDir?: string;
  /** Host-owned inherited PATH; no login shell or request-controlled executable. */
  path?: string;
  profile?: string | null;
  session?: boolean;
  unavailable?: boolean;
}
export async function readCodexConfig(opts: CodexConfigRequest) {
  const home = opts.home ?? homedir();
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  const systemDir = opts.systemDir ?? '/etc/codex';
  const layers: Layer[] = [];
  const profiles: { id: string; label: string; format: string; source: string }[] = [];
  const assets: Asset[] = [];
  const reasons = ['runtime-unobserved', 'launch-overrides-unobserved', 'managed-policy-unobserved', 'project-trust-unobserved', 'version-unobserved'];
  let selected: string | null = null;
  let installation: { status: string; version: string | null; evidence: string } = { status: 'unknown', version: null, evidence: 'unobserved' };
  const add = async (id: string, kind: string, path: string, display = path) => {
    const data = await config(path);
    const truncated = Object.keys(data.raw).length > MAX_ENTRIES || ['mcp_servers', 'profiles'].some(k => object(data.raw[k]) && Object.keys(data.raw[k]).length > MAX_ENTRIES);
    if (truncated) reasons.push('config-discovery-incomplete');
    if (data.status === 'unknown') reasons.push('config-source-unreadable');
    layers.push({ id, kind, path: display, status: truncated ? 'unknown' : data.status, settings: declarations(data.raw, id) });
    if (object(data.raw.mcp_servers)) for (const name of Object.keys(data.raw.mcp_servers).slice(0, MAX_ENTRIES)) {
      assets.push({ id: opaque('mcp', name), kind: 'mcp', source: id, location: 'mcp_servers', status: 'read', applicability: 'unknown' });
    }
    return data.raw;
  };
  const assetStat = async (path: string) => lstat(path).catch(e => {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') reasons.push('asset-discovery-incomplete');
    return null;
  });
  const instructions = async (base: string, source: string) => {
    // Presence/size only; never read instruction prose or follow imports/alternate configured paths.
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
      const info = await assetStat(join(base, name));
      if (info) assets.push({ id: opaque('instruction', `${base}/${name}`), kind: 'instructions', source, location: name, status: info.isFile() && info.nlink === 1 ? 'read' : 'unknown', applicability: 'unknown' });
    }
  };
  const skills = async (base: string, source: string) => {
    const listing = await entries(base);
    if (listing.status === 'unknown') reasons.push('skill-discovery-incomplete');
    for (const name of listing.names) {
      const dir = await assetStat(join(base, name));
      const info = dir?.isDirectory() ? await assetStat(join(base, name, 'SKILL.md')) : null;
      if (info || dir?.isSymbolicLink()) assets.push({ id: opaque('skill', `${base}/${name}`), kind: 'skill', source, location: '[skill]/SKILL.md', status: info?.isFile() && info.nlink === 1 ? 'read' : 'unknown', applicability: 'unknown' });
    }
  };
  if (!opts.unavailable) {
    // Unknown session home/profile must not inherit the host's currently selected Codex login.
    if (!opts.session) {
      const searchPath = opts.path ?? [process.env.PATH ?? '', join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].join(delimiter);
      const binary = await which('codex', searchPath);
      const installedVersion = binary ? await passiveCodexVersion(await realpath(binary).catch(() => binary)) : null;
      installation = { status: binary ? 'found' : 'not-found-on-path', version: installedVersion, evidence: installedVersion ? 'npm-package-metadata' : 'filesystem-path-only' };
      await add('system', 'system', join(systemDir, 'config.toml'));
      const raw = await add('user', 'user', join(codexHome, 'config.toml'));
      const listing = await entries(codexHome);
      if (listing.status === 'unknown') reasons.push('profile-discovery-incomplete');
      const candidates = new Map<string, string>();
      for (const file of listing.names.filter(n => /^[A-Za-z0-9_-]+\.config\.toml$/.test(n))) {
        const id = opaque('profile', file);
        profiles.push({ id, label: `Perfil ${profiles.length + 1}`, format: 'file-since-0.134', source: 'user' });
        candidates.set(id, file);
      }
      if (object(raw.profiles)) for (const key of Object.keys(raw.profiles).slice(0, MAX_ENTRIES)) profiles.push({ id: opaque('legacy', key), label: `Perfil ${profiles.length + 1}`, format: 'legacy-before-0.134', source: 'user' });
      if (opts.profile && profiles.some(p => p.id === opts.profile)) {
        selected = opts.profile;
        const file = candidates.get(selected);
        if (file) await add(selected, 'profile', join(codexHome, file), `${codexHome}/[profile].config.toml`);
        else if (object(raw.profiles)) {
          const key = Object.keys(raw.profiles).find(k => opaque('legacy', k) === selected)!;
          layers.push({ id: selected, kind: 'legacy-profile', path: `${codexHome}/config.toml`, status: 'unknown', settings: object(raw.profiles[key]) ? declarations(raw.profiles[key], selected) : [] });
        }
      }
      await instructions(codexHome, 'user');
      await skills(join(home, '.agents', 'skills'), 'user-skills');
      await skills(join(systemDir, 'skills'), 'system-skills');
    } else reasons.push('session-home-and-profile-unresolved');
    if (opts.project) {
      const chain = await projectChain(opts.project);
      if (!chain.complete) reasons.push('project-root-unresolved');
      for (const [i, path] of chain.paths.entries()) {
        const id = `project-${i}`;
        await add(id, 'project', join(path, '.codex', 'config.toml'));
        await instructions(path, id);
        await skills(join(path, '.agents', 'skills'), id);
      }
    }
  }
  return {
    version: 1, provider: 'codex', machine: 'local', readOnly: true,
    availability: opts.unavailable ? 'unavailable' : 'available', project: opts.unavailable ? null : opts.project,
    installation, profiles, profile: selected, layers, declared: layers.flatMap(l => l.settings), assets,
    precedence: ['system', 'cloud-unknown', 'user', 'profile-version-dependent', 'trusted-project-root-to-cwd', 'cli-unknown'],
    runtime: { status: 'unknown', version: null, profile: null, model: null, tools: null },
    diagnostics: { status: 'unknown', strictEligible: false, reasons },
    warnings: [],
  };
}
