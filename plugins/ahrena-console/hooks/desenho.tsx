// O desenho do painel (wireframes P0 a P10, docs/wireframes): só elementos nativos do mod
// (Box, Text, Button, Link, Select, Svg), sem HTML. Recebe a leitura e devolve a árvore; quem
// pede ao núcleo e guarda o estado é o register.tsx.
//
// Grade: cards de CARD_W colunas, sempre do mesmo tamanho. A largura do painel decide quantos
// cabem por linha (1 no estreito de 38 colunas, 3 no largo de 121), nunca o tamanho do card.
// Cabeçalho, faixa e linhas de baixo ocupam a largura da grade.

import type { RenderElement } from 'claude-code'

import type {
  ContaDoPainel,
  DecisaoDoPainel,
  EscopoDasDecisoes,
  FilhaDoPainel,
  Leitura,
  Painel,
  PlanoDaSessao,
  PrecisaDeVoce,
  RetomadaDoPainel,
  SessaoDoPainel,
  SubagenteDoPainel,
  TrabalhoDoPainel,
  Vista,
} from '../types'
import {
  ESCOPOS,
  ESTADOS_DA_DECISAO,
  MOTIVOS,
  ORIGENS,
  STATUS,
  corta,
  decisoesTexto,
  desde,
  duracao,
  ha,
  hora,
  modelo,
  naoTexto,
  plural,
  precisamTexto,
  quando,
  quemDecidiu,
  statusDe,
  tokens,
  usd,
} from './formato'
import { paleta, status as STATUS_COR } from './marca'

export const CARD_W = 34
export const CARD_H = 9
export const GAP = 2
/** A versão deste plugin; o teste do núcleo confere com o plugin.json. */
export const VERSAO_DO_PLUGIN = '0.0.5'
const KPI_W = 15
/** No estreito, quantos cards de decisão cabem antes do rodapé "+N". */
const DECISOES_NO_ESTREITO = 3
const COMO_INICIAR = 'https://github.com/ahrenatechnology/ahrena-console/tree/main/plugins/ahrena-console#subir-o-núcleo'

const LARANJA = paleta.orange['500']
const ROSA = paleta.rose['500']
const AMARELO = paleta.yellow['500']
const VERDE = paleta.green['500']
const VERMELHO = paleta.red['500']
const VERMELHO_TEXTO = STATUS_COR.error.dark.text
const CINZA = paleta.gray['200']
const BORDA = paleta.gray['500']
const FUNDO_KPI = paleta.gray['900']
const FUNDO_CARTAO = paleta.gray['800']
const BADGE = {
  laranja: STATUS_COR.active.dark.badge,
  amarelo: STATUS_COR.waiting.dark.badge,
  verde: STATUS_COR.completed.dark.badge,
  vermelho: STATUS_COR.error.dark.badge,
  cinza: STATUS_COR.abandoned.dark.badge,
}
/** A cor da conta vem em hex do núcleo; qualquer outra coisa vira cinza. */
const corDaConta = (c: ContaDoPainel) => (/^#[0-9a-f]{6}$/i.test(c.cor) ? c.cor : CINZA)
/** Cor e fundo de cada status (docs/brand/tokens.json, tema escuro). */
const COR_STATUS = {
  active: { cor: STATUS_COR.active.dark.text, fundo: BADGE.laranja, borda: LARANJA },
  waiting: { cor: STATUS_COR.waiting.dark.text, fundo: BADGE.amarelo, borda: AMARELO },
  completed: { cor: STATUS_COR.completed.dark.text, fundo: BADGE.verde, borda: VERDE },
  error: { cor: VERMELHO_TEXTO, fundo: BADGE.vermelho, borda: VERMELHO },
  abandoned: { cor: STATUS_COR.abandoned.dark.text, fundo: BADGE.cinza, borda: BORDA },
} as const

/** Os elementos que o desenho usa, da tabela da superfície. */
export type Elementos = {
  Box: (p: any) => RenderElement
  Text: (p: any) => RenderElement
  Button: (p: any) => RenderElement
  Link: (p: any) => RenderElement
  Select: (p: any) => RenderElement
  Svg: (p: any) => RenderElement
}

export type Acoes = {
  verPrecisam: () => void
  fechar: () => void
  escopo: (valor: string) => void
  tentar: () => void
  irPara: (p: PrecisaDeVoce) => void
  verDecisoes: () => void
  escopoDecisoes: (valor: string) => void
  confirmar: (d: DecisaoDoPainel) => void
  descartar: (d: DecisaoDoPainel) => void
  verNaConversa: (d: DecisaoDoPainel) => void
  verPlanos: () => void
}

export type Contexto = {
  el: Elementos
  leitura: Leitura
  vista: Vista
  /** Colunas do corpo do painel. */
  cols: number
  agora: number
  /** `127.0.0.1:<porta>` do núcleo. */
  nucleo: string
  acoes: Acoes
}

// --- SVG (barras, rosca, linha do custo, logo, ícone sem conexão) ---

const svg = (w: number, h: number, corpo: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${corpo}</svg>`

export function logoSvg() {
  return svg(32, 32, `<rect width="32" height="32" rx="8" fill="${LARANJA}"/><path d="M9 23 L16 8 L23 23" stroke="${paleta.gray['900']}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 16.5 L19 16.5 L16 21.5 Z" fill="${ROSA}" stroke="${ROSA}" stroke-width="1" stroke-linejoin="round"/>`)
}

function barraSvg(pct: number, cor: string) {
  const w = Math.round(Math.max(0, Math.min(100, pct)) * 1.6)
  return svg(160, 6, `<rect width="160" height="6" rx="3" fill="${BORDA}"/>${w ? `<rect width="${w}" height="6" rx="3" fill="${cor}"/>` : ''}`)
}

function linhaSvg(serie: number[]) {
  const pts = serie.length >= 2 ? serie : [0, 0]
  const max = Math.max(...pts) || 1
  const xy = pts.map((v, i) => `${((i / (pts.length - 1)) * 100).toFixed(1)},${(9 - (v / max) * 7).toFixed(1)}`).join(' ')
  return svg(100, 10, `<polyline points="${xy}" fill="none" stroke="${LARANJA}" stroke-width="1.2" stroke-linejoin="round"/>`)
}

/** A barra do plano atual, na largura da barra dos subagentes. */
function progressoSvg(pct: number) {
  const w = (Math.max(0, Math.min(100, pct)) / 100) * 200
  return svg(200, 5, `<clipPath id="p"><rect width="200" height="5" rx="2.5"/></clipPath><g clip-path="url(#p)"><rect width="200" height="5" fill="${BORDA}"/>${w ? `<rect width="${w.toFixed(1)}" height="5" fill="${LARANJA}"/>` : ''}</g>`)
}

function subagentesSvg(itens: SubagenteDoPainel[]) {
  const total = Math.max(1, itens.length)
  const partes: [number, string][] = [
    [itens.filter((s) => s.status === 'working' || s.status === 'waiting').length, LARANJA],
    [itens.filter((s) => s.status === 'completed').length, VERDE],
    [itens.filter((s) => s.status === 'error').length, VERMELHO],
  ]
  let x = 0
  const rects = partes
    .filter(([n]) => n > 0)
    .map(([n, cor]) => {
      const w = (n / total) * 200
      const r = `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="5" fill="${cor}"/>`
      x += w
      return r
    })
    .join('')
  return svg(200, 5, `<clipPath id="b"><rect width="200" height="5" rx="2.5"/></clipPath><g clip-path="url(#b)"><rect width="200" height="5" fill="${BORDA}"/>${rects}</g>`)
}

function semConexaoSvg() {
  return svg(
    24,
    24,
    `<g fill="none" stroke="${VERMELHO_TEXTO}" stroke-width="1.8" stroke-linecap="round"><path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10.5 10.5 0 0 1 14 0"/><path d="M8.5 15.5a5.5 5.5 0 0 1 7 0"/><path d="M3 3l18 18"/></g><circle cx="12" cy="19.5" r="1.3" fill="${VERMELHO_TEXTO}"/>`,
  )
}

