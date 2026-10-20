// #245/AC-2: the old "Esperando você" and "na sua vez" are gone from what the núcleo says; the states are
// "Precisa de você" and "Ociosa".
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

describe('#245/AC-2 "Esperando você" is gone from the núcleo', () => {
  test('no source file of the núcleo says "Esperando você" or "na sua vez"', () => {
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const found: string[] = [];
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => /esperando você|esperam por você|na sua vez/i.test(line) && found.push(`${path.slice(root.length)}:${i + 1}`));
    }
    assert.deepEqual(found, []);
  });

  // The screens say "Precisa de você" and "Ociosa" too: the /ui of the núcleo and the desktop app's Rust.
  for (const [name, folder] of [
    ['the /ui screens (packages/nucleo/ui)', '../../ui/'],
    ['the desktop app (apps/desktop/src-tauri/src)', '../../../../apps/desktop/src-tauri/src/'],
  ] as const) {
    test(`no file of ${name} says "Esperando você"`, () => {
      const root = fileURLToPath(new URL(folder, import.meta.url));
      const found: string[] = [];
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        readFileSync(path, 'utf8')
          .split('\n')
          .forEach((line, i) => /esperando você/i.test(line) && found.push(`${path.slice(root.length)}:${i + 1}`));
      }
      assert.deepEqual(found, []);
    });
  }
});
