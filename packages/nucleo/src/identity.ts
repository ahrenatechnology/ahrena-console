import { createHash } from 'node:crypto';
/** Provider identifiers are never internal routing IDs. Null scope means unknown, not the current login. */
export const PROVIDERS = ['claude', 'codex'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type EvidenceConfidence = 'confirmed' | 'inferred' | 'unknown';
export interface IdentityScope {
  provider: Provider;
  profileId: string | null;
  machineId: string | null;
  environmentId: string | null;
}
export interface SessionIdentity extends IdentityScope { providerSessionId: string }
export interface AccountIdentity extends IdentityScope {
  providerAccountId: string;
  organizationId: string | null;
}
export type CapabilityState = 'available' | 'unavailable' | 'unknown';
export interface SessionCapabilities {
  mode: 'external' | 'managed' | 'unknown';
  history: CapabilityState;
  nativeOpen: CapabilityState;
  sendInput: CapabilityState;
  interrupt: CapabilityState;
  approve: CapabilityState;
}
export function unknownCapabilities(): SessionCapabilities {
  return { mode: 'unknown', history: 'unknown', nativeOpen: 'unknown', sendInput: 'unknown', interrupt: 'unknown', approve: 'unknown' };
}
export function legacySessionIdentity(id: string): SessionIdentity {
  return { provider: 'claude', providerSessionId: id, profileId: null, machineId: null, environmentId: null };
}
export function isLegacyIdentity(i: SessionIdentity): boolean {
  return i.provider === 'claude' && i.profileId === null && i.machineId === null && i.environmentId === null;
}
function text(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value));
}
/** Whitelist identity fields: credentials and arbitrary metadata have no place in this contract. */
export function validateIdentity(i: SessionIdentity | AccountIdentity, account = false): void {
  if (!i || !PROVIDERS.includes(i.provider)) throw new Error('Invalid identity provider');
  const keys = ['provider', 'profileId', 'machineId', 'environmentId', ...(account ? ['providerAccountId', 'organizationId'] : ['providerSessionId'])];
  if (Object.keys(i).some(k => !keys.includes(k))) throw new Error('Unexpected identity field');
  for (const k of ['profileId', 'machineId', 'environmentId'] as const) {
    if (!text(i[k], true)) throw new Error(`Invalid identity ${k}`);
  }
  if (account) {
    const a = i as AccountIdentity;
    if (!text(a.providerAccountId) || !text(a.organizationId, true)) throw new Error('Invalid account identity');
  } else if (!text((i as SessionIdentity).providerSessionId)) throw new Error('Invalid session identity');
}
function scope(i: IdentityScope): (string | null)[] { return [i.provider, i.profileId, i.machineId, i.environmentId]; }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Fixed-size, delimiter-safe keys stay within existing routing limits. */
export function providerSessionKey(i: SessionIdentity): string {
  validateIdentity(i);
  return `session:${hash([...scope(i), i.providerSessionId])}`;
}
export function providerAccountKey(i: AccountIdentity): string {
  validateIdentity(i, true);
  return `account:${hash([...scope(i), i.providerAccountId, i.organizationId])}`;
}
export function scopedEntityId(sessionId: string, kind: 'event' | 'agent', providerId: string): string {
  if (!text(sessionId) || !text(providerId)) throw new Error('Invalid entity identity');
  return `${scopedEntityPrefix(sessionId, kind)}${hash(providerId)}`;
}
export function scopedEntityPrefix(sessionId: string, kind: 'event' | 'agent'): string {
  return `${kind}:${hash(sessionId).slice(0, 32)}:`;
}
export function validateCapabilities(c: SessionCapabilities): void {
  if (!c || !['external', 'managed', 'unknown'].includes(c.mode)) throw new Error('Invalid session mode');
  const actions = ['history', 'nativeOpen', 'sendInput', 'interrupt', 'approve'] as const;
  if (Object.keys(c).some(k => k !== 'mode' && !actions.includes(k as typeof actions[number]))) throw new Error('Unexpected capability field');
  for (const key of actions) if (!['available', 'unavailable', 'unknown'].includes(c[key])) throw new Error(`Invalid capability ${key}`);
  if (c.mode !== 'managed' && ['sendInput', 'interrupt', 'approve'].some(k => c[k as keyof SessionCapabilities] === 'available')) {
    throw new Error('External or unknown sessions cannot advertise managed controls');
  }
}

/** Explicit credential fields are rejected rather than copied into provider metadata. */
export function validateProviderMetadata(value: unknown): void {
  const seen = new Set<object>();
  // Normalize punctuation/case and recognize provider prefixes (OPENAI_API_KEY, etc.).
  // Raw environment/header/auth containers are not descriptive metadata.
  const credential = /(?:token|apikey|privatekey|authorization|password|clientsecret|credentials?|secret)$/;
  const containers = new Set(['env', 'environ', 'environment', 'headers', 'auth', 'authentication', 'oauth']);
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (seen.has(item)) throw new Error('Cyclic provider metadata');
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (containers.has(normalized) || credential.test(normalized)) throw new Error('Credential fields are forbidden in provider metadata');
      visit(child);
    }
    seen.delete(item);
  };
  visit(value);
}