// --- Peças ---

/** Pílula: o glifo e o rótulo na cor, sobre o fundo do status. */
function pilula(c: Contexto, key: string, texto: string, cor: string, fundo: string, negrito = false) {
  const { Text } = c.el
  return (
    <Text key={key} mono size="caption" weight={negrito ? 'bold' : 'medium'} color={cor} backgroundColor={fundo}>
      {` ${texto} `}
    </Text>
  )
}

function pilulaDeStatus(c: Contexto, key: string, estado: SessaoDoPainel['estado'] | FilhaDoPainel['estado']) {
  const st = statusDe(estado)
  const cor = COR_STATUS[st]
  return pilula(c, key, `● ${STATUS[st].rotulo}`, cor.cor, cor.fundo)
}

function pilulaDeMotivo(c: Contexto, key: string, motivo: NonNullable<SessaoDoPainel['motivo']>) {
  const m = MOTIVOS[motivo]
  return pilula(c, key, `${m.glifo} ${m.rotulo}`, AMARELO, BADGE.amarelo, m.urgente)
}

/** Cabeçalho de card: ícone e título em versalete à esquerda, um valor à direita. */
function cabecalho(c: Contexto, icone: string, titulo: string, direita: string, corDireita?: string) {
  const { Box, Text } = c.el
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text mono size="caption" weight="semibold" dimColor wrap="truncate-end">
        {icone} {titulo}
      </Text>
      <Text mono size="caption" tabular color={corDireita} dimColor={!corDireita}>
        {direita}
      </Text>
    </Box>
  )
}

function cartao(c: Contexto, key: string, filhos: (RenderElement | false | null)[], borda: string = BORDA, fundo: string = FUNDO_CARTAO) {
  const { Box } = c.el
  return (
    <Box key={key} flexDirection="column" width={CARD_W} height={CARD_H} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={borda} backgroundColor={fundo} paddingX={1} gap="xs">
      {filhos.filter(Boolean)}
    </Box>
  )
}

/** Quantos cards cabem por linha e a largura da grade, em colunas. */
export function grade(cols: number) {
  const porLinha = Math.max(1, Math.min(3, Math.floor((cols - 2 + GAP) / (CARD_W + GAP))))
  return { porLinha, largura: porLinha * CARD_W + (porLinha - 1) * GAP }
}

// --- Cabeçalho do painel e rótulo da seção ---

