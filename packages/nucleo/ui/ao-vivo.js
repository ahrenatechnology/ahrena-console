// "Ao vivo": long polling em `GET /api/mudancas?desde=<cursor>&espera=25`, pela camada de leitura.
//
// - O primeiro pedido vai sem cursor e volta na hora com `reiniciar: true`.
// - `reiniciar: true` (núcleo reiniciado, cursor velho) chama `aoReiniciar`: as telas releem tudo.
// - Novidade chama `aoMudar(mudancas)`; timeout sem novidade só segue o laço.
// - Falha muda o estado para `sem-conexao` e tenta de novo, com espera crescente (ou o `Retry-After`
//   de um 503). Quando volta, o estado volta para `ao-vivo` e chama `aoReiniciar`, mesmo que o
//   cursor ainda sirva: o que estava na tela pode ter ficado velho durante a queda.

export const ESTADOS_DO_AO_VIVO = ['conectando', 'ao-vivo', 'sem-conexao'];

const dormirDeVerdade = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export function iniciarAoVivo({
  ler,
  espera = 25,
  atrasos = [1000, 2000, 5000, 10000],
  aoMudar = () => {},
  aoReiniciar = () => {},
  aoEstado = () => {},
  dormir = dormirDeVerdade,
}) {
  const parar = new AbortController();
  let estado = 'conectando';
  let erro = null;
  let proximaTentativa = null;
  const mudar = (novo, e = null, quando = null) => {
    erro = e;
    proximaTentativa = quando;
    if (novo === estado && !e) return;
    estado = novo;
    aoEstado({ estado, erro, proximaTentativa });
  };

  async function laco() {
    let cursor = '';
    let falhas = 0;
    while (!parar.signal.aborted) {
      try {
        const r = await ler(`/api/mudancas?desde=${encodeURIComponent(cursor)}&espera=${espera}`, { signal: parar.signal });
        const voltou = falhas > 0;
        falhas = 0;
        mudar('ao-vivo');
        cursor = r.cursor;
        if (r.reiniciar || voltou) aoReiniciar(r);
        else if (r.mudancas?.length) aoMudar(r.mudancas);
      } catch (e) {
        if (parar.signal.aborted) break;
        falhas++;
        const ms = e?.tentarEm ?? atrasos[Math.min(falhas, atrasos.length) - 1];
        mudar('sem-conexao', e, Date.now() + ms);
        await dormir(ms, parar.signal);
      }
    }
  }

  const fim = laco();
  return {
    get estado() {
      return estado;
    },
    get erro() {
      return erro;
    },
    get proximaTentativa() {
      return proximaTentativa;
    },
    /** Para o laço; a promessa resolve quando o pedido aberto termina. */
    parar() {
      parar.abort();
      return fim;
    },
  };
}
