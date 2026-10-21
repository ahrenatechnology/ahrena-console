// The newest version of each source (#280, decision 0014 section 2, the table): from the manager's
// metadata, never by downloading the package. Every process goes through the injected runner and every
// HTTP read through the injected fetch, both with a timeout.
//
// | kind            | how                                                          | network |
// | homebrew(-cask) | `brew info --json=v2 [--cask] <name>`, HOMEBREW_NO_AUTO_UPDATE=1 | no (the check runs `brew update` first) |
// | apt             | `apt-cache policy <package>`, Candidate, from the local lists  | no      |
// | winget          | `winget show --id <id> --exact --disable-interactivity`       | yes     |
// | npm             | `npm view <package> version`                                  | yes     |
// | fnm-lts         | `fnm list-remote --lts`, the last one                         | yes     |
// | rustup          | `rustup check`, the stable line                               | yes     |
// | uv-python       | `uv python list`, the newest stable CPython                   | yes     |
// | claude-channel  | the native installer's channel, as `claude update` reads it   | yes     |
// | go-dl           | `https://go.dev/dl/?mode=json`, the first stable              | yes     |
// | aws-changelog   | the AWS CLI v2 changelog, the first version heading           | yes     |
//
// These run only on an explicit check (`ToolsService.check()`); `GET /api/tools` reads the cache.

import type { LatestSpec } from './catalog.ts';
import { FETCH_TIMEOUT_MS, LATEST_TIMEOUT_MS, toolsEnv, type FetchText, type ToolRunner } from './runner.ts';

export const GO_DL_URL = 'https://go.dev/dl/?mode=json';
export const AWS_CHANGELOG_URL = 'https://raw.githubusercontent.com/aws/aws-cli/v2/CHANGELOG.rst';
export const CLAUDE_CHANNEL_URL = 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest';

