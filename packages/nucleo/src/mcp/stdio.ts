// Transporte stdio do MCP: uma mensagem JSON-RPC por linha na entrada, uma resposta por linha na
// saída. Nada além de JSON vai para a saída; o log vai para o stderr.
//
// Quem atende é uma função: o próprio `ServidorMcp` (testes) ou a ponte para o núcleo que já
// roda em 127.0.0.1 (cli.ts), que é o que o Claude Desktop usa. Assim só um processo lê o banco.

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ERROS, erro, type RespostaJsonRpc } from './protocol.ts';

export type Atender = (mensagem: unknown) => Promise<RespostaJsonRpc | RespostaJsonRpc[] | null>;

export interface OpcoesDoStdio {
  atender: Atender;
  entrada?: Readable;
  saida?: Writable;
  log?: (mensagem: string) => void;
}

/** Atende até a entrada fechar; resolve depois da última resposta escrita. */
export async function atenderPorStdio({ atender, entrada = process.stdin, saida = process.stdout, log = () => {} }: OpcoesDoStdio): Promise<void> {
  const pendentes = new Set<Promise<void>>();
  const escrever = (r: unknown) => saida.write(`${JSON.stringify(r)}\n`);
  for await (const linha of createInterface({ input: entrada, crlfDelay: Infinity })) {
    if (!linha.trim()) continue;
    let mensagem: unknown;
    try {
      mensagem = JSON.parse(linha);
    } catch {
      escrever(erro(null, ERROS.parse, 'JSON inválido'));
      continue;
    }
    const p = atender(mensagem)
      .then((r) => {
        if (r !== null) escrever(r);
      })
      .catch((e) => log(`erro: ${(e as Error).message}`))
      .finally(() => pendentes.delete(p));
    pendentes.add(p);
  }
  await Promise.all(pendentes);
}

/**
 * Ponte para o `/mcp` do núcleo: o mesmo servidor, pelo HTTP local. Com o núcleo fora do ar,
 * `semNucleo` responde no lugar dele (`initialize`, `ping` e `tools/list` funcionam; `tools/call`
 * volta com `isError` dizendo como subir o núcleo), para o cliente não marcar o servidor como
 * quebrado só porque o núcleo ainda não subiu. Cada pedido tenta o HTTP de novo.
 */
export function ponteHttp(url: string, { semNucleo, fetcher = fetch }: { semNucleo: Atender; fetcher?: typeof fetch }): Atender {
  return async (mensagem) => {
    let res: Response;
    try {
      res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(mensagem),
      });
    } catch {
      return semNucleo(mensagem);
    }
    if (res.status === 202) return null;
    const texto = await res.text();
    let corpo: RespostaJsonRpc | RespostaJsonRpc[];
    try {
      corpo = JSON.parse(texto) as RespostaJsonRpc | RespostaJsonRpc[];
    } catch {
      return erroComId(mensagem, `resposta inesperada do núcleo (HTTP ${res.status})`);
    }
    // O 4xx do HTTP não sabe o id (o corpo nem foi lido, ou não era JSON-RPC): no stdio, o cliente
    // casa a resposta pelo id, então ela leva o do pedido.
    if (!Array.isArray(corpo) && corpo.id === null && corpo.error) return erroComId(mensagem, corpo.error.message, corpo.error.code);
    return corpo;
  };
}

function erroComId(mensagem: unknown, motivo: string, codigo: number = ERROS.interno): RespostaJsonRpc | RespostaJsonRpc[] | null {
  const um = (m: unknown): RespostaJsonRpc | null => {
    const id = (m as { id?: unknown } | null)?.id;
    return typeof id === 'string' || typeof id === 'number' ? erro(id, codigo, motivo) : null;
  };
  if (Array.isArray(mensagem)) {
    const r = mensagem.map(um).filter((x): x is RespostaJsonRpc => x !== null);
    return r.length > 0 ? r : null;
  }
  return um(mensagem);
}
