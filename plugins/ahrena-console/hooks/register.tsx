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
import { DESFAZER_MS, decisoesTexto, linhaDeStatus, modelo, precisamTexto, STATUS, statusDe, tokens } from './formato'

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

// Em andamento neste módulo: o "compactando…" vale enquanto a chamada não volta.
let compactando = false

const TELAS: readonly Vista['tela'][] = ['sessao', 'precisam', 'decisoes', 'planos', 'decisao', 'subagentes', 'filhas', 'prs']

function normalizarVista(v: unknown): Vista {
  const r = (v ?? {}) as Partial<Vista>
  const decisao = r.decisao && typeof r.decisao === 'object' && typeof r.decisao.id === 'string' ? r.decisao : null
  const u = r.ultimaAcao
  return {
    tela: TELAS.includes(r.tela as Vista['tela']) && (r.tela !== 'decisao' || decisao) ? (r.tela as Vista['tela']) : 'sessao',
    escopo: r.escopo === 'familia' || r.escopo === 'maquina' ? r.escopo : null,
    escopoDecisoes: ESCOPOS_DE_DECISAO.includes(r.escopoDecisoes as EscopoDasDecisoes) ? (r.escopoDecisoes as EscopoDasDecisoes) : null,
    decisao,
    ajustando: r.ajustando === true,
    ultimaAcao: u && typeof u.id === 'string' && typeof u.em === 'number' ? u : null,
    // "compactando" não sobrevive a um reload: a chamada que o mostrava acabou com o módulo.
    compactar: r.compactar === 'compactando' && compactando ? 'compactando' : r.compactar === 'confirmar' ? 'confirmar' : null,
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
/**
 * O que o painel desenha da resposta: tudo menos a hora em que a API a montou. Duas respostas
 * iguais a menos disso não pedem redesenho.
 */
const assinatura = (p: Painel) => JSON.stringify({ ...p, geradoEm: null })

/** Sem mudança de dados, o painel ainda redesenha a cada minuto, para os "há N min". */
const REDESENHO_MINIMO_MS = 60_000

// A última leitura boa e quando o atom foi gravado. Ficam fora do atom: o atom só muda quando o
// desenho muda (ver `consultar`).
let ultima: { assinatura: string; lidoEm: number; gravadoEm: number; status: string | null } = { assinatura: '', lidoEm: 0, gravadoEm: 0, status: null }

function mostrarStatus($: Engine, texto: string) {
  if (ultima.status === texto) return
  ultima.status = texto
  $.ui.status(texto)
}

/**
 * O contexto desta sessão pelo engine, o mesmo número da barra do Claude Code: ele acompanha a
 * compactação na hora, o que o núcleo (que lê o uso das respostas) só faz na próxima resposta.
 * A chamada não custa nada; sem ela (engine antigo, terminal), vale o número do núcleo.
 */
async function contextoDoEngine($: Engine): Promise<Leitura['contextoAoVivo']> {
  try {
    const { context } = await $.session.usage()
    if (typeof context?.percent !== 'number' || !(context.window > 0)) return null
    return { usados: typeof context.tokens === 'number' ? context.tokens : null, limite: context.window, pct: Math.round(context.percent) }
  } catch {
    return null
  }
}

/**
 * Pede o painel ao núcleo e grava o atom só quando o que o painel desenha mudou (ou a cada minuto,
 * pelos tempos relativos). Cada gravação redesenha o pane, e um redesenho troca os handles dos
 * Buttons ("the host holds only a handle, for the drawing's life"): um clique que chega com o handle
 * do desenho anterior é descartado (`ui_press not handled`). Gravar a cada tick de 5 s, com `lidoEm`
 * e `geradoEm` sempre novos, fazia o primeiro clique quase sempre cair num desenho já trocado.
 */
async function consultar($: Engine) {
  const agora = await $.clock.now()
  try {
    const res = await $.http.fetch(`http://${nucleo}${await enderecoDoTick($)}`)
    const painel = res.ok && res.text ? (JSON.parse(res.text) as Painel) : null
    if (!painel || painel.versao !== 1) throw new Error(res.ok ? 'resposta inválida' : `HTTP ${res.status}`)
    const contextoAoVivo = await contextoDoEngine($)
    const nova = assinatura(painel) + JSON.stringify(contextoAoVivo)
    const atual = normalizarLeitura(await read($, leitura))
    const mudou = nova !== ultima.assinatura || atual.offline || !atual.painel || agora - ultima.gravadoEm >= REDESENHO_MINIMO_MS
    ultima = { ...ultima, assinatura: nova, lidoEm: agora }
    if (mudou) {
      ultima.gravadoEm = agora
      await update($, leitura, () => ({ painel, lidoEm: agora, offline: false, erro: null, proximaEm: null, contextoAoVivo }))
    }
    mostrarStatus($, linhaDeStatus(painel, false))
  } catch (err) {
    // Sem núcleo: guarda a última leitura boa e tenta de novo no próximo tick, sem redesenhar a cada um.
    const atual = normalizarLeitura(await read($, leitura))
    if (!atual.offline) {
      ultima.gravadoEm = agora
      await update($, leitura, (v) => ({ ...normalizarLeitura(v), lidoEm: ultima.lidoEm || null, offline: true, erro: String(err), proximaEm: null }))
    }
    mostrarStatus($, linhaDeStatus(null, true))
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
  ultima.status = null
  $.ui.status(undefined)
}

/** Confirmar ou Descartar uma sugerida: um POST em nome desta sessão, e a leitura de novo. */
type AcaoNaDecisao = 'confirmar' | 'descartar' | 'ajustar' | 'desfazer'

const FEITO: Record<AcaoNaDecisao, string> = {
  confirmar: 'confirmada: passa a valer',
  descartar: 'descartada: fica só no histórico',
  ajustar: 'ajustada: a sua versão passa a valer',
  desfazer: 'voltou ao que era',
}

/**
 * Confirmar, Descartar, Ajustar (com o texto da pessoa) ou Desfazer, pela API do núcleo. Depois de
 * uma ação, o "Desfazer" fica à vista por alguns segundos; no detalhe, a decisão aberta é a que voltou.
 */
async function decidir($: Engine, id: string, rotulo: string, acao: AcaoNaDecisao, texto: string | null = null) {
  try {
    const base = await endereco($)
    const query = base.includes('?') ? base.slice(base.indexOf('?')) : ''
    const res = await $.http.fetch(`http://${nucleo}/api/decisoes/${encodeURIComponent(id)}/${acao}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessao: await $.session.id(), ...(texto === null ? {} : { texto }) }),
    })
    const corpo = (() => {
      try {
        return JSON.parse(res.text ?? '') as { error?: string; decisao?: DecisaoDoPainel }
      } catch {
        return {}
      }
    })()
    if (!res.ok) {
      $.ui.toast(`Não deu para ${acao} ${rotulo}: ${corpo.error ?? `HTTP ${res.status}`}.`)
    } else {
      const agora = await $.clock.now()
      $.ui.toast(`${rotulo} ${FEITO[acao]}.`)
      // O "Desfazer" some sozinho: um redesenho só, quando o tempo dele acaba.
      if (acao !== 'desfazer') {
        $.clock.after(DESFAZER_MS + 100, () => {
          void update($, vista, (v) => {
            const atual = normalizarVista(v)
            return atual.ultimaAcao?.em === agora ? { ...atual, ultimaAcao: null } : atual
          })
        })
      }
      await update($, vista, (v) => {
        const atual = normalizarVista(v)
        return {
          ...atual,
          ajustando: false,
          ultimaAcao: acao === 'desfazer' ? null : { id, rotulo, acao, em: agora },
          decisao: atual.decisao?.id === id && corpo.decisao ? corpo.decisao : atual.decisao,
        }
      })
    }
  } catch {
    $.ui.toast(`Sem conexão com o núcleo em ${nucleo}; ${rotulo} ficou como estava.`)
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

/**
 * Compacta a conversa desta sessão, a mesma chamada do `/compact` (`$.session.compact()`). Só
 * entre turnos: no meio de um, o engine recusa, e o painel diz o motivo.
 */
async function compactar($: Engine) {
  if (compactando) return
  compactando = true
  await mudarVista($, { compactar: 'compactando' })
  try {
    const r = await $.session.compact()
    if (r && 'skip' in r && r.skip) $.ui.toast(`A conversa não foi compactada: ${r.skip}.`)
    else {
      const antes = r && 'tokensBefore' in r ? r.tokensBefore : undefined
      const depois = r && 'tokensAfter' in r ? r.tokensAfter : undefined
      $.ui.toast(antes && depois ? `Conversa compactada: de ${tokens(antes)} para ${tokens(depois)} tokens.` : 'Conversa compactada.')
    }
  } catch (err) {
    $.ui.toast(`Não deu para compactar agora: ${(err as Error)?.message ?? String(err)}`)
  } finally {
    compactando = false
    await mudarVista($, { compactar: null })
    await consultar($)
  }
}

/** Pede à API local que abra a conversa no Claude Desktop (no macOS, `open claude://…`). */
async function abrirSessao($: Engine, local: string, titulo: string) {
  try {
    const res = await $.http.fetch(`http://${nucleo}/abrir/${encodeURIComponent(local)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (res.ok) $.ui.toast(`Abrindo "${titulo}" no Claude Desktop…`)
    else {
      const erro = (() => {
        try {
          return (JSON.parse(res.text ?? '') as { error?: string }).error
        } catch {
          return undefined
        }
      })()
      $.ui.toast(`Não deu para abrir "${titulo}": ${erro ?? `HTTP ${res.status}`}.`)
    }
  } catch {
    $.ui.toast(`Sem conexão com o núcleo em ${nucleo}; "${titulo}" não foi aberta.`)
  }
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
      linhas: (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows,
      agora,
      nucleo,
      acoes: {
        verPrecisam: () => void mudarVista($, { tela: 'precisam' }),
        fechar: () => void mudarVista($, { tela: 'sessao' }),
        escopo: (valor) => void mudarVista($, { escopo: valor === 'familia' ? 'familia' : 'maquina' }),
        tentar: () => void consultar($),
        irPara: (i) => void irPara($, i, e.surface),
        abrirSessao: (local, titulo) => void abrirSessao($, local, titulo),
        compactar: (passo) =>
          void (passo === 'pedir' ? mudarVista($, { compactar: 'confirmar' }) : passo === 'cancelar' ? mudarVista($, { compactar: null }) : compactar($)),
        // Abrir as decisões ou trocar o escopo já pede a lista, sem esperar o próximo tick.
        verDecisoes: () => void mudarVista($, { tela: 'decisoes' }).then(() => consultar($)),
        escopoDecisoes: (valor) =>
          void mudarVista($, { escopoDecisoes: ESCOPOS_DE_DECISAO.includes(valor as EscopoDasDecisoes) ? (valor as EscopoDasDecisoes) : null }).then(() =>
            consultar($),
          ),
        confirmar: (d) => void decidir($, d.id, d.rotulo, 'confirmar'),
        descartar: (d) => void decidir($, d.id, d.rotulo, 'descartar'),
        verNaConversa: (d) => void verNaConversa($, d),
        verPlanos: () => void mudarVista($, { tela: 'planos' }),
        abrirDecisao: (d) => void mudarVista($, { tela: 'decisao', decisao: d, ajustando: false }),
        voltarDecisoes: () => void mudarVista($, { tela: 'decisoes', ajustando: false }).then(() => consultar($)),
        desfazer: (id, rotulo) => void decidir($, id, rotulo, 'desfazer'),
        ajustar: (abrir) => void mudarVista($, { ajustando: abrir }),
        enviarAjuste: (d, texto) => void (texto.trim() ? decidir($, d.id, d.rotulo, 'ajustar', texto) : undefined),
        verSubagentes: () => void mudarVista($, { tela: 'subagentes' }),
        verFilhas: () => void mudarVista($, { tela: 'filhas' }),
        verPrs: () => void mudarVista($, { tela: 'prs' }),
      },
    })
  })
}
