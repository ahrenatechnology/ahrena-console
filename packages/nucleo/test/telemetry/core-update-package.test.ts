// The update script ships with the app (issue 462, decision 0022 section 2): the desktop bundle copies
// `scripts/remote-core/update-remote-core.mjs` to the place the núcleo reads it from, the copy is the repository's
// file byte for byte, and it stays under the 256 KiB cap the núcleo sends over ssh stdin.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_UPDATE_SCRIPT_BYTES, readPackagedScript, UPDATE_SCRIPT_URL } from '../../src/telemetry/core-update.ts';

const REPO_SCRIPT = fileURLToPath(new URL('../../../../scripts/remote-core/update-remote-core.mjs', import.meta.url));
const TAURI_DIR = fileURLToPath(new URL('../../../../apps/desktop/src-tauri/', import.meta.url));
const conf = JSON.parse(readFileSync(`${TAURI_DIR}tauri.conf.json`, 'utf8')) as { bundle: { resources: Record<string, string> } };

describe('issue 462 the packaged update script', () => {
  test('the bundle copies the script, and to the place the núcleo reads it from', () => {
    const entry = Object.entries(conf.bundle.resources).find(([, to]) => to === 'scripts/remote-core/update-remote-core.mjs');
    assert.ok(entry, 'tauri.conf.json resources carries the script');
    assert.equal(resolve(TAURI_DIR, entry![0]), REPO_SCRIPT, 'the bundled source is the repository script');
    // The núcleo's own folder is bundled as packages/nucleo/src/; the script is read relative to src/telemetry/.
    assert.equal(conf.bundle.resources['../../../packages/nucleo/src/'], 'packages/nucleo/src/');
    const read = new URL('../../../../scripts/remote-core/update-remote-core.mjs', 'file:///resources/packages/nucleo/src/telemetry/core-update.ts');
    assert.equal(posix.normalize(read.pathname), '/resources/scripts/remote-core/update-remote-core.mjs');
    assert.equal(posix.join('/resources', entry![1]), read.pathname, 'the same relative layout in the checkout and in the app resources');
  });

  test('the file the núcleo reads is the repository script, byte for byte, and fits the cap', async () => {
    assert.equal(fileURLToPath(UPDATE_SCRIPT_URL), REPO_SCRIPT);
    const text = await readPackagedScript();
    assert.equal(text, readFileSync(REPO_SCRIPT, 'utf8'));
    assert.ok(statSync(REPO_SCRIPT).size < MAX_UPDATE_SCRIPT_BYTES, `${statSync(REPO_SCRIPT).size} bytes is over the ${MAX_UPDATE_SCRIPT_BYTES} cap`);
    assert.equal(MAX_UPDATE_SCRIPT_BYTES, 256 * 1024);
  });
});
