// The OpenTelemetry adapter behind the observability port (#661), driven with in-memory exporters.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createOtelObserver } from './otel-observer.ts';

type SpanExporter = import('@opentelemetry/sdk-trace-base').SpanExporter;
type LogRecordExporter = import('@opentelemetry/sdk-logs').LogRecordExporter;

const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');
const { InMemoryLogRecordExporter } = await import('@opentelemetry/sdk-logs');

const ENTRY = { name: 'GET /api/history', method: 'GET', route: '/api/history' };

async function build(extra: { log?: (line: string) => void; endpoint?: string } = {}) {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const observability = await createOtelObserver({ version: '1.2.3', environment: 'test', exporters: { spans, logs }, ...extra });
  return { spans, logs, observability };
}

describe('createOtelObserver', () => {
  test('an adapter span is a child of the entry span and the instrumentation scope is ahrena-console.core', async () => {
    const { spans, observability } = await build();
    await observability.observer.entry(ENTRY, async (scope) => {
      await observability.observer.adapter({ name: 'history.read', system: 'sqlite' }, async () => undefined);
      scope.respond(200);
    });
    const finished = spans.getFinishedSpans();
    const entry = finished.find((s) => s.name === ENTRY.name)!;
    const adapter = finished.find((s) => s.name === 'history.read')!;
    assert.equal(adapter.parentSpanContext?.spanId, entry.spanContext().spanId);
    assert.equal(adapter.spanContext().traceId, entry.spanContext().traceId);
    assert.equal(adapter.attributes['db.system'], 'sqlite');
    assert.equal(entry.attributes['http.response.status_code'], 200);
    assert.equal(entry.instrumentationScope.name, 'ahrena-console.core');
  });

  test('the request log record is on the root trace and carries the resource attributes', async () => {
    const { spans, logs, observability } = await build();
    let correlationId = '';
    await observability.observer.entry(ENTRY, async (scope) => {
      correlationId = scope.correlationId;
      scope.respond(200);
    });
    const entry = spans.getFinishedSpans().find((s) => s.name === ENTRY.name)!;
    const [record] = logs.getFinishedLogRecords();
    assert.equal(record!.spanContext?.traceId, entry.spanContext().traceId);
    assert.equal(record!.attributes['correlation.id'], correlationId);
    assert.equal(record!.attributes['http.response.status_code'], 200);
    assert.equal(record!.resource.attributes['service.name'], 'ahrena-console-core');
    assert.equal(record!.resource.attributes['service.version'], '1.2.3');
    assert.equal(record!.resource.attributes['deployment.environment'], 'test');
  });

  test('the log record exports only the named fields, after masking, and no whole object', async () => {
    const { logs, observability } = await build();
    await observability.observer.entry(ENTRY, async (scope) => scope.respond(200));
    const [record] = logs.getFinishedLogRecords();
    assert.deepEqual(Object.keys(record!.attributes).sort(), ['correlation.id', 'event.name', 'http.request.method', 'http.response.status_code', 'http.route']);
    assert.equal(record!.attributes['http.route'], '/api/history');
    assert.deepEqual(record!.body, { method: 'GET', route: '/api/history' });
  });

  test('a failure records exception.type, exception.message and exception.stacktrace on the span and the log, masked, with error.code', async () => {
    const { spans, logs, observability } = await build();
    const error = Object.assign(new TypeError('disk exploded'), { code: 'SQLITE_BUSY' });
    await observability.observer.entry(ENTRY, async (scope) => {
      scope.fail(error);
      scope.respond(500);
    });
    const span = spans.getFinishedSpans()[0]!;
    const [record] = logs.getFinishedLogRecords();
    assert.equal(record!.attributes['exception.type'], 'TypeError');
    assert.equal(record!.attributes['error.code'], 'SQLITE_BUSY');
    assert.equal(record!.attributes['exception.message'], 'disk exploded');
    assert.equal(record!.attributes['exception.stacktrace'], error.stack);
    const event = span.events[0]!;
    assert.equal(event.name, 'exception');
    assert.equal(event.attributes?.['exception.type'], 'TypeError');
    assert.equal(event.attributes?.['exception.message'], 'disk exploded');
    assert.equal(event.attributes?.['exception.stacktrace'], error.stack);
    assert.equal(span.status.message, undefined);
  });

  test('a failure with no stack records the type and the message without a stacktrace', async () => {
    const { spans, observability } = await build();
    await observability.observer.entry(ENTRY, async (scope) => {
      scope.fail('plain string');
      scope.respond(500);
    });
    const event = spans.getFinishedSpans()[0]!.events[0]!;
    assert.equal(event.attributes?.['exception.type'], 'string');
    assert.equal(event.attributes?.['exception.stacktrace'], undefined);
  });

  test('a throw inside an adapter is recorded with type, message and stacktrace and rethrown', async () => {
    const { spans, observability } = await build();
    const error = new RangeError('private detail');
    await assert.rejects(
      observability.observer.entry(ENTRY, async () => {
        await observability.observer.adapter({ name: 'history.read' }, async () => { throw error; });
      }),
      RangeError,
    );
    const adapter = spans.getFinishedSpans().find((s) => s.name === 'history.read')!;
    assert.equal(adapter.events[0]!.attributes?.['exception.type'], 'RangeError');
    assert.equal(adapter.events[0]!.attributes?.['exception.message'], 'private detail');
    assert.equal(adapter.events[0]!.attributes?.['exception.stacktrace'], error.stack);
  });

  test('the exception attributes go through the masking: a key that names a secret leaves as [redacted]', async () => {
    const { maskAttributes, REDACTED } = await import('./masking.ts');
    const masked = maskAttributes({ 'exception.type': 'Error', 'exception.message': 'm', 'exception.stacktrace': 's', 'auth.token': 'x' });
    assert.equal(masked['exception.message'], 'm');
    assert.equal(masked['auth.token'], REDACTED);
  });
});

