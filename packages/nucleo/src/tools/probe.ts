// What is installed and where it came from (#280, decision 0014 section 2).
//
// - The binary is the probe's argv[0], looked up in the login PATH in JS (login-path.ts). Not found:
//   missing.
// - The probe runs the catalog's fixed argv with the binary's full path, through the injected runner
//   (`execFile`, no shell, 5 s); the version is the probe regex's first group over stdout and stderr.
// - The source is the `realpath` of the binary against each source's `binaryUnder` (in the catalog's
//   order, for this platform and arch): `/opt/homebrew/...` is Homebrew, `~/.local/share/fnm/...` is
//   fnm. No match: `manual` (no action). `{npmPrefix}` is the active Node's prefix, so a global npm
//   package is told apart from one of Homebrew.

import { realpath as fsRealpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { appliesTo, NPM_PREFIX_TOKEN, sourcesFor, type DetectedSourceId, type Platform, type ToolEntry, type ToolProbe } from './catalog.ts';
import { expandHome, which, type IsExecutable } from './login-path.ts';
import { PROBE_TIMEOUT_MS, toolsEnv, type ToolRunner } from './runner.ts';

export interface Detection {
  toolId: string;
  /** The installed version, or `null` (missing, or the probe failed). */
  installed: string | null;
  binaryPath: string | null;
  realPath: string | null;
  sourceId: DetectedSourceId | null;
  /** `probe-failed` (it did not run), `no-version` (it ran, the regex did not match) or `null`. */
  probeError: string | null;
}

export interface ProbeContext {
  platform: Platform;
  arch: string;
  home: string;
  /** The login shell's PATH. */
  path: string;
  run: ToolRunner;
  env?: NodeJS.ProcessEnv;
  realpath?: (path: string) => Promise<string>;
  isExecutable?: IsExecutable;
  /** The active Node's prefix (`{npmPrefix}`), or `null` without Node. */
  npmPrefix?: string | null;
}

export function parseVersion(probe: ToolProbe, output: string): string | null {
  return probe.version.exec(output)?.[1] ?? null;
}

/** Paths compared with forward slashes; case-insensitive on Windows. */
function norm(p: string, platform: Platform): string {
  const s = platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p;
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

export function isUnder(path: string, prefix: string, platform: Platform): boolean {
  const a = norm(path, platform);
  const b = norm(prefix, platform);
  return a === b || a.startsWith(b === '/' ? '/' : `${b}/`);
}

/** The prefix of the Node at `nodeRealPath`: `<prefix>/bin/node` on Unix, `<prefix>\node.exe` on Windows. */
export function npmPrefixOf(nodeRealPath: string, platform: Platform): string {
  const P = platform === 'win32' ? win32 : posix;
  return platform === 'win32' ? P.dirname(nodeRealPath) : P.dirname(P.dirname(nodeRealPath));
}

export function detectSource(entry: ToolEntry, realPath: string, ctx: Pick<ProbeContext, 'platform' | 'arch' | 'home' | 'npmPrefix'>): DetectedSourceId {
  const sources = sourcesFor(entry, ctx.platform, ctx.arch);
  if (entry.anySourcePath) return sources[0]?.id ?? 'manual';
  for (const s of sources)
    for (const raw of s.binaryUnder) {
      const prefix = raw === NPM_PREFIX_TOKEN ? (ctx.npmPrefix ?? null) : expandHome(raw, ctx.home, ctx.platform);
      if (prefix && isUnder(realPath, prefix, ctx.platform)) return s.id;
    }
  return 'manual';
}

export async function probeTool(entry: ToolEntry, ctx: ProbeContext): Promise<Detection> {
  const none: Detection = { toolId: entry.id, installed: null, binaryPath: null, realPath: null, sourceId: null, probeError: null };
  if (!entry.probe || !appliesTo(entry, ctx.platform)) return none;
  const binaryPath = await which(entry.probe.argv[0]!, ctx.path, { platform: ctx.platform, ...(ctx.isExecutable ? { isExecutable: ctx.isExecutable } : {}) });
  if (!binaryPath) return none;
  const realPath = await (ctx.realpath ?? fsRealpath)(binaryPath).catch(() => binaryPath);
  const sourceId = detectSource(entry, realPath, ctx);
  const r = await ctx.run([binaryPath, ...entry.probe.argv.slice(1)], { timeoutMs: PROBE_TIMEOUT_MS, env: toolsEnv(ctx.path, ctx.env) }).catch(() => null);
  const installed = r ? parseVersion(entry.probe, `${r.stdout}\n${r.stderr}`) : null;
  const probeError = installed ? null : !r || (r.code === null && r.error) ? 'probe-failed' : 'no-version';
  return { toolId: entry.id, installed, binaryPath, realPath, sourceId, probeError };
}

/** Every entry's detection; Node first, since its prefix tells a global npm package apart. */
export async function probeAll(entries: readonly ToolEntry[], ctx: ProbeContext): Promise<Map<string, Detection>> {
  const out = new Map<string, Detection>();
  const node = entries.find((e) => e.id === 'node');
  let npmPrefix = ctx.npmPrefix ?? null;
  if (node) {
    const d = await probeTool(node, ctx);
    out.set(node.id, d);
    if (d.realPath && npmPrefix === null) npmPrefix = npmPrefixOf(d.realPath, ctx.platform);
  }
  const rest = entries.filter((e) => e !== node);
  const results = await Promise.all(rest.map((e) => probeTool(e, { ...ctx, npmPrefix })));
  for (const d of results) out.set(d.toolId, d);
  return out;
}
