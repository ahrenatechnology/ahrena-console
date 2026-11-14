// The read layer of the interface: every screen reads the core through `read(route)`, and nothing else.
//
// In the app window (and in the browser), `read` goes over HTTP to its own origin, 127.0.0.1:<port>.
// In the artifact, later, the same page swaps the transport with `useReader(...)` and reads through
// the extension's `host:`, without the screens changing.
//
// - The route is always `/api/...`; anything else is refused before it goes out.
// - The HTTP reader only talks to 127.0.0.1, localhost or [::1].
// - A failure becomes a `ReadError`, with `status` (0 when the core did not answer), `retryIn` (ms,
//   from `Retry-After`) and the response `body`, when there was one. Giving up (`signal`) propagates
//   the `AbortError` as it came.
//
// The write (`write(route, body)`) lives here too, with the same rules and a transport swappable
// with `useWriter(...)`: POST with JSON (or, with `{ method: 'DELETE' }`, a DELETE without a body; `{ method: 'PATCH' }` sends
// JSON as POST does, and a DELETE that needs its JSON body says `{ jsonBody: true }`), only `/api/`, only the local core.
// A failure becomes a `WriteError` (issue 535).
//
// Both transports carry a deadline (issues 525 and 557): `timeoutMs`, from the factory options (default 60 s) or per call
// (`{ timeoutMs }`, for a route that legitimately blocks longer: the dictation and the framework install). The deadline
// covers the wait for the answer and the read of its body. When it passes, the request is aborted and ends as a
// `ReadError` / `WriteError` with status 0 and the same "O núcleo em <host> não respondeu" as an unreachable core, so
// every screen's existing failure state runs; `timedOut: true` tells that case from an unreachable core (the core may still finish
// what it was asked). It is combined with the caller's `signal`: the caller giving up first
// still cancels the request, also while the body is being read, and propagates its `AbortError`. The timer is cleared once the request settles.

export class ReadError extends Error {
  constructor(message, { status = 0, route = null, retryIn = null, body = null, timedOut = false } = {}) {
    super(message);
    this.name = 'ReadError';
    this.timedOut = timedOut;
    this.status = status;
    this.route = route;
    this.retryIn = retryIn;
    this.body = body;
  }
}

/** The write failed: the same fields as the read (`status`, `route`, `retryIn`, `body`, `timedOut`). */
export class WriteError extends ReadError {
  constructor(message, options) {
    super(message, options);
    this.name = 'WriteError';
  }
}

// Injected only by the owner's native window, never by the HTTP-served HTML.
function ownerHeaders() {
  const token = globalThis.__AHRENA_OWNER_TOKEN__;
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? { authorization: `Bearer ${token}` } : {};
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** How long a read or a write waits for the core before giving up (issues 525 and 557). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One deadline for one request, combined with the caller's `signal` (by hand, so both are honoured without `AbortSignal.any`) (issue 525).
 * `signal` goes to `fetch`; `run(promise)` ends as soon as either fires, even when the transport ignores the signal;
 * `timedOut` says it was the deadline, not the caller; `clear()` drops the timer and the listener.
 */
function startDeadline(callerSignal, timeoutMs) {
  const controller = new AbortController();
  const state = { timedOut: false };
  let timer = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    callerSignal?.removeEventListener('abort', onCaller);
  };
  function onCaller() {
    clear();
    controller.abort(callerSignal.reason);
  }
  const ended = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  ended.catch(() => {});
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener('abort', onCaller, { once: true });
    timer = setTimeout(() => {
      timer = null;
      state.timedOut = true;
      controller.abort(new DOMException('The request timed out', 'TimeoutError'));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return state.timedOut && !callerSignal?.aborted;
    },
    /** The caller's own abort, as it came (its reason, or an AbortError), or null while the caller has not given up (issue 557). */
    callerAbort: () => (callerSignal?.aborted ? (callerSignal.reason ?? new DOMException('This operation was aborted', 'AbortError')) : null),
    run: (promise) => Promise.race([promise, ended]),
    clear,
  };
}