describe('a failing export', () => {
  const FAILED = 1;
  const SUCCESS = 0;

  function sequence(results: number[], error?: Error): (_items: unknown, done: (result: { code: number; error?: Error }) => void) => void {
    let call = 0;
    return (_items, done) => {
      const code = results[Math.min(call++, results.length - 1)]!;
      done(code === FAILED && error ? { code, error } : { code });
    };
  }

  function exporters(results: number[], error?: Error): { spans: SpanExporter; logs: LogRecordExporter } {
    return {
      spans: { export: sequence(results, error), shutdown: async () => undefined },
      logs: { export: sequence(results, error), shutdown: async () => undefined },
    };
  }

  async function runOnce(observer: Awaited<ReturnType<typeof createOtelObserver>>['observer']): Promise<void> {
    await observer.entry(ENTRY, async (scope) => scope.respond(200));
  }

  test('writes one line naming the signal, the endpoint variable and the error type, never the error text', async () => {
    const lines: string[] = [];
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:4318 secret-body'), { name: 'AggregateError' });
    const { observer } = await createOtelObserver({ version: '1', environment: 'test', endpoint: 'http://collector:4318', exporters: exporters([FAILED], error), log: (line) => lines.push(line) });
    await runOnce(observer);
    assert.equal(lines.length, 2, 'one line per signal');
    assert.ok(lines.some((l) => l.includes('traces')));
    assert.ok(lines.some((l) => l.includes('logs')));
    for (const line of lines) {
      assert.ok(line.includes('AHRENA_CONSOLE_OTEL_ENDPOINT'));
      assert.ok(line.includes('AggregateError'));
      for (const leak of ['ECONNREFUSED', '10.0.0.7', 'secret-body']) assert.ok(!line.includes(leak), `the line holds ${leak}`);
    }
  });

  test('is throttled to one line per failure streak and reports again after a success', async () => {
    const lines: string[] = [];
    const { observer } = await createOtelObserver({ version: '1', environment: 'test', exporters: exporters([FAILED, FAILED, FAILED, SUCCESS, SUCCESS, FAILED]), log: (line) => lines.push(line) });
    for (let i = 0; i < 3; i++) await runOnce(observer);
    assert.equal(lines.length, 2, 'the streak of failures writes one line per signal');
    await runOnce(observer);
    await runOnce(observer);
    await runOnce(observer);
    assert.equal(lines.length, 4, 'a failure after a success starts a new streak');
  });

  test('writes nothing when the export succeeds', async () => {
    const lines: string[] = [];
    const { observer } = await createOtelObserver({ version: '1', environment: 'test', exporters: exporters([SUCCESS]), log: (line) => lines.push(line) });
    await runOnce(observer);
    assert.deepEqual(lines, []);
  });
});
