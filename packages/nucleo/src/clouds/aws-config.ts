// The AWS CLI's configuration file, read by the AWS connector (#277, decision 0013 sections 1 and 2):
// a pure parser of `~/.aws/config` (or the file in `AWS_CONFIG_FILE`) and the profiles it groups.
//
// - The SSO sessions: each `[sso-session <name>]` section (the CLI v2 format), with the profiles that
//   name it in `sso_session`; and each profile in the old format (`sso_start_url` in the profile
//   itself), which becomes a session of its own, named after the profile (`kind: 'legacy'`).
// - Per profile: name, account id, role name and region. Per session: name, the start URL's host
//   only (never the path), region, its profiles, and `loginSupported`: the name goes on the `aws`
//   command line only when it matches `SAFE_CLI_NAME`. A legacy session whose name is also an
//   sso-session's is not supported either (the route could not tell them apart).
// - Profiles without SSO (an access key, a role to assume) come out as `outOfScope`, as do profiles
//   whose `sso_session` names a section the file does not have.
// - A line that is not a section, a comment, a `key = value`, or an indented sub-key of a key with
//   no value is a parse error, with its line number (1-based). Nothing of the file is logged.
// - Never opens `~/.aws/credentials`; never reads a key value it does not use.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** A name that may go on the `aws` command line (decision 0013 section 1). */
export const SAFE_CLI_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export interface AwsProfile {
  name: string;
  accountId: string | null;
  roleName: string | null;
  region: string | null;
}

export interface AwsSsoSession {
  name: string;
  /** `sso-session`: a `[sso-session <name>]` section; `legacy`: a profile with `sso_start_url`. */
  kind: 'sso-session' | 'legacy';
  /** The start URL's host only. */
  startUrlHost: string | null;
  region: string | null;
  profiles: AwsProfile[];
  loginSupported: boolean;
  /** The start URL itself, kept inside the núcleo (the legacy cache file is named after it); never served. */
  startUrl: string | null;
}

export interface AwsOutOfScopeProfile {
  name: string;
  /** `no-sso`: an access key or a role to assume; `missing-sso-session`: names a section that is not there. */
  reason: 'no-sso' | 'missing-sso-session';
}

export interface AwsConfig {
  sessions: AwsSsoSession[];
  outOfScope: AwsOutOfScopeProfile[];
}

export type AwsConfigParse = { ok: true; config: AwsConfig } | { ok: false; line: number; message: string };

/** `AWS_CONFIG_FILE`, else `~/.aws/config`, as the CLI does. */
export function awsConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const fromEnv = env.AWS_CONFIG_FILE;
  if (fromEnv) return fromEnv.startsWith('~/') ? join(home, fromEnv.slice(2)) : fromEnv;
  return join(home, '.aws', 'config');
}

/** The SSO token cache folder of the CLI v2. */
export function awsSsoCacheDir(home: string = homedir()): string {
  return join(home, '.aws', 'sso', 'cache');
}

type Section = { kind: 'profile' | 'sso-session' | 'other'; name: string; keys: Map<string, string> };

const SECTION = /^\[\s*([^\]]*?)\s*\]\s*(?:[#;].*)?$/;
const KEY_VALUE = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/;

function sectionOf(header: string): Section {
  if (header === 'default') return { kind: 'profile', name: 'default', keys: new Map() };
  const m = /^(profile|sso-session)\s+(.+)$/.exec(header);
  if (m) return { kind: m[1] === 'profile' ? 'profile' : 'sso-session', name: m[2]!.trim(), keys: new Map() };
  return { kind: 'other', name: header, keys: new Map() };
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host ? host.slice(0, 253) : null;
  } catch {
    return null;
  }
}

const value = (s: Section, key: string): string | null => {
  const v = s.keys.get(key);
  return v === undefined || v === '' ? null : v.slice(0, 256);
};

const profileOf = (s: Section): AwsProfile => ({ name: s.name, accountId: value(s, 'sso_account_id'), roleName: value(s, 'sso_role_name'), region: value(s, 'region') });

export function parseAwsConfig(text: string): AwsConfigParse {
  const sections: Section[] = [];
  let current: Section | null = null;
  // The key whose value is empty: indented lines below it are its sub-keys (`s3 =\n  max_… = 20`).
  let openKey = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (/^\s/.test(raw) && openKey) {
      if (!KEY_VALUE.test(line)) return { ok: false, line: i + 1, message: 'sub-chave sem "="' };
      continue;
    }
    if (line.startsWith('[')) {
      const m = SECTION.exec(line);
      if (!m || !m[1]) return { ok: false, line: i + 1, message: 'cabeçalho de seção inválido' };
      current = sectionOf(m[1]);
      sections.push(current);
      openKey = false;
      continue;
    }
    const kv = KEY_VALUE.exec(line);
    if (!kv) return { ok: false, line: i + 1, message: 'linha sem "chave = valor"' };
    if (!current) return { ok: false, line: i + 1, message: 'chave fora de uma seção' };
    const v = kv[2]!.trim();
    current.keys.set(kv[1]!.toLowerCase(), v);
    openKey = v === '';
  }
  return { ok: true, config: groupSessions(sections) };
}

function groupSessions(sections: Section[]): AwsConfig {
  // The last section of a name wins, as in the CLI.
  const ssoSections = new Map<string, Section>();
  const profiles = new Map<string, Section>();
  for (const s of sections) {
    if (s.kind === 'sso-session') ssoSections.set(s.name, s);
    if (s.kind === 'profile') profiles.set(s.name, s);
  }
  const sessions = new Map<string, AwsSsoSession>();
  for (const [name, s] of ssoSections) {
    const startUrl = value(s, 'sso_start_url');
    sessions.set(name, { name, kind: 'sso-session', startUrlHost: hostOf(startUrl ?? undefined), region: value(s, 'sso_region'), profiles: [], loginSupported: SAFE_CLI_NAME.test(name), startUrl });
  }
  const legacy: AwsSsoSession[] = [];
  const outOfScope: AwsOutOfScopeProfile[] = [];
  for (const [name, p] of profiles) {
    const sessionName = value(p, 'sso_session');
    if (sessionName) {
      const session = sessions.get(sessionName);
      if (session) session.profiles.push(profileOf(p));
      else outOfScope.push({ name, reason: 'missing-sso-session' });
      continue;
    }
    const startUrl = value(p, 'sso_start_url');
    if (startUrl) {
      legacy.push({
        name,
        kind: 'legacy',
        startUrlHost: hostOf(startUrl),
        region: value(p, 'sso_region'),
        profiles: [profileOf(p)],
        loginSupported: SAFE_CLI_NAME.test(name) && !sessions.has(name),
        startUrl,
      });
      continue;
    }
    outOfScope.push({ name, reason: 'no-sso' });
  }
  return { sessions: [...sessions.values(), ...legacy], outOfScope };
}
