import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('production API entrypoint parses without executing startup or inference', () => {
  const cli = fileURLToPath(new URL('../../src/api/cli.ts', import.meta.url));
  // --check parses only: no imports, provider processes, application startup or inference.
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', cli], { timeout: 10_000, stdio: 'pipe' }));
});
