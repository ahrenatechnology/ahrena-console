// `GET /api/history?before=<AAAA-MM-DD>&days=<N>&search=<texto>` (#33, C15): as sessões encerradas
// por dia, com o detalhe de cada uma e a ligação depois do /clear. As regras estão em
// src/historico/modelo.ts e a leitura em src/historico/leitura.ts; aqui só o pedido e a resposta.
//
// - `before` (opcional): só os dias estritamente anteriores; sem ele, do dia mais recente com sessão.
// - `days` (opcional, padrão 7, máximo 31): quantos dias com sessão encerrada por página.
// - `search` (opcional, até 100 caracteres): substring sem diferenciar maiúsculas no título, no id e no projeto.
// - Parâmetro inválido: 400 `{ error }`. Sem o histórico ligado na API: 404.
// Resposta 200: `{ days: [{ day, sessions: ItemDoHistorico[] }], next }` (src/historico/leitura.ts);
// the old route `/api/historico` answers it in the old keys (src/api/legacy-routes.ts).

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { HistoricoDeSessoes } from '../historico/leitura.ts';
import { lerPedidoDoHistorico } from '../historico/modelo.ts';

export const HISTORY_ROUTE = '/api/history';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DO_HISTORICO = '/api/historico';

export async function responderHistorico(res: ServerResponse, url: URL, historico: HistoricoDeSessoes | null | undefined): Promise<void> {
  if (!historico) return send(res, 404, { error: 'o núcleo subiu sem o histórico' });
  const lido = lerPedidoDoHistorico(url.searchParams);
  if (!lido.ok) return send(res, 400, { error: lido.erro });
  send(res, 200, await historico.pagina(lido.pedido));
}
