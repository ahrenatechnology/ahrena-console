// Painel lateral do Ahrena Console: esta sessão, o que roda dentro dela, o trabalho pelo
// branch e quem precisa de você em todas as contas (issues #35, #36, #37 e #116; decisões
// 0004 e 0006). Desenho em desenho.tsx, sobre os wireframes de docs/wireframes.
//
// Consumo (issue #81, decisão 0004): o painel só consulta o núcleo enquanto está aberto e à
// vista. Abre com /console (ou desenhado de novo depois de um reload) e para quando fecha,
// sai de cena ou a sessão termina; sessão sem painel aberto não faz nenhum pedido. A cada
// 5 s pede só GET /api/painel/<esta sessão>: um pedido, só a própria sessão. Com as decisões
// abertas (P9), o mesmo pedido leva `decisoes=<escopo>` e traz a lista; Confirmar e Descartar são
// um POST cada, só quando a pessoa aperta.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { DecisaoDoPainel, EscopoDasDecisoes, Leitura, Painel, PrecisaDeVoce, Vista } from '../types'
import { desenhar, escopoDasDecisoes, type Elementos } from './desenho'
import { decisoesTexto, linhaDeStatus, modelo, precisamTexto, STATUS, statusDe } from './formato'

// Id próprio: `ahrena-console` foi o do painel de teste (spikes/painel-teste), e o engine guarda
// por id o painel que a pessoa já abriu.
export const PANE = 'ahrena-console-sessao'
const A_CADA_MS = 5000
// `127.0.0.1:<porta>`; a porta vem da opção `porta` do plugin (padrão 4720).
let nucleo = '127.0.0.1:4720'

const LEITURA_VAZIA: Leitura = { painel: null, lidoEm: null, offline: false, erro: null, proximaEm: null }
const VISTA_VAZIA: Vista = { tela: 'sessao', escopo: null, escopoDecisoes: null }
const ESCOPOS_DE_DECISAO: readonly EscopoDasDecisoes[] = ['sessao', 'familia', 'branch']

const leitura = atom({ plugin: 'ahrena-console', key: 'leitura' } as const, LEITURA_VAZIA)
const vista = atom({ plugin: 'ahrena-console', key: 'vista' } as const, VISTA_VAZIA)

// O relógio do polling: existe só enquanto o painel está aberto (iniciar/parar).
let relogio: { cancel: () => void } | undefined
// O que o painel manda junto com o id, lido uma vez por carga do módulo.
let consulta: string | undefined
// A largura do último desenho: decide o escopo padrão das decisões no pedido.
let colunas = 38

// Estado salvo por outra versão do painel pode vir com outro formato: vale só o que reconhecemos.
function normalizarLeitura(v: unknown): Leitura {
  const r = (v ?? {}) as Partial<Leitura>
  const painel = r.painel && (r.painel as Painel).versao === 1 && (r.painel as Painel).precisam ? (r.painel as Painel) : null
  return { ...LEITURA_VAZIA, ...r, painel }
}

function normalizarVista(v: unknown): Vista {
  const r = (v ?? {}) as Partial<Vista>
  return {
    tela: r.tela === 'precisam' || r.tela === 'decisoes' ? r.tela : 'sessao',
    escopo: r.escopo === 'familia' || r.escopo === 'maquina' ? r.escopo : null,
    escopoDecisoes: ESCOPOS_DE_DECISAO.includes(r.escopoDecisoes as EscopoDasDecisoes) ? (r.escopoDecisoes as EscopoDasDecisoes) : null,
  }
}

async function lerLeitura($: Engine) {
  return normalizarLeitura(await read($, leitura))
}

async function mudarVista($: Engine, patch: Partial<Vista>) {
  await update($, vista, (v) => ({ ...normalizarVista(v), ...patch }))
}

