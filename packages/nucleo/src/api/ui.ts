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

export const ROTA_DA_UI = '/ui';
export const PASTA_DA_UI = fileURLToPath(new URL('../../ui/', import.meta.url));

const TIPOS: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
};

const ARQUIVO = /^\/ui\/((?:screens\/)?[a-z0-9-]+\.(js|css|svg))$/;
// The old folder of the screens: the same files.
const LEGACY_SCREENS = /^\/ui\/telas\//;
// Um arquivo que não existe dá 404, não a página: um id de sessão nunca termina assim.
const PARECE_ARQUIVO = /\.(js|mjs|css|svg|html?|json|map|png|ico|txt|woff2?)$/i;

export const POLITICA_DA_UI = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** `/ui` e tudo o que começa com `/ui/`. */
export const ehDaUi = (caminho: string): boolean => caminho === ROTA_DA_UI || caminho.startsWith(`${ROTA_DA_UI}/`);

export async function responderUi(res: ServerResponse, caminho: string, pasta: string = PASTA_DA_UI): Promise<void> {
  const arquivo = ARQUIVO.exec(caminho.replace(LEGACY_SCREENS, '/ui/screens/'));
  if (!arquivo && PARECE_ARQUIVO.test(caminho)) return send(res, 404, { error: 'não encontrado' });
  const nome = arquivo ? arquivo[1] : 'index.html';
  let corpo: Buffer;
  try {
    corpo = await readFile(`${pasta}${nome}`);
  } catch {
    return send(res, 404, { error: 'não encontrado' });
  }
  res.writeHead(200, {
    'content-type': TIPOS[nome.slice(nome.lastIndexOf('.') + 1)]!,
    'content-length': corpo.length,
    'cache-control': 'no-cache',
    'content-security-policy': POLITICA_DA_UI,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(corpo);
}
