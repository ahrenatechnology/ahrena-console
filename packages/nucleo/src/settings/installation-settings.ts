// The installation's settings (#241, decision 0011 §8): what one installation chose, none of it a
// secret. Three keys and nothing else: the active GitHub login (the vault account), the credential
// source and the Project of the kanban. Each value is validated on write, so a credential cannot land
// here by mistake (a token is not a login, and there is no key for one).

import type { DatabaseSync } from 'node:sqlite';

export interface ProjectSelection {
  owner: string;
  number: number;
  /** The single-select field the kanban's columns come from. */
  field: string;
}

export type GithubCredentialSource = 'console' | 'gh';

export interface InstallationSettingValues {
  'github.login': string;
  'github.source': GithubCredentialSource;
  'project.selection': ProjectSelection;
}

export type InstallationSettingKey = keyof InstallationSettingValues;

export const INSTALLATION_SETTING_KEYS: readonly InstallationSettingKey[] = ['github.login', 'github.source', 'project.selection'];

export interface InstallationSettings {
  get<K extends InstallationSettingKey>(key: K): InstallationSettingValues[K] | null;
  set<K extends InstallationSettingKey>(key: K, value: InstallationSettingValues[K]): void;
  delete(key: InstallationSettingKey): void;
}

/** A GitHub login or organization: letters, digits and hyphens, up to 39, not starting with a hyphen. */
export const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

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
  'github.login': (v): v is string => typeof v === 'string' && GITHUB_OWNER.test(v),
  'github.source': (v): v is GithubCredentialSource => v === 'console' || v === 'gh',
  'project.selection': isProjectSelection,
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
}
