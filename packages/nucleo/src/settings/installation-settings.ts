/*
 * The installation's settings (#241, decision 0011 §8): what one installation chose, none of it a
 * secret. Six keys and nothing else: the active GitHub login (the vault account), the credential
 * source, the Project of the kanban, (#594) the owners the core opens work sessions for and (#477) how
 * many executions run at once and (#619) whether permission requests can be answered from the Console. Each
 * value is validated on write, so a credential cannot land here by mistake (a token is not a login,
 * and there is no key for one).
 */

import type { DatabaseSync } from 'node:sqlite';
import { GITHUB_LOGIN, isGithubLogin } from '../github/login.ts';

export interface ProjectSelection {
  owner: string;
  number: number;
  /** The single-select field the kanban's columns come from. */
  field: string;
}

export type GithubCredentialSource = 'console' | 'gh';

export interface InstallationSettingValues {
  /** The active vault account; `null` (kept) after a disconnect, so a restart does not adopt an entry again. */
  'github.login': string | null;
  'github.source': GithubCredentialSource;
  'project.selection': ProjectSelection;
  /** #594 the GitHub owners whose repositories the core opens work sessions for; stored, it replaces the default (the Project's owner). `[]` trusts nobody. */
  'work.trustedOwners': string[];
  /** #477 how many executions of the work board run at once; stored, it replaces the default (2). */
  'work.executionLimit': number;
  /** #619 whether a permission request can be answered from the Console; absent it is on (with a live window credential the capability is on). */
  'permissions.answerFromConsole': boolean;
}

export type InstallationSettingKey = keyof InstallationSettingValues;

export const INSTALLATION_SETTING_KEYS: readonly InstallationSettingKey[] = ['github.login', 'github.source', 'project.selection', 'work.trustedOwners', 'work.executionLimit', 'permissions.answerFromConsole'];

export interface InstallationSettings {
  get<K extends InstallationSettingKey>(key: K): InstallationSettingValues[K] | null;
  set<K extends InstallationSettingKey>(key: K, value: InstallationSettingValues[K]): void;
  delete(key: InstallationSettingKey): void;
  /** Whether the key is stored at all (a stored `null` counts). */
  has(key: InstallationSettingKey): boolean;
}

/** A GitHub login or organization (src/github/login.ts). */
export const GITHUB_OWNER = GITHUB_LOGIN;

/** #594 how many owners a trusted list holds at most. */
export const MAX_TRUSTED_OWNERS = 100;

/** Whether `value` is a list of at most `MAX_TRUSTED_OWNERS` GitHub owners; an empty list is valid. */
export function isTrustedOwners(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_TRUSTED_OWNERS && value.every((o) => typeof o === 'string' && GITHUB_OWNER.test(o));
}

/** #477 the most concurrent executions a limit may allow. */
export const MAX_EXECUTION_LIMIT = 50;

/** Whether `value` is a whole number from 1 to `MAX_EXECUTION_LIMIT`. */
export const isExecutionLimit = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_EXECUTION_LIMIT;

/** Whether `value` is a valid Project selection: owner like a login, number 1..999999999, field 1..100 printable chars. */
export function isProjectSelection(value: unknown): value is ProjectSelection {
  if (!value || typeof value !== 'object') return false;
  const { owner, number, field } = value as Record<string, unknown>;
  return (
    typeof owner === 'string' &&
    GITHUB_OWNER.test(owner) &&
    Number.isInteger(number) &&
    (number as number) > 0 &&
    (number as number) <= 999_999_999 &&
    typeof field === 'string' &&
    field.length >= 1 &&
    field.length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(field)
  );
}

const VALIDATORS: { [K in InstallationSettingKey]: (v: unknown) => v is InstallationSettingValues[K] } = {
  'github.login': (v): v is string | null => v === null || isGithubLogin(v),
  'github.source': (v): v is GithubCredentialSource => v === 'console' || v === 'gh',
  'project.selection': isProjectSelection,
  'work.trustedOwners': isTrustedOwners,
  'work.executionLimit': isExecutionLimit,
  'permissions.answerFromConsole': (v): v is boolean => typeof v === 'boolean',
};

function assertKey(key: string): asserts key is InstallationSettingKey {
  if (!Object.hasOwn(VALIDATORS, key)) throw new Error(`installation settings: unknown key ${JSON.stringify(key)}`);
}

function assertValue(key: InstallationSettingKey, value: unknown): void {
  if (!VALIDATORS[key](value)) throw new Error(`installation settings: invalid value for ${key}`);
}

/** The stored value, or `null` when it no longer passes validation (a hand-edited row). */
function checked<K extends InstallationSettingKey>(key: K, value: unknown): InstallationSettingValues[K] | null {
  return VALIDATORS[key](value) ? (value as InstallationSettingValues[K]) : null;
}

export class MemoryInstallationSettings implements InstallationSettings {
  private readonly values = new Map<InstallationSettingKey, string>();

  constructor(seed: Partial<InstallationSettingValues> = {}) {
    for (const [key, value] of Object.entries(seed)) this.set(key as InstallationSettingKey, value as never);
  }

  get<K extends InstallationSettingKey>(key: K): InstallationSettingValues[K] | null {
    assertKey(key);
    const json = this.values.get(key);
    return json === undefined ? null : checked(key, JSON.parse(json));
  }

  set<K extends InstallationSettingKey>(key: K, value: InstallationSettingValues[K]): void {
    assertKey(key);
    assertValue(key, value);
    this.values.set(key, JSON.stringify(value));
  }

  delete(key: InstallationSettingKey): void {
    assertKey(key);
    this.values.delete(key);
  }

  has(key: InstallationSettingKey): boolean {
    assertKey(key);
    return this.values.has(key);
  }
}

/** On the core's `storage.db`; the table comes from the storage's migrations. */
export class SqliteInstallationSettings implements InstallationSettings {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, { now = Date.now }: { now?: () => number } = {}) {
    this.db = db;
    this.now = now;
  }

  get<K extends InstallationSettingKey>(key: K): InstallationSettingValues[K] | null {
    assertKey(key);
    const row = this.db.prepare('SELECT value_json FROM installation_settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return checked(key, JSON.parse(row.value_json));
    } catch {
      return null;
    }
  }

  set<K extends InstallationSettingKey>(key: K, value: InstallationSettingValues[K]): void {
    assertKey(key);
    assertValue(key, value);
    this.db
      .prepare(
        `INSERT INTO installation_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date(this.now()).toISOString());
  }

  delete(key: InstallationSettingKey): void {
    assertKey(key);
    this.db.prepare('DELETE FROM installation_settings WHERE key = ?').run(key);
  }

  has(key: InstallationSettingKey): boolean {
    assertKey(key);
    return this.db.prepare('SELECT 1 FROM installation_settings WHERE key = ?').get(key) !== undefined;
  }
}

/** #619 the Controle switch over the installation setting: read at each use so a change applies at once; nothing stored reads as on. */
export function answerFromConsoleSwitch(settings: InstallationSettings): { enabled: () => boolean; setEnabled: (value: boolean) => void } {
  return {
    enabled: () => settings.get('permissions.answerFromConsole') ?? true,
    setEnabled: (value) => settings.set('permissions.answerFromConsole', value),
  };
}
