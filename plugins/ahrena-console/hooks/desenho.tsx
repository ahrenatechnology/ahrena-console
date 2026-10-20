// O desenho do painel (wireframes P0 a P13, docs/wireframes): só elementos nativos do mod
// (Box, Text, Button, Link, Select, Svg), sem HTML. Recebe a leitura e devolve a árvore; quem
// pede ao núcleo e guarda o estado é o register.tsx.
//
// Grade (P1, `.pc`): todo card tem CARD_W colunas e CARD_H linhas, fixas e iguais. A largura do
// painel decide quantos cabem por linha (1 no estreito de 38 colunas, 3 no largo de 121). Dentro do
// card, cada linha é uma só, com reticências, como no P1; o inteiro fica no detalhe. Os seis cards
// aparecem sempre; a altura que sobra fica vazia embaixo, e a que falta o corpo do pane rola.
// Cabeçalho, faixa e linhas de baixo ocupam a largura da grade.

import type { RenderElement } from 'claude-code'

import type {
  ContaDoPainel,
  DecisaoDoPainel,
  EscopoDasDecisoes,
  FilhaDoPainel,
  Leitura,
  Painel,
  PerguntaDaSessao,
  PassoDoPainel,
  PlanoDaSessao,
  PrAguardando,
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
  DESFAZER,
  DESFAZER_MS,
  dataEHora,
  plural,
  precisamTexto,
  quando,
  quemDecidiu,
  rotuloDaConta,
  semMarkdown,
  statusDe,
  tokens,
  usd,
} from './formato'
import { alturaDaGrade, BORDA_DO_CARD, ESPACO, LINHAS_DO_CARD, linhasDoTexto } from './altura'
import { ESTADO_DO_GRAFO, contagemCurta, montarGrafo, paginar, type EstadoDoGrafo, type LinhaDoGrafo } from './grafo'
import { paleta, status as STATUS_COR } from './marca'

export const CARD_W = 34
/** Todo card tem a mesma altura, ~190 px no Desktop (ver LINHAS_DO_CARD): a borda e as linhas de conteúdo. */
export const CARD_H = BORDA_DO_CARD + LINHAS_DO_CARD
export const GAP = 2
/** A versão deste plugin; o teste do núcleo confere com o plugin.json. */
export const VERSAO_DO_PLUGIN = '0.0.30'
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
  Input: (p: any) => RenderElement
}

export type Acoes = {
  verPrecisam: () => void
  fechar: () => void
  escopo: (valor: string) => void
  tentar: () => void
  irPara: (p: PrecisaDeVoce) => void
  /** O "Compactar" do card Contexto: abre a confirmação, confirma ou cancela. */
  compactar: (passo: 'pedir' | 'confirmar' | 'cancelar') => void
  /** Abre a conversa no Claude Desktop pela API local (`open`, no macOS). */
  abrirSessao: (local: string, titulo: string) => void
  verDecisoes: () => void
  escopoDecisoes: (valor: string) => void
  confirmar: (d: DecisaoDoPainel) => void
  descartar: (d: DecisaoDoPainel) => void
  verNaConversa: (d: DecisaoDoPainel) => void
  verPlanos: () => void
  /** #131: o detalhe da decisão, o Desfazer, o Ajustar e as listas completas. */
  abrirDecisao: (d: DecisaoDoPainel) => void
  voltarDecisoes: () => void
  desfazer: (id: string, rotulo: string) => void
  ajustar: (abrir: boolean) => void
  enviarAjuste: (d: DecisaoDoPainel, texto: string) => void
  verSubagentes: () => void
  /** #146: mexe no grafo da sessão: a página, as ondas abertas e fechadas, o filtro. */
  grafo: (patch: Partial<EstadoDoGrafo>) => void
  verFilhas: () => void
  /** #140: a lista dos PRs aguardando a sua aprovação. */
  verPrs: () => void
  /** #140: manda ao chat a resposta de um botão da caixa de próximo passo. */
  responder: (mensagem: string) => void
  /** #145: pede à sessão do painel para desarquivar a filha (`unarchive_session`, a pessoa aprova). */
  desarquivar: (f: FilhaDoPainel) => void
}

export type Contexto = {
  el: Elementos
  leitura: Leitura
  vista: Vista
  /** Colunas do corpo do painel. */
  cols: number
  /** Linhas do corpo do painel (`scroll.bodyRows`); sem elas, sem limite de altura. */
  linhas?: number
  /** #140: a pergunta com que esta sessão terminou o turno, em destaque no topo. */
  pergunta?: PerguntaDaSessao | null
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

/** O anel do plano (P1): o feito em laranja sobre o trilho, e o % no meio. */
function anelSvg(pct: number) {
  const r = 20
  const volta = 2 * Math.PI * r
  const arco = (Math.max(0, Math.min(100, pct)) / 100) * volta
  return svg(
    50,
    50,
    `<circle cx="25" cy="25" r="${r}" fill="none" stroke="${BORDA}" stroke-width="6"/>` +
      (arco ? `<circle cx="25" cy="25" r="${r}" fill="none" stroke="${LARANJA}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${arco.toFixed(1)} ${volta.toFixed(1)}" transform="rotate(-90 25 25)"/>` : '') +
      `<text x="25" y="28.5" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="10" fill="${paleta.gray['100']}">${pct}%</text>`,
  )
}

/** A barra dos Subagentes, em px: a largura útil do card (30 colunas × ~7,9 px) e uma linha fina. */
const BARRA_W = 236
const BARRA_H = 5

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
  // Esticada sem manter a proporção, no tamanho que o Svg dá (BARRA_W × BARRA_H).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 5" preserveAspectRatio="none"><clipPath id="b"><rect width="200" height="5" rx="2.5"/></clipPath><g clip-path="url(#b)"><rect width="200" height="5" fill="${BORDA}"/>${rects}</g></svg>`
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

/**
 * Cabeçalho de card (`.pc .t` do P1): ícone e título em versalete à esquerda; à direita um valor
 * pequeno, em cor neutra e sem caixa alta (`.pc .t .r`). Não é clicável: no Desktop, todo Button é
 * o botão nativo, no tamanho do corpo, e quebraria o cabeçalho.
 */
function cabecalho(c: Contexto, icone: string, titulo: string, direita: string, opcoes: { cor?: string } = {}) {
  const { Box, Text } = c.el
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
      {/* O título nunca corta: quem cede é o valor da direita. */}
      <Box flexShrink={0}>
        <Text mono size="caption" weight="semibold" dimColor>
          {icone} {titulo}
        </Text>
      </Box>
      <Text mono size="caption" tabular color={opcoes.cor} dimColor={!opcoes.cor} wrap="truncate-end">
        {direita}
      </Text>
    </Box>
  )
}

/**
 * O respiro de todo card, num lugar só: dos lados, uma coluna (o que já estava bom); embaixo, dois
 * espaços (~20 px no Desktop), para o pé nunca encostar na borda de baixo. Em cima, o respiro que o
 * Desktop já dá ao Box com borda.
 */
export const RESPIRO_DO_CARD = { paddingX: 1, paddingBottom: 2 } as const

/**
 * Todo card do P1: a mesma largura, a mesma altura fixa, a mesma borda, o mesmo raio e o mesmo
 * respiro. Com `pe`, um espaçador empurra o pé para o fundo do card, logo acima do respiro de baixo,
 * na mesma altura em todos os cards.
 */
function cartao(c: Contexto, key: string, filhos: (RenderElement | false | null)[], borda: string = BORDA, fundo: string = FUNDO_CARTAO, pe: RenderElement | null = null) {
  const { Box } = c.el
  return (
    <Box key={key} flexDirection="column" width={CARD_W} height={CARD_H} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={borda} backgroundColor={fundo} {...RESPIRO_DO_CARD} gap="xs">
      {filhos.filter(Boolean)}
      {pe ? <Box key="espaco-do-pe" flexGrow={1} /> : null}
      {pe}
    </Box>
  )
}

/**
 * O pé do card: uma linha só, ancorada no fundo (ver `cartao`), à esquerda (os "ver mais": "93
 * planos anteriores ›") ou à direita (o "Compactar agora" do Contexto).
 */
function peDoCard(c: Contexto, conteudo: RenderElement, alinhamento: 'esquerda' | 'direita' = 'esquerda') {
  const { Box } = c.el
  return (
    <Box key="pe-do-card" flexDirection="row" flexShrink={0} justifyContent={alinhamento === 'direita' ? 'flex-end' : 'flex-start'}>
      {conteudo}
    </Box>
  )
}

/** "1 plano anterior", "93 planos anteriores": o número primeiro, por extenso, com a concordância. */
const contagem = (n: number, umSingular: string, varios: string) => `${n} ${n === 1 ? umSingular : varios}`

/** O link do P1 (`pn-link`): laranja e sublinhado. */
function link(c: Contexto, key: string, href: string, texto: string) {
  const { Link, Text } = c.el
  return (
    <Link key={key} href={href}>
      <Text mono size="footnote" color={LARANJA} underline>
        {texto}
      </Text>
    </Link>
  )
}

/** Uma referência a PR no texto: "#139" ou "PR #139". */
const REF_DE_PR = /#(\d+)\b/g

/**
 * O texto com cada "#N" como link laranja para o PR no GitHub, no repositório da sessão (o do card
 * Trabalho). Sem "#N", o texto puro, que a linha corta. Com `max`, o texto cabe em `max` colunas
 * cortando o que vem antes do número, nunca o "#N" ("Revisar… #139"), com ou sem repositório.
 */
export function textoComPrs(c: Contexto, texto: string, max?: number): (string | RenderElement)[] {
  const repo = c.leitura.painel?.trabalho?.repo ?? null
  const refs = [...texto.matchAll(REF_DE_PR)]
  // Sem "#N" a proteger, o texto inteiro: a linha corta com reticências, no Desktop.
  if (refs.length === 0) return [texto]
  let t = texto
  if (max !== undefined && [...t].length > max) {
    // Corta o que vem antes da primeira referência; o número e o que vem depois ficam.
    const primeira = refs[0]!
    const depois = t.slice(primeira.index!)
    const sobra = max - [...depois].length - 2
    t = sobra >= 1 ? `${corta(t.slice(0, primeira.index!).trimEnd(), sobra + 1)} ${depois}` : depois
  }
  // Sem repositório conhecido, texto puro (com o número inteiro).
  if (!repo) return [t]
  const { Link, Text } = c.el
  const partes: (string | RenderElement)[] = []
  let ultimo = 0
  for (const m of t.matchAll(REF_DE_PR)) {
    if (m.index! > ultimo) partes.push(t.slice(ultimo, m.index!))
    partes.push(
      <Link key={`pr-${m[1]}-${m.index}`} href={`https://github.com/${repo}/pull/${m[1]}`}>
        <Text color={LARANJA} underline>
          {m[0]}
        </Text>
      </Link>,
    )
    ultimo = m.index! + m[0].length
  }
  if (ultimo < t.length) partes.push(t.slice(ultimo))
  return partes
}

/**
 * Um texto que abre algo, numa linha própria do card. No Desktop todo Button é nativo e ignora o
 * estilo do Text de dentro: o rótulo vai em `label`, sem moldura (`plain`), e neutro com `dimColor`.
 */
function abre(c: Contexto, key: string, texto: string, acao: () => void, neutro = false) {
  const { Button } = c.el
  return <Button key={key} plain dimColor={neutro} label={texto} onPress={acao} />
}

/** Colunas de texto dentro de um card: a largura menos a borda e o respiro. */
const UTIL = CARD_W - 4

/**
 * O link que abre a conversa da sessão no Claude Desktop. O Desktop abre `claude://claude.ai/
 * epitaxy/<local_…>`, mas o `Link` do mod só leva `https:` ou `http://localhost`: o link vai ao
 * núcleo local (`/abrir/<local_…>`), que redireciona para o endereço do Desktop.
 */
/** O id `local_<uuid>` do índice do Claude Desktop, o mesmo padrão que a API exige. */
const LOCAL_DO_DESKTOP = /^local_[0-9a-f-]{36}$/

/** A API abre a sessão direto no Claude Desktop, sem passar pelo navegador? */
const abreDireto = (c: Contexto, local: string | null | undefined) => !!local && LOCAL_DO_DESKTOP.test(local) && c.leitura.painel?.api?.abreSessao === true