function topo(c: Contexto, largura: number) {
  const { Box, Text, Svg } = c.el
  const off = c.leitura.offline
  return (
    <Box key="topo" flexDirection="row" alignItems="center" gap={1} width={largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Svg source={logoSvg()} alt="Ahrena Console" width={28} height={28} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text mono weight="semibold">Ahrena Console</Text>
        <Text mono size="caption" dimColor wrap="truncate-end">
          {off ? `${c.nucleo} · sem resposta` : c.nucleo}
        </Text>
      </Box>
      {pilula(c, 'conexao', off ? '● Offline' : '● Online', off ? VERMELHO_TEXTO : VERDE, off ? BADGE.vermelho : BADGE.verde)}
    </Box>
  )
}

function rotuloDaSecao(c: Contexto, largura: number, titulo: string, direita: RenderElement, conta?: ContaDoPainel | null) {
  const { Box, Text } = c.el
  return (
    <Box key={`secao-${titulo}`} flexDirection="row" justifyContent="space-between" alignItems="center" width={largura}>
      <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
        <Text mono size="caption" weight="semibold" dimColor>
          {titulo}
        </Text>
        {conta && (
          <Text mono size="caption" color={corDaConta(conta)} wrap="truncate-end">
            ◆ {conta.rotulo}
          </Text>
        )}
      </Box>
      {direita}
    </Box>
  )
}

function chip(c: Contexto, key: string, texto: string) {
  const { Box, Text } = c.el
  return (
    <Box key={key} borderStyle="round" borderColor={BORDA} paddingX={1} flexShrink={0}>
      <Text mono size="caption" dimColor>
        {texto}
      </Text>
    </Box>
  )
}

// --- Faixa (pergunta, permissão, erro) ---

function faixa(c: Contexto, s: SessaoDoPainel, largura: number, estreito: boolean) {
  const f = s.faixa
  if (!f) return null
  const { Box, Text } = c.el
  const erro = f.tipo === 'erro'
  const cor = erro ? COR_STATUS.error : COR_STATUS.waiting
  return (
    <Box key="faixa" flexDirection="column" width={largura} borderStyle="round" borderColor={cor.borda} backgroundColor={cor.fundo} paddingX={1} gap="xs">
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        {erro ? pilulaDeStatus(c, 'faixa-status', 'error') : pilulaDeStatus(c, 'faixa-status', 'waiting')}
        {!erro && s.motivo && pilulaDeMotivo(c, 'faixa-motivo', s.motivo)}
        {(!estreito || erro) && (
          <Text mono size="caption">
            {erro ? `${ha(f.desde, c.agora)} · turno ${s.turno}` : `${f.tipo} · ${ha(f.desde, c.agora)}`}
          </Text>
        )}
      </Box>
      <Text mono weight="semibold" wrap={estreito ? 'wrap' : 'truncate-end'}>
        {estreito ? corta(f.texto, 64) : f.texto}
      </Text>
      <Text mono size="caption" wrap="truncate-end">
        {f.rodape}
      </Text>
    </Box>
  )
}

// --- Os seis cards ---

function cardSessao(c: Contexto, s: SessaoDoPainel) {
  const { Box, Text } = c.el
  const st = statusDe(s.estado)
  const cor = COR_STATUS[st]
  const tinta = st === 'waiting' || st === 'error'
  const dur = desde(s.iniciadaEm, c.agora)
  const a = s.atividade
  const corAtividade =
    a.tipo === 'erro' ? VERMELHO_TEXTO : a.tipo === 'ferramenta' || a.tipo === 'delegando' ? LARANJA : a.tipo === 'concluida' || a.tipo === 'abandonada' ? undefined : AMARELO
  const glifo: Record<string, string> = {
    ferramenta: '↻', delegando: '⋔', pergunta: '?', permissao: '⛉', erro: '⊗', prompt: '›_', 'sua-vez': '↵', interrompida: '⏸', concluida: '', abandonada: '', ociosa: '',
  }
  return cartao(
    c,
    'card-sessao',
    [
      cabecalho(c, '∿', 'ESTA SESSÃO', dur),
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {pilulaDeStatus(c, 'status', s.estado)}
        {st === 'waiting' && s.motivo && pilulaDeMotivo(c, 'motivo', s.motivo)}
      </Box>,
      <Text mono weight="bold" wrap="truncate-end">
        {s.titulo}
      </Text>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {modelo(s.modelo)} · {dur} · turno {s.turno}
      </Text>,
      <Text mono size="footnote" wrap="truncate-end" color={corAtividade} dimColor={!corAtividade}>
        {glifo[a.tipo] ? <Text color={corAtividade ?? CINZA}>{glifo[a.tipo]} </Text> : null}
        <Text color={a.tipo === 'erro' ? VERMELHO_TEXTO : undefined}>{a.tipo === 'erro' ? corta(a.texto.split('.')[0]!, 40) : a.texto}</Text>
      </Text>,
    ],
    cor.borda,
    tinta ? cor.fundo : FUNDO_CARTAO,
  )
}

function kpi(c: Contexto, key: string, rotulo: string, valor: RenderElement | string, rodape?: RenderElement | null, corValor?: string) {
  const { Box, Text } = c.el
  return (
    <Box key={key} flexDirection="column" width={KPI_W} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_KPI} paddingX={1}>
      <Text mono size="caption" weight="semibold" dimColor>
        {rotulo}
      </Text>
      <Text mono size="footnote" weight="bold" color={corValor} wrap="truncate-end">
        {valor}
      </Text>
      {rodape}
    </Box>
  )
}

function cardContexto(c: Contexto, p: Painel | null) {
  const { Box, Svg } = c.el
  const ctx = p?.contexto ?? null
  const pct = ctx?.pct ?? 0
  const corCtx = pct >= 80 ? VERMELHO : LARANJA
  const erro = p?.sessao?.status === 'error'
  const bg = p?.background ?? { total: 0, primeiro: null }
  const tk = p?.tokens
  return cartao(c, 'card-contexto', [
    cabecalho(c, '◠', 'CONTEXTO E CUSTO', 'estimativa'),
    <Box flexDirection="row" gap={1}>
      {kpi(c, 'kpi-contexto', 'CONTEXTO', `${pct}%`, <Svg source={barraSvg(pct, corCtx)} alt={`contexto em ${pct}%`} width={96} height={5} />, pct >= 80 ? VERMELHO_TEXTO : undefined)}
      {kpi(c, 'kpi-custo', 'CUSTO', usd(p?.custo?.usd ?? 0), <Svg source={linhaSvg(p?.custo?.serie ?? [])} alt="custo acumulado da sessão" width={96} height={10} />)}
    </Box>,
    <Box flexDirection="row" gap={1}>
      {kpi(c, 'kpi-tokens', 'TOKENS', tk ? `↑${tokens(tk.entrada)} ↓${tokens(tk.saida)}` : '—')}
      {kpi(c, 'kpi-background', 'BACKGROUND', bg.total ? `${bg.total} · ${bg.primeiro ?? ''}` : '0 · nenhum', null, bg.total && erro ? VERMELHO_TEXTO : undefined)}
    </Box>,
  ])
}

