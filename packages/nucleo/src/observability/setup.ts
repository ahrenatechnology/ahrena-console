// The composition root of the observer (#661). Without AHRENA_CONSOLE_OTEL_EXPORTER (or `none`) it returns the
// no-op observer and the OpenTelemetry adapter is never loaded; with `otlp` it loads the adapter by `import()`.
//
//   AHRENA_CONSOLE_OTEL_EXPORTER   `none` (default) | `otlp`
//   AHRENA_CONSOLE_OTEL_ENDPOINT   OTLP/HTTP base URL, with `otlp`
//   AHRENA_CONSOLE_ENVIRONMENT     `deployment.environment`, default `local`
import { API_VERSION } from '../api/version.ts';
import type { OtelObserverOptions } from './otel-observer.ts';
import { noopObserver, type Observability } from './port.ts';

export interface ObservabilityEnv {
  readonly [name: string]: string | undefined;
}

export interface ObservabilityDeps {
  /** Loads the OpenTelemetry adapter; the default is a dynamic `import()` of it. */
  readonly load?: () => Promise<{ createOtelObserver(options: OtelObserverOptions): Promise<Observability> }>;
  /** In-memory exporters installed by a test at this root. */
  readonly exporters?: OtelObserverOptions['exporters'];
}

const EXPORTER_VARIABLE = 'AHRENA_CONSOLE_OTEL_EXPORTER';

export async function createObservability(env: ObservabilityEnv, deps: ObservabilityDeps = {}): Promise<Observability> {
  const exporter = env[EXPORTER_VARIABLE] || 'none';
  if (exporter === 'none') return { observer: noopObserver, shutdown: async () => undefined };
  if (exporter !== 'otlp') throw new Error(`${EXPORTER_VARIABLE} must be none or otlp`);
  const load = deps.load ?? (() => import('./otel-observer.ts'));
  const { createOtelObserver } = await load();
  return createOtelObserver({
    version: API_VERSION,
    environment: env.AHRENA_CONSOLE_ENVIRONMENT || 'local',
    ...(env.AHRENA_CONSOLE_OTEL_ENDPOINT ? { endpoint: env.AHRENA_CONSOLE_OTEL_ENDPOINT } : {}),
    ...(deps.exporters ? { exporters: deps.exporters } : {}),
  });
}
