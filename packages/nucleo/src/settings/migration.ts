// SQLite schema for the installation's settings (#241, decision 0011 §8). It goes into the adapter's
// migration list (adapters/sqlite/migrations.ts) as a migration of its own, additive: a new table.
// One row per key; the value is JSON. No key ever holds a credential.

export const INSTALLATION_SETTINGS_MIGRATION_DESCRIPTION = 'installation settings: GitHub login, credential source, Project (#241)';

export const INSTALLATION_SETTINGS_MIGRATION_SQL = `
  CREATE TABLE installation_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`;
