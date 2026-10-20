// The console interface (#26), served by the core at `/ui`: the desktop app window and, later, the
// artifact. A static page, with no build and no dependencies, in `packages/nucleo/ui/`.
//
// - `/ui`, `/ui/` and any other `/ui/<path>` that does not look like a file return `index.html`: the
//   routing is in the client (`/ui/sessions`, `/ui/sessions/<id>`; the old `/ui/sessoes/<id>` too,
//   which the client swaps for the new one).
// - `/ui/<file>.<js|css|svg>` and `/ui/screens/<file>.<js|css>` return the file, if it exists; nothing
//   outside the folder, nothing with `..`. `/ui/telas/` is the old name of the `screens/` folder and
//   serves the same files until the aliases leave (decision 0009, issue #173).
// - The content policy only lets the page talk to its own origin (127.0.0.1:<port>): no fonts, no
//   scripts, no `fetch` going out.

import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { send } from '../ingest/hooks/receiver.ts';

export const UI_ROUTE = '/ui';
export const UI_FOLDER = fileURLToPath(new URL('../../ui/', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
};

const UI_FILE = /^\/ui\/((?:screens\/)?[a-z0-9-]+\.(js|css|svg))$/;
// The old folder of the screens: the same files.
const LEGACY_SCREENS = /^\/ui\/telas\//;
// A file that does not exist gives 404, not the page: a session id never ends like this.
const LOOKS_LIKE_FILE = /\.(js|mjs|css|svg|html?|json|map|png|ico|txt|woff2?)$/i;

/** The content policy: the page only talks to its own origin. */
export const UI_CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** `/ui` and everything that starts with `/ui/`. */
export const isUiPath = (path: string): boolean => path === UI_ROUTE || path.startsWith(`${UI_ROUTE}/`);

/** Serves `index.html` or a file of the `/ui` folder, with the content policy. */
export async function respondUi(res: ServerResponse, path: string, folder: string = UI_FOLDER): Promise<void> {
  const file = UI_FILE.exec(path.replace(LEGACY_SCREENS, '/ui/screens/'));
  if (!file && LOOKS_LIKE_FILE.test(path)) return send(res, 404, { error: 'não encontrado' });
  const name = file ? file[1] : 'index.html';
  let body: Buffer;
  try {
    body = await readFile(`${folder}${name}`);
  } catch {
    return send(res, 404, { error: 'não encontrado' });
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)]!,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'content-security-policy': UI_CONTENT_POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}