export function enderecoDaSessao(c: Pick<Contexto, 'nucleo'>, local: string | null | undefined): string | null {
  if (!local || !LOCAL_DO_DESKTOP.test(local)) return null
  const porta = c.nucleo.split(':')[1] ?? '4720'
  return `http://localhost:${porta}/abrir/${local}`
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

function rotuloDaSecao(c: Contexto, largura: number, titulo: string, direita: RenderElement | null, conta?: ContaDoPainel | null) {
  const { Box, Text } = c.el
  return (
    <Box key={`secao-${titulo}`} flexDirection="row" justifyContent="space-between" alignItems="center" width={largura}>
      <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
        <Box flexShrink={0}>
          <Text mono size="caption" weight="semibold" dimColor>
            {titulo}
          </Text>
        </Box>
        {conta && (
          <Text mono size="caption" color={corDaConta(conta)} wrap="truncate-end">
            ◆ {rotuloDaConta(conta.rotulo)}
          </Text>
        )}
      </Box>
      {direita}
    </Box>
  )
}

/**
 * O "auto · 5 s" ao lado de "ESTA SESSÃO" e da conta. O nome da conta nunca corta: no estreito, o
 * chip encurta para "5 s" e, se ainda não couber, sai.
 */
function chipDaSecao(c: Contexto, largura: number, estreito: boolean, conta: ContaDoPainel | null | undefined): RenderElement | null {
  if (!estreito) return chip(c, 'chip', 'auto · 5 s')
  // O título, o espaço e "◆ rótulo"; antes do chip, um espaço.
  const daConta = conta ? 1 + 2 + [...rotuloDaConta(conta.rotulo)].length : 0
  const usadas = [...'ESTA SESSÃO'].length + daConta
  return usadas + 1 + [...'5 s'].length <= largura ? chip(c, 'chip', '5 s') : null
}

/**
 * O chip do P1 (`.pn-sec .r`): no Desktop, um Box com borda ganha respiro vertical e o chip ficava
 * com duas linhas de altura. Sem borda: só o texto pequeno e neutro, numa linha.
 */
function chip(c: Contexto, key: string, texto: string) {
  const { Text } = c.el
  return (
    <Text key={key} mono size="caption" dimColor>
      {texto}
    </Text>
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
        {estreito ? corta(semMarkdown(f.texto), 64) : semMarkdown(f.texto)}
      </Text>
      <Text mono size="caption" wrap="truncate-end">
        {f.rodape}
      </Text>
    </Box>
  )
}

// --- Os seis cards ---

const GLIFO_DA_ATIVIDADE: Record<string, string> = {
  ferramenta: '↻', delegando: '⋔', pergunta: '?', permissao: '⛉', erro: '⊗', prompt: '›_', 'sua-vez': '↵', interrompida: '⏸', concluida: '', abandonada: '', ociosa: '',
}
/** A atividade da sessão como texto: a do erro, a primeira frase; a última mensagem, sem o markdown cru. */
const textoDaAtividade = (s: SessaoDoPainel) => semMarkdown(s.atividade.tipo === 'erro' ? s.atividade.texto.split('.')[0]! : s.atividade.texto)
/**
 * Colunas que uma linha de texto do card ocupa sem cortar no Desktop. A conta nominal é UTIL (30), mas
 * o Desktop acrescenta respiro ao Box com borda: "Opus 5.5 · 12 min · turno 18" (28) cabe, e a linha
 * de uma sessão de dias com o modelo 1M ("Opus 5.5 1M · 2 d · turno 262", 29) saiu cortada.
 */
export const COLUNAS_SEM_CORTE = UTIL - 2

/**
 * A linha do modelo no card Esta sessão, que nunca corta com reticências: inteira se couber; senão o
 * modelo sem a versão ("Opus 5.5" → "Opus"); depois o turno curto ("turno 262" → "t262"). Se nem
 * assim couber, a linha quebra (o desenho usa `wrap`).
 */
export function linhaDoModelo(s: Pick<SessaoDoPainel, 'modelo' | 'iniciadaEm' | 'turno'>, agora: number, max = COLUNAS_SEM_CORTE): string {
  const nome = modelo(s.modelo)
  const curto = nome.replace(/^(Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?/, '$1')
  const tempo = desde(s.iniciadaEm, agora)
  const opcoes = [`${nome} · ${tempo} · turno ${s.turno}`, `${curto} · ${tempo} · turno ${s.turno}`, `${curto} · ${tempo} · t${s.turno}`]
  return opcoes.find((x) => [...x].length <= max) ?? opcoes.at(-1)!
}
/**
 * O card "Esta sessão" (pnEstado do P1): a duração à direita do cabeçalho, as pills, o título, o
 * modelo e o que ela faz agora, cada um numa linha. No card de altura fixa, o título e a atividade
 * cortam com reticências, como no P1; inteiros, ficam na conversa.
 */
function cardSessao(c: Contexto, s: SessaoDoPainel) {
  const { Box, Text } = c.el
  const st = statusDe(s.estado)
  const cor = COR_STATUS[st]
  const tinta = st === 'waiting' || st === 'error'
  const a = s.atividade
  const corAtividade =
    a.tipo === 'erro' ? VERMELHO_TEXTO : a.tipo === 'ferramenta' || a.tipo === 'delegando' ? LARANJA : a.tipo === 'concluida' || a.tipo === 'abandonada' ? undefined : AMARELO
  const glifo = GLIFO_DA_ATIVIDADE[a.tipo]
  return cartao(
    c,
    'card-sessao',
    [
      cabecalho(c, '∿', 'ESTA SESSÃO', desde(s.iniciadaEm, c.agora)),
      // Uma linha só, em qualquer estado (ver pilulasDaSessao): duas pills largas quebravam a linha, e
      // o card de altura fixa esmagava a linha do modelo.
      <Box flexDirection="row" gap={1} flexWrap="nowrap">
        {pilulasDaSessao(st === 'waiting' ? s.motivo : null, statusDe(s.estado)).map((x, i) =>
          i === 0 ? pilula(c, 'status', x.texto, cor.cor, cor.fundo) : pilula(c, 'motivo', x.texto, AMARELO, BADGE.amarelo, MOTIVOS[s.motivo!].urgente),
        )}
      </Box>,
      <Text mono weight="bold" wrap="truncate-end">
        {s.titulo}
      </Text>,
      // Nunca com reticências: encurta e, em último caso, quebra (ver linhaDoModelo).
      <Text mono size="footnote" dimColor wrap="wrap">
        {linhaDoModelo(s, c.agora)}
      </Text>,
      <Text mono size="footnote" wrap="truncate-end">
        {glifo ? <Text color={corAtividade ?? CINZA}>{glifo} </Text> : null}
        <Text color={a.tipo === 'erro' ? VERMELHO_TEXTO : undefined} dimColor={!corAtividade && a.tipo !== 'erro'}>
          {textoDaAtividade(s)}
        </Text>
      </Text>,
    ],
    cor.borda,
    tinta ? cor.fundo : FUNDO_CARTAO,
  )
}

/**
 * As pills do card Esta sessão, numa linha que cabe em COLUNAS_SEM_CORTE. Cada pill ocupa o texto e
 * um espaço de cada lado; entre elas, uma coluna. Sem caber, "Esperando você" vira "Esperando" e,
 * por último, o status fica só com o glifo: o motivo, que diz por que a sessão espera, fica inteiro.
 */
export function pilulasDaSessao(motivo: SessaoDoPainel['motivo'] | null, st: ReturnType<typeof statusDe>): { texto: string }[] {
  const status = `● ${STATUS[st].rotulo}`
  if (!motivo) return [{ texto: status }]
  const m = MOTIVOS[motivo]
  const motivoInteiro = `${m.glifo} ${m.rotulo}`
  const opcoes: [string, string][] = [[status, motivoInteiro], ['● Esperando', motivoInteiro], ['●', motivoInteiro]]
  const largura = ([a, b]: [string, string]) => [...a].length + 2 + 1 + [...b].length + 2
  const [a, b] = opcoes.find((o) => largura(o) <= COLUNAS_SEM_CORTE) ?? opcoes.at(-1)!
  return [{ texto: a }, { texto: b }]
}

/**
 * Um tile do P1 (`.tile`), com borda: o rótulo pequeno, o valor e, embaixo, a barra ou a linha. O
 * card tem a altura que as duas fileiras pedem no Desktop (ver LINHAS_DO_CARD).
 */
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

/** A partir daqui, o "Compactar agora" aparece no pé do card Contexto. */
export const CONTEXTO_ALTO = 80

/** O contexto desta sessão: o do engine (acompanha a compactação na hora) ou, sem ele, o do núcleo. */
const contextoDaSessao = (c: Pick<Contexto, 'leitura'>, p: Painel | null) => c.leitura?.contextoAoVivo ?? p?.contexto ?? null

/**
 * O "Compactar agora" do pé do card Contexto (a partir de 80%): a mesma linha de pé dos outros
 * cards, à direita, sem moldura. O botão primário nativo do Desktop (~28 px, branco) não cabia
 * acima do respiro e destoava dos outros pés. Enquanto o engine compacta, "compactando…".
 */
function botaoCompactar(c: Contexto) {
  const { Text } = c.el
  return c.vista.compactar === 'compactando' ? (
    <Text key="compactando" mono size="footnote" color={AMARELO}>
      compactando…
    </Text>
  ) : (
    abre(c, 'compactar', 'Compactar agora ›', () => c.acoes.compactar('pedir'))
  )
}

/**
 * O card Contexto e custo (pnMetricas do P1): "estimativa" à direita do cabeçalho e os quatro
 * tiles em 2×2. Até 79%, como no P1, sem Compactar; a partir de 80%, o "Compactar agora" no pé do
 * card, à direita: o card se basta sozinho.
 */
function cardContexto(c: Contexto, p: Painel | null) {
  const { Box, Svg } = c.el
  const ctx = contextoDaSessao(c, p)
  const pct = ctx?.pct ?? 0
  const alto = pct >= CONTEXTO_ALTO
  const corCtx = alto ? VERMELHO : LARANJA
  const erro = p?.sessao?.status === 'error'
  const bg = p?.background ?? { total: 0, primeiro: null }
  const tk = p?.tokens
  return cartao(c, 'card-contexto', [
    cabecalho(c, '◠', 'CONTEXTO E CUSTO', 'estimativa'),
    <Box flexDirection="row" gap={1} flexShrink={0}>
      {kpi(c, 'kpi-contexto', 'CONTEXTO', `${pct}%`, <Svg source={barraSvg(pct, corCtx)} alt={`contexto em ${pct}%`} width={96} height={5} />, alto ? VERMELHO_TEXTO : undefined)}
      {kpi(c, 'kpi-custo', 'CUSTO', usd(p?.custo?.usd ?? 0), <Svg source={linhaSvg(p?.custo?.serie ?? [])} alt="custo acumulado da sessão" width={96} height={10} />)}
    </Box>,
    <Box flexDirection="row" gap={1} flexShrink={0}>
      {kpi(c, 'kpi-tokens', 'TOKENS', tk ? `↑${tokens(tk.entrada)} ↓${tokens(tk.saida)}` : '—')}
      {kpi(c, 'kpi-background', 'BACKGROUND', bg.total ? `${bg.total} · ${bg.primeiro ?? ''}` : '0 · nenhum', null, bg.total && erro ? VERMELHO_TEXTO : undefined)}
    </Box>,
  ], BORDA, FUNDO_CARTAO, alto ? peDoCard(c, botaoCompactar(c), 'direita') : null)
}

/**
 * #140 (6 e 7): a pergunta com que a sessão terminou o turno, no topo, inteira e em destaque. Na
 * caixa de próximo passo, cada resposta com mensagem é um botão que a manda ao chat; as ações do app
 * (commit, criar PR) e o AskUserQuestion se respondem no chat.
 */
function faixaPergunta(c: Contexto, largura: number) {
  const q = c.pergunta
  if (!q) return null
  const { Box, Button, Text } = c.el
  const noChat = (
    <Text key="responder-no-chat" mono size="footnote" color={AMARELO}>
      responder no chat ↓
    </Text>
  )
  if (q.tipo === 'fechamento') {
    const respostas = q.acoes.filter((a) => a.mensagem !== null)
    const doApp = q.acoes.filter((a) => a.doApp)
    return (
      <Box key="pergunta" flexDirection="column" width={largura} borderStyle="round" borderColor={AMARELO} backgroundColor={BADGE.amarelo} paddingX={1} gap="xs">
        <Text mono size="caption" weight="semibold" color={AMARELO}>
          ? ESTA SESSÃO PERGUNTA
        </Text>
        <Text mono weight="bold" wrap="wrap">
          {semMarkdown(q.texto)}
        </Text>
        <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          {respostas.map((a, i) => (
            <Button key={`responder-${i}`} label={a.rotulo} variant={i === 0 ? 'primary' : 'secondary'} onPress={() => c.acoes.responder(a.mensagem!)} />
          ))}
          {doApp.length ? (
            <Text mono size="footnote" dimColor wrap="wrap">
              {doApp.map((a) => a.rotulo).join(' · ')}: no chat ↓
            </Text>
          ) : null}
          {respostas.length === 0 && !doApp.length ? noChat : null}
        </Box>
      </Box>
    )
  }
  return (
    <Box key="pergunta" flexDirection="column" width={largura} borderStyle="round" borderColor={AMARELO} backgroundColor={BADGE.amarelo} paddingX={1} gap="xs">
      <Text mono size="caption" weight="semibold" color={AMARELO}>
        ? ESTA SESSÃO PERGUNTA
      </Text>
      {q.perguntas.map((p, i) => (
        <Box key={`pergunta-${i}`} flexDirection="column">
          <Text mono weight="bold" wrap="wrap">
            {p.cabecalho ? <Text color={AMARELO}>{p.cabecalho} · </Text> : null}
            {p.texto}
          </Text>
          {p.opcoes.map((o, j) => (
            <Text key={`opcao-${i}-${j}`} mono size="footnote" wrap="wrap">
              <Text color={AMARELO}>{p.varias ? '☐' : '○'} </Text>
              <Text weight="semibold">{o.rotulo}</Text>
              {o.descricao ? <Text dimColor> · {o.descricao}</Text> : null}
            </Text>
          ))}
        </Box>
      ))}
      {noChat}
    </Box>
  )
}

/** Linhas da faixa da pergunta (com o espaço antes dela): a borda, o rótulo, os textos e as ações. */
function linhasDaPergunta(c: Pick<Contexto, 'pergunta'>, largura: number): number {
  const q = c.pergunta
  if (!q) return 0
  const util = largura - 4
  if (q.tipo === 'fechamento') {
    const acoes = q.acoes.map((a) => a.rotulo).join('    ')
    return 1 + 2 + 1 + linhasDoTexto(q.texto, util) + Math.max(1, linhasDoTexto(acoes, util) * 2)
  }
  let n = 1 + 2 + 1 + 1
  for (const p of q.perguntas) {
    n += linhasDoTexto(`${p.cabecalho ?? ''} · ${p.texto}`, util)
    for (const o of p.opcoes) n += linhasDoTexto(`○ ${o.rotulo}${o.descricao ? ` · ${o.descricao}` : ''}`, util)
  }
  return n
}

/** A confirmação do "Compactar", no topo: age só nesta sessão. */
function faixaCompactar(c: Contexto, largura: number) {
  if (c.vista.compactar !== 'confirmar') return null
  const { Box, Button, Text } = c.el
  return (
    <Box key="confirmar-compactar" flexDirection="column" width={largura} borderStyle="round" borderColor={AMARELO} backgroundColor={BADGE.amarelo} paddingX={1} gap="xs">
      <Text mono weight="semibold" wrap="truncate-end">
        Compactar a conversa desta sessão?
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="compactar-sim" label="Compactar" variant="primary" onPress={() => c.acoes.compactar('confirmar')} />
        <Button key="compactar-nao" label="Cancelar" variant="secondary" onPress={() => c.acoes.compactar('cancelar')} />
      </Box>
    </Box>
  )
}

/**
 * O card Trabalho (pnTrabalho do P1): com issue, "#N título", as sub-issues com a barra, o PR com o
 * estado e "abrir", e as pills de CI e review. Sem issue, o branch numa linha com reticências (como
 * no P1: o nome inteiro fica no GitHub) e "ligar uma issue".
 */
function cardTrabalho(c: Contexto, t: TrabalhoDoPainel | null) {
  const { Box, Text, Svg } = c.el
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
      <Text mono size="footnote" dimColor wrap="truncate-end">
        ⎇ {t.branch}
      </Text>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {t.erro ? `GitHub: ${t.erro}` : 'sem issue ligada a este branch'}
      </Text>,
      t.repo ? link(c, 'ligar-issue', `https://github.com/${t.repo}/issues`, 'ligar uma issue') : null,
    )
    return cartao(c, 'card-trabalho', corpo)
  }
  const i = t.issue
  const sub = i.subIssues
  corpo.push(
    <Text mono size="footnote" weight="semibold" wrap="truncate-end">
      <Text color={LARANJA}>#{i.numero}</Text> {i.titulo}
    </Text>,
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
    return cartao(c, 'card-trabalho', corpo)
  }
  const pr = t.pr
  corpo.push(
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
      <Text mono size="footnote" wrap="truncate-end">
        <Text dimColor>⇄ </Text>PR #{pr.numero} <Text dimColor>· {pr.estado}</Text>
      </Text>
      {link(c, 'abrir-pr', pr.url, 'abrir')}
    </Box>,
  )
  const pilulas: RenderElement[] = []
  // Com a contagem: "CI ✓ 6/6", "CI ✕ 2 falhas", "CI … 3/7" (as que terminaram).
  const k = pr.checks
  if (pr.ci === 'ok') pilulas.push(pilula(c, 'ci', k ? `CI ✓ ${k.ok}/${k.total}` : 'CI ✓', VERDE, BADGE.verde))
  if (pr.ci === 'falhou') pilulas.push(pilula(c, 'ci', k?.falhas ? `CI ✕ ${k.falhas} ${k.falhas === 1 ? 'falha' : 'falhas'}` : 'CI ✕ falhou', VERMELHO_TEXTO, BADGE.vermelho))
  if (pr.ci === 'rodando') pilulas.push(pilula(c, 'ci', k ? `CI … ${k.total - k.rodando}/${k.total}` : 'CI … rodando', AMARELO, BADGE.amarelo))
  if (pr.review === 'aprovado') pilulas.push(pilula(c, 'review', 'aprovado', VERDE, BADGE.verde))
  if (pr.review === 'ajustes') pilulas.push(pilula(c, 'review', 'ajustes pedidos', VERMELHO_TEXTO, BADGE.vermelho))
  if (pr.review === 'pendente') pilulas.push(pilula(c, 'review', 'review pendente', AMARELO, BADGE.amarelo, true))
  if (pilulas.length) corpo.push(<Box flexDirection="row" gap={1}>{pilulas}</Box>)
  return cartao(c, 'card-trabalho', corpo)
}

