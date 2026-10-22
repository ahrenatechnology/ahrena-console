// The two request checks the same-origin rules share (decision 0003, extended by 0011 §6, #241).

import type { IncomingMessage } from 'node:http';

/** The request comes from our own `/ui`: `Origin` equal to `http://<Host>`, and the Host is ours. */
export function fromOwnUi(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  return origin === `http://${host}`;
}

/**
 * A browser on another page: `Sec-Fetch-Site: cross-site` or `same-site` (a `<form>`, an `<img>`, a
 * no-cors `fetch`, which send no `Origin`). A browser always sends it; the /ui itself is `same-origin`,
 * a typed URL `none`, and a client that is not a browser sends nothing.
 */
export function fromAnotherSite(req: IncomingMessage): boolean {
  return /^(cross-site|same-site)$/i.test(String(req.headers['sec-fetch-site'] ?? ''));
}
