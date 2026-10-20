// A camada de leitura da interface: toda tela lê o núcleo por `ler(rota)`, e por nada mais.
//
// Na janela do app (e no navegador), `ler` vai por HTTP à própria origem, 127.0.0.1:<porta>. No
// artefato, depois, a mesma página troca o transporte com `usarLeitor(...)` e lê pelo `host:` da
// extensão, sem que as telas mudem.
//
// - A rota é sempre `/api/...`; qualquer outra coisa é recusada antes de sair.
// - O leitor HTTP só fala com 127.0.0.1, localhost ou [::1].
// - Falha vira `ErroDeLeitura`, com `status` (0 quando o núcleo não respondeu) e `tentarEm` (ms,
//   do `Retry-After`). Desistir (`signal`) propaga o `AbortError` como veio.

export class ErroDeLeitura extends Error {
  constructor(mensagem, { status = 0, rota = null, tentarEm = null } = {}) {
    super(mensagem);
    this.name = 'ErroDeLeitura';
    this.status = status;
    this.rota = rota;
    this.tentarEm = tentarEm;
  }
}

const LOCAIS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function leitorHttp({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const origem = new URL(base);
  if (origem.protocol !== 'http:' || !LOCAIS.has(origem.hostname)) {
    throw new ErroDeLeitura(`o console só lê o núcleo local, não ${origem.origin}`);
  }
  return async function lerPorHttp(rota, { signal } = {}) {
    if (typeof rota !== 'string' || !rota.startsWith('/api/')) throw new ErroDeLeitura(`rota fora da API: ${rota}`, { rota });
    const url = new URL(rota, origem);
    if (url.origin !== origem.origin || !url.pathname.startsWith('/api/')) throw new ErroDeLeitura(`rota fora do núcleo: ${rota}`, { rota });
    let resposta;
    try {
      resposta = await fetch(url, { signal, headers: { accept: 'application/json' }, credentials: 'omit', cache: 'no-store' });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ErroDeLeitura(`O núcleo em ${origem.host} não respondeu`, { rota });
    }
    const corpo = await resposta.json().catch(() => null);
    if (!resposta.ok) {
      const segundos = Number(resposta.headers.get('retry-after'));
      throw new ErroDeLeitura(corpo?.error ?? `O núcleo respondeu ${resposta.status}`, {
        status: resposta.status,
        rota,
        tentarEm: Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : null,
      });
    }
    return corpo;
  };
}

let atual = null;

/** Troca o transporte (o artefato passa o leitor do `host:`). */
export function usarLeitor(leitor) {
  atual = leitor;
}

/** Lê uma rota da API do núcleo e devolve o JSON. */
export function ler(rota, opcoes) {
  atual ??= leitorHttp();
  return atual(rota, opcoes);
}

// ---------- As escritas das Decisões (issue 103) ----------
//
// Confirmar, Descartar e Promover a registro: `POST /api/decisoes/<id>/<acao>` na própria origem, em
// JSON. Mesmas travas do leitor (só /api/, só o núcleo local, `credentials: 'omit'`), e o núcleo só
// aceita esse POST com o `Origin` da página (servidor.ts). O artefato troca o transporte com
// `usarEscritor()`. As telas não chamam `fetch`: chamam `escrever(rota, corpo)`.

const ROTA_DE_ESCRITA = /^\/api\/decisoes\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/(confirmar|descartar|ajustar|desfazer|promover)$/;

export function escritorHttp({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const origem = new URL(base);
  if (origem.protocol !== 'http:' || !LOCAIS.has(origem.hostname)) throw new ErroDeLeitura(`o console só fala com o núcleo local, não ${origem.origin}`);
  return async function escreverPorHttp(rota, corpo = {}, { signal } = {}) {
    if (typeof rota !== 'string' || !ROTA_DE_ESCRITA.test(rota)) throw new ErroDeLeitura(`escrita fora das decisões: ${rota}`, { rota });
    const url = new URL(rota, origem);
    if (url.origin !== origem.origin || url.pathname !== rota) throw new ErroDeLeitura(`rota fora do núcleo: ${rota}`, { rota });
    let resposta;
    try {
      resposta = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(corpo ?? {}), credentials: 'omit', cache: 'no-store' });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ErroDeLeitura(`O núcleo em ${origem.host} não respondeu`, { rota });
    }
    const dados = await resposta.json().catch(() => null);
    if (!resposta.ok) throw new ErroDeLeitura(dados?.error ?? `O núcleo respondeu ${resposta.status}`, { status: resposta.status, rota });
    return dados;
  };
}

let escritor = null;

/** Troca o transporte das escritas (o artefato passa o do `host:`). */
export function usarEscritor(f) {
  escritor = f;
}

/** `POST` em JSON numa rota de escrita das decisões; devolve o JSON da resposta. */
export function escrever(rota, corpo, opcoes) {
  escritor ??= escritorHttp();
  return escritor(rota, corpo, opcoes);
}
