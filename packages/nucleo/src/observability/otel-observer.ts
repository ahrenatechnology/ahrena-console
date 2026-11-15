/* The OpenTelemetry adapter behind the observability port (#661). Loaded by `import()` from setup.ts and only when
   AHRENA_CONSOLE_OTEL_EXPORTER is configured: this is the one file in the core that imports @opentelemetry/*.
   Exits: a span (name, method, route, status code, exception type) and a log record (event.name, method, route,
   status code, correlation id, exception type, error code). The error's text and its stack stay out of both
   (layer-exposure rule); the response carries the correlation id instead. A failed export writes one line per
   failure streak to the internal log: the signal, AHRENA_CONSOLE_OTEL_ENDPOINT and the error type, never its text. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context, type Span } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider, SimpleLogRecordProcessor, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { maskAttributes, type AttributeValue } from './masking.ts';
import type { AdapterDescription, EntryDescription, Observability, Observer, Scope } from './port.ts';

export const SERVICE_NAME = 'ahrena-console-core';
const SCOPE_NAME = 'ahrena-console.core';
const REQUEST_EVENT = 'http.server.request';
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface OtelObserverOptions {
  readonly version: string;
  readonly environment: string;
  /** OTLP/HTTP base URL (#661); absent, the exporters' own default. Ignored when `exporters` is given. */
  readonly endpoint?: string;
  /** Exporters installed by the composition root (#661; tests install in-memory ones); absent, OTLP/HTTP. */
  readonly exporters?: { readonly spans: SpanExporter; readonly logs: LogRecordExporter };
  /** Where a failed-export line goes (#661); absent, stderr. */
  readonly log?: (line: string) => void;
}

/* ExportResultCode.FAILED of @opentelemetry/core, which is not a direct dependency of the core. */
const EXPORT_FAILED = 1;

interface ExportOutcome {
  readonly code: number;
  readonly error?: Error;
}

type ExportFailureLog = (signal: 'traces' | 'logs', errorType: string) => void;

/** One line per failure streak (#661): the first failure writes, the next success re-arms it. */
function failureLogger(write: (line: string) => void): ExportFailureLog {
  return (signal, errorType) => write(`OpenTelemetry export of ${signal} failed (${errorType}); check AHRENA_CONSOLE_OTEL_ENDPOINT`);
}

function streakReporter(signal: 'traces' | 'logs', report: ExportFailureLog): (result: ExportOutcome) => void {
  let failing = false;
  return (result) => {
    if (result.code !== EXPORT_FAILED) {
      failing = false;
      return;
    }
    if (failing) return;
    failing = true;
    report(signal, result.error?.name ?? 'unknown');
  };
}

function reportingSpanExporter(inner: SpanExporter, observe: (result: ExportOutcome) => void): SpanExporter {
  return {
    export: (spans, done) => inner.export(spans, (result) => {
      observe(result);
      done(result);
    }),
    shutdown: () => inner.shutdown(),
    ...(inner.forceFlush ? { forceFlush: () => inner.forceFlush!() } : {}),
  };
}

function reportingLogExporter(inner: LogRecordExporter, observe: (result: ExportOutcome) => void): LogRecordExporter {
  return {
    export: (records, done) => inner.export(records, (result) => {
      observe(result);
      done(result);
    }),
    shutdown: () => inner.shutdown(),
    ...(inner.forceFlush ? { forceFlush: () => inner.forceFlush!() } : {}),
  };
}

interface Failure {
  readonly type: string;
  readonly code: string | null;
}

/** The named fields of a failure (#661): its type and its provider code, never its text or its stack. */
function describeFailure(error: unknown): Failure {
  const type = error instanceof Error ? error.name : typeof error;
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && ERROR_CODE.test(error.code) ? error.code : null;
  return { type, code };
}

function markFailed(span: Span, failure: Failure): void {
  span.addEvent('exception', { 'exception.type': failure.type });
  span.setStatus({ code: SpanStatusCode.ERROR });
}

