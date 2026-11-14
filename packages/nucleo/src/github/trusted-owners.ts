/*
 * #594 which repositories the core opens sessions for: the ones whose owner the installation trusts.
 * Text written in an issue reaches an Athena session that runs with the owner's Claude Code authority,
 * so "Planejar" and "Executar plano" refuse a repository of an owner outside this list.
 *
 * The list is the installation setting `work.trustedOwners`; with nothing stored it is the owners of the
 * Projects the board read (#609: the organizations read and the person's account, never an organization
 * that came back with a warning), else the owner of the chosen Project before any read, and a stored list
 * replaces that default (it never adds to it). An empty stored list trusts nobody, and so does no list with
 * no Project chosen. Owners compare in any letter case.
 */

import type { InstallationSettings } from '../settings/installation-settings.ts';

/** Whether the core may open a session for a repository (`owner/name`). */
export interface RepositoryTrust {
  isTrusted(repo: string): boolean;
}

/** The trusted owners, lower-cased: the stored list when there is one, else the owners of the Projects read, else the chosen Project's owner. */
export function trustedOwnersOf({ stored, selectedOwner, readOwners = [] }: { stored: readonly string[] | null; selectedOwner: string | null; readOwners?: readonly string[] }): string[] {
  const owners = stored ?? (readOwners.length ? readOwners : selectedOwner ? [selectedOwner] : []);
  return owners.map((o) => o.toLowerCase());
}

/** Whether `repo` (`owner/name`) belongs to one of `owners`; a value that is not `owner/name` never does. */
export function isTrustedRepo(repo: string, owners: readonly string[]): boolean {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) return false;
  const owner = repo.slice(0, slash).toLowerCase();
  return owners.some((o) => o !== '' && o.toLowerCase() === owner);
}

/** The installation's trust: the setting, the owners the board read and the Project's owner, read at each question so a change applies at once. */
export class InstallationRepositoryTrust implements RepositoryTrust {
  private readonly settings: Pick<InstallationSettings, 'get'>;
  private readonly selection: () => { owner: string } | null;
  private readonly readOwners: () => readonly string[];

  constructor(settings: Pick<InstallationSettings, 'get'>, selection: () => { owner: string } | null, readOwners: () => readonly string[] = () => []) {
    this.settings = settings;
    this.selection = selection;
    this.readOwners = readOwners;
  }

  isTrusted(repo: string): boolean {
    const owners = trustedOwnersOf({ stored: this.settings.get('work.trustedOwners'), selectedOwner: this.selection()?.owner ?? null, readOwners: this.readOwners() });
    return isTrustedRepo(repo, owners);
  }
}