function cardTrabalho(c: Contexto, t: TrabalhoDoPainel | null) {
  const { Box, Text, Link, Svg } = c.el
  const corpo: (RenderElement | false | null)[] = [cabecalho(c, '⎇', 'TRABALHO', 'pelo branch')]
  if (!t) {
    corpo.push(
      <Text mono size="footnote" dimColor>
        lendo o branch desta sessão…
      </Text>,
    )
    return cartao(c, 'card-trabalho', corpo)
  }
  if (!t.issue) {
    corpo.push(
      <Text mono size="footnote">
        <Text dimColor>⎇ </Text>
        {t.branch}
      </Text>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {t.erro ? `GitHub: ${t.erro}` : 'sem issue ligada a este branch'}
      </Text>,
      t.repo ? <Link href={`https://github.com/${t.repo}/issues`} label="ligar uma issue" /> : null,
    )
    return cartao(c, 'card-trabalho', corpo)
  }
  const i = t.issue
  const sub = i.subIssues
  corpo.push(
    <Text mono size="footnote" weight="semibold" wrap="truncate-end">
      <Text color={LARANJA}>#{i.numero}</Text> {i.titulo}
    </Text>,
  )
  corpo.push(
    <Box flexDirection="row" gap={1} alignItems="center">
      <Text mono size="footnote" dimColor>
        {sub ? `sub-issues ${sub.feitas}/${sub.total}` : 'sem sub-issues'}
      </Text>
      {sub && <Svg source={barraSvg(sub.total ? (sub.feitas / sub.total) * 100 : 0, LARANJA)} alt={`${sub.feitas} de ${sub.total} sub-issues`} width={80} height={5} />}
    </Box>,
  )
  if (!t.pr) {
    corpo.push(
      <Text mono size="footnote" dimColor>
        sem PR{t.semPush ? ' · branch sem push' : ''}
      </Text>,
    )
  } else {
    const pr = t.pr
    corpo.push(
      <Box flexDirection="row" justifyContent="space-between">
        <Text mono size="footnote">
          <Text dimColor>⇄ </Text>PR #{pr.numero} <Text dimColor>· {pr.estado}</Text>
        </Text>
        <Link href={pr.url} label="abrir" />
      </Box>,
    )
    const pilulas: RenderElement[] = []
    if (pr.ci === 'ok') pilulas.push(pilula(c, 'ci', 'CI ✓', VERDE, BADGE.verde))
    if (pr.ci === 'falhou') pilulas.push(pilula(c, 'ci', 'CI ✕ falhou', VERMELHO_TEXTO, BADGE.vermelho))
    if (pr.ci === 'rodando') pilulas.push(pilula(c, 'ci', 'CI … rodando', AMARELO, BADGE.amarelo))
    if (pr.review === 'aprovado') pilulas.push(pilula(c, 'review', 'aprovado', VERDE, BADGE.verde))
    if (pr.review === 'ajustes') pilulas.push(pilula(c, 'review', 'ajustes pedidos', VERMELHO_TEXTO, BADGE.vermelho))
    if (pr.review === 'pendente') pilulas.push(pilula(c, 'review', 'review pendente', AMARELO, BADGE.amarelo, true))
    if (pilulas.length) corpo.push(<Box flexDirection="row" gap={1}>{pilulas}</Box>)
  }
  return cartao(c, 'card-trabalho', corpo)
}

const planosAnteriores = (n: number) => `+${n} ${n === 1 ? 'plano anterior' : 'planos anteriores'}`

/** Quanto o plano durou; o atual, até agora. */
const duracaoDoPlano = (p: PlanoDaSessao, agora: number) => duracao((p.fim ? Date.parse(p.fim) : agora) - Date.parse(p.inicio))

/** Uma linha de plano: ✓ concluído, ◐ abandonado (X/Y) ou ● o atual, o resumo e a duração. */
function linhaDePlano(c: Contexto, p: PlanoDaSessao, detalhe = false) {
  const { Box, Text } = c.el
  const marca = p.resultado === 'concluido' ? { g: '✓', cor: VERDE } : p.resultado === 'abandonado' ? { g: '◐', cor: AMARELO } : { g: '●', cor: LARANJA }
  const tempo = duracaoDoPlano(p, c.agora)
  return (
    <Box key={`plano-${p.numero}`} flexDirection="row" justifyContent="space-between" gap={1}>
      <Text mono size="footnote" wrap="truncate-end">
        <Text color={marca.cor}>{marca.g} </Text>
        <Text weight={p.resultado === 'atual' ? 'semibold' : undefined}>{p.resumo}</Text>
        {detalhe && p.atual ? <Text dimColor> · {p.atual}</Text> : null}
      </Text>
      <Text mono size="footnote" dimColor tabular>
        {p.resultado === 'concluido' && !detalhe ? '' : `${p.feitos}/${p.total} · `}
        {tempo === 'agora' ? '< 10 s' : tempo}
      </Text>
    </Box>
  )
}

function botaoPlanos(c: Contexto, n: number) {
  const { Button, Text } = c.el
  return (
    <Button key="ver-planos" plain onPress={c.acoes.verPlanos}>
      <Text mono size="footnote" color={LARANJA} underline>
        {planosAnteriores(n)}
      </Text>
    </Button>
  )
}

