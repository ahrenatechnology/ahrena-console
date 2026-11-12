// Issue 449, decision 0021 section 4, criterion AC4: `packages/nucleo/remote-contract.json` is what the
// update command reads from the target checkout (`git show <sha>:...`) before it stops anything. It is
// written by hand (the contract is the source), and this test fails the CI when it drifts from the
// constants it mirrors, so no one changes one without the other.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { ownerProofRequired } from '../../src/api/owner-auth.ts';
import { TELEMETRY_VERSION } from '../../src/telemetry/model.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const manifest = JSON.parse(read('../../remote-contract.json')) as Record<string, unknown>;

describe('AC4 remote-contract.json mirrors what the núcleo answers', () => {
  test('AC4 it has exactly the four documented keys, manifest 1', () => {
    assert.deepEqual(Object.keys(manifest).sort(), ['manifest', 'ownerProofRequired', 'remoteCredentialCommand', 'telemetryVersion']);
    assert.equal(manifest.manifest, 1);
  });

  test('AC4 telemetryVersion is TELEMETRY_VERSION', () => {
    assert.equal(manifest.telemetryVersion, TELEMETRY_VERSION);
  });

  test('AC4 ownerProofRequired is what ownerProofRequired("GET", "/api/telemetry") decides', () => {
    assert.equal(typeof manifest.ownerProofRequired, 'boolean');
    assert.equal(manifest.ownerProofRequired, ownerProofRequired('GET', '/api/telemetry'));
  });

  test('AC4 remoteCredentialCommand is a subcommand that owner/cli.ts dispatches (or null when the target has none)', () => {
    const command = manifest.remoteCredentialCommand;
    assert.ok(command === null || typeof command === 'string');
    if (command === null) return;
    const cli = read('../../src/owner/cli.ts');
    assert.ok(cli.includes(`command === '${command}'`), `owner/cli.ts has no "${command}" subcommand`);
  });
});
