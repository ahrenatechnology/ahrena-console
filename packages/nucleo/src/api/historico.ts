// `GET /api/history?before=<AAAA-MM-DD>&days=<N>&search=<texto>` (#33, C15): as sessões encerradas
// por dia, com o detalhe de cada uma e a ligação depois do /clear. As regras estão em
// src/history/model.ts e a leitura em src/history/reading.ts; aqui só o pedido e a resposta.
//
// - `before` (opcional): só os dias estritamente anteriores; sem ele, do dia mais recente com sessão.
// - `days` (opcional, padrão 7, máximo 31): quantos dias com sessão encerrada por página.
// - `search` (opcional, até 100 caracteres): substring sem diferenciar maiúsculas no título, no id e no projeto.
// - Parâmetro inválido: 400 `{ error }`. Sem o histórico ligado na API: 404.
// Resposta 200: `{ days: [{ day, sessions: HistoryItem[] }], next }` (src/history/reading.ts);
// the old route `/api/historico` answers it in the old keys (src/api/legacy-routes.ts).

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { SessionHistory } from '../history/reading.ts';
import { parseHistoryRequest } from '../history/model.ts';

export const HISTORY_ROUTE = '/api/history';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DO_HISTORICO = '/api/historico';

export async function responderHistorico(res: ServerResponse, url: URL, historico: SessionHistory | null | undefined): Promise<void> {
  if (!historico) return send(res, 404, { error: 'o núcleo subiu sem o histórico' });
  const parsed = parseHistoryRequest(url.searchParams);
  if (!parsed.ok) return send(res, 400, { error: parsed.error });
  send(res, 200, await historico.page(parsed.request));
}