// O plano atual em destaque (barra e passo em andamento) e os anteriores (issue #131). Cinco
// linhas abaixo do cabeçalho, como o card dos subagentes: a barra, o atual e mais três. No
// estreito, os anteriores ficam atrás de "+N planos anteriores", que abre a lista.
function cardPlano(c: Contexto, p: Painel['plano'], planos: PlanoDaSessao[], estreito: boolean) {
  const { Text, Svg } = c.el
  const anteriores = planos.filter((x) => x.resultado !== 'atual')
  if (!p && anteriores.length === 0) {
    return cartao(c, 'card-plano', [
      cabecalho(c, '☰', 'PLANO', '0/0', LARANJA),
      <Text mono size="footnote" dimColor>
        sem plano nesta sessão
      </Text>,
    ])
  }
  const corpo: (RenderElement | false | null)[] = [cabecalho(c, '☰', 'PLANO', p ? `${p.feitos}/${p.total}` : '0/0', LARANJA)]
  let linhas = 3
  if (p) {
    const pct = p.total ? (p.feitos / p.total) * 100 : 0
    const atual = planos.find((x) => x.resultado === 'atual')
    corpo.push(
      <Svg source={progressoSvg(pct)} alt={`plano ${Math.round(pct)}% feito, ${p.feitos} de ${p.total}`} width={200} height={4} />,
      <Text mono size="footnote" weight="semibold" wrap="truncate-end">
        {p.atual ? <Text color={LARANJA}>● </Text> : p.feitos === p.total ? <Text color={VERDE}>✓ </Text> : <Text dimColor>○ </Text>}
        {p.atual ?? (p.feitos === p.total ? 'plano concluído' : 'nenhum passo em andamento')}
        {atual ? <Text weight="regular" dimColor> · {duracaoDoPlano(atual, c.agora)}</Text> : null}
      </Text>,
    )
    if (p.proximo && (estreito || anteriores.length <= 2)) {
      corpo.push(
        <Text mono size="footnote" dimColor wrap="truncate-end">
          ○ {corta(p.proximo, 20)}
          {p.restantes ? ` · +${p.restantes}` : ''}
        </Text>,
      )
      linhas--
    }
  } else {
    corpo.push(
      <Text mono size="footnote" dimColor>
        nenhum plano em andamento
      </Text>,
    )
    linhas++
  }
  if (anteriores.length === 0) return cartao(c, 'card-plano', corpo)
  if (estreito) {
    corpo.push(botaoPlanos(c, anteriores.length))
    return cartao(c, 'card-plano', corpo)
  }
  const cabem = anteriores.length <= linhas ? anteriores.length : linhas - 1
  corpo.push(...anteriores.slice(0, cabem).map((x) => linhaDePlano(c, x)))
  if (cabem < anteriores.length) corpo.push(botaoPlanos(c, anteriores.length - cabem))
  return cartao(c, 'card-plano', corpo)
}

function linhaDeSubagente(c: Contexto, s: SubagenteDoPainel) {
  const { Box, Text } = c.el
  const marca =
    s.status === 'completed' ? { g: '✓', cor: VERDE } : s.status === 'error' ? { g: '✕', cor: VERMELHO_TEXTO } : { g: '●', cor: LARANJA }
  const tempo = s.ate ? duracao(Date.parse(s.ate) - Date.parse(s.desde)) : desde(s.desde, c.agora)
  return (
    <Box key={`sub-${s.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
      <Text mono size="footnote" wrap="truncate-end">
        <Text color={marca.cor}>{marca.g} </Text>
        <Text weight="semibold">{s.nome}</Text>
        {s.tarefa ? <Text dimColor> · {s.tarefa}</Text> : null}
      </Text>
      <Text mono size="footnote" dimColor tabular>
        {tempo === 'agora' ? '< 10 s' : tempo}
      </Text>
    </Box>
  )
}

function cardSubagentes(c: Contexto, s: Painel['subagentes']) {
  const { Text, Svg } = c.el
  const direita = plural(s.ativos, 'ativo', 'ativos')
  if (s.itens.length === 0) {
    return cartao(c, 'card-subagentes', [
      cabecalho(c, '⑂', 'SUBAGENTES', direita),
      <Text mono size="footnote" dimColor>
        nenhum nesta sessão
      </Text>,
    ])
  }
  // Os ativos sempre; dos encerrados, só os que couberem nas três linhas.
  const ativos = s.itens.filter((i) => i.status === 'working' || i.status === 'waiting')
  const outros = s.itens.filter((i) => !ativos.includes(i))
  const mostrar = [...ativos, ...outros].slice(0, 3)
  const fora = s.itens.length - mostrar.length
  const concluidosFora = s.itens.filter((i) => !mostrar.includes(i) && i.status === 'completed').length
  return cartao(c, 'card-subagentes', [
    cabecalho(c, '⑂', 'SUBAGENTES', direita),
    <Svg source={subagentesSvg(s.itens)} alt={`${s.ativos} ativos de ${s.itens.length}`} width={200} height={4} />,
    ...mostrar.map((i) => linhaDeSubagente(c, i)),
    fora > 0 && (
      <Text mono size="footnote" dimColor>
        +{fora} {concluidosFora === fora ? (fora === 1 ? 'concluído' : 'concluídos') : fora === 1 ? 'encerrado' : 'encerrados'}
      </Text>
    ),
  ])
}

function cardFilhas(c: Contexto, filhas: FilhaDoPainel[]) {
  const { Box, Text } = c.el
  if (filhas.length === 0) {
    return cartao(c, 'card-filhas', [
      cabecalho(c, '⑃', 'SESSÕES FILHAS', '0'),
      <Text mono size="footnote" dimColor>
        nenhuma aberta por esta
      </Text>,
    ])
  }
  return cartao(c, 'card-filhas', [
    cabecalho(c, '⑃', 'SESSÕES FILHAS', String(filhas.length)),
    ...filhas.slice(0, 4).map((f) => {
      const st = statusDe(f.estado)
      const g = st === 'waiting' ? '◐' : st === 'completed' ? '✓' : st === 'error' ? '✕' : st === 'abandoned' ? '○' : '●'
      const direita = st === 'waiting' && f.motivo ? MOTIVOS[f.motivo].rotulo : desde(f.desde, c.agora)
      return (
        <Box key={`filha-${f.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
          <Text mono size="footnote" wrap="truncate-end">
            <Text color={COR_STATUS[st].cor}>{g} </Text>
            <Text weight="semibold">{f.titulo}</Text>
          </Text>
          <Text mono size="footnote" color={st === 'waiting' ? AMARELO : undefined} dimColor={st !== 'waiting'}>
            {direita}
          </Text>
        </Box>
      )
    }),
  ])
}

// --- Linha de baixo: "N precisam de você" ---