function deadlineOf(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function httpReader({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis), timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !LOCAL_HOSTS.has(origin.hostname)) {
    throw new ReadError(`o console só lê o núcleo local, não ${origin.origin}`);
  }
  return async function readOverHttp(route, { signal, timeoutMs } = {}) {
    if (typeof route !== 'string' || !route.startsWith('/api/')) throw new ReadError(`rota fora da API: ${route}`, { route });
    const url = new URL(route, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/')) throw new ReadError(`rota fora do núcleo: ${route}`, { route });
    const deadline = startDeadline(signal, deadlineOf(timeoutMs, deadlineOf(defaultTimeoutMs, DEFAULT_TIMEOUT_MS)));
    const silent = (timedOut = false) => new ReadError(`O núcleo em ${origin.host} não respondeu`, { route, timedOut });
    try {
      let response;
      try {
        response = await deadline.run(fetch(url, { signal: deadline.signal, headers: { ...ownerHeaders(), accept: 'application/json' }, credentials: 'omit', cache: 'no-store' }));
      } catch (err) {
        if (deadline.timedOut) throw silent(true);
        const gaveUp = deadline.callerAbort();
        if (gaveUp) throw gaveUp;
        throw silent();
      }
      let body;
      try {
        body = await deadline.run(response.json());
      } catch {
        if (deadline.timedOut) throw silent(true);
        const gaveUp = deadline.callerAbort();
        if (gaveUp) throw gaveUp;
        body = null;
      }
      if (!response.ok) {
        const seconds = Number(response.headers.get('retry-after'));
        throw new ReadError(body?.error ?? `O núcleo respondeu ${response.status}`, {
          status: response.status,
          route,
          retryIn: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
          body,
        });
      }
      return body;
    } finally {
      deadline.clear();
    }
  };
}

let current = null;

/** Swaps the transport (the artifact passes the `host:` reader). */
export function useReader(reader) {
  current = reader;
}

/** Reads a route of the core API and returns the JSON. */
export function read(route, options) {
  current ??= httpReader();
  return current(route, options);
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

/**
 * The HTTP writer: POST or PATCH with a JSON body (or DELETE, which goes without one unless `jsonBody` is true: the issue's
 * Plan step route names the step in it; a `Blob` or bytes go as they are, with their own type: the dictation's WAV), only to
 * `/api/` of the local core, without credentials.
 */
export function httpWriter({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis), timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !LOCAL_HOSTS.has(origin.hostname)) {
    throw new WriteError(`o console só escreve no núcleo local, não ${origin.origin}`);
  }
  const isBinary = (b) => (typeof Blob !== 'undefined' && b instanceof Blob) || b instanceof ArrayBuffer || ArrayBuffer.isView(b);
  return async function writeOverHttp(route, body, { signal, method = 'POST', jsonBody = false, timeoutMs } = {}) {
    if (typeof route !== 'string' || !route.startsWith('/api/')) throw new WriteError(`rota fora da API: ${route}`, { route });
    if (!WRITE_METHODS.has(method)) throw new WriteError(`método de escrita não aceito: ${method}`, { route });
    const url = new URL(route, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/')) throw new WriteError(`rota fora do núcleo: ${route}`, { route });
    const deadline = startDeadline(signal, deadlineOf(timeoutMs, deadlineOf(defaultTimeoutMs, DEFAULT_TIMEOUT_MS)));
    const silent = (timedOut = false) => new WriteError(`O núcleo em ${origin.host} não respondeu`, { route, timedOut });
    const common = { method, signal: deadline.signal, credentials: 'omit', cache: 'no-store' };
    const headers = { ...ownerHeaders(), accept: 'application/json' };
    try {
      let response;
      try {
        response = await deadline.run(
          fetch(
            url,
            method === 'DELETE' && !jsonBody
              ? { ...common, headers }
              : isBinary(body)
                ? { ...common, headers: { ...headers, 'content-type': body.type || 'application/octet-stream' }, body }
                : { ...common, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) },
          ),
        );
      } catch (err) {
        if (deadline.timedOut) throw silent(true);
        const gaveUp = deadline.callerAbort();
        if (gaveUp) throw gaveUp;
        throw silent();
      }
      let answer;
      try {
        answer = await deadline.run(response.json());
      } catch {
        if (deadline.timedOut) throw silent(true);
        const gaveUp = deadline.callerAbort();
        if (gaveUp) throw gaveUp;
        answer = null;
      }
      if (!response.ok) {
        const seconds = Number(response.headers.get('retry-after'));
        throw new WriteError(answer?.error ?? `O núcleo respondeu ${response.status}`, {
          status: response.status,
          route,
          retryIn: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
          body: answer,
        });
      }
      return answer;
    } finally {
      deadline.clear();
    }
  };
}

let writer = null;

/** Swaps the write transport (the artifact passes the `host:` writer). */
export function useWriter(next) {
  writer = next;
}

/** Whether this page can write to a core: the HTTP writer works on a local origin; the artifact has none. */
export function canWrite() {
  if (writer) return true;
  try {
    writer = httpWriter();
    return true;
  } catch {
    return false;
  }
}

/** Sends `body` (JSON) to a route of the core API and returns the JSON of the answer; `{ method: 'PATCH' }` patches, `{ method: 'DELETE' }` deletes (`jsonBody: true` keeps the body). */
export function write(route, body, options) {
  writer ??= httpWriter();
  return writer(route, body, options);
}
