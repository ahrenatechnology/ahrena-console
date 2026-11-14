/*
 * #594 which repositories the core opens sessions for: the ones whose owner the installation trusts.
 * Text written in an issue reaches an Athena session that runs with the owner's Claude Code authority,
 * so "Planejar" and "Executar plano" refuse a repository of an owner outside this list.
 *
 * The list is the installation setting `work.trustedOwners`; with nothing stored it is the owner of the
 * Project the board reads, and a stored list replaces that default (it never adds to it). An empty
 * stored list trusts nobody, and so does no list with no Project chosen. Owners compare in any letter case.
 */

import type { InstallationSettings } from '../settings/installation-settings.ts';

/** Whether the core may open a session for a repository (`owner/name`). */
export interface RepositoryTrust {
  isTrusted(repo: string): boolean;
}

/** The trusted owners, lower-cased: the stored list when there is one, else the Project's owner. */
export function trustedOwnersOf({ stored, selectedOwner }: { stored: readonly string[] | null; selectedOwner: string | null }): string[] {
  const owners = stored ?? (selectedOwner ? [selectedOwner] : []);
  return owners.map((o) => o.toLowerCase());
}

/** Whether `repo` (`owner/name`) belongs to one of `owners`; a value that is not `owner/name` never does. */
export function isTrustedRepo(repo: string, owners: readonly string[]): boolean {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) return false;
  const owner = repo.slice(0, slash).toLowerCase();
  return owners.some((o) => o !== '' && o.toLowerCase() === owner);
}

/** The installation's trust: the setting and the Project's owner, read at each question so a change applies at once. */
export class InstallationRepositoryTrust implements RepositoryTrust {
  private readonly settings: Pick<InstallationSettings, 'get'>;
  private readonly selection: () => { owner: string } | null;

  constructor(settings: Pick<InstallationSettings, 'get'>, selection: () => { owner: string } | null) {
    this.settings = settings;
    this.selection = selection;
  }

  isTrusted(repo: string): boolean {
    const owners = trustedOwnersOf({ stored: this.settings.get('work.trustedOwners'), selectedOwner: this.selection()?.owner ?? null });
    return isTrustedRepo(repo, owners);
  }
}