/** Largura fixa da coluna de tempo das listas: "< 10 s", "19 min", "3 h". */
const TEMPO_W = 7

/**
 * Uma linha de lista (planos, subagentes, sessões filhas): o texto numa linha só, com reticências,
 * e o tempo numa coluna de largura fixa à direita, que nunca divide espaço com o texto. Na tela
 * "+N" (`inteiro`), o texto quebra e aparece inteiro.
 */
function linhaDeLista(c: Contexto, key: string, texto: (RenderElement | string | null)[], tempo: string, inteiro = false, esquerda?: RenderElement, corTempo?: string) {
  const { Box, Text } = c.el
  return (
    <Box key={key} flexDirection="row" gap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {esquerda ?? (
          <Text mono size="footnote" wrap={inteiro ? 'wrap' : 'truncate-end'}>
            {texto}
          </Text>
        )}
      </Box>
      <Box width={TEMPO_W} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Text mono size="footnote" dimColor={!corTempo} color={corTempo} tabular>
          {tempo}
        </Text>
      </Box>
    </Box>
  )
}


/** Quanto o plano durou; o atual, até agora. */
const duracaoDoPlano = (p: PlanoDaSessao, agora: number) => duracao((p.fim ? Date.parse(p.fim) : agora) - Date.parse(p.inicio))

/** Uma linha de plano: ✓ concluído, ◐ abandonado (X/Y) ou ● o atual, o resumo e a duração. */
function linhaDePlano(c: Contexto, p: PlanoDaSessao, detalhe = false) {
  const { Text } = c.el
  const marca = p.resultado === 'concluido' ? { g: '✓', cor: VERDE } : p.resultado === 'abandonado' ? { g: '◐', cor: AMARELO } : { g: '●', cor: LARANJA }
  return linhaDeLista(
    c,
    `plano-${p.numero}`,
    [
      <Text color={marca.cor}>{marca.g} </Text>,
      <Text weight={p.resultado === 'atual' ? 'semibold' : undefined}>{textoComPrs(c, p.resumo)}</Text>,
      p.resultado === 'concluido' && !detalhe ? null : <Text dimColor> · {p.feitos}/{p.total}</Text>,
      detalhe && p.atual ? <Text dimColor> · {p.atual}</Text> : null,
    ],
    duracaoDoPlano(p, c.agora),
    detalhe,
  )
}

/** Colunas do texto de um passo no card do Plano: a largura útil menos o anel (~7) e o glifo. */
const PASSO_NO_CARD = UTIL - 9 - 2

/** Quantos passos o card do Plano destaca ao lado do anel. */
const PASSOS_NO_CARD = 3

/**
 * Os passos que o card destaca: em volta do atual (o último feito, o atual e os próximos); sem
 * atual, os primeiros pendentes; tudo feito, os últimos.
 */
export function passosEmDestaque(passos: readonly PassoDoPainel[]): PassoDoPainel[] {
  if (passos.length <= PASSOS_NO_CARD) return [...passos]
  const atual = passos.findIndex((x) => x.estado === 'in_progress')
  const pendente = passos.findIndex((x) => x.estado === 'pending')
  const foco = atual >= 0 ? atual : pendente >= 0 ? pendente : passos.length - 1
  const inicio = Math.max(0, Math.min(foco - 1, passos.length - PASSOS_NO_CARD))
  return passos.slice(inicio, inicio + PASSOS_NO_CARD)
}

/**
 * O card Plano (pnPlano do P1, com a área útil): o anel com o % à esquerda e, à direita, três
 * passos do plano em destaque (✓ feito, ● o atual em negrito, ○ pendente). Os outros passos e os
 * planos anteriores ficam no detalhe, que a última linha abre.
 */
function cardPlano(c: Contexto, p: Painel['plano'], planos: PlanoDaSessao[]) {
  const { Box, Text, Svg } = c.el
  const anteriores = planos.filter((x) => x.resultado !== 'atual')
  const valor = p ? `${p.feitos}/${p.total}` : '0/0'
  const corpo: (RenderElement | false | null)[] = [cabecalho(c, '☰', 'PLANO', valor, { cor: LARANJA })]
  if (!p) {
    corpo.push(
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {anteriores.length ? 'nenhum plano em andamento' : 'sem plano nesta sessão'}
      </Text>,
    )
    const pe = anteriores.length ? peDoCard(c, abre(c, 'ver-planos', `${contagem(anteriores.length, 'plano anterior', 'planos anteriores')} ›`, c.acoes.verPlanos, true)) : null
    return cartao(c, 'card-plano', corpo, BORDA, FUNDO_CARTAO, pe)
  }
  const pct = p.total ? Math.round((p.feitos / p.total) * 100) : 0
  const passos = p.passos ?? []
  const destaque = passosEmDestaque(passos)
  const linha = (x: PassoDoPainel) => {
    const feito = x.estado === 'completed'
    const atual = x.estado === 'in_progress'
    return (
      <Text key={`passo-${x.id}`} mono size="footnote" wrap="truncate-end" dimColor={!feito && !atual}>
        <Text color={feito ? VERDE : atual ? LARANJA : undefined}>{feito ? '✓' : atual ? '●' : '○'} </Text>
        <Text weight={atual ? 'bold' : undefined}>{textoComPrs(c, atual ? (x.textoAtivo ?? x.texto) : x.texto, PASSO_NO_CARD)}</Text>
      </Text>
    )
  }
  // Sem os passos (núcleo antigo): o resumo do P1, "✓ N feitas", o atual e o próximo.
  const resumo = [
    <Text key="feitas" mono size="footnote" color={VERDE} wrap="truncate-end">
      ✓ {p.feitos} {p.feitos === 1 ? 'feita' : 'feitas'}
    </Text>,
    <Text key="atual" mono size="footnote" wrap="truncate-end">
      {p.atual ? (
        <Text>
          <Text color={LARANJA}>● </Text>
          <Text weight="bold">{p.atual}</Text>
        </Text>
      ) : (
        <Text color={VERDE} weight="semibold">
          concluído ✓
        </Text>
      )}
    </Text>,
    p.atual && p.proximo ? (
      <Text key="proximo" mono size="footnote" dimColor wrap="truncate-end">
        ○ {p.proximo}
        {p.restantes ? ` · +${p.restantes}` : ''}
      </Text>
    ) : null,
  ]
  corpo.push(
    <Box flexDirection="row" gap={2} alignItems="center">
      <Svg source={anelSvg(pct)} alt={`plano ${pct}% feito, ${p.feitos} de ${p.total}`} width={50} height={50} />
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        {destaque.length ? destaque.map(linha) : resumo}
      </Box>
    </Box>,
  )
  // O plano inteiro (os passos) e os anteriores, no detalhe: "6 passos · 2 planos anteriores ›".
  const partes = [passos.length ? contagem(passos.length, 'passo', 'passos') : null, anteriores.length ? contagem(anteriores.length, 'plano anterior', 'planos anteriores') : null].filter(Boolean)
  const pe = peDoCard(c, abre(c, 'ver-planos', partes.length ? `${partes.join(' · ')} ›` : 'ver o plano ›', c.acoes.verPlanos, true))
  return cartao(c, 'card-plano', corpo, BORDA, FUNDO_CARTAO, pe)
}

/** Colunas do texto de uma linha de lista no card: a largura útil menos a coluna de tempo e o espaço. */
const TEXTO_DA_LINHA = CARD_W - 4 - TEMPO_W - 1
/** Na linha do subagente, quantos caracteres da descrição ficam à vista antes de o tipo encurtar. */
const DESCRICAO_MIN = 8
/** O tipo nunca encurta abaixo disso ("gener…"). */
const TIPO_MIN = 6

function linhaDeSubagente(c: Contexto, s: SubagenteDoPainel, inteiro = false) {
  const { Text } = c.el
  const marca =
    s.status === 'completed' ? { g: '✓', cor: VERDE } : s.status === 'error' ? { g: '✕', cor: VERMELHO_TEXTO } : { g: '●', cor: LARANJA }
  const tempo = s.ate ? duracao(Date.parse(s.ate) - Date.parse(s.desde)) : desde(s.desde, c.agora)
  // O que distingue um subagente é a descrição: no card, se ela não couber com pelo menos
  // DESCRICAO_MIN caracteres, é o tipo que encurta ("general…").
  const nome = inteiro || !s.tarefa ? s.nome : corta(s.nome, Math.max(TIPO_MIN, TEXTO_DA_LINHA - 2 - 3 - Math.min([...s.tarefa].length, DESCRICAO_MIN)))
  return linhaDeLista(
    c,
    `sub-${s.id}`,
    [
      <Text color={marca.cor}>{marca.g} </Text>,
      <Text weight="bold">{nome}</Text>,
      // O "#N" da descrição é link para o PR; no card, o texto cabe na linha sem cortar o número.
      s.tarefa ? <Text dimColor> · {textoComPrs(c, s.tarefa, inteiro ? undefined : Math.max(1, TEXTO_DA_LINHA - 2 - [...nome].length - 3))}</Text> : null,
    ],
    tempo,
    inteiro,
  )
}


/** Os ativos primeiro; depois os encerrados, mais recentes antes. */
function subagentesEmOrdem(s: Painel['subagentes']) {
  const ativos = s.itens.filter(subagenteAtivo)
  const encerrados = s.itens.filter((i) => !subagenteAtivo(i)).sort((x, y) => (y.ate ?? y.desde).localeCompare(x.ate ?? x.desde))
  return [...ativos, ...encerrados]
}

const subagenteAtivo = (i: SubagenteDoPainel) => i.status === 'working' || i.status === 'waiting'


