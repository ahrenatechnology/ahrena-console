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
// with `useWriter(...)`: POST with JSON, only `/api/`, only the local core. A failure becomes a `WriteError`.

export class ReadError extends Error {
  constructor(message, { status = 0, route = null, retryIn = null, body = null } = {}) {
    super(message);
    this.name = 'ReadError';
    this.status = status;
    this.route = route;
    this.retryIn = retryIn;
    this.body = body;
  }
}

/** The write failed: the same fields as the read (`status`, `route`, `retryIn`, `body`). */
export class WriteError extends ReadError {
  constructor(message, options) {
    super(message, options);
    this.name = 'WriteError';
  }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function httpReader({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !LOCAL_HOSTS.has(origin.hostname)) {
    throw new ReadError(`o console só lê o núcleo local, não ${origin.origin}`);
  }
  return async function readOverHttp(route, { signal } = {}) {
    if (typeof route !== 'string' || !route.startsWith('/api/')) throw new ReadError(`rota fora da API: ${route}`, { route });
    const url = new URL(route, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/')) throw new ReadError(`rota fora do núcleo: ${route}`, { route });
    let response;
    try {
      response = await fetch(url, { signal, headers: { accept: 'application/json' }, credentials: 'omit', cache: 'no-store' });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ReadError(`O núcleo em ${origin.host} não respondeu`, { route });
    }
    const body = await response.json().catch(() => null);
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

/** The HTTP writer: POST with a JSON body, only to `/api/` of the local core, without credentials. */
export function httpWriter({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !LOCAL_HOSTS.has(origin.hostname)) {
    throw new WriteError(`o console só escreve no núcleo local, não ${origin.origin}`);
  }
  return async function writeOverHttp(route, body, { signal } = {}) {
    if (typeof route !== 'string' || !route.startsWith('/api/')) throw new WriteError(`rota fora da API: ${route}`, { route });
    const url = new URL(route, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/')) throw new WriteError(`rota fora do núcleo: ${route}`, { route });
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new WriteError(`O núcleo em ${origin.host} não respondeu`, { route });
    }
    const answer = await response.json().catch(() => null);
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
  };
}

let writer = null;

/** Swaps the write transport (the artifact passes the `host:` writer). */
export function useWriter(next) {
  writer = next;
}

/** Sends `body` (JSON) to a route of the core API and returns the JSON of the answer. */
export function write(route, body, options) {
  writer ??= httpWriter();
  return writer(route, body, options);
}

// ---------- The page's only open-in-desktop write ----------
//
// The session detail's "Abrir no Claude Desktop": `POST /open/<local_…>` on its own origin, in JSON.
// The core accepts this POST with the page's `Origin` and no other (servidor.ts). The artifact swaps
// the transport with `useOpener()`.

const DESKTOP_LOCAL_ID = /^local_[0-9a-f-]{36}$/;

export function httpOpener({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !LOCAL_HOSTS.has(origin.hostname)) throw new ReadError(`o console só fala com o núcleo local, não ${origin.origin}`);
  return async function openOverHttp(local) {
    if (typeof local !== 'string' || !DESKTOP_LOCAL_ID.test(local)) throw new ReadError(`id de sessão do Desktop inválido: ${local}`);
    const route = `/open/${local}`;
    let response;
    try {
      response = await fetch(new URL(route, origin), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}', credentials: 'omit', cache: 'no-store' });
    } catch {
      throw new ReadError(`O núcleo em ${origin.host} não respondeu`, { route });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new ReadError(body?.error ?? `O núcleo respondeu ${response.status}`, { status: response.status, route });
    return body;
  };
}

let opener = null;

/** Swaps the transport of "Abrir no Claude Desktop". */
export function useOpener(f) {
  opener = f;
}

/** Opens the `local_…` conversation in Claude Desktop, through the core. */
export function openInDesktop(local) {
  opener ??= httpOpener();
  return opener(local);
}
