// Non-inferential diagnostics only. Never read auth.json, keychains, tokens or invoke helpers.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type BillingProvider = 'claude' | 'codex';
export type AuthMode = 'subscription' | 'api' | 'none' | 'unknown';
export type ProbeReason = 'environment_override' | 'config_override' | 'config_unreadable' |
  'config_ambiguous' | 'effective_config_unverified' | 'auth_unverified' | 'probe_failed';
export interface BillingScope {
  provider: BillingProvider;
  profileId: string;
  /** Non-secret identity/revision from the profile owner. Never a credential or e-mail. */
  accountId: string | null;
  configDir: string;
  cwd: string;
}
export interface AuthObservation {
  mode: AuthMode;
  source: 'claude-auth-status' | 'codex-login-status' | 'unavailable';
}
export interface AuthDiagnostic {
  scope: BillingScope;
  observedAt: number;
  expiresAt: number;
  /** Only a change detector, not proof that effective configuration is complete. */
  revision: string;
  reasons: ProbeReason[];
  auth: AuthObservation;
  source: 'local-read-only';
}

const OVERRIDE = /^(?:ANTHROPIC_|OPENAI_|AZURE_|AWS_|GOOGLE_|GCLOUD_|VERTEX_|BEDROCK_|CODEX_|CLAUDE_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_)/i;
const ALLOWED_ENV = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SYSTEMROOT', 'WINDIR'];

/** Drop everything not explicitly needed by a future child process. Inspect before dropping. */
export function prepareBillingEnvironment(scope: BillingScope, inherited: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv; reasons: ProbeReason[];
} {
  const env: NodeJS.ProcessEnv = {};
  const reasons: ProbeReason[] = [];
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && OVERRIDE.test(key)) reasons.push('environment_override');
  }
  for (const key of ALLOWED_ENV) if (inherited[key] !== undefined) env[key] = inherited[key];
  env[scope.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = scope.configDir;
  return { env, reasons: [...new Set(reasons)] };
}

/** Parse only allowlisted fields from official status output; discard all other data. */
export function parseClaudeAuthStatus(output: string): AuthObservation {
  try {
    const value = JSON.parse(output);
    if (value?.loggedIn === false) return { mode: 'none', source: 'claude-auth-status' };
    if (value?.loggedIn !== true) return { mode: 'unknown', source: 'claude-auth-status' };
    const method = value.authMethod;
    return {
      mode: method === 'claude.ai' ? 'subscription' :
        ['api_key', 'api_key_helper', 'third_party'].includes(method) ? 'api' : 'unknown',
      source: 'claude-auth-status',
    };
  } catch { return { mode: 'unknown', source: 'claude-auth-status' }; }
}

/** Human-readable status is diagnostic only, never a billing entitlement. */
export function parseCodexLoginStatus(output: string): AuthObservation {
  const text = output.trim();
  return { mode: text === 'Logged in using ChatGPT' ? 'subscription' :
    text === 'Not logged in' ? 'none' : /^Logged in using an API key(?:\s|$)/.test(text) ? 'api' : 'unknown',
  source: 'codex-login-status' };
}

const CONFIG_OVERRIDE = /api.?key|auth.?token|oauth.?token|apiKeyHelper|base.?url|gateway|model_provider|model_providers|credential|bedrock|vertex|foundry|cloud_provider|env_key|http_headers|requires_openai_auth|forced_login_method/i;

/** Conservative inspection, not a replacement for provider-specific effective-config resolution. */
export function inspectBillingConfig(text: string): ProbeReason[] {
  // Do not echo keys, values, lines, parsing exceptions or file content into diagnostics.
  if (CONFIG_OVERRIDE.test(text)) return ['config_override'];
  // Even apparently harmless settings may include future provider features or executable hooks.
  if (text.trim() && text.trim() !== '{}') return ['config_ambiguous'];
  return [];
}

export interface DiagnosticOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Inspect known non-secret settings files without executing any provider binary. Missing files
 * are normal; missing effective-config coverage is NOT proof of clean settings. In particular,
 * managed/server settings, includes and alternate homes need #295's resolver before auth probes
 * may run (Claude status itself must not be allowed to execute an apiKeyHelper).
 */
export async function diagnoseBilling(scope: BillingScope, options: DiagnosticOptions = {}): Promise<AuthDiagnostic> {
  const snapshot = { ...scope };
  const now = (options.now ?? Date.now)();
  const reasons: ProbeReason[] = ['effective_config_unverified', 'auth_unverified'];
  const inherited = { ...(options.env ?? process.env) };
  reasons.push(...prepareBillingEnvironment(snapshot, inherited).reasons);
  const hash = createHash('sha256');
  hash.update(JSON.stringify(snapshot));
  // Hash only presence of risky env names, never credential values (not even their hashes).
  hash.update(JSON.stringify(Object.keys(inherited).filter(k => inherited[k] !== undefined && OVERRIDE.test(k)).sort()));
  if (!isAbsolute(snapshot.configDir) || !isAbsolute(snapshot.cwd)) {
    reasons.push('config_ambiguous');
  } else {
    const files = snapshot.provider === 'claude'
      ? [join(snapshot.configDir, 'settings.json'), join(snapshot.cwd, '.claude/settings.json'), join(snapshot.cwd, '.claude/settings.local.json')]
      : [join(snapshot.configDir, 'config.toml'), join(snapshot.cwd, '.codex/config.toml')];
    for (const file of files) {
      let handle;
      try {
        // Do not follow a credential-file symlink or block on a FIFO/device.
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 256 * 1024) { reasons.push('config_ambiguous'); continue; }
        // Bounded read even if a file grows after stat.
        const buffer = Buffer.alloc(256 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 256 * 1024) { reasons.push('config_ambiguous'); continue; }
        const content = buffer.subarray(0, bytesRead).toString('utf8');
        reasons.push(...inspectBillingConfig(content));
        // Metadata detects ordinary edits without persisting a hash of credential-bearing content.
        hash.update(JSON.stringify([file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reasons.push('config_unreadable');
        hash.update('unavailable');
      } finally { await handle?.close(); }
    }
  }
  return { scope: snapshot, observedAt: now, expiresAt: now + 30_000, revision: hash.digest('hex'),
    reasons: [...new Set(reasons)], auth: { mode: 'unknown', source: 'unavailable' }, source: 'local-read-only' };
}