async function exportersOf(options: OtelObserverOptions): Promise<{ spans: SpanExporter; logs: LogRecordExporter; simple: boolean }> {
  if (options.exporters) return { ...options.exporters, simple: true };
  const [{ OTLPTraceExporter }, { OTLPLogExporter }] = await Promise.all([import('@opentelemetry/exporter-trace-otlp-http'), import('@opentelemetry/exporter-logs-otlp-http')]);
  const base = options.endpoint?.replace(/\/+$/, '');
  return {
    spans: new OTLPTraceExporter(base ? { url: `${base}/v1/traces` } : {}),
    logs: new OTLPLogExporter(base ? { url: `${base}/v1/logs` } : {}),
    simple: false,
  };
}

export async function createOtelObserver(options: OtelObserverOptions): Promise<Observability> {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME, [ATTR_SERVICE_VERSION]: options.version, 'deployment.environment': options.environment });
  const base = await exportersOf(options);
  const report = failureLogger(options.log ?? ((line) => process.stderr.write(`${line}\n`)));
  const exporters = {
    simple: base.simple,
    spans: reportingSpanExporter(base.spans, streakReporter('traces', report)),
    logs: reportingLogExporter(base.logs, streakReporter('logs', report)),
  };
  const tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [exporters.simple ? new SimpleSpanProcessor(exporters.spans) : new BatchSpanProcessor(exporters.spans)] });
  const loggerProvider = new LoggerProvider({ resource, processors: [exporters.simple ? new SimpleLogRecordProcessor({ exporter: exporters.logs }) : new BatchLogRecordProcessor({ exporter: exporters.logs })] });
  const tracer = tracerProvider.getTracer(SCOPE_NAME, options.version);
  const logger = loggerProvider.getLogger(SCOPE_NAME, options.version);
  /* The active context is this observer's own: no global context manager is installed by loading the SDK (#661). */
  const active = new AsyncLocalStorage<Context>();

  function emitRequestLog(context: Context, description: EntryDescription, status: number | null, correlationId: string, failure: Failure | null): void {
    const attributes: Record<string, AttributeValue> = {
      'event.name': REQUEST_EVENT,
      'http.request.method': description.method,
      'http.route': description.route,
      'correlation.id': correlationId,
    };
    if (status !== null) attributes['http.response.status_code'] = status;
    if (failure) attributes['exception.type'] = failure.type;
    if (failure?.code) attributes['error.code'] = failure.code;
    logger.emit({
      eventName: REQUEST_EVENT,
      severityNumber: failure ? SeverityNumber.ERROR : SeverityNumber.INFO,
      severityText: failure ? 'ERROR' : 'INFO',
      body: { method: description.method, route: description.route },
      attributes: maskAttributes(attributes),
      context,
    });
  }

  const observer: Observer = {
    async entry(description: EntryDescription, run: (scope: Scope) => Promise<void>): Promise<void> {
      const span = tracer.startSpan(description.name, { kind: SpanKind.SERVER, attributes: { 'http.request.method': description.method, 'http.route': description.route } }, ROOT_CONTEXT);
      const context = trace.setSpan(ROOT_CONTEXT, span);
      const correlationId = span.spanContext().traceId;
      let status: number | null = null;
      let failure: Failure | null = null;
      const scope: Scope = {
        correlationId,
        fail(error) {
          failure = describeFailure(error);
          markFailed(span, failure);
        },
        respond(code) {
          status = code;
        },
      };
      try {
        await active.run(context, () => run(scope));
      } catch (error) {
        scope.fail(error);
        throw error;
      } finally {
        if (status !== null) span.setAttribute('http.response.status_code', status);
        emitRequestLog(context, description, status, correlationId, failure);
        span.end();
      }
    },

    async adapter<T>(description: AdapterDescription, run: () => Promise<T>): Promise<T> {
      const parent = active.getStore() ?? ROOT_CONTEXT;
      const span = tracer.startSpan(description.name, { kind: SpanKind.CLIENT, attributes: description.system ? { 'db.system': description.system } : {} }, parent);
      try {
        return await active.run(trace.setSpan(parent, span), run);
      } catch (error) {
        markFailed(span, describeFailure(error));
        throw error;
      } finally {
        span.end();
      }
    },
  };

  return {
    observer,
    shutdown: async () => {
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
    },
  };
}
