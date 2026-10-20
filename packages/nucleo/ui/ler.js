// A camada de leitura da interface: toda tela lê o núcleo por `ler(rota)`, e por nada mais.
//
// Na janela do app (e no navegador), `ler` vai por HTTP à própria origem, 127.0.0.1:<porta>. No
// artefato, depois, a mesma página troca o transporte com `usarLeitor(...)` e lê pelo `host:` da
// extensão, sem que as telas mudem.
//
// - A rota é sempre `/api/...`; qualquer outra coisa é recusada antes de sair.
// - O leitor HTTP só fala com 127.0.0.1, localhost ou [::1].
// - Falha vira `ErroDeLeitura`, com `status` (0 quando o núcleo não respondeu) e `tentarEm` (ms,
//   do `Retry-After`) e o `corpo` da resposta, quando veio. Desistir (`signal`) propaga o
//   `AbortError` como veio.
//
// A escrita (`escrever(rota, corpo)`) mora aqui também, com as mesmas regras e o transporte trocável
// por `usarEscritor(...)`: POST com JSON, só `/api/`, só o núcleo local. Falha vira `ErroDeEscrita`.

export class ErroDeLeitura extends Error {
  constructor(mensagem, { status = 0, rota = null, tentarEm = null, corpo = null } = {}) {
    super(mensagem);
    this.name = 'ErroDeLeitura';
    this.status = status;
    this.rota = rota;
    this.tentarEm = tentarEm;
    this.corpo = corpo;
  }
}

/** A escrita falhou: os mesmos campos da leitura (`status`, `rota`, `tentarEm`, `corpo`). */
export class ErroDeEscrita extends ErroDeLeitura {
  constructor(mensagem, opcoes) {
    super(mensagem, opcoes);
    this.name = 'ErroDeEscrita';
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
        corpo,
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

/** O escritor HTTP: POST com corpo JSON, só para `/api/` do núcleo local, sem credenciais. */
export function escritorHttp({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const origem = new URL(base);
  if (origem.protocol !== 'http:' || !LOCAIS.has(origem.hostname)) {
    throw new ErroDeEscrita(`o console só escreve no núcleo local, não ${origem.origin}`);
  }
  return async function escreverPorHttp(rota, corpo, { signal } = {}) {
    if (typeof rota !== 'string' || !rota.startsWith('/api/')) throw new ErroDeEscrita(`rota fora da API: ${rota}`, { rota });
    const url = new URL(rota, origem);
    if (url.origin !== origem.origin || !url.pathname.startsWith('/api/')) throw new ErroDeEscrita(`rota fora do núcleo: ${rota}`, { rota });
    let resposta;
    try {
      resposta = await fetch(url, {
        method: 'POST',
        signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(corpo ?? {}),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ErroDeEscrita(`O núcleo em ${origem.host} não respondeu`, { rota });
    }
    const volta = await resposta.json().catch(() => null);
    if (!resposta.ok) {
      const segundos = Number(resposta.headers.get('retry-after'));
      throw new ErroDeEscrita(volta?.error ?? `O núcleo respondeu ${resposta.status}`, {
        status: resposta.status,
        rota,
        tentarEm: Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : null,
        corpo: volta,
      });
    }
    return volta;
  };
}

let escritor = null;

/** Troca o transporte da escrita (o artefato passa o escritor do `host:`). */
export function usarEscritor(novo) {
  escritor = novo;
}

/** Manda `corpo` (JSON) a uma rota da API do núcleo e devolve o JSON da resposta. */
export function escrever(rota, corpo, opcoes) {
  escritor ??= escritorHttp();
  return escritor(rota, corpo, opcoes);
}

// ---------- A única escrita da página ----------
//
// O "Abrir no Claude Desktop" do Detalhe: `POST /open/<local_…>` na própria origem, em JSON. O núcleo
// aceita esse POST com o `Origin` da página e nenhum outro (servidor.ts). O artefato troca o
// transporte com `usarAbridor()`.

const LOCAL_DO_DESKTOP = /^local_[0-9a-f-]{36}$/;

export function abridorHttp({ base = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const origem = new URL(base);
  if (origem.protocol !== 'http:' || !LOCAIS.has(origem.hostname)) throw new ErroDeLeitura(`o console só fala com o núcleo local, não ${origem.origin}`);
  return async function abrirPorHttp(local) {
    if (typeof local !== 'string' || !LOCAL_DO_DESKTOP.test(local)) throw new ErroDeLeitura(`id de sessão do Desktop inválido: ${local}`);
    const rota = `/open/${local}`;
    let resposta;
    try {
      resposta = await fetch(new URL(rota, origem), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}', credentials: 'omit', cache: 'no-store' });
    } catch {
      throw new ErroDeLeitura(`O núcleo em ${origem.host} não respondeu`, { rota });
    }
    const corpo = await resposta.json().catch(() => null);
    if (!resposta.ok) throw new ErroDeLeitura(corpo?.error ?? `O núcleo respondeu ${resposta.status}`, { status: resposta.status, rota });
    return corpo;
  };
}

let abridor = null;

/** Troca o transporte do "Abrir no Claude Desktop". */
export function usarAbridor(f) {
  abridor = f;
}

/** Abre a conversa `local_…` no Claude Desktop, pelo núcleo. */
export function abrirNoDesktop(local) {
  abridor ??= abridorHttp();
  return abridor(local);
}
