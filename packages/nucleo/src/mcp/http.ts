// Transporte HTTP do MCP ("Streamable HTTP" sem sessão), montado em `/mcp` na porta da API local.
//
// - `POST /mcp` com uma mensagem JSON-RPC (ou um lote): resposta em `application/json`, sem SSE.
//   Só notificações → 202 sem corpo.
// - `GET /mcp` → 405: o servidor não abre stream para o cliente (a spec permite). Quem quer
//   esperar mudança chama a ferramenta de long polling (2.4), que responde no próprio POST.
// - `DELETE /mcp` → 405: stateless, não há `Mcp-Session-Id` para encerrar.
// - `MCP-Protocol-Version` (2025-06-18 em diante) com versão que não conhecemos → 400. Sem o
//   cabeçalho, vale qualquer uma (é o que a spec manda supor para o cliente de 2025-03-26).
//
// `Origin` e `Host` são conferidos antes, pelo servidor da API (decisão 0003): é a defesa contra
// DNS rebinding que a spec pede.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, send } from '../ingest/hooks/receiver.ts';
import { ERROS, erro, VERSOES_DO_PROTOCOLO, type ServidorMcp } from './protocol.ts';

export const CAMINHO_DO_MCP = '/mcp';

export type RotaMcp = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function criarRotaMcp(servidor: ServidorMcp): RotaMcp {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return send(res, 405, erro(null, ERROS.pedidoInvalido, 'use POST: este servidor MCP não abre stream nem guarda sessão'));
    }
    const versao = header(req, 'mcp-protocol-version');
    if (versao && !(VERSOES_DO_PROTOCOLO as readonly string[]).includes(versao)) {
      return send(res, 400, erro(null, ERROS.pedidoInvalido, `MCP-Protocol-Version não suportada: ${versao}`));
    }
    const tipo = header(req, 'content-type') ?? '';
    if (!tipo.toLowerCase().includes('application/json')) return send(res, 415, erro(null, ERROS.pedidoInvalido, 'use Content-Type: application/json'));

    let corpo: string;
    try {
      corpo = await readBody(req);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      return send(res, status, erro(null, ERROS.pedidoInvalido, (e as Error).message));
    }
    let mensagem: unknown;
    try {
      mensagem = JSON.parse(corpo);
    } catch {
      return send(res, 400, erro(null, ERROS.parse, 'JSON inválido'));
    }

    // A chamada longa (long polling) para quando o cliente fecha a conexão.
    const desistiu = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) desistiu.abort();
    });
    const resposta = await servidor.atender(mensagem, { sinal: desistiu.signal, versao });
    if (desistiu.signal.aborted) return;
    if (resposta === null) {
      res.writeHead(202).end();
      return;
    }
    send(res, 200, resposta);
  };
}

function header(req: IncomingMessage, nome: string): string | null {
  const v = req.headers[nome];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
