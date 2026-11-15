/* #661: `GET /api/history` end to end through the observer, with in-memory exporters installed at the composition
   root: a root span for the route, a child span for the adapter read, a log record correlated to both. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { SpanStatusCode } from '@opentelemetry/api';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { API_VERSION } from '../../src/api/version.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { SessionHistory } from '../../src/history/reading.ts';
import { createObservability } from '../../src/observability/setup.ts';
import { seedPanelHistory } from '../../src/simulator/history-ended.ts';
import { PANEL_SESSION, seedPanelScenario, seedPanelDecisions } from '../../src/simulator/panel.ts';
import { T0 } from '../fixtures.ts';
import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';

const NOW = Date.parse(T0);
const UNEXPECTED = 'disk exploded at /Users/someone/private/nucleo.sqlite';

/** An adapter read that fails unexpectedly (#661), with a provider code, a text and a stack a caller must never see. */
class FailingHistory extends SessionHistory {
  override async page(): Promise<never> {
    throw Object.assign(new Error(UNEXPECTED), { code: 'SQLITE_BUSY' });
  }
}

async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function start({ failing = false, observed = true } = {}) {
  const lines: string[] = [];
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisions = new SqliteDecisionStore(storage.db);
  await seedPanelScenario(storage, 'p4', NOW);
  await seedPanelDecisions(decisions, 'p4', NOW);
  await seedPanelHistory(storage, decisions, 'p4', NOW);
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null, decisoes: decisions, agora: () => NOW, apelido: () => PANEL_SESSION });
  const history = new (failing ? FailingHistory : SessionHistory)({ storage, decisions, timeZone: 'UTC' });
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const observability = await createObservability(
    { AHRENA_CONSOLE_OTEL_EXPORTER: 'otlp', AHRENA_CONSOLE_ENVIRONMENT: 'test' },
    API_VERSION,
    { exporters: { spans, logs } },
  );
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder, hooks: { storage }, port: 0, log: (line) => lines.push(line), history, ...(observed ? { observer: observability.observer } : {}) });
  return {
    spans,
    logs,
    lines,
    get: (query = '') => fetch(`${api.url}/api/history${query}`),
    close: async () => {
      await api.close();
      await observability.shutdown();
      await storage.close();
    },
  };
}

