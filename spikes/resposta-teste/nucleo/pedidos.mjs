// O lado do núcleo no spike #58: guarda os pedidos das sessões, entrega
// cada um ao console e devolve à sessão a primeira resposta, uma vez só.
//
//   node spikes/resposta-teste/nucleo/pedidos.mjs   (porta 4721)
//
// Dois tokens: o da sessão (publica e espera) e o do console (lista e
// responde). Nenhum dos dois faz o papel do outro.

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const DECISOES = {
  permissao: ['permitir', 'negar'],
  pergunta: ['responder', 'negar'],
  plano: ['aprovar', 'recusar'],
}

function igual(a, b) {
  const x = Buffer.from(a ?? '')
  const y = Buffer.from(b ?? '')
  return x.length === y.length && timingSafeEqual(x, y)
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let texto = ''
    req.on('data', c => {
      texto += c
      if (texto.length > 256_000) req.destroy(new Error('corpo grande demais'))
    })
    req.on('end', () => {
      try {
        ok(texto ? JSON.parse(texto) : {})
      } catch (e) {
        falha(e)
      }
    })
    req.on('error', falha)
  })
}

export function criarNucleo({ tokenSessao, tokenConsole, porta, auditar = () => {}, agora = () => Date.now() }) {
  const pedidos = new Map() // id -> { pedido, resposta?, encerrado?, esperando: Set<fn> }

  function papel(req) {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (igual(token, tokenSessao)) return 'sessao'
    if (igual(token, tokenConsole)) return 'console'
    return undefined
  }

  function vencido(p) {
    return agora() > Date.parse(p.pedido.expiraEm)
  }

  async function tratar(req, res) {
    const enviar = (status, corpo) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(corpo === undefined ? '' : JSON.stringify(corpo))
    }
    // Só o próprio Mac: Host fixo (contra DNS rebinding) e nada vindo de página web.
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${porta}` && host !== `localhost:${porta}`) return enviar(421, { erro: 'host' })
    if (req.headers.origin !== undefined) return enviar(403, { erro: 'origem' })
    const quem = papel(req)
    if (!quem) return enviar(401, { erro: 'token' })

    const url = new URL(req.url, `http://${host}`)
    const [, api, recurso, id, acao] = url.pathname.split('/')
    if (api !== 'api' || recurso !== 'pedidos') return enviar(404)

    if (req.method === 'POST' && !id) {
      if (quem !== 'sessao') return enviar(403, { erro: 'papel' })
      const pedido = await lerCorpo(req)
      if (typeof pedido.id !== 'string' || !DECISOES[pedido.tipo] || typeof pedido.digest !== 'string')
        return enviar(400, { erro: 'pedido' })
      if (pedidos.has(pedido.id)) return enviar(409, { erro: 'pedido repetido' })
      pedidos.set(pedido.id, { pedido, esperando: new Set() })
      auditar({ em: new Date(agora()).toISOString(), evento: 'pedido', id: pedido.id, sessao: pedido.sessao, tipo: pedido.tipo, ferramenta: pedido.ferramenta })
      return enviar(201, { id: pedido.id })
    }

    if (req.method === 'GET' && !id) {
      if (quem !== 'console') return enviar(403, { erro: 'papel' })
      const abertos = [...pedidos.values()].filter(p => !p.resposta && !p.encerrado && !vencido(p)).map(p => p.pedido)
      return enviar(200, abertos)
    }

    const p = pedidos.get(id)
    if (!p) return enviar(404)

    if (req.method === 'POST' && acao === 'resposta') {
      if (quem !== 'console') return enviar(403, { erro: 'papel' })
      if (p.resposta || p.encerrado) return enviar(409, { erro: 'já respondido ou encerrado' })
      if (vencido(p)) return enviar(410, { erro: 'expirado' })
      const corpo = await lerCorpo(req)
      if (!DECISOES[p.pedido.tipo].includes(corpo.decisao)) return enviar(400, { erro: 'decisão' })
      if (typeof corpo.quem !== 'string' || !corpo.quem.trim()) return enviar(400, { erro: 'quem' })
      // O núcleo amarra a resposta ao pedido: o console não escolhe id nem digest.
      p.resposta = { ...corpo, pedido: p.pedido.id, digest: p.pedido.digest }
      auditar({ em: new Date(agora()).toISOString(), evento: 'resposta', id, quem: corpo.quem, canal: corpo.canal, decisao: corpo.decisao })
      for (const acordar of p.esperando) acordar()
      return enviar(202, { id })
    }

    if (req.method === 'GET' && acao === 'resposta') {
      if (quem !== 'sessao') return enviar(403, { erro: 'papel' })
      if (p.encerrado) return enviar(410, { erro: 'encerrado' })
      if (!p.resposta) {
        const ms = Math.min(Number(url.searchParams.get('esperaMs') ?? 0), 25_000)
        await new Promise(acordar => {
          const t = setTimeout(acordar, ms)
          p.esperando.add(() => (clearTimeout(t), acordar()))
        })
      }
      if (!p.resposta) return enviar(204)
      // Entregue uma vez: depois disso o pedido está encerrado.
      p.encerrado = 'entregue'
      return enviar(200, p.resposta)
    }

    if (req.method === 'POST' && acao === 'encerrar') {
      if (quem !== 'sessao') return enviar(403, { erro: 'papel' })
      const { desfecho } = await lerCorpo(req)
      p.encerrado ??= String(desfecho ?? 'encerrado')
      auditar({ em: new Date(agora()).toISOString(), evento: 'encerrado', id, desfecho: p.encerrado })
      return enviar(200, { id })
    }

    return enviar(404)
  }

  const servidor = createServer((req, res) =>
    tratar(req, res).catch(() => {
      res.writeHead(400)
      res.end()
    }),
  )
  return { servidor, pedidos }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const porta = 4721
  const { servidor } = criarNucleo({
    tokenSessao: process.env.TOKEN_SESSAO,
    tokenConsole: process.env.TOKEN_CONSOLE,
    porta,
    auditar: linha => console.log(JSON.stringify(linha)),
  })
  if (!process.env.TOKEN_SESSAO || !process.env.TOKEN_CONSOLE) throw new Error('defina TOKEN_SESSAO e TOKEN_CONSOLE')
  servidor.listen(porta, '127.0.0.1', () => console.log(`pedidos em http://127.0.0.1:${porta}/api/pedidos`))
}
