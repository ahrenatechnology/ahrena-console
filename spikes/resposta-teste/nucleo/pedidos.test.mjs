import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { criarNucleo } from './pedidos.mjs'

const SESSAO = 'token-sessao'
const CONSOLE = 'token-console'

async function subir() {
  const auditoria = []
  const { servidor } = criarNucleo({ tokenSessao: SESSAO, tokenConsole: CONSOLE, porta: 0, auditar: l => auditoria.push(l) })
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok))
  const porta = servidor.address().port
  // A porta só é conhecida depois do listen: refaz o núcleo com ela.
  servidor.close()
  const nucleo = criarNucleo({ tokenSessao: SESSAO, tokenConsole: CONSOLE, porta, auditar: l => auditoria.push(l) })
  await new Promise(ok => nucleo.servidor.listen(porta, '127.0.0.1', ok))
  const chamar = (metodo, caminho, { token, corpo, cabecalhos = {} } = {}) =>
    new Promise((ok, falha) => {
      const req = request(
        { host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers: { authorization: `Bearer ${token}`, ...cabecalhos } },
        res => {
          let texto = ''
          res.on('data', c => (texto += c))
          res.on('end', () => ok({ status: res.statusCode, corpo: texto ? JSON.parse(texto) : undefined }))
        },
      )
      req.on('error', falha)
      req.end(corpo === undefined ? undefined : JSON.stringify(corpo))
    })
  return { chamar, auditoria, fechar: () => nucleo.servidor.close() }
}

const pedido = (extra = {}) => ({
  id: crypto.randomUUID(),
  sessao: 's1',
  tipo: 'permissao',
  ferramenta: 'Bash',
  entrada: { command: 'npm test' },
  digest: 'a'.repeat(64),
  expiraEm: new Date(Date.now() + 30_000).toISOString(),
  soNegar: false,
  ...extra,
})

test('do pedido à resposta, uma vez só, com auditoria', async () => {
  const n = await subir()
  try {
    const p = pedido()
    assert.equal((await n.chamar('POST', '/api/pedidos', { token: SESSAO, corpo: p })).status, 201)
    const abertos = await n.chamar('GET', '/api/pedidos', { token: CONSOLE })
    assert.deepEqual(abertos.corpo.map(x => x.id), [p.id])

    const espera = n.chamar('GET', `/api/pedidos/${p.id}/resposta?esperaMs=5000`, { token: SESSAO })
    const r = await n.chamar('POST', `/api/pedidos/${p.id}/resposta`, {
      token: CONSOLE,
      corpo: { decisao: 'permitir', quem: 'ana', canal: 'painel', digest: 'b'.repeat(64), pedido: 'outro' },
    })
    assert.equal(r.status, 202)
    const entregue = await espera
    assert.equal(entregue.status, 200)
    // O console não escolhe o pedido nem o digest.
    assert.equal(entregue.corpo.pedido, p.id)
    assert.equal(entregue.corpo.digest, p.digest)

    const segunda = await n.chamar('POST', `/api/pedidos/${p.id}/resposta`, { token: CONSOLE, corpo: { decisao: 'negar', quem: 'bia', canal: 'hub' } })
    assert.equal(segunda.status, 409)
    assert.equal((await n.chamar('GET', `/api/pedidos/${p.id}/resposta`, { token: SESSAO })).status, 410)
    assert.deepEqual(n.auditoria.map(l => l.evento), ['pedido', 'resposta'])
  } finally {
    n.fechar()
  }
})

test('cada token só faz o seu papel', async () => {
  const n = await subir()
  try {
    const p = pedido()
    assert.equal((await n.chamar('POST', '/api/pedidos', { token: CONSOLE, corpo: p })).status, 403)
    assert.equal((await n.chamar('POST', '/api/pedidos', { token: 'errado', corpo: p })).status, 401)
    await n.chamar('POST', '/api/pedidos', { token: SESSAO, corpo: p })
    const pelaSessao = await n.chamar('POST', `/api/pedidos/${p.id}/resposta`, { token: SESSAO, corpo: { decisao: 'permitir', quem: 'eu' } })
    assert.equal(pelaSessao.status, 403)
  } finally {
    n.fechar()
  }
})

test('recusa página web, Host estranho, pedido repetido e expirado', async () => {
  const n = await subir()
  try {
    const comOrigem = await n.chamar('GET', '/api/pedidos', { token: CONSOLE, cabecalhos: { origin: 'https://exemplo.com' } })
    assert.equal(comOrigem.status, 403)
    const rebinding = await n.chamar('GET', '/api/pedidos', { token: CONSOLE, cabecalhos: { host: 'atacante.exemplo:80' } })
    assert.equal(rebinding.status, 421)

    const p = pedido()
    await n.chamar('POST', '/api/pedidos', { token: SESSAO, corpo: p })
    assert.equal((await n.chamar('POST', '/api/pedidos', { token: SESSAO, corpo: p })).status, 409)

    const velho = pedido({ expiraEm: new Date(Date.now() - 1).toISOString() })
    await n.chamar('POST', '/api/pedidos', { token: SESSAO, corpo: velho })
    const tarde = await n.chamar('POST', `/api/pedidos/${velho.id}/resposta`, { token: CONSOLE, corpo: { decisao: 'permitir', quem: 'ana', canal: 'painel' } })
    assert.equal(tarde.status, 410)
  } finally {
    n.fechar()
  }
})

test('pedido encerrado pela sessão não aceita resposta', async () => {
  const n = await subir()
  try {
    const p = pedido()
    await n.chamar('POST', '/api/pedidos', { token: SESSAO, corpo: p })
    await n.chamar('POST', `/api/pedidos/${p.id}/encerrar`, { token: SESSAO, corpo: { desfecho: 'segue no terminal' } })
    const r = await n.chamar('POST', `/api/pedidos/${p.id}/resposta`, { token: CONSOLE, corpo: { decisao: 'permitir', quem: 'ana', canal: 'painel' } })
    assert.equal(r.status, 409)
    assert.deepEqual((await n.chamar('GET', '/api/pedidos', { token: CONSOLE })).corpo, [])
  } finally {
    n.fechar()
  }
})