describe('GET /api/history observed', () => {
  test('#661/AC-1 one request gives a root span, a child span for the adapter read and a log record on the root trace', async () => {
    const t = await start();
    try {
      const response = await t.get();
      assert.equal(response.status, 200);
      const finished = await eventually(() => (t.spans.getFinishedSpans().length >= 2 && t.logs.getFinishedLogRecords().length >= 1 ? t.spans.getFinishedSpans() : undefined), 'spans and log');
      const root = finished.find((s) => s.name === 'GET /api/history');
      const child = finished.find((s) => s.name === 'history.read');
      assert.ok(root && child, `spans: ${finished.map((s) => s.name).join(', ')}`);
      assert.equal(root.parentSpanContext, undefined);
      assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
      assert.equal(child.spanContext().traceId, root.spanContext().traceId);
      assert.equal(child.attributes['db.system'], 'sqlite');
      assert.equal(root.attributes['http.route'], '/api/history');
      assert.equal(root.attributes['http.response.status_code'], 200);
      const [record] = t.logs.getFinishedLogRecords();
      assert.equal(record!.spanContext?.traceId, root.spanContext().traceId);
      assert.equal(record!.spanContext?.spanId, root.spanContext().spanId);
      assert.equal(record!.attributes['event.name'], 'http.server.request');
      assert.equal(record!.eventName, 'http.server.request');
      assert.equal(record!.severityNumber, SeverityNumber.INFO);
      assert.equal(record!.attributes['http.response.status_code'], 200);
    } finally {
      await t.close();
    }
  });

  test('#661/AC-2 every log record carries the resource attributes and the trace ids, the failing request included', async () => {
    const ok = await start();
    const bad = await start({ failing: true });
    try {
      await ok.get();
      await ok.get('?days=3');
      await bad.get();
      for (const t of [ok, bad]) await eventually(() => (t.logs.getFinishedLogRecords().length >= 1 ? true : undefined), 'log');
      const records = [...ok.logs.getFinishedLogRecords(), ...bad.logs.getFinishedLogRecords()];
      assert.ok(records.length >= 3);
      for (const r of records) {
        assert.equal(r.resource.attributes['service.name'], 'ahrena-console-core');
        assert.equal(r.resource.attributes['service.version'], API_VERSION);
        assert.equal(r.resource.attributes['deployment.environment'], 'test');
        assert.match(r.spanContext?.traceId ?? '', /^[0-9a-f]{32}$/);
        assert.match(r.spanContext?.spanId ?? '', /^[0-9a-f]{16}$/);
        assert.ok(typeof r.attributes['event.name'] === 'string');
      }
    } finally {
      await ok.close();
      await bad.close();
    }
  });

  test('#661/AC-1 an unexpected adapter failure records message and stack on both spans and the log, and gives the caller a generic error with a correlation id, no text, no stack', async () => {
    const t = await start({ failing: true });
    try {
      const response = await t.get();
      const raw = await response.text();
      assert.equal(response.status, 500);
      const body: unknown = JSON.parse(raw);
      assert.ok(typeof body === 'object' && body !== null);
      assert.deepEqual(Object.keys(body).sort(), ['correlationId', 'error']);
      for (const leak of [UNEXPECTED, 'disk exploded', '/Users/', 'SQLITE_BUSY', 'FailingHistory', ' at ', '.ts:']) assert.ok(!raw.includes(leak), `the response holds ${leak}`);
      const finished = await eventually(() => (t.spans.getFinishedSpans().length >= 2 && t.logs.getFinishedLogRecords().length >= 1 ? t.spans.getFinishedSpans() : undefined), 'spans and log');
      const root = finished.find((s) => s.name === 'GET /api/history')!;
      const child = finished.find((s) => s.name === 'history.read')!;
      assert.equal('correlationId' in body && body.correlationId, root.spanContext().traceId);
      for (const span of [root, child]) {
        assert.equal(span.status.code, SpanStatusCode.ERROR);
        const exception = span.events.find((e) => e.name === 'exception');
        assert.ok(exception, `${span.name} records the exception`);
        assert.equal(exception.attributes?.['exception.type'], 'Error');
        assert.equal(exception.attributes?.['exception.message'], UNEXPECTED);
        assert.match(String(exception.attributes?.['exception.stacktrace']), /^Error: disk exploded[\s\S]* at /);
        assert.equal(span.status.message, undefined);
      }
      const [record] = t.logs.getFinishedLogRecords();
      assert.equal(record!.severityNumber, SeverityNumber.ERROR);
      assert.equal(record!.spanContext?.traceId, root.spanContext().traceId);
      assert.equal(record!.attributes['http.response.status_code'], 500);
      assert.equal(record!.attributes['exception.type'], 'Error');
      assert.equal(record!.attributes['error.code'], 'SQLITE_BUSY');
      assert.equal(record!.attributes['correlation.id'], root.spanContext().traceId);
      assert.equal(record!.attributes['exception.message'], UNEXPECTED);
      assert.match(String(record!.attributes['exception.stacktrace']), /^Error: disk exploded[\s\S]* at /);
    } finally {
      await t.close();
    }
  });

  test('#661/AC-1 a failing read with no observer wired still leaves one server log line naming the operation, the exception type and the correlation id of the 500 body, with no error text', async () => {
    const t = await start({ failing: true, observed: false });
    try {
      const response = await t.get();
      assert.equal(response.status, 500);
      const body: unknown = await response.json();
      assert.ok(typeof body === 'object' && body !== null && 'correlationId' in body && typeof body.correlationId === 'string');
      const line = t.lines.find((l) => l.includes('GET /api/history'));
      assert.ok(line, `lines: ${t.lines.join(' | ')}`);
      assert.ok(line.includes(body.correlationId), 'the line carries the correlation id of the response');
      assert.ok(line.includes('Error'), 'the line carries the exception type');
      for (const leak of [UNEXPECTED, 'disk exploded', '/Users/', ' at ', '.ts:']) assert.ok(!line.includes(leak), `the line holds ${leak}`);
    } finally {
      await t.close();
    }
  });

  test('with no observer wired the route behaves as before: 200 and the same body shape', async () => {
    const t = await start({ observed: false });
    try {
      const response = await t.get();
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      assert.ok(typeof body === 'object' && body !== null);
      assert.deepEqual(Object.keys(body).sort(), ['days', 'next']);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(t.spans.getFinishedSpans().length, 0);
      assert.equal(t.logs.getFinishedLogRecords().length, 0);
    } finally {
      await t.close();
    }
  });
});
