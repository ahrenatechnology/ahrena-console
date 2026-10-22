// #280: the jobs of the Tools screen run detached, so the core's shutdown() must stop them before it
// exits. Reading the source is the cheapest guard: booting a core with a running job is not stable.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('shutdown() stops the tools executor before closing the API', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/api/cli.ts', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('async function shutdown()'));
  const stop = body.indexOf('toolsExecutor?.stopAll()');
  assert.ok(stop > 0, 'shutdown() calls toolsExecutor.stopAll()');
  assert.ok(stop < body.indexOf('api.close()'), 'before api.close()');
});