/** O endereço do pedido: o id da sessão e o que o painel sabe dela pelo ambiente (decisão 0006, ordem 1). */
async function endereco($: Engine): Promise<string> {
  if (consulta === undefined) {
    const params: string[] = []
    const add = (k: string, v: string | undefined | null) => {
      if (v) params.push(`${k}=${encodeURIComponent(v)}`)
    }
    add('local', await $.env.get('CLAUDE_CODE_HOST_SESSION_ID'))
    add('conta', await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'))
    add('org', await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID'))
    add('modelo', await $.session.model().catch(() => null))
    add('cwd', await $.session.cwd().catch(() => null))
    consulta = `/api/painel/${encodeURIComponent(await $.session.id())}${params.length ? `?${params.join('&')}` : ''}`
  }
  return consulta
}

/** O pedido do tick: com as decisões abertas, leva o escopo para a lista vir junto. */
async function enderecoDoTick($: Engine): Promise<string> {
  const base = await endereco($)
  const v = normalizarVista(await read($, vista))
  if (v.tela !== 'decisoes') return base
  return `${base}${base.includes('?') ? '&' : '?'}decisoes=${escopoDasDecisoes(v, colunas)}`
}

// O pedido de todo tick: esta sessão, a conta e quantas precisam de você, nunca a frota.
async function consultar($: Engine) {
  const agora = await $.clock.now()
  try {
    const res = await $.http.fetch(`http://${nucleo}${await enderecoDoTick($)}`)
    const painel = res.ok && res.text ? (JSON.parse(res.text) as Painel) : null
    if (!painel || painel.versao !== 1) throw new Error(res.ok ? 'resposta inválida' : `HTTP ${res.status}`)
    await update($, leitura, () => ({ painel, lidoEm: agora, offline: false, erro: null, proximaEm: agora + A_CADA_MS }))
    $.ui.status(linhaDeStatus(painel, false))
  } catch (err) {
    // Sem núcleo: guarda a última leitura boa e tenta de novo no próximo tick.
    await update($, leitura, (v) => ({ ...normalizarLeitura(v), offline: true, erro: String(err), proximaEm: agora + A_CADA_MS }))
    $.ui.status(linhaDeStatus(null, true))
  }
}

async function nossoPainel($: Engine) {
  return (await $.ui.panes()).find((p) => p.id === PANE)
}

// Cada tick confere o painel antes de pedir: fechado ou não desenhado, o polling para;
// aberto atrás de outra aba, o tick passa sem pedir nada.
async function tick($: Engine) {
  try {
    const p = await nossoPainel($)
    if (!p?.isPlaced) return parar($)
    if (!p.isShown) return
    await consultar($)
  } catch {
    // o próximo tick tenta de novo
  }
}

function iniciar($: Engine) {
  if (relogio) return
  relogio = $.clock.every(A_CADA_MS, () => void tick($))
  void tick($)
}

function parar($: Engine) {
  if (!relogio) return
  relogio.cancel()
  relogio = undefined
  $.ui.status(undefined)
}

/** Confirmar ou Descartar uma sugerida: um POST em nome desta sessão, e a leitura de novo. */
async function decidir($: Engine, d: DecisaoDoPainel, acao: 'confirmar' | 'descartar') {
  try {
    const base = await endereco($)
    const query = base.includes('?') ? base.slice(base.indexOf('?')) : ''
    const res = await $.http.fetch(`http://${nucleo}/api/decisoes/${encodeURIComponent(d.id)}/${acao}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessao: await $.session.id() }),
    })
    if (!res.ok) {
      const erro = (() => {
        try {
          return (JSON.parse(res.text ?? '') as { error?: string }).error
        } catch {
          return undefined
        }
      })()
      $.ui.toast(`Não deu para ${acao} ${d.rotulo}: ${erro ?? `HTTP ${res.status}`}.`)
    } else {
      $.ui.toast(`${d.rotulo} ${acao === 'confirmar' ? 'confirmada: passa a valer' : 'descartada: fica só no histórico'}.`)
    }
  } catch {
    $.ui.toast(`Sem conexão com o núcleo em ${nucleo}; ${d.rotulo} continua a confirmar.`)
  }
  await consultar($)
}

/**
 * "ver na conversa": rola a conversa até a chamada que originou a decisão (o `tool_use_id`),
 * quando ela é desta sessão; o engine só rola a conversa em resposta a um clique da pessoa.
 * Quando não dá (de outra sessão, ou a linha não está mais na conversa), diz onde ela está.
 */
async function verNaConversa($: Engine, d: DecisaoDoPainel) {
  const longe =
    d.sessao === 'mae' ? 'na sessão mãe' : d.sessao === 'familia' ? 'em outra sessão da família' : d.sessao === 'branch' ? 'em outra sessão do branch' : null
  if (longe || !d.toolUseId) {
    $.ui.toast(`${d.rotulo} foi decidida ${longe ?? 'numa mensagem que esta conversa não mostra'}.`)
    return
  }
  const r = await $.ui.scroll({ to: { requestId: d.toolUseId }, block: 'center' }).catch((err: unknown) => ({ deny: String(err) }))
  if ('deny' in r && r.deny) $.ui.toast(`A mensagem de ${d.rotulo} não está à vista nesta conversa.`)
}

async function irPara($: Engine, i: PrecisaDeVoce, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  // O mod não troca de sessão no Desktop: copia o nome e diz onde ela está.
  await $.ui.copy({ text: i.titulo, surface }).catch(() => undefined)
  $.ui.toast(`"${i.titulo}" está na barra lateral; o nome foi copiado para a busca.`)
}

export const register: Register = (on, options) => {
  const porta = Number((options as { porta?: unknown } | undefined)?.porta)
  nucleo = `127.0.0.1:${Number.isInteger(porta) && porta > 0 && porta < 65536 ? porta : 4720}`

  // A sessão começa sem consultar nada: só registra o /console. Se o painel já estava aberto
  // (o módulo recarregou com ele à vista), retoma o polling.
  on('session.start', async ($, e, next) => {
    consulta = undefined
    await $.command.register({ name: 'console', description: 'Abre o painel do Ahrena Console: esta sessão e quem precisa de você' })
    if ((await nossoPainel($).catch(() => undefined))?.isPlaced) iniciar($)
    return next(e)
  })

  on('command.run', { command: 'console' }, async ($) => {
    const aberto = await $.ui.open({ id: PANE, title: 'Ahrena Console', focus: true })
    if (aberto.isPlaced) {
      iniciar($)
      return { text: 'Painel do Ahrena Console aberto.' }
    }
    // Aberto, mas sem lugar agora (largura, superfície): o engine desenha quando houver, e o
    // render começa o polling. O motivo vem do engine.
    return { text: `O painel do Ahrena Console fica aberto e aparece quando houver lugar (${aberto.reason}).` }
  })

  // Fechou (a pessoa, o plugin ou um unload): o polling para na hora.
  on('ui.close', async ($, e, next) => {
    try {
      if (e.id === PANE) parar($)
    } catch {
      // parar nunca deve impedir o painel de fechar
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    parar($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Desenhado é aberto: se o polling não começou (reload, ou o painel aberto por outro
    // caminho que não o /console), começa agora; o tick confere se ele está à vista.
    iniciar($)
    const l = await lerLeitura($)
    const agora = await $.clock.now()
    if (e.surface !== 'desktop') {
      // Terminal e outras superfícies: o resumo em texto, sem a grade.
      const { Box, Text } = $.ui.resolve(e)
      const s = l.painel?.sessao
      return (
        <Box flexDirection="column">
          <Text bold color="#f47720">Ahrena Console</Text>
          {l.offline || !l.painel ? (
            <Text>{l.offline ? `Sem conexão com o núcleo em ${nucleo}.` : 'Lendo o núcleo…'}</Text>
          ) : (
            <Box flexDirection="column">
              <Text>
                {s ? `${STATUS[statusDe(s.estado)].glifo} ${s.titulo} · ${modelo(s.modelo)} · turno ${s.turno}` : 'Sessão nova'}
              </Text>
              <Text dimColor>{s ? s.atividade.texto : ''}</Text>
              {l.painel.decisoes?.vigentes ? <Text>⊸ {decisoesTexto(l.painel.decisoes.vigentes)}</Text> : null}
              <Text>{l.painel.precisam.total ? `⚠ ${precisamTexto(l.painel.precisam.total)}` : 'ninguém mais precisa de você'}</Text>
            </Box>
          )}
        </Box>
      )
    }
    const el = $.ui.resolve(e) as unknown as Elementos
    const v = normalizarVista(await read($, vista))
    colunas = e.props.bodyColumns ?? 38
    return desenhar({
      el,
      leitura: l,
      vista: v,
      cols: colunas,
      agora,
      nucleo,
      acoes: {
        verPrecisam: () => void mudarVista($, { tela: 'precisam' }),
        fechar: () => void mudarVista($, { tela: 'sessao' }),
        escopo: (valor) => void mudarVista($, { escopo: valor === 'familia' ? 'familia' : 'maquina' }),
        tentar: () => void consultar($),
        irPara: (i) => void irPara($, i, e.surface),
        // Abrir as decisões ou trocar o escopo já pede a lista, sem esperar o próximo tick.
        verDecisoes: () => void mudarVista($, { tela: 'decisoes' }).then(() => consultar($)),
        escopoDecisoes: (valor) =>
          void mudarVista($, { escopoDecisoes: ESCOPOS_DE_DECISAO.includes(valor as EscopoDasDecisoes) ? (valor as EscopoDasDecisoes) : null }).then(() =>
            consultar($),
          ),
        confirmar: (d) => void decidir($, d, 'confirmar'),
        descartar: (d) => void decidir($, d, 'descartar'),
        verNaConversa: (d) => void verNaConversa($, d),
      },
    })
  })
}