export interface LatestDeps {
  run: ToolRunner;
  fetchText: FetchText;
  /** The login PATH, for the processes' environment. */
  path: string;
  /** The full path of a manager's executable on the login PATH, or `null`. */
  resolve: (name: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

export interface LatestResult {
  version: string | null;
  /** `no-manager`, `command-failed`, `unparsable`, `network` or `null`. */
  error: string | null;
}

export function usesNetwork(spec: LatestSpec): boolean {
  return spec.kind !== 'homebrew' && spec.kind !== 'homebrew-cask' && spec.kind !== 'apt';
}

/** Numeric comparison, part by part (`1.10` > `1.9`); missing parts are 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const newest = (versions: string[]): string | null => versions.reduce<string | null>((m, v) => (m === null || compareVersions(v, m) > 0 ? v : m), null);

/** `brew info --json=v2`: the formula's stable version, or the cask's (before a comma). */
export function parseBrewInfo(out: string, spec: { formula: string } | { cask: string }): string | null {
  try {
    const j = JSON.parse(out) as { formulae?: { name?: string; versions?: { stable?: string } }[]; casks?: { token?: string; version?: string }[] };
    if ('formula' in spec) return j.formulae?.find((f) => f.name === spec.formula)?.versions?.stable ?? null;
    const v = j.casks?.find((c) => c.token === spec.cask)?.version;
    return v ? (v.split(',')[0] ?? null) : null;
  } catch {
    return null;
  }
}

/** A Debian version without epoch and revision: `1:2.43.0-1ubuntu7.3` → `2.43.0`. */
export function debianUpstream(v: string): string | null {
  return /^(?:\d+:)?(\d+(?:\.\d+)*)/.exec(v)?.[1] ?? null;
}

/** `apt-cache policy`: the Candidate line. */
export function parseAptPolicy(out: string): string | null {
  const c = /^\s*Candidate:\s*(\S+)/m.exec(out)?.[1];
  return c && c !== '(none)' ? debianUpstream(c) : null;
}

export function parseWingetShow(out: string): string | null {
  return /^\s*Version:\s*(\S+)/m.exec(out)?.[1] ?? null;
}

export function parseNpmView(out: string): string | null {
  return /^"?(\d+(?:\.\d+)*)"?$/.exec(out.trim())?.[1] ?? null;
}

/** `fnm list-remote --lts`: `v24.11.0 (Krypton)` per line; the newest. */
export function parseFnmLts(out: string): string | null {
  return newest([...out.matchAll(/^\s*v(\d+\.\d+\.\d+)/gm)].map((m) => m[1]!));
}

/** `rustup check`: `stable-<host> - Update available : 1.90.0 (…) -> 1.91.0 (…)` or `- Up to date : 1.91.0 (…)`. */
export function parseRustupCheck(out: string): string | null {
  const line = out.split('\n').find((l) => l.startsWith('stable-'));
  if (!line) return null;
  return /->\s*(\d+\.\d+\.\d+)/.exec(line)?.[1] ?? /Up to date\s*:\s*(\d+\.\d+\.\d+)/.exec(line)?.[1] ?? null;
}

/** `uv python list`: the newest stable CPython (no pre-release, no freethreaded build). */
export function parseUvPythonList(out: string): string | null {
  return newest([...out.matchAll(/^cpython-(\d+\.\d+\.\d+)-/gm)].map((m) => m[1]!));
}

/** go.dev's JSON: the first stable release, `go1.25.3` → `1.25.3`. */
export function parseGoDl(out: string): string | null {
  try {
    const list = JSON.parse(out) as { version?: string; stable?: boolean }[];
    const v = list.find((r) => r.stable === true)?.version;
    return v ? (/^go(\d+(?:\.\d+)*)$/.exec(v)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** The AWS CLI changelog: the first line that is only a version. */
export function parseAwsChangelog(out: string): string | null {
  return /^(\d+\.\d+\.\d+)\s*$/m.exec(out)?.[1] ?? null;
}

export function parseClaudeChannel(out: string): string | null {
  return /^(\d+\.\d+\.\d+)$/.exec(out.trim())?.[1] ?? null;
}

async function command(deps: LatestDeps, manager: string, args: string[], parse: (out: string) => string | null): Promise<LatestResult> {
  const exe = await deps.resolve(manager);
  if (!exe) return { version: null, error: 'no-manager' };
  const r = await deps.run([exe, ...args], { timeoutMs: LATEST_TIMEOUT_MS, env: toolsEnv(deps.path, deps.env) }).catch(() => null);
  if (!r || (r.code !== 0 && !r.stdout)) return { version: null, error: 'command-failed' };
  const version = parse(r.stdout);
  return version ? { version, error: null } : { version: null, error: 'unparsable' };
}

async function http(deps: LatestDeps, url: string, parse: (out: string) => string | null): Promise<LatestResult> {
  let text: string;
  try {
    text = await deps.fetchText(url, FETCH_TIMEOUT_MS);
  } catch {
    return { version: null, error: 'network' };
  }
  const version = parse(text);
  return version ? { version, error: null } : { version: null, error: 'unparsable' };
}

export async function readLatest(spec: LatestSpec, deps: LatestDeps): Promise<LatestResult> {
  switch (spec.kind) {
    case 'homebrew':
      return command(deps, 'brew', ['info', '--json=v2', '--formula', spec.formula], (o) => parseBrewInfo(o, spec));
    case 'homebrew-cask':
      return command(deps, 'brew', ['info', '--json=v2', '--cask', spec.cask], (o) => parseBrewInfo(o, spec));
    case 'apt':
      return command(deps, 'apt-cache', ['policy', spec.package], parseAptPolicy);
    case 'winget':
      return command(deps, 'winget', ['show', '--id', spec.id, '--exact', '--disable-interactivity'], parseWingetShow);
    case 'npm':
      return command(deps, 'npm', ['view', spec.package, 'version'], parseNpmView);
    case 'fnm-lts':
      return command(deps, 'fnm', ['list-remote', '--lts'], parseFnmLts);
    case 'rustup':
      return command(deps, 'rustup', ['check'], parseRustupCheck);
    case 'uv-python':
      return command(deps, 'uv', ['python', 'list'], parseUvPythonList);
    case 'claude-channel':
      return http(deps, CLAUDE_CHANNEL_URL, parseClaudeChannel);
    case 'go-dl':
      return http(deps, GO_DL_URL, parseGoDl);
    case 'aws-changelog':
      return http(deps, AWS_CHANGELOG_URL, parseAwsChangelog);
  }
}
