/*
 * #594 which repositories the core opens sessions for: the owners the installation trusts. The rule is
 * pure (a stored list replaces the default, which is the owner of the Project the board reads, and the
 * comparison ignores letter case); the installation's adapter reads the setting and the resolver.
 */
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

  test('#609/AC-4 with nothing stored the default is the owners of the Projects the board read, any letter case', () => {
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'Acme', readOwners: ['Acme-Labs', 'Mira-Dev'] }), ['acme-labs', 'mira-dev', 'acme']);
  });

  test('#609/AC-4 the chosen Project\'s owner stays trusted next to the owners read, once', () => {
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'solo-co', readOwners: ['acme-labs'] }), ['acme-labs', 'solo-co']);
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'Acme-Labs', readOwners: ['acme-labs'] }), ['acme-labs']);
  });

  test('#609/AC-4 the chosen Project\'s owner is not trusted when the read reported it with a warning', () => {
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'Locked-Co', readOwners: ['acme-labs'], warnedOwners: ['locked-co'] }), ['acme-labs']);
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'locked-co', readOwners: [], warnedOwners: ['locked-co'] }), []);
  });

  test('#609/AC-4 a warned owner is never trusted, even when it is also among the owners read', () => {
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'maria', readOwners: ['acme-labs', 'Maria'], warnedOwners: ['maria'] }), ['acme-labs']);
  });

  test('#609/AC-4 a stored list wins over the chosen Project\'s owner too', () => {
    assert.deepEqual(trustedOwnersOf({ stored: ['beta'], selectedOwner: 'acme-labs', readOwners: ['acme-labs'] }), ['beta']);
  });

  test('#609/AC-4 the installation asks the owners with a warning at each question', () => {
    const settings = new MemoryInstallationSettings();
    let warned: string[] = [];
    const trust = new InstallationRepositoryTrust(settings, () => ({ owner: 'locked-co' }), () => ['acme-labs'], () => warned);
    assert.equal(trust.isTrusted('locked-co/app'), true);
    warned = ['locked-co'];
    assert.equal(trust.isTrusted('locked-co/app'), false);
    assert.equal(trust.isTrusted('acme-labs/app'), true);
  });

  test('#609/AC-4 a stored list still wins over the owners read, an empty one included', () => {
    assert.deepEqual(trustedOwnersOf({ stored: ['beta'], selectedOwner: null, readOwners: ['acme-labs'] }), ['beta']);
    assert.deepEqual(trustedOwnersOf({ stored: [], selectedOwner: null, readOwners: ['acme-labs'] }), []);
  });

  test('#609/AC-4 before any Project was read the default falls back to the owner of the chosen Project', () => {
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'acme', readOwners: [] }), ['acme']);
  });

  test('#609/AC-4 the installation asks the owners read at each question', () => {
    const settings = new MemoryInstallationSettings();
    let read: string[] = [];
    const trust = new InstallationRepositoryTrust(settings, () => null, () => read);
    assert.equal(trust.isTrusted('acme-labs/app'), false);
    read = ['acme-labs'];
    assert.equal(trust.isTrusted('Acme-Labs/app'), true);
    assert.equal(trust.isTrusted('globex/app'), false);
  });
});