/** Quantos itens cabem em `linhas`; quando nem todos cabem, uma linha fica para o "+N". */
function quantosCabem(alturas: number[], linhas: number): number {
  if (alturas.reduce((a, b) => a + b, 0) <= linhas) return alturas.length
  let usadas = 0
  let n = 0
  for (const h of alturas) {
    if (usadas + h + 1 > linhas) break
    usadas += h
    n++
  }
  return n
}

/** No card (P1), até 3 linhas: os ativos primeiro, e os encerrados mais recentes até completar. */
const LINHAS_DA_LISTA = 3

/**
 * O pé do card Subagentes (P11), que abre o grafo da sessão: com todos no card, "ver o grafo ›"; com
 * mais, quantos ficaram fora e, entre eles, os com erro: "+22 · 1 com erro · grafo ›".
 */
function peDosSubagentes(fora: SubagenteDoPainel[]): string {
  if (fora.length === 0) return 'ver o grafo ›'
  const erros = fora.filter((i) => i.status === 'error').length
  const longo = `+${fora.length}${erros ? ` · ${erros} com erro` : ''} · grafo ›`
  // O botão nativo não quebra: sem caber, o erro vira o glifo ("+22 · 1 ✕ · grafo ›").
  return [...longo].length <= COLUNAS_SEM_CORTE ? longo : `+${fora.length}${erros ? ` · ${erros} ✕` : ''} · grafo ›`
}

/**
 * O card Subagentes (pnSubs do P1): "N ativos" à direita do cabeçalho, a barra por estado (ativo
 * laranja, concluído verde, erro vermelho) e até 3 linhas "glifo tipo · descrição … tempo", os
 * concluídos também. O pé abre o grafo da sessão (P11). Nunca só o cabeçalho.
 */
function cardSubagentes(c: Contexto, s: Painel['subagentes']) {
  const { Text, Svg } = c.el
  const corpo: (RenderElement | false | null)[] = [cabecalho(c, '⑂', 'SUBAGENTES', plural(s.ativos, 'ativo', 'ativos'))]
  if (s.itens.length === 0) {
    corpo.push(
      <Text mono size="footnote" dimColor>
        nenhum nesta sessão
      </Text>,
    )
    return cartao(c, 'card-subagentes', corpo)
  }
  const todos = subagentesEmOrdem(s)
  const fora = todos.slice(LINHAS_DA_LISTA)
  corpo.push(
    // Largura e altura explícitas: sem elas, o Desktop dá ao Svg a altura do próprio desenho na
    // largura que sobra, e a barra virava um bloco do tamanho do card. BARRA_W é a largura útil do
    // card no Desktop (~7,9 px por coluna), de borda a borda.
    <Svg source={subagentesSvg(s.itens)} alt={`${s.ativos} ativos de ${s.itens.length}`} width={BARRA_W} height={BARRA_H} />,
    ...todos.slice(0, LINHAS_DA_LISTA).map((i) => linhaDeSubagente(c, i)),
  )
  const pe = peDoCard(c, abre(c, 'ver-subagentes', peDosSubagentes(fora), c.acoes.verSubagentes, true))
  return cartao(c, 'card-subagentes', corpo, BORDA, FUNDO_CARTAO, pe)
}

/** O nome da sessão: um link que abre a conversa no Claude Desktop, quando ela está no índice dele. */
function nomeDaSessao(c: Contexto, key: string, titulo: string, local: string | null | undefined, max: number, inteiro = false, comoNoCard = false) {
  const { Button, Link, Text } = c.el
  const rotulo = inteiro ? titulo : corta(titulo, max)
  // No card (P1), o nome em negrito na cor do texto; na lista, o link em laranja.
  const texto = (
    <Text mono size="footnote" weight={comoNoCard ? 'bold' : 'semibold'} color={comoNoCard ? undefined : LARANJA} underline={!comoNoCard} wrap={inteiro ? 'wrap' : 'truncate-end'}>
      {rotulo}
    </Text>
  )
  // No macOS, a API abre a conversa direto; fora dele, o link de reserva passa pelo navegador.
  // No Desktop o Button é nativo e ignora o Text de dentro: o nome vai no `label`.
  if (abreDireto(c, local)) return <Button key={key} plain label={rotulo} onPress={() => c.acoes.abrirSessao(local!, titulo)} />
  const href = enderecoDaSessao(c, local)
  if (href) return comoNoCard ? <Link key={key} href={href}>{texto}</Link> : <Link key={key} href={href} label={rotulo} />
  return (
    <Text key={key} mono size="footnote" weight={comoNoCard ? 'bold' : 'semibold'} wrap={inteiro ? 'wrap' : 'truncate-end'}>
      {titulo}
    </Text>
  )
}

/** Onde a filha entra na lista: trabalhando, precisando de você, na sua vez ou parada. */
export type GrupoDaFilha = 'trabalhando' | 'precisa' | 'sua-vez' | 'parada' | 'arquivada'

export function grupoDaFilha(f: FilhaDoPainel): GrupoDaFilha {
  // #145: a arquivada no Desktop vem por último, seja qual for o estado em que parou.
  if (f.arquivada) return 'arquivada'
  if (f.estado === 'active' || f.estado === 'delegating' || f.estado === 'background') return 'trabalhando'
  if (f.estado === 'error') return 'precisa'
  // Uma permissão ou uma pergunta chega como `notification`; o fim do turno e o Esc são a sua vez.
  if (f.estado === 'waiting') return f.motivo === 'notification' ? 'precisa' : 'sua-vez'
  return 'parada'
}

const ORDEM_DAS_FILHAS: GrupoDaFilha[] = ['trabalhando', 'precisa', 'sua-vez', 'parada', 'arquivada']

/** O que vem depois do nome, em cor neutra: o que a filha que trabalha está fazendo. */
const fazendoDaFilha = (f: FilhaDoPainel) => (grupoDaFilha(f) === 'trabalhando' ? (f.fazendo ?? null) : null)

/** A coluna da direita (P1): o tempo, ou o estado que pede você, em âmbar ("Sua vez", "Precisa"). */
function direitaDaFilha(f: FilhaDoPainel, agora: number): { texto: string; cor?: string } {
  const grupo = grupoDaFilha(f)
  if (grupo === 'sua-vez') return { texto: 'Sua vez', cor: AMARELO }
  if (grupo === 'precisa') return { texto: f.estado === 'error' ? 'Erro' : 'Precisa', cor: f.estado === 'error' ? VERMELHO_TEXTO : AMARELO }
  // Na coluna de 7: "arquiv." (na lista completa, "· arquivada" vai depois do nome).
  if (grupo === 'arquivada') return { texto: 'arquiv.' }
  return { texto: desde(f.desde, agora) }
}

/** Uma filha (P1): "glifo nome … estado ou tempo"; na lista completa, a que trabalha com o que faz depois do nome. */
function linhaDeFilha(c: Contexto, f: FilhaDoPainel, max: number, inteiro = false, comFazendo = true) {
  const { Box, Text } = c.el
  const st = statusDe(f.estado)
  const g = st === 'waiting' ? '◐' : st === 'completed' ? '✓' : st === 'error' ? '✕' : st === 'abandoned' ? '○' : '●'
  // No card (P1) é "nome … tempo"; o que ela está fazendo aparece na lista completa.
  const fazendo = comFazendo ? fazendoDaFilha(f) : null
  const direita = direitaDaFilha(f, c.agora)
  return linhaDeLista(
    c,
    `filha-${f.id}`,
    [],
    direita.texto,
    inteiro,
    <Box flexDirection="row" flexShrink={1} minWidth={0}>
      <Text mono size="footnote" color={COR_STATUS[st].cor}>
        {g}{' '}
      </Text>
      <Box flexShrink={1} minWidth={0}>
        {nomeDaSessao(c, `nome-filha-${f.id}`, f.titulo, f.local, max, inteiro, !comFazendo)}
      </Box>
      {fazendo ? (
        <Box flexShrink={2} minWidth={0}>
          <Text mono size="footnote" dimColor wrap="truncate-end">
            {' '}· {textoComPrs(c, fazendo)}
          </Text>
        </Box>
      ) : null}
    </Box>,
    direita.cor,
  )
}

/** A sessão do painel está no meio de um turno? O `prompt.submit` de um plugin só roda com ela ociosa. */
const emTurno = (s: SessaoDoPainel | null | undefined) => !!s && (s.estado === 'active' || s.estado === 'delegating')

/**
 * Uma filha arquivada na lista completa (#145): o nome e "· arquivada" em cor neutra e, à direita,
 * "Desarquivar", que pede à sessão do painel para chamar `unarchive_session` (a pessoa aprova). Com a
 * sessão no meio de um turno, o pedido só rodaria depois: "aguarde o turno" no lugar do botão.
 */
function linhaDeArquivada(c: Contexto, f: FilhaDoPainel, sessao: SessaoDoPainel | null | undefined) {
  const { Box, Button, Text } = c.el
  return (
    <Box key={`filha-${f.id}`} flexDirection="row" alignItems="center" gap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text mono size="footnote" dimColor wrap="wrap">
          ○ {f.titulo} · arquivada
        </Text>
      </Box>
      {!f.local ? null : emTurno(sessao) ? (
        <Text key={`aguarde-${f.id}`} mono size="footnote" dimColor>
          aguarde o turno
        </Text>
      ) : (
        <Button key={`desarquivar-${f.id}`} label="Desarquivar" variant="secondary" onPress={() => c.acoes.desarquivar(f)} />
      )}
    </Box>
  )
}

/** Na ordem do card: as trabalhando, as que precisam, as na sua vez e as paradas; em cada grupo, a mais recente antes. */
const filhasEmOrdem = (filhas: FilhaDoPainel[]) =>
  [...filhas].sort(
    (a, b) => ORDEM_DAS_FILHAS.indexOf(grupoDaFilha(a)) - ORDEM_DAS_FILHAS.indexOf(grupoDaFilha(b)) || (b.desde ?? '').localeCompare(a.desde ?? ''),
  )

/**
 * O card Sessões filhas (pnFilhas do P1): a contagem à direita do cabeçalho, até 3 linhas, as que
 * trabalham primeiro, e "ver todas as N ›" na última quando há mais do que cabe. Nunca só o cabeçalho.
 */
function cardFilhas(c: Contexto, todasAsFilhas: FilhaDoPainel[]) {
  const filhas = filhasEmOrdem(todasAsFilhas)
  const { Text } = c.el
  // O total com as arquivadas, e quantas são (#145): "15 · 9 arquivadas".
  const arquivadas = filhas.filter((f) => f.arquivada).length
  const corpo: (RenderElement | false | null)[] = [cabecalho(c, '⑃', 'SESSÕES FILHAS', `${filhas.length}${arquivadas ? ` · ${contagem(arquivadas, 'arquivada', 'arquivadas')}` : ''}`)]
  if (filhas.length === 0) {
    corpo.push(
      <Text mono size="footnote" dimColor>
        nenhuma aberta por esta
      </Text>,
    )
    return cartao(c, 'card-filhas', corpo)
  }
  corpo.push(
    // O nome no card é cortado só no link (que não quebra linha); o resto corta com reticências.
    ...filhas.slice(0, LINHAS_DA_LISTA).map((f) => linhaDeFilha(c, f, UTIL - TEMPO_W - 3, false, false)),
  )
  // O pé ("N sessões filhas ›") só quando há mais filhas do que as linhas do card.
  const pe = filhas.length > LINHAS_DA_LISTA ? peDoCard(c, abre(c, 'ver-filhas', `${contagem(filhas.length, 'sessão filha', 'sessões filhas')} ›`, c.acoes.verFilhas, true)) : null
  return cartao(c, 'card-filhas', corpo, BORDA, FUNDO_CARTAO, pe)
}

/**
 * Folga abaixo da altura do corpo: a estimativa das linhas não conta a pintura do desktop ao
 * pixel, e o dono não quer nenhuma rolagem.
 */
export const FOLGA = 2

/** Linhas livres numa tela que toma o lugar da sessão, descontado o que ela tem em volta e a folga. */
const livres = (c: Contexto, emVolta: number) =>
  c.linhas === undefined ? Number.POSITIVE_INFINITY : c.linhas - emVolta - FOLGA - (linhasDoRodape(c.leitura.painel) - 1)
/** O que não coube nesta altura: o painel não rola. */
function naoCouberam(c: Contexto, key: string, n: number) {
  if (n <= 0) return null
  const { Text } = c.el
  return (
    <Text key={key} mono size="footnote" dimColor>
      +{n} que não cabem nesta altura
    </Text>
  )
}
/** Quantas fileiras de cards de 9 linhas cabem (com o espaço entre elas). */
const fileirasQueCabem = (linhas: number) => Math.max(1, Math.floor((linhas + 1) / (BORDA_DO_CARD + LINHAS_DO_CARD + 1)))

