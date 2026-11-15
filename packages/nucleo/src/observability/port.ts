/* The observability port (#661): the only thing routes, adapters and the edge observer know about telemetry.
   The OpenTelemetry SDK sits behind it (otel-observer.ts) and is loaded only at the composition root (setup.ts). */
import { randomUUID } from 'node:crypto';

/** What an entry point (a route) tells the observer about itself: named fields only, never the URL or the query. */
export interface EntryDescription {
  /** Span name, stable (#661): the method and the route template, e.g. `GET /api/history`. */
  readonly name: string;
  readonly method: string;
  /** The route template (#661), a bounded set of values, never a path with ids in it. */
  readonly route: string;
}

/** What an adapter call tells the observer about itself. */
export interface AdapterDescription {
  /** Span name, stable (#661), e.g. `history.read`. */
  readonly name: string;
  /** `db.system` (#661), when the adapter is a database. */
  readonly system?: string;
}

/** The scope of one entry point execution. */
export interface Scope {
  /** What the caller receives next to a generic error and what the internal log carries (#661): the trace id, or a random id with no exporter. */
  readonly correlationId: string;
  /** An unexpected failure (#661): the span and the log record get the exception type, message and stack through the masking, and the span the error status; the caller never receives them. */
  fail(error: unknown): void;
  /** The status the response carries (#661); the request log record reads it. */
  respond(status: number): void;
}

export interface Observer {
  /** Opens the root span of an entry point and, when it ends, writes its log record (#661). A throw is recorded and rethrown. */
  entry(description: EntryDescription, run: (scope: Scope) => Promise<void>): Promise<void>;
  /** Opens a child span for a call into an adapter (#661). A throw is recorded and rethrown. */
  adapter<T>(description: AdapterDescription, run: () => Promise<T>): Promise<T>;
}

/** The observer when no exporter is configured: it runs the work and records nothing. */
export const noopObserver: Observer = {
  entry: (_description, run) => run({ correlationId: randomUUID(), fail: () => undefined, respond: () => undefined }),
  adapter: (_description, run) => run(),
};

/** An observer plus the flush the composition root runs on shutdown. */
export interface Observability {
  readonly observer: Observer;
  shutdown(): Promise<void>;
}