function linhaPrecisam(c: Contexto, p: Painel, largura: number, estreito: boolean) {
  const { Box, Text, Button } = c.el
  const n = p.precisam.total
  if (n === 0) {
    return (
      <Box key="precisam" flexDirection="row" width={largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
        <Text mono dimColor>
          ○ ninguém mais precisa de você
        </Text>
      </Box>
    )
  }
  const nomes = p.precisam.maquina
    .slice(0, 2)
    .map((i) => `${i.titulo} (${i.estado === 'error' ? 'Com erro' : i.motivo ? MOTIVOS[i.motivo].rotulo : 'Esperando'})`)
    .join(', ')
  const divisao = p.precisam.porConta.map((d) => `${d.conta?.rotulo ?? 'sem conta'} ${d.n}`).join(' · ')
  return (
    <Box key="precisam" flexDirection="column" width={largura} borderStyle="round" borderColor={AMARELO} backgroundColor={BADGE.amarelo} paddingX={1} hover={{ borderColor: LARANJA }}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text mono weight="bold" color={AMARELO} wrap="truncate-end">
            🔔 {precisamTexto(n)}
            {!estreito && nomes ? <Text weight="regular" color={paleta.gray['100']}> · {nomes}</Text> : null}
          </Text>
        </Box>
        <Button key="ver-precisam" label="Ver" variant="primary" onPress={c.acoes.verPrecisam} />
      </Box>
      <Box display="none" hover={{ display: 'flex' }}>
        <Text mono size="caption" color={AMARELO} wrap="truncate-end">
          por conta: {divisao}
        </Text>
      </Box>
    </Box>
  )
}

// --- Decisões: a linha "N decisões vigentes", a faixa da retomada (P10) e a lista (P9) ---

/** O escopo das decisões na vista, ou o da largura: sessão no estreito, família no largo. */
export function escopoDasDecisoes(vista: Vista, cols: number): EscopoDasDecisoes {
  return vista.escopoDecisoes ?? (grade(cols).porLinha === 1 ? 'sessao' : 'familia')
}

// No estreito, "· N a confirmar" não cabe ao lado do "Ver": desce para a linha de baixo.
function linhaDecisoes(c: Contexto, p: Painel, largura: number, estreito: boolean) {
  const d = p.decisoes
  if (!d) return null
  const { Box, Text, Button } = c.el
  const nada = d.vigentes === 0 && d.aConfirmar === 0
  const aConfirmar = d.aConfirmar ? `${d.aConfirmar} a confirmar` : null
  return (
    <Box key="decisoes" flexDirection="column" width={largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text mono weight={nada ? 'regular' : 'bold'} dimColor={nada} wrap="truncate-end">
            <Text color={LARANJA}>⊸ </Text>
            {nada ? 'nenhuma decisão vigente' : decisoesTexto(d.vigentes)}
            {aConfirmar && !estreito ? <Text color={AMARELO}> · {aConfirmar}</Text> : null}
          </Text>
        </Box>
        <Button key="ver-decisoes" label="Ver" variant="secondary" onPress={c.acoes.verDecisoes} />
      </Box>
      {aConfirmar && estreito ? (
        <Text mono size="caption" color={AMARELO} wrap="truncate-end">
          {aConfirmar}
        </Text>
      ) : null}
    </Box>
  )
}

/** P10: depois de um /clear, quantas decisões da sessão anterior continuam valendo. Só com dado (#100). */
function faixaRetomada(c: Contexto, r: RetomadaDoPainel | null | undefined, largura: number, estreito: boolean) {
  if (!r || r.n <= 0) return null
  const { Box, Text, Button } = c.el
  const custo = r.tokens ? ` (~${tokens(r.tokens)} tokens)` : ''
  const de = r.de ? (
    <Text>
      Esta sessão continua a <Text weight="bold">{r.de}</Text> depois de um /clear.
    </Text>
  ) : (
    <Text>Esta sessão continua a anterior depois de um /clear.</Text>
  )
  return (
    <Box key="retomada" flexDirection="column" width={largura} borderStyle="round" borderColor={LARANJA} backgroundColor={BADGE.laranja} paddingX={1}>
      <Text mono weight="bold" wrap="truncate-end">
        <Text color={LARANJA}>⊸ </Text>
        {plural(r.n, 'decisão', 'decisões')} da sessão anterior{estreito ? '' : r.n === 1 ? ' continua valendo' : ' continuam valendo'}
      </Text>
      <Text mono size="footnote" wrap="wrap">
        {de}
        {estreito ? '' : ` As decisões vigentes foram injetadas no início${custo}.`}
      </Text>
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="ver-retomada" plain onPress={c.acoes.verDecisoes}>
          <Text mono size="footnote" color={LARANJA} underline>
            ver {r.n === 1 ? 'a decisão' : `as ${r.n}`}
          </Text>
        </Button>
        <Text mono size="footnote" dimColor>
          · desligar a injeção
        </Text>
      </Box>
    </Box>
  )
}

function pilulaDaDecisao(c: Contexto, d: DecisaoDoPainel) {
  const rotulo = ESTADOS_DA_DECISAO[d.estado]
  if (d.estado === 'a_confirmar') return pilula(c, 'estado', rotulo, AMARELO, BADGE.amarelo, true)
  if (d.estado === 'substituida') return pilula(c, 'estado', rotulo, STATUS_COR.abandoned.dark.text, BADGE.cinza)
  return pilula(c, 'estado', rotulo, VERDE, BADGE.verde)
}

function cardDecisao(c: Contexto, d: DecisaoDoPainel) {
  const { Box, Text, Button } = c.el
  const o = ORIGENS[d.origem]
  const sugerida = d.estado === 'a_confirmar'
  const velha = d.estado === 'substituida'
  let acao: RenderElement
  if (sugerida) {
    acao = (
      <Box flexDirection="row" gap={1}>
        <Button key={`confirmar-${d.id}`} label="Confirmar" variant="primary" onPress={() => c.acoes.confirmar(d)} />
        <Button key={`descartar-${d.id}`} label="Descartar" variant="secondary" onPress={() => c.acoes.descartar(d)} />
      </Box>
    )
  } else if (velha) {
    acao = (
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {d.substituidaPor ? `substituída por ${d.substituidaPor}` : 'substituída'}
      </Text>
    )
  } else {
    acao = (
      <Box flexDirection="row">
        <Button key={`ver-${d.id}`} plain onPress={() => c.acoes.verNaConversa(d)}>
          <Text mono size="footnote" color={LARANJA} underline>
            ver na conversa
          </Text>
        </Button>
      </Box>
    )
  }
  return cartao(
    c,
    `decisao-${d.id}`,
    [
      cabecalho(c, o.glifo, o.rotulo, quando(d.decididaEm, c.agora)),
      <Text mono weight="bold" wrap="truncate-end" strikethrough={velha} dimColor={velha}>
        {d.titulo}
      </Text>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {naoTexto(d)}
      </Text>,
      <Box flexDirection="row" gap={1} alignItems="center">
        {pilulaDaDecisao(c, d)}
        <Text mono size="footnote" dimColor={velha} wrap="truncate-end">
          {quemDecidiu(d)}
        </Text>
      </Box>,
      acao,
    ],
    sugerida ? AMARELO : BORDA,
    sugerida ? BADGE.amarelo : FUNDO_CARTAO,
  )
}

function telaDecisoes(c: Contexto, p: Painel, g: ReturnType<typeof grade>, estreito: boolean) {
  const { Box, Text, Button, Select } = c.el
  const escopo = escopoDasDecisoes(c.vista, c.cols)
  const lista = p.decisoes?.lista?.escopo === escopo ? p.decisoes.lista : null
  const select = (
    <Select
      key="escopo-decisoes"
      value={escopo}
      options={ESCOPOS.map((e) => ({ value: e.valor, label: e.rotulo.toUpperCase() }))}
      onSelect={(v: string) => c.acoes.escopoDecisoes(v)}
    />
  )
  const vigentes = lista?.vigentes ?? (escopo === 'familia' ? (p.decisoes?.vigentes ?? 0) : null)
  const titulo = `DECISÕES${vigentes === null ? '' : ` · ${vigentes} ${vigentes === 1 ? 'VIGENTE' : 'VIGENTES'}`}`
  const itens = lista?.itens ?? []
  const mostrar = estreito ? itens.slice(0, DECISOES_NO_ESTREITO) : itens
  const fora = itens.length - mostrar.length
  let conteudo: RenderElement[]
  if (!p.decisoes) conteudo = [<Text key="sem" mono dimColor>o núcleo não trouxe as decisões</Text>]
  else if (!lista) conteudo = [<Text key="lendo" mono dimColor>lendo as decisões…</Text>]
  else if (!itens.length) conteudo = [<Text key="vazio" mono dimColor>nenhuma decisão {escopo === 'sessao' ? 'nesta sessão' : escopo === 'familia' ? 'na família' : 'neste branch'}</Text>]
  else conteudo = mostrar.map((d) => cardDecisao(c, d))
  const fechar = (
    <Button key="fechar-decisoes" plain onPress={c.acoes.fechar}>
      <Text color={LARANJA} underline>
        fechar
      </Text>
    </Button>
  )
  const rodape = estreito ? (
    <Text mono wrap="truncate-end">{fora > 0 ? `+${fora} · troque o escopo` : 'mais recentes primeiro'}</Text>
  ) : (
    <Text mono wrap="truncate-end">
      escopo:{' '}
      {ESCOPOS.map((e, i) => (
        <Text key={`escopo-${e.valor}`} color={e.valor === escopo ? LARANJA : undefined} weight={e.valor === escopo ? 'bold' : 'regular'}>
          {i ? ' · ' : ''}
          {e.rotulo}
        </Text>
      ))}
      {' · mais recentes primeiro'}
    </Text>
  )
  return [
    rotuloDaSecao(c, g.largura, titulo, select),
    <Box key="lista-decisoes" flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={1} width={g.largura}>
      {conteudo}
    </Box>,
    <Box key="rodape-decisoes" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Box flexDirection="row" flexShrink={1} minWidth={0}>
        {rodape}
      </Box>
      {fechar}
    </Box>,
  ]
}

// --- P7: a lista de quem precisa de você ---

function cardPrecisa(c: Contexto, i: PrecisaDeVoce) {
  const { Box, Text, Button } = c.el
  const erro = i.estado === 'error'
  const cor = erro ? COR_STATUS.error : COR_STATUS.waiting
  const relacao = i.relacao === 'mae' ? 'mãe desta' : i.relacao === 'filha' ? 'filha desta' : i.relacao === 'irma' ? 'irmã desta' : i.mesmoProjeto ? 'mesmo projeto' : 'outro projeto'
  return cartao(
    c,
    `precisa-${i.id}`,
    [
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text mono weight="bold" wrap="truncate-end">
          <Text color={cor.borda}>● </Text>
          {i.titulo}
        </Text>
        <Text mono size="caption" dimColor>
          {desde(i.desde, c.agora)}
        </Text>
      </Box>,
      <Box flexDirection="row" gap={1} alignItems="center">
        {erro ? pilulaDeStatus(c, 'st', 'error') : i.motivo ? pilulaDeMotivo(c, 'mt', i.motivo) : null}
        {i.urgente && (
          <Text mono size="caption" dimColor>
            urgente
          </Text>
        )}
      </Box>,
      <Text mono size="footnote" wrap="truncate-end" color={erro ? VERMELHO_TEXTO : undefined}>
        {i.texto}
      </Text>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {relacao} · {modelo(i.modelo)}
        {i.conta ? <Text color={corDaConta(i.conta)}> · ◆ {i.conta.rotulo}</Text> : null}
      </Text>,
      <Box flexDirection="row">
        <Button key={`ir-${i.id}`} label="Ir para a sessão" variant="secondary" onPress={() => c.acoes.irPara(i)} />
      </Box>,
    ],
    cor.borda,
    cor.fundo,
  )
}

function telaPrecisam(c: Contexto, p: Painel, g: ReturnType<typeof grade>, estreito: boolean) {
  const { Box, Text, Button, Select } = c.el
  const escopo = c.vista.escopo ?? (estreito && p.precisam.familia.length ? 'familia' : 'maquina')
  const itens = escopo === 'familia' ? p.precisam.familia : p.precisam.maquina
  const select = (
    <Select
      key="escopo"
      value={escopo}
      options={[
        { value: 'familia', label: 'FAMÍLIA' },
        { value: 'maquina', label: 'MÁQUINA INTEIRA' },
      ]}
      onSelect={(v: string) => c.acoes.escopo(v)}
    />
  )
  return [
    rotuloDaSecao(c, g.largura, `PRECISAM DE VOCÊ · ${itens.length}`, select),
    <Box key="lista" flexDirection="row" flexWrap="wrap" gap={GAP} width={g.largura}>
      {itens.length ? itens.map((i) => cardPrecisa(c, i)) : [<Text key="vazio" mono dimColor>ninguém {escopo === 'familia' ? 'da família' : ''} precisa de você agora</Text>]}
    </Box>,
    <Box key="rodape-precisam" flexDirection="row" justifyContent="space-between" alignItems="center" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Text mono wrap="truncate-end">urgentes primeiro{estreito ? '' : ' · esperando e com erro'}</Text>
      <Button key="fechar-precisam" plain onPress={c.acoes.fechar}>
        <Text color={LARANJA} underline>
          fechar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- Os planos da sessão (issue #131) ---

function telaPlanos(c: Contexto, p: Painel, g: ReturnType<typeof grade>, estreito: boolean) {
  const { Box, Text, Button } = c.el
  const planos = p.planos ?? []
  const conta = (r: PlanoDaSessao['resultado']) => planos.filter((x) => x.resultado === r).length
  return [
    rotuloDaSecao(c, g.largura, `PLANOS DA SESSÃO · ${planos.length}`, chip(c, 'chip-planos', `${conta('concluido')} ✓ · ${conta('abandonado')} ◐`)),
    <Box key="lista-planos" flexDirection="column" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1} gap="xs">
      {planos.length ? planos.map((x) => linhaDePlano(c, x, !estreito)) : [<Text key="vazio" mono dimColor>sem plano nesta sessão</Text>]}
    </Box>,
    <Box key="rodape-planos" flexDirection="row" justifyContent="space-between" alignItems="center" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Text mono wrap="truncate-end">mais recente primeiro{estreito ? '' : ' · ✓ concluído · ◐ abandonado'}</Text>
      <Button key="fechar-planos" plain onPress={c.acoes.fechar}>
        <Text color={LARANJA} underline>
          fechar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- P8: sem conexão ---

function telaOffline(c: Contexto, g: ReturnType<typeof grade>, estreito: boolean) {
  const { Box, Text, Button, Link, Svg } = c.el
  const lidoEm = c.leitura.lidoEm
  return [
    <Box key="offline" flexDirection="column" alignItems="center" width={g.largura} borderStyle="round" borderColor={VERMELHO} backgroundColor={BADGE.vermelho} paddingX={2} paddingY={1} gap="xs">
      <Svg source={semConexaoSvg()} alt="sem conexão" width={24} height={24} />
      <Text mono weight="bold">Sem conexão com o núcleo</Text>
      <Text mono size="footnote" wrap="wrap">
        {c.nucleo} não respondeu. {lidoEm ? `Mostrando a última leitura, de ${hora(lidoEm)}.` : 'Ainda não houve leitura.'}
      </Text>
      {!estreito && (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key="tentar" label="Tentar de novo" variant="primary" onPress={c.acoes.tentar} />
          <Link href={COMO_INICIAR} label="como iniciar o núcleo" />
        </Box>
      )}
    </Box>,
    <Box key="sem-dados" flexDirection="row" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Text mono dimColor>
        ○ sem dados de outras sessões
      </Text>
    </Box>,
  ]
}

/** O painel inteiro, no desktop. */
export function desenhar(c: Contexto): RenderElement {
  const { Box } = c.el
  const g = grade(c.cols)
  const estreito = g.porLinha === 1
  const p = c.leitura.painel
  const offline = c.leitura.offline
  const s = p?.sessao ?? null
  const proxima = c.leitura.proximaEm ? Math.max(1, Math.ceil((c.leitura.proximaEm - c.agora) / 1000)) : 5

  let corpo: (RenderElement | null)[]
  if (offline || !p) {
    corpo = [
      rotuloDaSecao(c, g.largura, 'ESTA SESSÃO', chip(c, 'chip', offline ? `nova tentativa em ${proxima} s` : 'lendo…')),
      ...(offline ? telaOffline(c, g, estreito) : []),
    ]
  } else if (c.vista.tela === 'precisam') {
    corpo = telaPrecisam(c, p, g, estreito)
  } else if (c.vista.tela === 'decisoes') {
    corpo = telaDecisoes(c, p, g, estreito)
  } else if (c.vista.tela === 'planos') {
    corpo = telaPlanos(c, p, g, estreito)
  } else {
    const cards = [
      s ? cardSessao(c, s) : null,
      cardContexto(c, p),
      cardTrabalho(c, p.trabalho),
      cardPlano(c, p.plano, p.planos ?? [], estreito),
      cardSubagentes(c, p.subagentes),
      cardFilhas(c, p.filhas),
    ].filter((x): x is RenderElement => x !== null)
    corpo = [
      rotuloDaSecao(c, g.largura, 'ESTA SESSÃO', chip(c, 'chip', 'auto · 5 s'), s?.conta),
      faixaRetomada(c, p.decisoes?.retomada, g.largura, estreito),
      s ? faixa(c, s, g.largura, estreito) : null,
      <Box key="cards" flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={1} width={g.largura}>
        {cards}
      </Box>,
      linhaDecisoes(c, p, g.largura, estreito),
      linhaPrecisam(c, p, g.largura, estreito),
    ]
  }

  return (
    <Box flexDirection="column" alignItems="center" gap={1} paddingY={1} minWidth={0}>
      {topo(c, g.largura)}
      {corpo.filter((x): x is RenderElement => x !== null)}
      {rodape(c, g.largura)}
    </Box>
  )
}

/** "plugin 0.0.5 · api 0.0.1 · 4a3e196": para saber que o painel e a API são os da mesma versão. */
function rodape(c: Contexto, largura: number) {
  const { Box, Text } = c.el
  const api = c.leitura.painel?.api
  return (
    <Box key="rodape-versao" flexDirection="row" justifyContent="center" width={largura}>
      <Text mono size="caption" dimColor wrap="truncate-end">
        plugin {VERSAO_DO_PLUGIN} · api {api ? `${api.versao}${api.commit ? ` · ${api.commit}` : ''}` : '—'}
      </Text>
    </Box>
  )
}
