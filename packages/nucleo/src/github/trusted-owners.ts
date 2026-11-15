/*
 * #594 which repositories the core opens sessions for: the ones whose owner the installation trusts.
 * Text written in an issue reaches an Athena session that runs with the owner's Claude Code authority,
 * so "Planejar" and "Executar plano" refuse a repository of an owner outside this list.
 *
 * The list is the installation setting `work.trustedOwners`; with nothing stored it is the owners of the
 * Projects the board read (#609: the organizations read and the person's account) plus the owner of the
 * chosen Project, and never an owner that came back with a warning. A stored list replaces that default (it never adds to it). An empty stored list trusts nobody, and so does no list with
 * no Project chosen. Owners compare in any letter case.
 */

import type { InstallationSettings } from '../settings/installation-settings.ts';

/** Whether the core may open a session for a repository (`owner/name`). */
export interface RepositoryTrust {
  isTrusted(repo: string): boolean;
}

/** #609 The trusted owners, lower-cased: the stored list when there is one, else the owners of the Projects read and the chosen Project's owner, unless the read reported that owner with a warning. */
export function trustedOwnersOf({ stored, selectedOwner, readOwners = [], warnedOwners = [] }: { stored: readonly string[] | null; selectedOwner: string | null; readOwners?: readonly string[]; warnedOwners?: readonly string[] }): string[] {
  if (stored) return stored.map((o) => o.toLowerCase());
  const warned = new Set(warnedOwners.map((o) => o.toLowerCase()));
  const chosen = selectedOwner && !warned.has(selectedOwner.toLowerCase()) ? [selectedOwner] : [];
  return [...new Set([...readOwners, ...chosen].map((o) => o.toLowerCase()))].filter((o) => !warned.has(o));
}

/** Whether `repo` (`owner/name`) belongs to one of `owners`; a value that is not `owner/name` never does. */
export function isTrustedRepo(repo: string, owners: readonly string[]): boolean {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) return false;
  const owner = repo.slice(0, slash).toLowerCase();
  return owners.some((o) => o !== '' && o.toLowerCase() === owner);
}

/** #609 The installation's trust: the setting, the owners the board read and the Project's owner, read at each question so a change applies at once. */
export class InstallationRepositoryTrust implements RepositoryTrust {
  private readonly settings: Pick<InstallationSettings, 'get'>;
  private readonly selection: () => { owner: string } | null;
  private readonly readOwners: () => readonly string[];
  private readonly warnedOwners: () => readonly string[];

  constructor(settings: Pick<InstallationSettings, 'get'>, selection: () => { owner: string } | null, readOwners: () => readonly string[] = () => [], warnedOwners: () => readonly string[] = () => []) {
    this.warnedOwners = warnedOwners;
    this.settings = settings;
    this.selection = selection;
    this.readOwners = readOwners;
  }

  isTrusted(repo: string): boolean {
    const owners = trustedOwnersOf({ stored: this.settings.get('work.trustedOwners'), selectedOwner: this.selection()?.owner ?? null, readOwners: this.readOwners(), warnedOwners: this.warnedOwners() });
    return isTrustedRepo(repo, owners);
  }
}
