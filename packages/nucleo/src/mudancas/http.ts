// A rota do long polling na API local, para o app de bandeja e o painel:
//
//   GET /api/changes?since=<cursor>&wait=<s>&session=<id>&account=<id>&type=<tipo>
//
// (The old `/api/mudancas?desde=&espera=&sessao=&conta=&tipo=` is an alias: src/api/legacy-routes.ts.)
//
// - `since` vazio volta na hora com o cursor de agora e `reiniciar: true`.
// - `wait` em segundos (padrão 25, máximo 110; 0 não espera).
// - `session`, `account` e `type` aceitam vírgula ou repetição; `account=sem-conta` pede "Sem conta".
// - O cliente que fecha a conexão libera a espera na hora.
// - Esperas abertas demais: 503 com `Retry-After`.

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { ErroDeLotacao, ESPERA_PADRAO_MS, TIPOS_DE_MUDANCA, type CursorDeMudancas, type FiltrosDeMudanca, type TipoDeMudanca } from './cursor.ts';

export const CHANGES_ROUTE = '/api/changes';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DAS_MUDANCAS = '/api/mudancas';
export const SEM_CONTA = 'sem-conta';

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function lista(url: URL, nome: string): string[] | undefined {
  const valores = url.searchParams.getAll(nome).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return valores.length > 0 ? valores : undefined;
}

/** Lê os parâmetros; devolve a mensagem de erro quando algum é inválido. */
export function lerPedidoDeMudancas(url: URL): { cursor: string | null; timeoutMs: number; filtros: FiltrosDeMudanca } | string {
  const filtros: FiltrosDeMudanca = {};
  const sessoes = lista(url, 'session');
  if (sessoes) {
    if (!sessoes.every((s) => ID.test(s))) return 'sessao inválida';
    filtros.sessionIds = sessoes;
  }
  const contas = lista(url, 'account');
  if (contas) {
    if (!contas.every((c) => ID.test(c))) return 'conta inválida';
    filtros.accountIds = contas.map((c) => (c === SEM_CONTA ? null : c));
  }
  const tipos = lista(url, 'type');
  if (tipos) {
    if (!tipos.every((t): t is TipoDeMudanca => (TIPOS_DE_MUDANCA as readonly string[]).includes(t))) {
      return `tipo: um de ${TIPOS_DE_MUDANCA.join(', ')}`;
    }
    filtros.tipos = tipos as TipoDeMudanca[];
  }
  const espera = url.searchParams.get('wait');
  const segundos = espera === null || espera === '' ? ESPERA_PADRAO_MS / 1000 : Number(espera);
  if (!Number.isFinite(segundos) || segundos < 0) return 'espera inválida';
  return { cursor: url.searchParams.get('since'), timeoutMs: segundos * 1000, filtros };
}

export async function responderMudancas(
  res: ServerResponse,
  url: URL,
  mudancas: CursorDeMudancas,
): Promise<void> {
  const pedido = lerPedidoDeMudancas(url);
  if (typeof pedido === 'string') return send(res, 400, { error: pedido });
  const desistiu = new AbortController();
  const aoFechar = () => desistiu.abort();
  res.once('close', aoFechar);
  try {
    const resposta = await mudancas.aguardar(pedido.cursor, { ...pedido, signal: desistiu.signal });
    if (!res.destroyed && !res.writableEnded) send(res, 200, resposta);
  } catch (err) {
    if (!(err instanceof ErroDeLotacao)) throw err;
    res.setHeader('retry-after', '5');
    send(res, 503, { error: err.message });
  } finally {
    res.off('close', aoFechar);
  }
}
