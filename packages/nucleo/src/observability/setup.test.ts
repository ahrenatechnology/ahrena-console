// The composition root of the observer (#661): no exporter, no OpenTelemetry module.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { noopObserver } from './port.ts';
import { createObservability } from './setup.ts';

const SRC = new URL('../', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

describe('createObservability', () => {
  for (const env of [{}, { AHRENA_CONSOLE_OTEL_EXPORTER: 'none' }, { AHRENA_CONSOLE_OTEL_EXPORTER: '' }]) {
    test(`with ${JSON.stringify(env)} it returns the no-op observer and never loads the OpenTelemetry module`, async () => {
      let loads = 0;
      const { observer, shutdown } = await createObservability(env, { load: async () => { loads++; throw new Error('must not load'); } });
      assert.equal(observer, noopObserver);
      assert.equal(loads, 0);
      await shutdown();
    });
  }

  test('an unknown exporter value stops the start, naming the variable', async () => {
    await assert.rejects(createObservability({ AHRENA_CONSOLE_OTEL_EXPORTER: 'jaeger' }), /AHRENA_CONSOLE_OTEL_EXPORTER/);
  });

  test('with otlp and the OpenTelemetry packages absent the core still starts: the no-op observer and one log line naming the variable and the error type, no error text', async () => {
    const lines: string[] = [];
    const missing = Object.assign(new Error("Cannot find package '@opentelemetry/api' imported from /Users/someone/private/otel-observer.ts"), { code: 'ERR_MODULE_NOT_FOUND' });
    const { observer, shutdown } = await createObservability({ AHRENA_CONSOLE_OTEL_EXPORTER: 'otlp' }, { load: async () => { throw missing; }, log: (line) => lines.push(line) });
    assert.equal(observer, noopObserver);
    await shutdown();
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes('AHRENA_CONSOLE_OTEL_EXPORTER'));
    assert.ok(lines[0]!.includes('Error'));
    for (const leak of ['Cannot find package', '@opentelemetry', '/Users/', 'otel-observer.ts']) assert.ok(!lines[0]!.includes(leak), `the line holds ${leak}`);
  });

  test('the core imports @opentelemetry/* statically nowhere but in the adapter the composition root loads dynamically', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith('/observability/otel-observer.ts'))
      .filter((f) => /^\s*(import|export)\b[^\n]*['"]@opentelemetry\//m.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  });
});
