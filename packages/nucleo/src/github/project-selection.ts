// Which Project the kanban shows (#241, decision 0011 §7). `AHRENA_CONSOLE_PROJECT` (env) wins, with
// a warning on screen (`envOverride`); then the installation setting `project.selection` chosen on
// the screen; then, only under --demo, the simulator's Project; else none. There is no default
// Project. The kanban is built for the current selection and rebuilt when the selection changes or
// the GitHub identity changes (`reset`).

import { DEFAULT_PROJECT_FIELD } from './project.ts';
import { isProjectSelection, type InstallationSettings, type ProjectSelection } from '../settings/installation-settings.ts';

export const PROJECT_ENV = 'AHRENA_CONSOLE_PROJECT';

export type ProjectSelectionFrom = 'env' | 'settings' | 'demo';

export interface ResolvedProjectSelection extends ProjectSelection {
  from: ProjectSelectionFrom;
}

export interface ProjectEnvOverride {
  variable: typeof PROJECT_ENV;
  /** `owner/number`, as set. */
  value: string;
}

/** A selection the API refuses (400 `invalid`). */
export class ProjectSelectionError extends Error {
  readonly code = 'invalid';
  constructor() {
    super('invalid project selection');
    this.name = 'ProjectSelectionError';
  }
}

/** `owner/number` from the env; empty → `null`; anything else throws (the core refuses to start, as before). */
export function parseProjectEnv(value = ''): ProjectSelection | null {
  if (!value.trim()) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(\d{1,9})$/.exec(value.trim());
  if (!m || Number(m[2]) < 1) throw new Error(`${PROJECT_ENV}: owner/number, like my-org/3 (got "${value}")`);
  return { owner: m[1], number: Number(m[2]), field: DEFAULT_PROJECT_FIELD };
}

export interface ProjectResolverOptions<K> {
  env?: NodeJS.ProcessEnv;
  settings: InstallationSettings;
  /** Under --demo: the simulator's Project, when nothing else is chosen (`--demo-project none` passes null). */
  demoSelection?: ProjectSelection | null;
  /** Builds the kanban of a selection. */
  build: (selection: ProjectSelection) => K;
}

export class ProjectResolver<K> {
  private readonly env: ProjectSelection | null;
  private readonly envValue: string | null;
  private readonly settings: InstallationSettings;
  private readonly demoSelection: ProjectSelection | null;
  private readonly build: (selection: ProjectSelection) => K;
  private built: { key: string; kanban: K } | null = null;

  constructor({ env = process.env, settings, demoSelection = null, build }: ProjectResolverOptions<K>) {
    this.env = parseProjectEnv(env[PROJECT_ENV] ?? '');
    this.envValue = this.env ? `${this.env.owner}/${this.env.number}` : null;
    this.settings = settings;
    this.demoSelection = demoSelection;
    this.build = build;
  }

  selection(): ResolvedProjectSelection | null {
    if (this.env) return { ...this.env, from: 'env' };
    const stored = this.settings.get('project.selection');
    if (stored) return { ...stored, from: 'settings' };
    if (this.demoSelection) return { ...this.demoSelection, from: 'demo' };
    return null;
  }

  envOverride(): ProjectEnvOverride | null {
    return this.envValue ? { variable: PROJECT_ENV, value: this.envValue } : null;
  }

  /** Stores the choice (validated); the env, when set, still wins and is reported. */
  select(input: { owner: unknown; number: unknown; field?: unknown }): { selection: ResolvedProjectSelection; envOverride: ProjectEnvOverride | null } {
    if (!input || typeof input !== 'object') throw new ProjectSelectionError();
    const candidate = { owner: input.owner, number: input.number, field: input.field === undefined ? DEFAULT_PROJECT_FIELD : input.field };
    if (!isProjectSelection(candidate)) throw new ProjectSelectionError();
    this.settings.set('project.selection', { owner: candidate.owner, number: candidate.number, field: candidate.field });
    return { selection: this.selection()!, envOverride: this.envOverride() };
  }

  /** The kanban of the current selection, or `null` without one. Same selection, same instance. */
  kanban(): K | null {
    const s = this.selection();
    if (!s) {
      this.built = null;
      return null;
    }
    const key = `${s.owner.toLowerCase()}/${s.number}:${s.field}`;
    if (this.built?.key !== key) this.built = { key, kanban: this.build({ owner: s.owner, number: s.number, field: s.field }) };
    return this.built.kanban;
  }

  /** The GitHub identity changed: the next `kanban()` builds a new one. */
  reset(): void {
    this.built = null;
  }
}
