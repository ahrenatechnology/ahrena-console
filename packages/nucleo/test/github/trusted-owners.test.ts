// #594 which repositories the core opens sessions for: the owners the installation trusts. The rule is
// pure (a stored list replaces the default, which is the owner of the Project the board reads, and the
// comparison ignores letter case); the installation's adapter reads the setting and the resolver.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InstallationRepositoryTrust, isTrustedRepo, trustedOwnersOf } from '../../src/github/trusted-owners.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';

describe('#594 the trusted owners', () => {
  test('#594/AC-2 with nothing stored the default is the owner of the Project the board reads', () => {
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'Acme' }), ['acme']);
  });

  test('#594/AC-2 with nothing stored and no Project chosen nobody is trusted', () => {
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: null }), []);
  });

  test('#594/AC-2 a stored list replaces the default, it does not add to it', () => {
    assert.deepEqual(trustedOwnersOf({ stored: ['Beta', 'gamma'], selectedOwner: 'acme' }), ['beta', 'gamma']);
  });

  test('#594/AC-2 a stored empty list trusts nobody, even with a Project chosen', () => {
    assert.deepEqual(trustedOwnersOf({ stored: [], selectedOwner: 'acme' }), []);
  });

  test('#594/AC-2 the comparison is case-insensitive, on the owner only', () => {
    assert.equal(isTrustedRepo('ACME/repo', ['acme']), true);
    assert.equal(isTrustedRepo('acme/Repo', ['ACME']), true);
    assert.equal(isTrustedRepo('other-org/repo', ['acme']), false);
    assert.equal(isTrustedRepo('acme-evil/repo', ['acme']), false);
    assert.equal(isTrustedRepo('repo/acme', ['acme']), false);
  });

  test('#594/AC-2 a value that is not owner/name is never trusted', () => {
    for (const bad of ['', 'acme', '/repo', 'acme/']) assert.equal(isTrustedRepo(bad, ['acme', '']), false, bad);
  });

  test('#594/AC-2 the installation reads the setting and the Project at each question', () => {
    const settings = new MemoryInstallationSettings();
    let selected: { owner: string } | null = { owner: 'acme' };
    const trust = new InstallationRepositoryTrust(settings, () => selected);
    assert.equal(trust.isTrusted('Acme/app'), true);
    assert.equal(trust.isTrusted('beta/app'), false);
    settings.set('work.trustedOwners', ['beta']);
    assert.equal(trust.isTrusted('acme/app'), false);
    assert.equal(trust.isTrusted('BETA/app'), true);
    settings.delete('work.trustedOwners');
    selected = null;
    assert.equal(trust.isTrusted('acme/app'), false);
  });
});