/** A lista completa das sessões filhas, no lugar dos cards. */
function telaFilhas(c: Contexto, p: Painel, g: ReturnType<typeof grade>) {
  const { Box, Text, Button } = c.el
  const util = g.largura - 4
  const alturas = p.filhas.map((f) => (enderecoDaSessao(c, f.local) ? 1 : linhasDoTexto(`● ${f.titulo}`, util - TEMPO_W - 3)))
  // Em volta: respiro, topo, voltar, rótulo, borda da caixa, rodapé, versão e os espaços.
  const n = quantosCabem(alturas, livres(c, 2 + 4 + 1 + 1 + 2 + 1 + 1 + 5))
  const itens = filhasEmOrdem(p.filhas).slice(0, n).map((f) => (f.arquivada ? linhaDeArquivada(c, f, p.sessao) : linhaDeFilha(c, f, g.largura, true)))
  return [
    rotuloDaSecao(c, g.largura, `SESSÕES FILHAS · ${p.filhas.length}`, chip(c, 'chip-filhas', 'desta sessão')),
    <Box key="lista-filhas" flexDirection="column" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1} gap="xs">
      {itens.length ? [...itens, naoCouberam(c, 'nao-couberam', p.filhas.length - n)] : [<Text key="vazio" mono dimColor>nada por aqui</Text>]}
    </Box>,
    <Box key="rodape-filhas" flexDirection="row" justifyContent="flex-end" width={g.largura}>
      <Button key="fechar-filhas" plain onPress={c.acoes.fechar}>
        <Text color={LARANJA} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- O grafo da sessão (#146, P12 e P13) ---

/** Px por coluna da fonte mono no Desktop (ver BARRA_W): a barra do tempo tem a largura das colunas dela. */
const PX_POR_COLUNA = 7.9
const BARRA_DO_GRAFO_H = 10
/** As colunas de cada linha do grafo: no estreito, nome, barra e tempo; no largo, também estado e início. */
const COLUNAS_DO_GRAFO = {
  estreito: { nome: 14, barra: 7, estado: 0, inicio: 0, tempo: TEMPO_W },
  largo: { nome: 40, barra: 36, estado: 9, inicio: 6, tempo: TEMPO_W },
} as const
/** O que o grafo tem em volta, em linhas: o respiro, o topo, os dois "← voltar", o rótulo, a borda da caixa, a régua, a raiz, o pé e a versão. */
const EM_VOLTA_DO_GRAFO = 2 + 4 + 1 + 1 + 2 + 2 + 2 + 2 + 1 + 5

const COR_DO_SUB = (s: SubagenteDoPainel['status']) => (s === 'completed' ? VERDE : s === 'error' ? VERMELHO : LARANJA)
const GLIFO_DO_SUB = (s: SubagenteDoPainel['status']) => (s === 'completed' ? '✓' : s === 'error' ? '✕' : '●')
const ESTADO_DO_SUB = (s: SubagenteDoPainel['status']) => (s === 'completed' ? 'concluído' : s === 'error' ? 'com erro' : 'ativo')
const ESTADO_DA_SESSAO: Record<ReturnType<typeof statusDe>, string> = { active: 'ativa', waiting: 'esperando', completed: 'concluída', error: 'com erro', abandoned: 'abandonada' }

/** O minuto da sessão, como na régua: "33′". */
const minutoDaSessao = (t0: number, t: number) => `${Math.max(0, Math.round((t - t0) / 60_000))}′`

/**
 * A barra do tempo de uma linha: o trilho fino da sessão inteira e, nele, de quando começou a quando
 * acabou (ou até agora, com um traço no fim). Numa onda recolhida, a faixa da onda, clara, com um
 * traço por subagente. Largura e altura explícitas, como todo Svg do mod.
 */
function barraDoGrafoSvg(w: number, t0: number, t1: number, ini: number, fim: number | null, cor: string, marcas?: number[]) {
  const h = BARRA_DO_GRAFO_H
  const x = (v: number) => 1 + ((Math.max(t0, Math.min(t1, v)) - t0) / Math.max(1, t1 - t0)) * (w - 2)
  const de = x(ini)
  const ate = x(fim ?? t1)
  const larg = Math.max(3, ate - de).toFixed(1)
  const trilho = `<rect x="0" y="${h / 2 - 1}" width="${w}" height="2" rx="1" fill="${BORDA}"/>`
  if (marcas) {
    return svg(w, h, `${trilho}<rect x="${de.toFixed(1)}" y="1" width="${larg}" height="${h - 2}" rx="2" fill="${cor}" fill-opacity="0.3"/>${marcas.map((m) => `<rect x="${x(m).toFixed(1)}" y="1" width="2" height="${h - 2}" fill="${cor}"/>`).join('')}`)
  }
  const agora = fim === null ? `<rect x="${(ate - 2).toFixed(1)}" y="0" width="2" height="${h}" fill="${cor}"/>` : ''
  return svg(w, h, `${trilho}<rect x="${de.toFixed(1)}" y="1" width="${larg}" height="${h - 2}" rx="2" fill="${cor}"/>${agora}`)
}

/** A régua do largo: 0′ à esquerda, a duração da sessão à direita e as dezenas (ou os cincos) no meio. */
function reguaDoGrafoSvg(w: number, minutos: number) {
  const passo = minutos < 30 ? 5 : 10
  const marcas = Array.from({ length: Math.floor(minutos / passo) + 1 }, (_, i) => i * passo).filter((m) => m === 0 || m <= minutos - passo / 2)
  const x = (m: number) => 1 + (m / Math.max(1, minutos)) * (w - 2)
  const fonte = `font-family="ui-monospace, Menlo, monospace" font-size="9" fill="${paleta.gray['300']}"`
  return svg(
    w,
    14,
    marcas.map((m) => `<rect x="${x(m).toFixed(1)}" y="10" width="1" height="4" fill="${paleta.gray['300']}"/><text x="${m === 0 ? 0 : (x(m) - 3).toFixed(1)}" y="8" ${fonte}>${m}′</text>`).join('') +
      `<rect x="${w - 1}" y="10" width="1" height="4" fill="${paleta.gray['300']}"/><text x="${w}" y="8" text-anchor="end" ${fonte}>${minutos}′</text>`,
  )
}

/** Uma linha do grafo: as colunas de largura fixa, que nunca dividem espaço uma com a outra. */
function linhaDoGrafo(
  c: Contexto,
  key: string,
  largo: boolean,
  nome: RenderElement | RenderElement[],
  barra: RenderElement | null,
  direita: { estado?: string; corEstado?: string; inicio?: string; tempo: string },
  fundo?: string,
) {
  const { Box, Text } = c.el
  const k = largo ? COLUNAS_DO_GRAFO.largo : COLUNAS_DO_GRAFO.estreito
  const celula = (chave: string, w: number, texto: string | undefined, cor?: string, aDireita = false) => (
    <Box key={chave} width={w} flexShrink={0} flexDirection="row" justifyContent={aDireita ? 'flex-end' : 'flex-start'} overflow="hidden">
      <Text mono size="footnote" tabular color={cor} dimColor={!cor} wrap="truncate-end">
        {texto ?? ''}
      </Text>
    </Box>
  )
  return (
    <Box key={key} flexDirection="row" gap={1} alignItems="center" backgroundColor={fundo}>
      <Box key="nome" width={k.nome} flexShrink={0} flexDirection="row" alignItems="center" overflow="hidden">
        {nome}
      </Box>
      <Box key="barra" width={k.barra} flexShrink={0} flexDirection="row" alignItems="center">
        {barra}
      </Box>
      {largo ? celula('estado', k.estado, direita.estado, direita.corEstado) : null}
      {largo ? celula('inicio', k.inicio, direita.inicio) : null}
      {celula('tempo', k.tempo, direita.tempo, undefined, true)}
    </Box>
  )
}

/** Uma onda: ▸/▾ (botão nativo) que abre e fecha, o que ela tem e, recolhida, a faixa dela no tempo. */
function linhaDaOnda(c: Contexto, o: Extract<LinhaDoGrafo, { tipo: 'onda' }>, largo: boolean, t0: number, estado: EstadoDoGrafo) {
  const { Svg, Text, Button } = c.el
  const k = largo ? COLUNAS_DO_GRAFO.largo : COLUNAS_DO_GRAFO.estreito
  const w = Math.round(k.barra * PX_POR_COLUNA)
  const alternar = () =>
    c.acoes.grafo(
      o.aberta
        ? { abertas: estado.abertas.filter((n) => n !== o.numero), fechadas: [...estado.fechadas.filter((n) => n !== o.numero), o.numero] }
        : { fechadas: estado.fechadas.filter((n) => n !== o.numero), abertas: [...estado.abertas.filter((n) => n !== o.numero), o.numero] },
    )
  const oQue = o.tipos.length === 1 ? `${o.total} ${o.tipos[0]}` : `${o.total} subagentes`
  const corDaOnda = o.cont.erros ? VERMELHO : o.cont.ativos ? LARANJA : VERDE
  const nome = [
    <Button key={`onda-${o.numero}`} plain label={`${o.aberta ? '▾' : '▸'} Onda ${o.numero}`} onPress={alternar} />,
    <Text key="resumo" mono size="footnote" wrap="truncate-end">
      <Text dimColor> · {largo ? `${oQue}${o.aberta && o.emParalelo ? ' em paralelo' : ''} ` : ''}</Text>
      {contagemCurta(o.cont).map((x, i) => (
        <Text key={`cont-${i}`} color={COR_STATUS[x.st].cor}>
          {i ? ' ' : ''}
          {x.texto}
        </Text>
      ))}
    </Text>,
  ]
  const fim = o.fim ?? c.agora
  const barra = o.aberta ? null : <Svg source={barraDoGrafoSvg(w, t0, c.agora, o.ini, o.fim, corDaOnda, o.marcas)} alt={`onda ${o.numero}`} width={w} height={BARRA_DO_GRAFO_H} />
  const estadoDaOnda = o.cont.erros ? { estado: 'com erro', corEstado: VERMELHO_TEXTO } : o.cont.ativos ? { estado: 'ativa', corEstado: LARANJA } : { estado: 'concluída' }
  return linhaDoGrafo(c, `grafo-onda-${o.numero}`, largo, nome, barra, o.aberta ? { tempo: '' } : { ...estadoDaOnda, inicio: minutoDaSessao(t0, o.ini), tempo: duracao(fim - o.ini) })
}

/** Um subagente: o trilho de quem o disparou, o glifo do estado, o tipo e a descrição, e a barra. */
function linhaDoNo(c: Contexto, n: Extract<LinhaDoGrafo, { tipo: 'no' }>, largo: boolean, t0: number) {
  const { Svg, Text } = c.el
  const s = n.sub
  const k = largo ? COLUNAS_DO_GRAFO.largo : COLUNAS_DO_GRAFO.estreito
  const w = Math.round(k.barra * PX_POR_COLUNA)
  const ini = Date.parse(s.desde)
  const fim = s.ate ? Date.parse(s.ate) : null
  const cor = COR_DO_SUB(s.status)
  const mais = n.mais && largo ? contagemCurta(n.mais).map((x) => x.texto.replace(/^(\d+)/, '+$1')).join(' ') : null
  const nome = (
    <Text key="no" mono size="footnote" wrap="truncate-end">
      <Text dimColor>{n.trilho}</Text>
      <Text color={s.status === 'error' ? VERMELHO_TEXTO : cor}>{GLIFO_DO_SUB(s.status)} </Text>
      <Text weight="bold">{s.nome}</Text>
      {s.tarefa && (largo || n.nivel === 1) ? <Text dimColor> · {s.tarefa}</Text> : null}
      {mais ? <Text dimColor> · {mais}</Text> : null}
    </Text>
  )
  const estado = s.status === 'error' ? { estado: 'com erro', corEstado: VERMELHO_TEXTO } : s.status === 'completed' ? { estado: 'concluído' } : { estado: 'ativo', corEstado: LARANJA }
  return linhaDoGrafo(
    c,
    `grafo-no-${s.id}`,
    largo,
    nome,
    <Svg source={barraDoGrafoSvg(w, t0, c.agora, ini, fim, cor)} alt={`${s.nome}: ${ESTADO_DO_SUB(s.status)}`} width={w} height={BARRA_DO_GRAFO_H} />,
    { ...estado, inicio: minutoDaSessao(t0, ini), tempo: duracao((fim ?? c.agora) - ini) },
    s.status === 'error' ? BADGE.vermelho : undefined,
  )
}

/**
 * O grafo da sessão (P12 e P13), no lugar dos cards, aberto pelo pé do card Subagentes (P11): a
 * sessão na raiz, cada subagente pendurado em quem o disparou e a barra de quando rodou; barras
 * sobrepostas rodaram em paralelo. Com mais de AGRUPAR_ACIMA, por onda, com o filtro; pagina pela
 * altura do painel, sem cortar uma linha.
 */
function telaGrafo(c: Contexto, p: Painel, g: ReturnType<typeof grade>, estreito: boolean) {
  const { Box, Text, Button, Select, Svg } = c.el
  const largo = !estreito
  const k = largo ? COLUNAS_DO_GRAFO.largo : COLUNAS_DO_GRAFO.estreito
  const itens = p.subagentes.itens
  const estado = c.vista.grafo ?? ESTADO_DO_GRAFO
  const grafo = montarGrafo(itens, c.agora, estado)
  const s = p.sessao
  const t0 = Math.min(s ? Date.parse(s.iniciadaEm) : c.agora, ...itens.map((x) => Date.parse(x.desde)))
  const minutos = Math.max(1, Math.round((c.agora - t0) / 60_000))
  const pag = paginar(grafo.linhas, livres(c, EM_VOLTA_DO_GRAFO), estado.pagina)
  const w = Math.round(k.barra * PX_POR_COLUNA)

  const cont = grafo.cont
  const chips = (
    <Box key="chips-grafo" flexDirection="row" gap={2} flexShrink={0}>
      {cont.erros ? (
        <Text key="erros" mono size="caption" color={VERMELHO_TEXTO}>
          {cont.erros} {estreito ? '✕' : 'com erro'}
        </Text>
      ) : null}
      {largo && grafo.paralelos ? chip(c, 'paralelos', `${grafo.paralelos} em paralelo`) : null}
      {chip(c, 'ativos', plural(cont.ativos, 'ativo', 'ativos'))}
    </Box>
  )
  const regua = linhaDoGrafo(
    c,
    'grafo-regua',
    largo,
    <Text key="quem" mono size="caption" dimColor wrap="truncate-end">
      {largo ? 'quem disparou quem' : 'quem disparou'}
    </Text>,
    largo ? (
      <Svg source={reguaDoGrafoSvg(w, minutos)} alt={`de 0 a ${minutos} minutos`} width={w} height={14} />
    ) : (
      <Text mono size="caption" dimColor>
        0–{minutos}′
      </Text>
    ),
    { estado: 'estado', inicio: 'início', tempo: largo ? 'duração' : 'tempo' },
  )
  const st = s ? statusDe(s.estado) : 'active'
  const raiz = linhaDoGrafo(
    c,
    'grafo-raiz',
    largo,
    <Text key="raiz" mono size="footnote" wrap="truncate-end">
      <Text color={LARANJA}>◆ </Text>
      <Text weight="bold">Esta sessão</Text>
      {largo && s?.modelo ? <Text dimColor> · {modelo(s.modelo)}</Text> : null}
    </Text>,
    <Svg source={barraDoGrafoSvg(w, t0, c.agora, t0, null, COR_STATUS[st].borda)} alt="esta sessão" width={w} height={BARRA_DO_GRAFO_H} />,
    { estado: ESTADO_DA_SESSAO[st], corEstado: st === 'active' ? LARANJA : COR_STATUS[st].cor, inicio: '0′', tempo: duracao(c.agora - t0) },
  )
  const linhas = pag.linhas.map((l) => (l.tipo === 'onda' ? linhaDaOnda(c, l, largo, t0, estado) : linhaDoNo(c, l, largo, t0)))
  const depois = pag.depois ? (
    <Text key="grafo-depois" mono size="footnote" dimColor>
      {'  '}⋯ +{pag.depois} na pág. {pag.pagina + 2}
    </Text>
  ) : null
  const filtro = grafo.agrupado ? (
    <Select
      key="grafo-filtro"
      value={estado.filtro}
      options={[
        { value: 'todos', label: 'Todos' },
        { value: 'ativos', label: 'Ativos e erros' },
      ]}
      onSelect={(v: string) => c.acoes.grafo({ filtro: v === 'ativos' ? 'ativos' : 'todos', pagina: 0 })}
    />
  ) : null
  const paginas =
    pag.paginas > 1
      ? [
          <Button key="grafo-anterior" plain label="‹" onPress={() => c.acoes.grafo({ pagina: Math.max(0, pag.pagina - 1) })} />,
          <Text key="grafo-pagina" mono size="footnote" dimColor tabular>
            {pag.pagina + 1}/{pag.paginas}
          </Text>,
          <Button key="grafo-proxima" plain label="›" onPress={() => c.acoes.grafo({ pagina: Math.min(pag.paginas - 1, pag.pagina + 1) })} />,
        ]
      : []
  // No estreito, a legenda só cabe quando o pé não tem a paginação nem o filtro.
  const legenda =
    largo || (!paginas.length && !filtro) ? (
      <Box key="legenda" flexShrink={1} minWidth={0}>
        <Text mono size="footnote" dimColor wrap="truncate-end">
          {largo ? `barras sobrepostas rodaram em paralelo${grafo.agrupado ? ' · ▸ abre a onda' : ''}` : 'sobrepostas: em paralelo'}
        </Text>
      </Box>
    ) : null
  return [
    rotuloDaSecao(c, g.largura, estreito ? `GRAFO · ${grafo.total}` : `GRAFO · ${grafo.total} SUBAGENTES`, chips),
    <Box key="grafo" flexDirection="column" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      {regua}
      {raiz}
      {linhas.length ? linhas : [<Text key="vazio" mono size="footnote" dimColor>nenhum nesta sessão</Text>]}
      {depois}
    </Box>,
    <Box key="grafo-pe" flexDirection="row" alignItems="center" gap={1} width={g.largura}>
      {paginas}
      {filtro}
      {legenda}
      <Box key="espaco" flexGrow={1} />
      <Button key="fechar-grafo" plain onPress={c.acoes.fechar}>
        <Text color={LARANJA} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- Linha de baixo: "N precisam de você" ---

/** O nível da sessão em "precisam de você"; núcleo antigo, sem o campo: conta como precisa. */
const precisa = (i: PrecisaDeVoce) => i.nivel !== 'sua-vez'

/** O que bloqueia, dito curto: o motivo da espera ou o erro. */
const PORQUE: Record<NonNullable<PrecisaDeVoce['porque']>, string> = {
  permissao: 'Pede permissão',
  pergunta: 'Pergunta',
  plano: 'Plano para aprovar',
  decisao: 'Pede decisão',
  erro: 'Com erro',
  'sua-vez': 'Sua vez',
  interrompida: 'Interrompida',
  'no-prompt': 'No prompt',
}
const porqueDe = (i: PrecisaDeVoce) => (i.porque ? PORQUE[i.porque] : i.estado === 'error' ? 'Com erro' : i.motivo ? MOTIVOS[i.motivo].rotulo : 'Esperando')

/**
 * "Precisam de você" (#140): o destaque é só de quem está bloqueada até você agir (permissão,
 * pergunta, plano, decisão pedida, erro). A sua vez no bate-bola aparece em cor neutra, ao lado,
 * sem somar na contagem.
 */
/** Quem precisa de você, pelo nome e pelo motivo: as duas primeiras, no largo. */
const nomesQuePrecisam = (p: Painel) =>
  p.precisam.maquina
    .filter(precisa)
    .slice(0, 2)
    .map((i) => `${i.titulo} (${porqueDe(i)})`)
    .join(', ')

/** As partes da linha de quem precisa de você: o que desenha e o que a estimativa da altura mede. */
function partesDePrecisam(p: Painel, estreito: boolean) {
  const n = p.precisam.total
  const vez = p.precisam.suaVez ?? 0
  const naVez = vez ? `${vez} na sua vez` : ''
  const nomes = !estreito && n > 0 ? nomesQuePrecisam(p) : ''
  const principal = n === 0 ? '○ ninguém mais precisa de você' : `🔔 ${precisamTexto(n)}`
  return { n, vez, naVez, nomes, texto: `${principal}${nomes ? ` · ${nomes}` : ''}${naVez ? ` · ${naVez}` : ''}`, principal }
}

/** O botão "Ver" ao lado e o espaço antes dele, em colunas. */
const BOTAO_VER = 7

/** Linhas da faixa de quem precisa de você: o texto quebra linha, nunca corta; com zero, sem botão (P1). */
const linhasDePrecisam = (p: Painel, util: number, estreito: boolean) =>
  LINHA_SOLTA - 1 + linhasDoTexto(partesDePrecisam(p, estreito).texto, util - (p.precisam.total ? BOTAO_VER : 0))

function linhaPrecisam(c: Contexto, p: Painel, largura: number, estreito: boolean) {
  const { Box, Text, Button } = c.el
  const { n, naVez, nomes, principal } = partesDePrecisam(p, estreito)
  if (n === 0) {
    // P1: com zero, em cor neutra e sem o "Ver"; a sua vez ao lado, também neutra.
    return (
      <Box key="precisam" flexDirection="row" alignItems="center" width={largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
        <Text mono dimColor wrap="wrap">
          {principal}
          {naVez ? ` · ${naVez}` : ''}
        </Text>
      </Box>
    )
  }
  const divisao = p.precisam.porConta.map((d) => `${d.conta ? rotuloDaConta(d.conta.rotulo) : 'sem conta'} ${d.n}`).join(' · ')
  return (
    <Box key="precisam" flexDirection="column" width={largura} borderStyle="round" borderColor={AMARELO} backgroundColor={BADGE.amarelo} paddingX={1} hover={{ borderColor: LARANJA }}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text mono weight="bold" color={AMARELO} wrap="wrap">
            {principal}
            {nomes ? <Text weight="regular" color={paleta.gray['100']}> · {nomes}</Text> : null}
            {naVez ? <Text weight="regular" color={CINZA}> · {naVez}</Text> : null}
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

/** #140: o indicador próprio dos PRs que aguardam a sua aprovação, com a lista de links. */
/**
 * "⇄ 1 PR aguardando sua aprovação"; no estreito, "⇄ 1 PR p/ aprovar", que cabe sem cortar. Em
 * laranja, o destaque: vermelho, no P1, é erro.
 */
const textoDePrs = (n: number, estreito: boolean) => `⇄ ${n === 1 ? '1 PR' : `${n} PRs`} ${estreito ? 'p/ aprovar' : 'aguardando sua aprovação'}`

function linhaPrs(c: Contexto, p: Painel, largura: number, estreito: boolean) {
  const n = p.prs?.total ?? 0
  if (n === 0) return null
  const { Box, Text, Button, Link } = c.el
  const um = n === 1 ? (p.prs?.itens[0] ?? null) : null
  return (
    <Box key="prs" flexDirection="row" alignItems="center" gap={1} width={largura} borderStyle="round" borderColor={LARANJA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {/* Com um PR só, o texto já é o link para ele no GitHub; com mais, "Ver" abre a lista, um link por PR. */}
        {um ? (
          <Link key="abrir-o-pr" href={um.url}>
            <Text mono weight="bold" color={LARANJA} underline wrap="wrap">
              {textoDePrs(n, estreito)}
            </Text>
          </Link>
        ) : (
          <Text mono weight="bold" color={LARANJA} wrap="wrap">
            {textoDePrs(n, estreito)}
          </Text>
        )}
      </Box>
      <Button key="ver-prs" label="Ver" variant="secondary" onPress={c.acoes.verPrs} />
    </Box>
  )
}

/** A lista dos PRs: um por linha, o número e o título como link, e a sessão que o abriu. */
function telaPrs(c: Contexto, p: Painel, g: ReturnType<typeof grade>) {
  const { Box, Text, Button, Link } = c.el
  const itens = p.prs?.itens ?? []
  // Em volta: respiro, topo, voltar, rótulo, borda da caixa, rodapé, versão e os espaços.
  const cabem = quantosCabem(itens.map(() => 1), livres(c, 2 + 4 + 1 + 1 + 2 + 1 + 1 + 5))
  const linha = (pr: PrAguardando) => (
    <Box key={`pr-${pr.url}`} flexDirection="row" gap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {link(c, `link-pr-${pr.url}`, pr.url, corta(`PR #${pr.numero} · ${pr.titulo}`, Math.max(20, g.largura - 24)))}
      </Box>
      <Box width={18} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Text mono size="footnote" dimColor wrap="truncate-end">
          {pr.sessao.titulo}
        </Text>
      </Box>
    </Box>
  )
  return [
    rotuloDaSecao(c, g.largura, `PRS AGUARDANDO SUA APROVAÇÃO · ${itens.length}`, chip(c, 'chip-prs', 'review pendente')),
    <Box key="lista-prs" flexDirection="column" width={g.largura} borderStyle="round" borderColor={LARANJA} backgroundColor={FUNDO_CARTAO} paddingX={1} gap="xs">
      {itens.length ? [...itens.slice(0, cabem).map(linha), naoCouberam(c, 'nao-couberam', itens.length - cabem)] : [<Text key="vazio" mono dimColor>nenhum PR aguardando</Text>]}
    </Box>,
    <Box key="rodape-prs" flexDirection="row" justifyContent="flex-end" width={g.largura}>
      <Button key="fechar-prs" plain onPress={c.acoes.fechar}>
        <Text color={LARANJA} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- Decisões: a linha "N decisões registradas", a faixa da retomada (P10) e a lista (P9) ---

/** O escopo das decisões na vista, ou o da largura: sessão no estreito, família no largo. */
export function escopoDasDecisoes(vista: Vista, cols: number): EscopoDasDecisoes {
  return vista.escopoDecisoes ?? (grade(cols).porLinha === 1 ? 'sessao' : 'familia')
}

// No estreito, "· N a confirmar" não cabe ao lado do "Ver": desce para a linha de baixo.
/**
 * As decisões (pnDec do P1), com o rótulo de registro: "⊸ N decisões registradas" e "Ver", neutra,
 * depois dos cards. As a confirmar ficam numa faixa própria no topo. Sem nenhuma, "nenhuma decisão
 * registrada ainda", sem botão.
 */
function linhaDecisoes(c: Contexto, p: Painel, largura: number, estreito: boolean) {
  const d = p.decisoes
  if (!d) return null
  const { Box, Text, Button } = c.el
  const nada = d.vigentes === 0
  return (
    <Box key="decisoes" flexDirection="row" alignItems="center" gap={1} width={largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {nada ? (
          <Text mono dimColor wrap="wrap">
            ⊸ nenhuma decisão registrada ainda
          </Text>
        ) : (
          <Text mono wrap="wrap">
            <Text color={LARANJA}>⊸ </Text>
            <Text weight="bold">{decisoesTexto(d.vigentes)}</Text>
            {estreito ? '' : ' nesta sessão'}
          </Text>
        )}
      </Box>
      {nada ? null : <Button key="ver-decisoes" label="Ver" variant="secondary" onPress={c.acoes.verDecisoes} />}
    </Box>
  )
}

/** O texto da faixa de decisões, para a estimativa da altura. */
const textoDeDecisoes = (p: Painel, estreito: boolean) => {
  const d = p.decisoes
  if (!d || d.vigentes === 0) return '⊸ nenhuma decisão registrada ainda'
  return `⊸ ${decisoesTexto(d.vigentes)}${estreito ? '' : ' nesta sessão'}`
}

/** As decisões a confirmar, no topo (pedem a atenção da pessoa): "⊸ N a confirmar" e "Ver". */
function faixaAConfirmar(c: Contexto, p: Painel, largura: number) {
  const n = p.decisoes?.aConfirmar ?? 0
  if (!n) return null
  const { Box, Text, Button } = c.el
  return (
    <Box key="a-confirmar" flexDirection="row" alignItems="center" gap={1} width={largura} borderStyle="round" borderColor={AMARELO} backgroundColor={BADGE.amarelo} paddingX={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text mono weight="bold" color={AMARELO} wrap="wrap">
          ⊸ {n === 1 ? '1 decisão a confirmar' : `${n} decisões a confirmar`}
        </Text>
      </Box>
      <Button key="ver-a-confirmar" label="Ver" variant="primary" onPress={c.acoes.verDecisoes} />
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
    // "ver na conversa" só quando a mensagem ainda está na conversa; senão, o detalhe traz o trecho.
    acao = (
      <Box flexDirection="row">
        {alcancavel(c, d) ? (
          <Button key={`ver-${d.id}`} plain onPress={() => c.acoes.verNaConversa(d)}>
            <Text mono size="footnote" color={LARANJA} underline>
              ver na conversa
            </Text>
          </Button>
        ) : (
          <Button key={`detalhe-${d.id}`} plain onPress={() => c.acoes.abrirDecisao(d)}>
            <Text mono size="footnote" color={LARANJA} underline>
              ver o trecho
            </Text>
          </Button>
        )}
      </Box>
    )
  }
  return cartao(
    c,
    `decisao-${d.id}`,
    [
      cabecalho(c, o.glifo, o.rotulo, quando(d.decididaEm, c.agora)),
      // O título corta no card; clicar nele abre a decisão inteira.
      <Button key={`abrir-${d.id}`} plain onPress={() => c.acoes.abrirDecisao(d)}>
        <Text mono weight="bold" wrap="truncate-end" strikethrough={velha} dimColor={velha}>
          {d.titulo}
        </Text>
      </Button>,
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
  const porEscopo = lista?.porEscopo ?? null
  // Os três escopos com as mesmas decisões (todas desta sessão): a troca funciona, mas não muda nada.
  const iguais = !!porEscopo && porEscopo.sessao === porEscopo.familia && porEscopo.familia === porEscopo.branch
  const select = (
    <Select
      key="escopo-decisoes"
      value={escopo}
      // Grafia normal, com a contagem de cada escopo quando o núcleo a manda: "Sessão 10".
      options={ESCOPOS.map((e) => ({ value: e.valor, label: porEscopo ? `${e.rotulo} ${porEscopo[e.valor]}` : e.rotulo }))}
      onSelect={(v: string) => c.acoes.escopoDecisoes(v)}
    />
  )
  const vigentes = lista?.vigentes ?? (escopo === 'familia' ? (p.decisoes?.vigentes ?? 0) : null)
  const titulo = `DECISÕES${vigentes === null ? '' : ` · ${vigentes} ${vigentes === 1 ? 'VIGENTE' : 'VIGENTES'}`}`
  const itens = lista?.itens ?? []
  // Em volta: respiro, topo, voltar, rótulo, a barra do Desfazer, o rodapé com borda, versão e os espaços.
  const barra = c.vista.ultimaAcao && c.agora - c.vista.ultimaAcao.em <= DESFAZER_MS ? 4 : 0
  const cabem = fileirasQueCabem(livres(c, 2 + 4 + 1 + 1 + barra + 3 + 1 + 5 + (iguais ? 2 : 0))) * g.porLinha
  const mostrar = itens.slice(0, Math.min(cabem, estreito ? DECISOES_NO_ESTREITO : itens.length))
  const fora = itens.length - mostrar.length
  let conteudo: RenderElement[]
  if (!p.decisoes) conteudo = [<Text key="sem" mono dimColor>o núcleo não trouxe as decisões</Text>]
  else if (!lista) conteudo = [<Text key="lendo" mono dimColor>lendo as decisões…</Text>]
  else if (!itens.length) conteudo = [<Text key="vazio" mono dimColor>nenhuma decisão {escopo === 'sessao' ? 'nesta sessão' : escopo === 'familia' ? 'na família' : 'neste branch'}</Text>]
  else conteudo = mostrar.map((d) => cardDecisao(c, d))
  const fechar = (
    <Button key="fechar-decisoes" plain onPress={c.acoes.fechar}>
      <Text color={LARANJA} underline>
        ← voltar
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
    iguais ? (
      <Text key="escopos-iguais" mono size="footnote" dimColor wrap="wrap">
        mesmo resultado em Sessão, Família e Branch: as decisões são todas desta sessão
      </Text>
    ) : null,
    barraDesfazer(c, g.largura),
    <Box key="lista-decisoes" flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={1} width={g.largura}>
      {conteudo}
    </Box>,
    estreito ? null : naoCouberam(c, 'nao-couberam', fora),
    <Box key="rodape-decisoes" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Box flexDirection="row" flexShrink={1} minWidth={0}>
        {rodape}
      </Box>
      {fechar}
    </Box>,
  ]
}

/** "D4 descartada · Desfazer", por alguns segundos depois de Confirmar, Descartar ou Ajustar. */
function barraDesfazer(c: Contexto, largura: number) {
  const u = c.vista.ultimaAcao
  if (!u || c.agora - u.em > DESFAZER_MS) return null
  const { Box, Text, Button } = c.el
  return (
    <Box key="barra-desfazer" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} width={largura} borderStyle="round" borderColor={LARANJA} backgroundColor={BADGE.laranja} paddingX={1}>
      <Text mono wrap="truncate-end">
        {u.rotulo} {DESFAZER[u.acao].feito}
      </Text>
      <Button key="desfazer-ultima" label="Desfazer" variant="secondary" onPress={() => c.acoes.desfazer(u.id, u.rotulo)} />
    </Box>
  )
}

/** Um bloco do detalhe: o rótulo em versalete e o texto inteiro, quebrando linha. */
function blocoDoDetalhe(c: Contexto, key: string, rotulo: string, texto: string, cor?: string) {
  const { Box, Text } = c.el
  return (
    <Box key={key} flexDirection="column">
      <Text mono size="caption" weight="semibold" dimColor>
        {rotulo}
      </Text>
      <Text mono wrap="wrap" color={cor}>
        {texto}
      </Text>
    </Box>
  )
}

/** A mensagem da decisão ainda está na conversa desta sessão? (Sai dela numa compactação.) */
const alcancavel = (c: Contexto, d: DecisaoDoPainel) => d.sessao === 'esta' && !!d.toolUseId && (c.vista.alcancaveis ?? []).includes(d.toolUseId)

/**
 * O trecho original da decisão, quando a mensagem não está mais na conversa (antes de uma
 * compactação, ou de outra sessão): quem disse, quando e o texto. Sem aviso de erro.
 */
function trechoOriginal(c: Contexto, d: DecisaoDoPainel) {
  const { Box, Text } = c.el
  const quem = d.decididaPor === 'agente' ? 'o agente' : 'você'
  const onde = d.sessao === 'esta' ? 'nesta sessão, antes de uma compactação' : d.sessao === 'mae' ? 'na sessão mãe' : 'em outra sessão'
  return (
    <Box key="trecho" flexDirection="column">
      <Text mono size="caption" weight="semibold" dimColor>
        TRECHO ORIGINAL
      </Text>
      <Text mono size="footnote" dimColor wrap="wrap">
        {quem}, {dataEHora(d.decididaEm)}, {onde}:
      </Text>
      <Text mono wrap="wrap">“{d.texto ?? d.titulo}”</Text>
    </Box>
  )
}

/** A decisão inteira: escolha, o que foi descartado, contexto, quem, quando, origem e as ações. */
function telaDecisao(c: Contexto, g: ReturnType<typeof grade>) {
  const { Box, Text, Button, Input } = c.el
  const d = c.vista.decisao
  if (!d) return [<Text key="sem-decisao" mono dimColor>nenhuma decisão aberta</Text>]
  const o = ORIGENS[d.origem]
  const sugerida = d.estado === 'a_confirmar'
  const acoes: RenderElement[] = []
  if (sugerida) {
    acoes.push(
      <Button key={`confirmar-${d.id}`} label="Confirmar" variant="primary" onPress={() => c.acoes.confirmar(d)} />,
      <Button key={`descartar-${d.id}`} label="Descartar" variant="secondary" onPress={() => c.acoes.descartar(d)} />,
    )
  }
  if ((sugerida || d.estado === 'vigente') && !c.vista.ajustando) {
    acoes.push(<Button key={`ajustar-${d.id}`} label="Ajustar" variant="secondary" onPress={() => c.acoes.ajustar(true)} />)
  }
  if (d.desfazer) {
    acoes.push(<Button key={`desfazer-${d.id}`} label={`Desfazer: ${DESFAZER[d.desfazer].volta}`} variant="secondary" onPress={() => c.acoes.desfazer(d.id, d.rotulo)} />)
  }
  if (alcancavel(c, d)) {
    acoes.push(
      <Button key={`conversa-${d.id}`} plain onPress={() => c.acoes.verNaConversa(d)}>
        <Text mono size="footnote" color={LARANJA} underline>
          ver na conversa
        </Text>
      </Button>,
    )
  }
  return [
    rotuloDaSecao(c, g.largura, `DECISÃO ${d.rotulo}`, pilulaDaDecisao(c, d)),
    barraDesfazer(c, g.largura),
    <Box key="detalhe-decisao" flexDirection="column" width={g.largura} borderStyle="round" borderColor={sugerida ? AMARELO : BORDA} backgroundColor={sugerida ? BADGE.amarelo : FUNDO_CARTAO} paddingX={1} gap="xs">
      <Text mono size="caption" weight="semibold" dimColor wrap="wrap">
        {o.glifo} {o.rotulo.toUpperCase()} · {quemDecidiu(d)} · {dataEHora(d.decididaEm)}
      </Text>
      {blocoDoDetalhe(c, 'decidido', 'DECIDIDO', d.texto ?? d.titulo)}
      {d.contexto ? blocoDoDetalhe(c, 'contexto', 'CONTEXTO', d.contexto) : null}
      {d.nao.length ? blocoDoDetalhe(c, 'nao', 'NÃO', d.nao.join('\n')) : null}
      {d.substituidaPor ? blocoDoDetalhe(c, 'substituida', 'SUBSTITUÍDA POR', d.substituidaPor) : null}
      {alcancavel(c, d) ? null : trechoOriginal(c, d)}
      {c.vista.ajustando ? (
        <Box key="ajuste" flexDirection="column" gap="xs">
          <Input key="ajuste-texto" autoFocus placeholder="a versão certa, ou um comentário" submitLabel="gravar" onSubmit={(v: string) => c.acoes.enviarAjuste(d, v)} />
          <Button key="cancelar-ajuste" plain onPress={() => c.acoes.ajustar(false)}>
            <Text mono size="footnote" dimColor underline>
              cancelar
            </Text>
          </Button>
        </Box>
      ) : null}
      <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
        {acoes}
      </Box>
    </Box>,
    <Box key="rodape-decisao" flexDirection="row" justifyContent="flex-end" width={g.largura}>
      <Button key="fechar-decisao" plain onPress={c.acoes.voltarDecisoes}>
        <Text color={LARANJA} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- P7: a lista de quem precisa de você ---

function cardPrecisa(c: Contexto, i: PrecisaDeVoce) {
  const { Box, Text, Button, Link } = c.el
  const erro = i.estado === 'error'
  // A sua vez em cor neutra (#140): sem o amarelo de quem está bloqueada.
  const neutra = { cor: CINZA, fundo: FUNDO_CARTAO, borda: BORDA }
  const cor = !precisa(i) ? neutra : erro ? COR_STATUS.error : COR_STATUS.waiting
  const relacao = i.relacao === 'mae' ? 'mãe desta' : i.relacao === 'filha' ? 'filha desta' : i.relacao === 'irma' ? 'irmã desta' : i.mesmoProjeto ? 'mesmo projeto' : 'outro projeto'
  return cartao(
    c,
    `precisa-${i.id}`,
    [
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        {enderecoDaSessao(c, i.local) ? (
          <Box flexDirection="row" flexShrink={1} minWidth={0}>
            <Text mono color={cor.borda}>● </Text>
            {nomeDaSessao(c, `nome-${i.id}`, i.titulo, i.local, 22)}
          </Box>
        ) : (
          <Text mono weight="bold" wrap="truncate-end">
            <Text color={cor.borda}>● </Text>
            {i.titulo}
          </Text>
        )}
        <Text mono size="caption" dimColor>
          {desde(i.desde, c.agora)}
        </Text>
      </Box>,
      <Box flexDirection="row" gap={1} alignItems="center">
        {!precisa(i)
          ? pilula(c, 'mt', `↵ ${porqueDe(i)}`, CINZA, BADGE.cinza)
          : erro
            ? pilulaDeStatus(c, 'st', 'error')
            : i.porque
              ? pilula(c, 'mt', porqueDe(i), AMARELO, BADGE.amarelo, true)
              : i.motivo
                ? pilulaDeMotivo(c, 'mt', i.motivo)
                : null}
        {i.urgente && (
          <Text mono size="caption" dimColor>
            urgente
          </Text>
        )}
      </Box>,
      <Text mono size="footnote" wrap="truncate-end" color={erro ? VERMELHO_TEXTO : undefined}>
        {semMarkdown(i.texto)}
      </Text>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {relacao} · {modelo(i.modelo)}
        {i.conta ? <Text color={corDaConta(i.conta)}> · ◆ {rotuloDaConta(i.conta.rotulo)}</Text> : null}
      </Text>,
      <Box flexDirection="row">
        {abreDireto(c, i.local) ? (
          <Button key={`ir-${i.id}`} label="Ir para a sessão" variant="secondary" onPress={() => c.acoes.abrirSessao(i.local!, i.titulo)} />
        ) : enderecoDaSessao(c, i.local) ? (
          <Link key={`ir-${i.id}`} href={enderecoDaSessao(c, i.local)!} label="Ir para a sessão" />
        ) : (
          <Button key={`ir-${i.id}`} label="Ir para a sessão" variant="secondary" onPress={() => c.acoes.irPara(i)} />
        )}
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
  // #140: quem precisa de você primeiro, com destaque; a sua vez depois, neutra, num grupo à parte.
  const doNivel = itens.filter(precisa)
  const naVez = itens.filter((i) => !precisa(i))
  // Em volta: respiro, topo, voltar, rótulo, o rótulo da sua vez, rodapé com borda, versão, o "+N" e os espaços.
  const cabem = fileirasQueCabem(livres(c, 2 + 4 + 1 + 1 + (naVez.length ? 2 : 0) + 3 + 1 + 2 + 5)) * g.porLinha
  const mostrar = [...doNivel, ...naVez].slice(0, cabem)
  const mostrarPrecisa = mostrar.filter(precisa)
  const mostrarVez = mostrar.filter((i) => !precisa(i))
  const select = (
    <Select
      key="escopo"
      value={escopo}
      options={[
        { value: 'familia', label: 'Família' },
        { value: 'maquina', label: 'Máquina inteira' },
      ]}
      onSelect={(v: string) => c.acoes.escopo(v)}
    />
  )
  return [
    rotuloDaSecao(c, g.largura, `PRECISAM DE VOCÊ · ${doNivel.length}`, select),
    <Box key="lista" flexDirection="row" flexWrap="wrap" gap={GAP} width={g.largura}>
      {doNivel.length ? mostrarPrecisa.map((i) => cardPrecisa(c, i)) : [<Text key="vazio" mono dimColor>ninguém {escopo === 'familia' ? 'da família' : ''} precisa de você agora</Text>]}
    </Box>,
    mostrarVez.length ? (
      <Text key="rotulo-sua-vez" mono size="caption" weight="semibold" dimColor>
        SUA VEZ · {naVez.length} · sem pendência, só a vez de responder
      </Text>
    ) : null,
    mostrarVez.length ? (
      <Box key="lista-sua-vez" flexDirection="row" flexWrap="wrap" gap={GAP} width={g.largura}>
        {mostrarVez.map((i) => cardPrecisa(c, i))}
      </Box>
    ) : null,
    naoCouberam(c, 'nao-couberam', itens.length - mostrar.length),
    <Box key="rodape-precisam" flexDirection="row" justifyContent="space-between" alignItems="center" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Text mono wrap="truncate-end">urgentes primeiro{estreito ? '' : ' · esperando e com erro'}</Text>
      <Button key="fechar-precisam" plain onPress={c.acoes.fechar}>
        <Text color={LARANJA} underline>
          ← voltar
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
  // Em volta: respiro, topo, voltar, rótulo, borda da caixa, rodapé com borda, versão e os espaços.
  const util = g.largura - 4 - TEMPO_W - 1
  // O plano atual, passo a passo, em cima: o que o card do P1 resume no anel e nas três linhas.
  const passos = p.plano?.passos ?? []
  const emVoltaDosPassos = passos.length ? 1 + 2 + 1 + passos.length : 0
  const cabem = quantosCabem(planos.map((x) => (estreito ? 1 : linhasDoTexto(`● ${x.resumo} · ${x.feitos}/${x.total}${x.atual ? ` · ${x.atual}` : ''}`, util))), livres(c, 2 + 4 + 1 + 1 + 2 + 3 + 1 + 5 + emVoltaDosPassos))
  const marca = (e: PassoDoPainel['estado']) => (e === 'completed' ? { g: '✓', cor: VERDE } : e === 'in_progress' ? { g: '●', cor: LARANJA } : { g: '○', cor: undefined })
  return [
    passos.length ? (
      <Box key="passos-do-plano" flexDirection="column" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
        {cabecalho(c, '☰', 'PLANO ATUAL', `${p.plano!.feitos}/${p.plano!.total}`, { cor: LARANJA })}
        {passos.map((x) => (
          <Text key={`passo-${x.id}`} mono size="footnote" wrap="wrap" dimColor={x.estado === 'pending'}>
            <Text color={marca(x.estado).cor}>{marca(x.estado).g} </Text>
            <Text weight={x.estado === 'in_progress' ? 'bold' : undefined}>{textoComPrs(c, x.estado === 'in_progress' ? (x.textoAtivo ?? x.texto) : x.texto)}</Text>
          </Text>
        ))}
      </Box>
    ) : null,
    rotuloDaSecao(c, g.largura, `PLANOS DA SESSÃO · ${planos.length}`, chip(c, 'chip-planos', `${conta('concluido')} ✓ · ${conta('abandonado')} ◐`)),
    <Box key="lista-planos" flexDirection="column" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1} gap="xs">
      {planos.length ? [...planos.slice(0, cabem).map((x) => linhaDePlano(c, x, !estreito)), naoCouberam(c, 'nao-couberam', planos.length - cabem)] : [<Text key="vazio" mono dimColor>sem plano nesta sessão</Text>]}
    </Box>,
    <Box key="rodape-planos" flexDirection="row" justifyContent="space-between" alignItems="center" width={g.largura} borderStyle="round" borderColor={BORDA} backgroundColor={FUNDO_CARTAO} paddingX={1}>
      <Text mono wrap="truncate-end">mais recente primeiro{estreito ? '' : ' · ✓ concluído · ◐ abandonado'}</Text>
      <Button key="fechar-planos" plain onPress={c.acoes.fechar}>
        <Text color={LARANJA} underline>
          ← voltar
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

/** "← voltar" no topo de toda tela que toma o lugar da sessão; o botão de baixo diz o mesmo. */
function voltar(c: Contexto, largura: number, para: () => void = c.acoes.fechar, key = 'voltar-sessao') {
  const { Box, Button, Text } = c.el
  return (
    <Box key="voltar" flexDirection="row" width={largura}>
      <Button key={key} plain onPress={para}>
        <Text mono color={LARANJA} underline>
          ← voltar
        </Text>
      </Button>
    </Box>
  )
}

/**
 * As linhas do painel fora da grade de cards: o respiro, o topo, o rótulo, as faixas, as linhas
 * de decisões e de "precisam de você", o rodapé e o espaço entre eles.
 */
/** Uma faixa de uma linha com borda e um botão, no desktop. */
const LINHA_SOLTA = 2

function linhasForaDaGrade(p: Painel, g: ReturnType<typeof grade>, estreito: boolean, compactar: Vista['compactar'] = null): number {
  const util = g.largura - 4
  // No desktop a borda é um traço fino, não uma linha: o topo (logo e duas linhas de texto) ocupa
  // 3, e cada faixa de uma linha com borda (decisões, precisam, PRs) ocupa 2, com o botão.
  // O topo ocupa 3; o rótulo da seção, 1 (o chip não tem borda).
  const partes = [3, 1]
  if (compactar === 'confirmar') partes.push(4)
  const r = p.decisoes?.retomada
  if (r && r.n > 0) partes.push(2 + 1 + (estreito ? 3 : 2) + 1)
  const f = p.sessao?.faixa
  if (f) partes.push(2 + 1 + (estreito ? linhasDoTexto(corta(f.texto, 64), util) : 1) + 1)
  partes.push(0) // a grade
  if (p.decisoes) partes.push(LINHA_SOLTA - 1 + linhasDoTexto(textoDeDecisoes(p, estreito), util - BOTAO_VER))
  if (p.decisoes?.aConfirmar) partes.push(LINHA_SOLTA)
  partes.push(linhasDePrecisam(p, util, estreito))
  if ((p.prs?.total ?? 0) > 0) partes.push(LINHA_SOLTA - 1 + linhasDoTexto(textoDePrs(p.prs!.total, estreito), util - BOTAO_VER))
  partes.push(linhasDoRodape(p))
  return 2 * ESPACO + partes.reduce((a, b) => a + b, 0) + (partes.length - 1) * ESPACO
}

/** Os cards da grade, na ordem do P1. */
const CARDS_DA_GRADE = ['sessao', 'contexto', 'trabalho', 'plano', 'subagentes', 'filhas'] as const

/**
 * A altura estimada da visão da sessão, em linhas: o que fica fora da grade e a grade, com os seis
 * cards sempre inteiros (P1). Quando o pane é mais baixo que isso, o corpo dele rola. Para os testes.
 */
export function linhasDaVisao(c: Contexto, p: Painel): number {
  const g = grade(c.cols)
  const estreito = g.porLinha === 1
  const dentro = CARDS_DA_GRADE.filter((id) => id !== 'sessao' || p.sessao)
  return linhasForaDaGrade(p, g, estreito, c.vista?.compactar) + linhasDaPergunta(c, g.largura) + alturaDaGrade(dentro.map(() => LINHAS_DO_CARD), g.porLinha)
}

/** O painel inteiro, no desktop. */
export function desenhar(c: Contexto): RenderElement {
  const { Box } = c.el
  const g = grade(c.cols)
  const estreito = g.porLinha === 1
  const p = c.leitura.painel
  const offline = c.leitura.offline
  const s = p?.sessao ?? null

  let corpo: (RenderElement | null)[]
  if (offline || !p) {
    corpo = [
      rotuloDaSecao(c, g.largura, 'ESTA SESSÃO', chip(c, 'chip', offline ? 'nova tentativa a cada 5 s' : 'lendo…')),
      ...(offline ? telaOffline(c, g, estreito) : []),
    ]
  } else if (c.vista.tela === 'precisam') {
    corpo = [voltar(c, g.largura), ...telaPrecisam(c, p, g, estreito)]
  } else if (c.vista.tela === 'decisoes') {
    corpo = [voltar(c, g.largura), ...telaDecisoes(c, p, g, estreito)]
  } else if (c.vista.tela === 'planos') {
    corpo = [voltar(c, g.largura), ...telaPlanos(c, p, g, estreito)]
  } else if (c.vista.tela === 'decisao') {
    corpo = [voltar(c, g.largura, c.acoes.voltarDecisoes, 'voltar-decisoes'), ...telaDecisao(c, g)]
  } else if (c.vista.tela === 'prs') {
    corpo = [voltar(c, g.largura), ...telaPrs(c, p, g)]
  } else if (c.vista.tela === 'subagentes') {
    corpo = [voltar(c, g.largura), ...telaGrafo(c, p, g, estreito)]
  } else if (c.vista.tela === 'filhas') {
    corpo = [voltar(c, g.largura), ...telaFilhas(c, p, g)]
  } else {
    // Os seis cards do P1, sempre inteiros e no lugar deles.
    const cards = [
      s ? cardSessao(c, s) : null,
      cardContexto(c, p),
      cardTrabalho(c, p.trabalho),
      cardPlano(c, p.plano, p.planos ?? []),
      cardSubagentes(c, p.subagentes),
      cardFilhas(c, p.filhas),
    ].filter((x): x is RenderElement => x !== null)
    corpo = [
      rotuloDaSecao(c, g.largura, 'ESTA SESSÃO', chipDaSecao(c, g.largura, estreito, s?.conta), s?.conta),
      // Decisão do Fernando (desvio aprovado do P1): o que pede a atenção dele sobe para o topo,
      // antes dos cards: a pergunta, quem precisa de você, os PRs e as decisões a confirmar. Com a
      // rolagem, no fim do painel, elas saíam de vista.
      faixaPergunta(c, g.largura),
      p.precisam.total > 0 ? linhaPrecisam(c, p, g.largura, estreito) : null,
      linhaPrs(c, p, g.largura, estreito),
      faixaAConfirmar(c, p, g.largura),
      faixaRetomada(c, p.decisoes?.retomada, g.largura, estreito),
      s ? faixa(c, s, g.largura, estreito) : null,
      faixaCompactar(c, g.largura),
      <Box key="cards" flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={1} width={g.largura}>
        {cards}
      </Box>,
      // Embaixo, só o que é informativo e neutro.
      linhaDecisoes(c, p, g.largura, estreito),
      p.precisam.total > 0 ? null : linhaPrecisam(c, p, g.largura, estreito),
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

/** A pasta da API mudou desde que ela subiu: o código no ar é outro. */
const pastaMudou = (p: Painel | null) => !!p?.api?.pasta && !!p.api.commit && p.api.pasta !== p.api.commit

/** Linhas do rodapé: a versão e, quando a pasta mudou, o aviso para reiniciar a API. */
const linhasDoRodape = (p: Painel | null) => (pastaMudou(p) ? 2 : 1)

/**
 * "plugin 0.0.8 · api 0.0.1 (1f9de92)": para saber que o painel e a API são os da mesma versão. O
 * commit é o do código que a API carregou; se a pasta já está em outro, o rodapé pede para reiniciar.
 */
function rodape(c: Contexto, largura: number) {
  const { Box, Text } = c.el
  const p = c.leitura.painel
  const api = p?.api
  return (
    <Box key="rodape-versao" flexDirection="column" alignItems="center" width={largura}>
      <Text mono size="caption" dimColor wrap="truncate-end">
        plugin {VERSAO_DO_PLUGIN} · api {api ? `${api.versao}${api.commit ? ` (${api.commit})` : ''}` : '—'}
      </Text>
      {pastaMudou(p) ? (
        <Text mono size="caption" color={AMARELO} wrap="truncate-end">
          pasta em {api!.pasta}: reinicie a API
        </Text>
      ) : null}
    </Box>
  )
}
