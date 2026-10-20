// `GET /api/historico?antes=<AAAA-MM-DD>&dias=<N>&busca=<texto>` (#33, C15): as sessões encerradas
// por dia, com o detalhe de cada uma e a ligação depois do /clear. As regras estão em
// src/historico/modelo.ts e a leitura em src/historico/leitura.ts; aqui só o pedido e a resposta.
//
// - `antes` (opcional): só os dias estritamente anteriores; sem ele, do dia mais recente com sessão.
// - `dias` (opcional, padrão 7, máximo 31): quantos dias com sessão encerrada por página.
// - `busca` (opcional, até 100 caracteres): substring sem diferenciar maiúsculas no título, no id e no projeto.
// - Parâmetro inválido: 400 `{ error }`. Sem o histórico ligado na API: 404.
// Resposta 200: `{ dias: [{ dia, sessoes: ItemDoHistorico[] }], proximo }` (src/historico/leitura.ts).

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { HistoricoDeSessoes } from '../historico/leitura.ts';
import { lerPedidoDoHistorico } from '../historico/modelo.ts';

export const ROTA_DO_HISTORICO = '/api/historico';

export async function responderHistorico(res: ServerResponse, url: URL, historico: HistoricoDeSessoes | null | undefined): Promise<void> {
  if (!historico) return send(res, 404, { error: 'o núcleo subiu sem o histórico' });
  const lido = lerPedidoDoHistorico(url.searchParams);
  if (!lido.ok) return send(res, 400, { error: lido.erro });
  send(res, 200, await historico.pagina(lido.pedido));
}
