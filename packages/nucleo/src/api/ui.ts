// A interface do console (#26), servida pelo núcleo em `/ui`: a janela do app desktop e, depois, o
// artefato. Página estática, sem build e sem dependências, em `packages/nucleo/ui/`.
//
// - `/ui`, `/ui/` e qualquer outro `/ui/<caminho>` que não pareça arquivo devolvem o `index.html`: o
//   roteamento é no cliente (`/ui/sessoes`, `/ui/sessoes/<id>`).
// - `/ui/<arquivo>.<js|css|svg>` e `/ui/telas/<arquivo>.js` devolvem o arquivo, se existir; nada fora
//   da pasta, nada com `..`.
// - A política de conteúdo só deixa a página falar com a própria origem (127.0.0.1:<porta>): nem
//   fontes, nem scripts, nem `fetch` para fora.

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

const ARQUIVO = /^\/ui\/((?:telas\/)?[a-z0-9-]+\.(js|css|svg))$/;
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
  const arquivo = ARQUIVO.exec(caminho);
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
