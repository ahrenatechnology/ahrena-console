// Painel do Ahrena Console (teste): abas Visão geral, Kanban, Trabalho e Sessões, montadas
// com os elementos que a aba Code do Claude Desktop oferece a um mod. Lê o núcleo
// local: /api/fleet (sessões) a cada 5 s, /api/work (hierarquia do GitHub) a cada 60 s e
// /api/kanban (o GitHub Project por Status) a cada 2 min; mover um card chama
// /api/kanban/move, que muda o Status no GitHub.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, RenderElement } from 'claude-code'

import type { Fleet, Kanban, KanbanCard, KanbanLane, Reading, SessionRow, Tab, View, Work, WorkNode } from '../types'

const PANE = 'ahrena-console'
const CORE = 'http://127.0.0.1:4720'
const REPO = 'https://github.com/ahrenatechnology/ahrena-console'
const FLEET_EVERY_MS = 5000
const WORK_EVERY_MS = 60_000
// O mesmo TTL do Project no núcleo (decisão 0001): reler antes disso sairia do cache.
const KANBAN_EVERY_MS = 2 * 60_000

const ORANGE = '#f47720'
const PINK = '#df285d'
const YELLOW = '#ffc30a'
const GREEN = '#1baf7a'
const VIOLET = '#9085e9'
const RED = '#e34948'
const MUTED = '#a6a6aa'
const STATE_COLOR: Record<SessionRow['state'], string> = { ativa: ORANGE, ociosa: YELLOW, encerrada: MUTED }
const STAGES = ['a fazer', 'em andamento', 'ci rodando', 'ci falhou', 'ajustes pedidos', 'em revisão', 'mergeado', 'concluída'] as const
const STAGE_COLOR: Record<string, string> = {
  'a fazer': MUTED,
  'em andamento': YELLOW,
  'ci rodando': YELLOW,
  'ci falhou': RED,
  'ajustes pedidos': RED,
  'em revisão': ORANGE,
  mergeado: GREEN,
  concluída: GREEN,
}
// Cor e rótulo de cada tipo de issue: o nível na hierarquia salta aos olhos no card.
const TYPE_STYLE: Record<string, { color: string; label: string }> = {
  Initiative: { color: ORANGE, label: 'Iniciativa' },
  'Epic / Milestone': { color: PINK, label: 'Épico' },
  Epic: { color: PINK, label: 'Épico' },
  Feature: { color: VIOLET, label: 'Feature' },
  'User Story': { color: VIOLET, label: 'História' },
  Task: { color: '#5aa9e6', label: 'Tarefa' },
  'Tech Task': { color: '#5aa9e6', label: 'Tarefa técnica' },
  Spike: { color: YELLOW, label: 'Spike' },
  Bug: { color: PINK, label: 'Bug' },
  Plan: { color: MUTED, label: 'Plano' },
}
// Raias do kanban: cada estágio cai numa raia.
const LANES: { id: string; label: string; color: string; stages: string[] }[] = [
  { id: 'fazer', label: 'A fazer', color: MUTED, stages: ['a fazer'] },
  { id: 'andamento', label: 'Em andamento', color: YELLOW, stages: ['em andamento', 'ci rodando'] },
  { id: 'revisao', label: 'Em revisão', color: ORANGE, stages: ['em revisão', 'ajustes pedidos', 'ci falhou'] },
  { id: 'feito', label: 'Feito', color: GREEN, stages: ['mergeado', 'concluída'] },
]
const LANE_LIMIT = 8
// Cores das opções de um campo do GitHub Project.
const GH_COLOR: Record<string, string> = {
  GRAY: MUTED, BLUE: '#5aa9e6', GREEN: GREEN, YELLOW: YELLOW, ORANGE: ORANGE, RED: RED, PINK: PINK, PURPLE: VIOLET,
}
const KIND_STYLE: Record<KanbanCard['kind'], { color: string; label: string } | null> = {
  Issue: null,
  PullRequest: { color: GREEN, label: 'PR' },
  DraftIssue: { color: MUTED, label: 'Rascunho' },
}
const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
// Abaixo desta largura (em colunas) as raias do kanban ficam empilhadas na vertical.
const KANBAN_WIDE_COLUMNS = 150
// Tamanho único dos cards, medido no painel do Claude Desktop (estreito ≈ 38 colunas,
// expandido ≈ 121): a largura da tela muda quantos cabem por linha, nunca o tamanho.
const CARD_W = 34
const CARD_H = 6
const KPI_W = 16
const KPI_H = 4
const laneOf = (stage: string) => LANES.find(l => l.stages.includes(stage)) ?? LANES[0]!
// Selo do CI com cor semântica: verde passou, vermelho falhou, amarelo rodando.
function ciBadge(ci: string | null) {
  if (!ci) return null
  if (ci === 'SUCCESS') return { text: 'CI ✓', color: GREEN }
  if (ci === 'FAILURE' || ci === 'ERROR') return { text: 'CI ✕', color: RED }
  return { text: 'CI …', color: YELLOW }
}
const typeStyle = (t: string | null) => (t && TYPE_STYLE[t]) || { color: MUTED, label: t ?? 'Issue' }
const TABS: { id: Tab; label: string }[] = [
  { id: 'visao', label: 'Visão geral' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'trabalho', label: 'Trabalho' },
  { id: 'sessoes', label: 'Sessões' },
]

const EMPTY_READING: Reading = {
  fleet: null, work: null, kanban: null, error: null, workError: null, kanbanError: null, moving: null, polls: 0, latencies: [],
}
const EMPTY_VIEW: View = {
  tab: 'visao', filter: 'todas', query: '', selected: null, stage: 'todas', org: 'todas', issueQuery: '', selectedIssue: null,
  workMode: 'kanban', expanded: [], fullLanes: [],
}

const reading = atom({ plugin: 'ahrena-console-painel', key: 'reading' } as const, EMPTY_READING)
const view = atom({ plugin: 'ahrena-console-painel', key: 'view' } as const, EMPTY_VIEW)

let fleetTimer: { cancel: () => void } | undefined
// Largura que o painel recebeu no último desenho; vai ao núcleo para calibrar o layout.
let lastBodyColumns: number | null = null
let workTimer: { cancel: () => void } | undefined
let kanbanTimer: { cancel: () => void } | undefined

// Estado salvo por uma versão anterior do painel pode vir sem campos novos.
function normalize(value: unknown): Reading {
  const raw = value as Partial<Reading> | undefined
  return {
    ...EMPTY_READING,
    ...raw,
    fleet: raw?.fleet?.totals ? raw.fleet : null,
    work: raw?.work?.nodes ? raw.work : null,
    kanban: raw?.kanban?.lanes ? raw.kanban : null,
    latencies: raw?.latencies ?? [],
  }
}

async function readingNow($: Engine): Promise<Reading> {
  return normalize(await read($, reading))
}

// Cada leitura grava só a parte dela, sobre o estado do momento da gravação:
// leituras em paralelo (sessões e trabalho) não apagam umas às outras.
async function patchReading($: Engine, fn: (r: Reading) => Partial<Reading>) {
  await update($, reading, cur => {
    const r = normalize(cur)
    return { ...r, ...fn(r) }
  })
}

// Lê a resposta do núcleo sem quebrar: corpo vazio ou erro viram uma mensagem legível,
// e quem chamou mantém o último dado bom na tela.
function readJson<T>(res: { ok: boolean; status: number; text: string }): { data: T | null; error: string | null } {
  if (!res.text) return { data: null, error: `HTTP ${res.status}: resposta vazia` }
  try {
    const json = JSON.parse(res.text) as T & { error?: string; stale?: boolean; staleReason?: string }
    if (!res.ok) return { data: null, error: json.error ?? `HTTP ${res.status}` }
    return { data: json, error: json.stale ? `mostrando dados antigos: ${json.staleReason ?? 'GitHub indisponível'}` : null }
  } catch {
    return { data: null, error: `HTTP ${res.status}: resposta inválida` }
  }
}

async function viewNow($: Engine): Promise<View> {
  const v = { ...EMPTY_VIEW, ...((await read($, view)) as Partial<View> | undefined) }
  return {
    ...v,
    tab: TABS.some(t => t.id === v.tab) ? v.tab : 'visao',
    expanded: Array.isArray(v.expanded) ? v.expanded : [],
    fullLanes: Array.isArray(v.fullLanes) ? v.fullLanes : [],
  }
}

async function pollFleet($: Engine) {
  const t0 = await $.clock.now()
  try {
    const res = await $.http.fetch(`${CORE}/api/fleet${lastBodyColumns ? `?cols=${lastBodyColumns}` : ''}`)
    const ms = (await $.clock.now()) - t0
    const { data: fleet, error } = readJson<Fleet>(res)
    await patchReading($, r => ({
      fleet: fleet ?? r.fleet,
      error,
      polls: r.polls + 1,
      latencies: [...r.latencies, ms].slice(-24),
    }))
    $.ui.status(fleet ? `ahrena-console ● ${fleet.totals.active} ativa · ${fleet.totals.idle} ociosa` : 'ahrena-console ○ erro')
  } catch (err) {
    await patchReading($, r => ({ error: String(err), polls: r.polls + 1 }))
    $.ui.status('ahrena-console ○ offline')
  }
}

async function pollWork($: Engine) {
  try {
    const res = await $.http.fetch(`${CORE}/api/work`)
    const { data: work, error } = readJson<Work>(res)
    await patchReading($, r => ({ work: work ?? r.work, workError: error }))
  } catch (err) {
    await patchReading($, () => ({ workError: String(err) }))
  }
}

// O quadro do Project. `force` é o botão de atualizar (o núcleo respeita o mínimo de 30 s).
async function pollKanban($: Engine, force = false) {
  try {
    const res = await $.http.fetch(`${CORE}/api/kanban${force ? '?force=1' : ''}`)
    const { data: kanban, error } = readJson<Kanban>(res)
    await patchReading($, r => ({ kanban: kanban ?? r.kanban, kanbanError: error }))
  } catch (err) {
    await patchReading($, () => ({ kanbanError: String(err) }))
  }
}

// Move um card de raia: o núcleo muda o Status no GitHub e devolve o quadro já atualizado,
// sem reler o Project. Enquanto isso, o card mostra que está esperando.
async function moveCard($: Engine, itemId: string, optionId: string) {
  if ((await readingNow($)).moving) return
  await patchReading($, () => ({ moving: itemId }))
  try {
    const res = await $.http.fetch(`${CORE}/api/kanban/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, optionId }),
    })
    const { data: kanban, error } = readJson<Kanban>(res)
    await patchReading($, r => ({ kanban: kanban ?? r.kanban, kanbanError: error && `Não deu para mover: ${error}`, moving: null }))
  } catch (err) {
    await patchReading($, () => ({ kanbanError: `Não deu para mover: ${String(err)}`, moving: null }))
  }
}

function start($: Engine) {
  fleetTimer?.cancel()
  workTimer?.cancel()
  kanbanTimer?.cancel()
  void pollFleet($)
  void pollWork($)
  void pollKanban($)
  fleetTimer = $.clock.every(FLEET_EVERY_MS, () => void pollFleet($))
  workTimer = $.clock.every(WORK_EVERY_MS, () => void pollWork($))
  kanbanTimer = $.clock.every(KANBAN_EVERY_MS, () => void pollKanban($))
}

async function setView($: Engine, patch: Partial<View>) {
  const v = await viewNow($)
  await update($, view, () => ({ ...v, ...patch }))
}

async function toggle($: Engine, key: string) {
  const v = await viewNow($)
  const expanded = v.expanded.includes(key) ? v.expanded.filter(k => k !== key) : [...v.expanded, key]
  await update($, view, () => ({ ...v, expanded }))
}

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}min`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${ORANGE}"/><path d="M9 23 L16 8 L23 23" stroke="#17171b" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 16.5 L19 16.5 L16 21.5 Z" fill="${PINK}" stroke="${PINK}" stroke-width="1" stroke-linejoin="round"/></svg>`
}

function barsSvg(values: number[]) {
  const max = Math.max(1, ...values)
  const w = 12 * values.length
  const bars = values
    .map((v, i) => {
      const h = Math.max(2, Math.round((v / max) * 36))
      return `<rect x="${i * 12 + 2}" y="${40 - h}" width="8" height="${h}" rx="2" fill="${i === values.length - 1 ? ORANGE : PINK}"/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 42">${bars}<line x1="0" y1="41" x2="${w}" y2="41" stroke="${MUTED}" stroke-width="0.5"/></svg>`
}

function sparkSvg(values: number[]) {
  if (values.length < 2) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"></svg>`
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${18 - (v / max) * 16}`).join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><polyline points="${pts}" fill="none" stroke="${ORANGE}" stroke-width="1.5"/></svg>`
}

// Barra de progresso das sub-issues: a parte concluída na cor do tipo.
function progressSvg(pct: number, color: string) {
  const w = Math.round(Math.max(0, Math.min(100, pct)) * 1.6)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 6"><rect x="0" y="0" width="160" height="6" rx="3" fill="${MUTED}" fill-opacity="0.25"/><rect x="0" y="0" width="${w}" height="6" rx="3" fill="${color}"/></svg>`
}

// Barra empilhada com a distribuição por estágio.
function stagesSvg(byStage: Record<string, number>) {
  const total = Math.max(1, STAGES.reduce((n, s) => n + (byStage[s] ?? 0), 0))
  let x = 0
  const parts = STAGES.filter(s => byStage[s])
    .map(s => {
      const w = ((byStage[s] ?? 0) / total) * 300
      const rect = `<rect x="${x}" y="0" width="${Math.max(w - 2, 1)}" height="10" rx="2" fill="${STAGE_COLOR[s]}"/>`
      x += w
      return rect
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 10">${parts}</svg>`
}

function prLine(n: WorkNode) {
  const p = n.prs.find(x => x.state === 'OPEN') ?? n.prs[0]
  if (!p) return null
  return `PR #${p.number} · ${p.isDraft ? 'rascunho' : p.state === 'OPEN' ? 'aberto' : p.state === 'MERGED' ? 'mergeado' : 'fechado'}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'console', description: 'Abre o painel do Ahrena Console' })
    start($)
    return next(e)
  })

  on('command.run', { command: 'console' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Ahrena Console' })
    return { text: isPlaced ? 'Painel do Ahrena Console aberto.' : 'Esta superfície não desenha painéis.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const r = await readingNow($)
    if (e.surface !== 'desktop') {
      const { Box, Text } = $.ui.resolve(e)
      const t = r.fleet?.totals
      return (
        <Box flexDirection="column">
          <Text bold color={ORANGE}>Ahrena Console</Text>
          <Text>{t ? `${t.active} ativa · ${t.idle} ociosa · ${t.sessions} sessões` : 'sem leitura do núcleo'}</Text>
        </Box>
      )
    }
    const { Box, Text, Button, Input, Select, Svg, Link, Code, Markdown, Client } = $.ui.resolve(e)
    const v = await viewNow($)
    const f = r.fleet
    const w = r.work

    // Layout responsivo: a largura do painel (em colunas) decide estreito, médio ou largo.
    // Gráficos em SVG crescem com o painel; recuos e larguras mínimas encolhem.
    const cols = e.props.bodyColumns ?? 60
    lastBodyColumns = cols
    const narrow = cols < 90
    const PX_PER_COL = 6
    const svgW = (max: number) => Math.max(60, Math.min(max, Math.floor((cols - 8) * PX_PER_COL)))
    const indent = (depth: number) => Math.min(depth, 3) * (narrow ? 1 : 2)

    const header = (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Svg source={logoSvg()} alt="Ahrena Console" width={28} height={28} />
          <Box flexDirection="column" flexGrow={1}>
            <Text size="heading" weight="bold" color={ORANGE}>Ahrena Console</Text>
            <Text size="caption" dimColor>v0.0.1 · teste</Text>
          </Box>
          <Link href={REPO} label="GitHub" />
        </Box>
        <Client key="pulso" module="./pulso.tsx" props={{ generatedAt: f?.generatedAt ?? null }} />
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          {TABS.map(t => (
            <Button key={`tab-${t.id}`} label={t.label} variant={v.tab === t.id ? 'primary' : 'secondary'} onPress={() => setView($, { tab: t.id })} />
          ))}
        </Box>
      </Box>
    )

    if (!f) {
      return (
        <Box flexDirection="column" gap="md" padding="sm">
          {header}
          <Text color={PINK}>Sem conexão com o núcleo: {r.error ?? 'aguardando a primeira leitura'}</Text>
          <Button key="retry" label="Tentar de novo" variant="primary" onPress={() => pollFleet($)} />
        </Box>
      )
    }

    const avgMs = r.latencies.length ? Math.round(r.latencies.reduce((a, b) => a + b, 0) / r.latencies.length) : 0
    const nodes = w ? Object.values(w.nodes) : []
    const openLeafs = nodes.filter(n => n.state === 'OPEN' && !n.children.length)
    const byStage: Record<string, number> = {}
    for (const n of openLeafs) byStage[n.stage] = (byStage[n.stage] ?? 0) + 1

    // Card de uma issue: tipo em destaque, título, estágio, progresso das filhas e PR.
    // Card único de item de trabalho, o mesmo em todas as visões (Kanban, árvore, por
    // estágio): sempre 4 linhas, na altura exata do conteúdo, e a mesma largura.
    const card = (n: WorkNode, depth: number) => {
      const ts = typeStyle(n.type)
      const isOpen = v.expanded.includes(n.key)
      const openPr = n.prs.find(x => x.state === 'OPEN') ?? n.prs[0]
      const ci = ciBadge(openPr?.ci ?? null)
      const lane = n.state === 'CLOSED' ? 'Feito' : laneOf(n.stage).label
      return (
        <Box key={`card-${n.key}`} flexDirection="column" marginLeft={indent(depth)} width={CARD_W} height={CARD_H} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={ts.color} paddingX="xs">
          <Box flexDirection="row" gap="xs" overflow="hidden">
            <Text size="caption" weight="bold" color={ts.color}>{ts.label}</Text>
            <Text size="caption" weight="semibold" color={laneOf(n.stage).color}>· {lane}</Text>
            <Text size="caption" dimColor>· #{n.number}</Text>
          </Box>
          <Text size="footnote" weight="semibold" wrap="truncate-end">{n.title}</Text>
          <Box flexDirection="row" gap="xs" overflow="hidden">
            {n.progress && <Text size="caption" tabular color={ts.color}>{n.progress.completed}/{n.progress.total}</Text>}
            {openPr && <Text size="caption" dimColor>PR #{openPr.number}</Text>}
            {ci && <Text size="caption" weight="bold" color={ci.color}>{ci.text}</Text>}
            {openPr?.review === 'CHANGES_REQUESTED' && <Text size="caption" weight="bold" color={RED}>ajustes</Text>}
            {openPr?.review === 'APPROVED' && <Text size="caption" weight="bold" color={GREEN}>aprovado</Text>}
            <Text size="caption" dimColor>{ago(n.updatedAt)}</Text>
          </Box>
          <Box flexDirection="row" gap="sm" overflow="hidden">
            {n.children.length > 0 && (
              <Button key={`toggle-${n.key}`} plain onPress={() => toggle($, n.key)}>
                <Text color={ts.color}>{isOpen ? '▾' : '▸'}</Text> {isOpen ? 'Recolher' : `${n.children.length} ${n.children.length === 1 ? 'item' : 'itens'}`}
              </Button>
            )}
            <Link href={n.url} label="Abrir" />
          </Box>
        </Box>
      )
    }

    const matches = (n: WorkNode) =>
      (v.org === 'todas' || n.repo.startsWith(`${v.org}/`)) &&
      (!v.issueQuery || `${n.repo} ${n.title}`.toLowerCase().includes(v.issueQuery.toLowerCase()))

    // Árvore: a raiz e, se expandida, as filhas, recursivamente.
    const tree = (key: string, depth: number): RenderElement[] => {
      const n = w?.nodes[key]
      if (!n) return []
      const out: RenderElement[] = [card(n, depth)]
      if (v.expanded.includes(key)) for (const c of n.children) out.push(...tree(c, depth + 1))
      return out
    }

    // Visão geral: números, atividade, distribuição do trabalho e projetos mais usados.
    const visao = (
      <Box flexDirection="column" gap="md">
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          {[
            { k: 'Ativas', n: f.totals.active, c: ORANGE },
            { k: 'Ociosas', n: f.totals.idle, c: YELLOW },
            { k: 'Iniciativas', n: w?.byType.Initiative ?? 0, c: ORANGE },
            { k: 'Itens abertos', n: openLeafs.length, c: PINK },
          ].map(c => (
            <Box key={c.k} flexDirection="column" borderStyle="round" borderColor={c.c} paddingX="sm" width={KPI_W} height={KPI_H} flexShrink={0} overflow="hidden">
              <Text size="caption" dimColor>{c.k}</Text>
              <Text size="title" weight="bold" tabular color={c.c}>{c.n}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" gap="xs">
          <Text size="footnote" weight="semibold">Atividade nas últimas 12 h</Text>
          <Svg source={barsSvg(f.activityByHour)} alt={`Sessões com atividade por hora: ${f.activityByHour.join(', ')}`} width={svgW(420)} height={46} />
        </Box>
        {w && (
          <Box flexDirection="column" gap="xs">
            <Text size="footnote" weight="semibold">Itens de trabalho abertos por estágio</Text>
            <Svg source={stagesSvg(byStage)} alt={STAGES.filter(s => byStage[s]).map(s => `${s}: ${byStage[s]}`).join(', ')} width={svgW(480)} height={10} />
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              {STAGES.filter(s => byStage[s]).map(s => (
                <Button key={`stage-${s}`} plain onPress={() => setView($, { tab: 'trabalho', workMode: 'estagio', stage: s })}>
                  <Text color={STAGE_COLOR[s]}>●</Text> {s} <Text dimColor>{byStage[s]}</Text>
                </Button>
              ))}
            </Box>
          </Box>
        )}
        <Box flexDirection="row" alignItems="center" gap="sm" flexWrap="wrap">
          <Text size="caption" dimColor>Latência do núcleo</Text>
          <Svg source={sparkSvg(r.latencies)} alt={`Latência média ${avgMs} ms`} width={svgW(160)} height={20} />
          <Text size="caption" tabular>{avgMs} ms</Text>
        </Box>
        <Markdown dimColor text={`**Projetos mais usados:** ${f.topProjects.map(p => `${p.project} (${p.sessions})`).join(', ')}`} />
      </Box>
    )

    // Sessões: filtro por estado, busca por projeto, lista e detalhe.
    const rows = f.recent
      .filter(s => v.filter === 'todas' || s.state === v.filter)
      .filter(s => !v.query || s.project.toLowerCase().includes(v.query.toLowerCase()))
    const sel = f.recent.find(s => s.id === v.selected) ?? null
    const sessoes = (
      <Box flexDirection="column" gap="md">
        <Box flexDirection={narrow ? 'column' : 'row'} gap="sm" alignItems={narrow ? 'stretch' : 'flex-end'} flexWrap="wrap">
          <Select
            key="filtro"
            label="Estado"
            value={v.filter}
            options={[
              { value: 'todas', label: 'Todas' },
              { value: 'ativa', label: 'Ativas' },
              { value: 'ociosa', label: 'Ociosas' },
              { value: 'encerrada', label: 'Encerradas' },
            ]}
            onSelect={(value: string) => setView($, { filter: value as View['filter'] })}
          />
          <Input key="busca" label="Projeto" placeholder="filtrar por nome" value={v.query} submitLabel="Filtrar" onInput={(value: string) => setView($, { query: value })} onSubmit={(value: string) => setView($, { query: value })} />
        </Box>
        <Box flexDirection="column">
          <Text size="footnote" weight="semibold">Sessões recentes ({rows.length})</Text>
          {rows.length === 0 && <Text dimColor>Nenhuma sessão com esse filtro.</Text>}
          {rows.map(s => (
            <Button key={s.id} plain onPress={() => setView($, { selected: v.selected === s.id ? null : s.id })}>
              <Text color={STATE_COLOR[s.state]}>●</Text> <Text wrap="truncate-end">{s.project}</Text> <Text dimColor>{narrow ? ago(s.lastActivity) : `${s.state} · ${ago(s.lastActivity)}`}</Text>
            </Button>
          ))}
        </Box>
        {sel && (
          <Box flexDirection="column" gap="xs" borderStyle="round" borderColor={PINK} padding="sm">
            <Text weight="semibold" color={PINK}>{sel.project}</Text>
            <Code language="json" source={JSON.stringify(sel, null, 2)} />
            <Button key="close-session" label="Fechar detalhe" role="dismiss" onPress={() => setView($, { selected: null })} />
          </Box>
        )}
      </Box>
    )

    // Quadro em raias, o mesmo para o Kanban do Project e para o fluxo do Trabalho.
    // Responsivo: com o painel largo, as raias lado a lado, quebrando linha se não couberem
    // (nunca estoura a largura); estreito, as raias empilhadas, cada uma com os cards embaixo.
    // Cada raia mostra os primeiros cards e abre por inteiro no "+N mais".
    type BoardLane = { id: string; label: string; color: string; cards: RenderElement[] }
    const wide = (e.props.bodyColumns ?? 0) >= KANBAN_WIDE_COLUMNS
    const laneHeader = (l: BoardLane) => (
      <Box flexDirection="row" gap="xs" borderStyle="round" borderColor={l.color} paddingX="xs">
        <Text size="footnote" weight="bold" color={l.color} wrap="truncate-end">{l.label}</Text>
        <Text size="footnote" tabular dimColor>{l.cards.length}</Text>
      </Box>
    )
    const laneFooter = (l: BoardLane) => {
      const full = v.fullLanes.includes(l.id)
      if (l.cards.length === 0) return <Text size="caption" dimColor>vazio</Text>
      if (l.cards.length <= LANE_LIMIT) return null
      return (
        <Button key={`more-${l.id}`} plain onPress={() => setView($, { fullLanes: full ? v.fullLanes.filter(x => x !== l.id) : [...v.fullLanes, l.id] })}>
          <Text size="caption" dimColor>{full ? '▴ mostrar menos' : `+${l.cards.length - LANE_LIMIT} mais`}</Text>
        </Button>
      )
    }
    const visible = (l: BoardLane) => (v.fullLanes.includes(l.id) ? l.cards : l.cards.slice(0, LANE_LIMIT))
    const laneBoard = (prefix: string, lanes: BoardLane[]) =>
      wide ? (
        <Box key={`${prefix}-wide`} flexDirection="row" gap="xs" alignItems="flex-start" flexWrap="wrap">
          {lanes.map(l => (
            <Box key={`lane-${l.id}`} flexDirection="column" gap="xs" width={CARD_W} flexShrink={0}>
              {laneHeader(l)}
              {visible(l)}
              {laneFooter(l)}
            </Box>
          ))}
        </Box>
      ) : (
        <Box key={`${prefix}-narrow`} flexDirection="column" gap="md">
          {lanes.map(l => (
            <Box key={`lane-${l.id}`} flexDirection="column" gap="xs" minWidth={0} overflow="hidden">
              {laneHeader(l)}
              <Box flexDirection="row" gap="xs" flexWrap="wrap">{visible(l)}</Box>
              {laneFooter(l)}
            </Box>
          ))}
        </Box>
      )

    // Fluxo do Trabalho: as folhas da hierarquia (o que de fato se executa) por estágio do PR.
    const fluxoBoard = laneBoard(
      'fluxo',
      LANES.map(l => ({
        ...l,
        cards: nodes.filter(n => !n.children.length && matches(n) && l.stages.includes(n.stage)).map(n => <Box key={`slot-${n.key}`} flexShrink={0}>{card(n, 0)}</Box>),
      })),
    )

    // Kanban do GitHub Project: raias na ordem das opções do Status, e cada card com ◂ ▸
    // para ir à raia vizinha, o que muda o Status no GitHub. Mesmo tamanho dos outros cards.
    const k = r.kanban
    const options = k ? k.lanes.filter((l): l is KanbanLane & { id: string } => l.id !== null) : []
    const laneColor = (l: KanbanLane) => (l.color && GH_COLOR[l.color]) || MUTED
    const kanbanCard = (c: KanbanCard, lane: KanbanLane) => {
      const ts = KIND_STYLE[c.kind] ?? typeStyle(c.type)
      const at = options.findIndex(o => o.id === lane.id)
      const prev = at > 0 ? options[at - 1] : undefined
      const next = at < 0 ? options[0] : options[at + 1]
      const moving = r.moving === c.itemId
      const parent = c.parent?.split('#')[1]
      return (
        <Box key={`card-${c.itemId}`} flexDirection="column" width={CARD_W} height={CARD_H} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={ts.color} paddingX="xs">
          <Box flexDirection="row" gap="xs" overflow="hidden">
            <Text size="caption" weight="bold" color={ts.color}>{ts.label}</Text>
            <Text size="caption" weight="semibold" color={laneColor(lane)} wrap="truncate-end">· {lane.name}</Text>
            {c.number !== null && <Text size="caption" dimColor>· #{c.number}</Text>}
          </Box>
          <Text size="footnote" weight="semibold" wrap="truncate-end">{c.title}</Text>
          <Box flexDirection="row" gap="xs" overflow="hidden">
            {parent && <Text size="caption" dimColor>↑ #{parent}</Text>}
            {c.state === 'CLOSED' && <Text size="caption" weight="bold" color={MUTED}>fechada</Text>}
            {c.state === 'MERGED' && <Text size="caption" weight="bold" color={GREEN}>mergeado</Text>}
            {c.updatedAt && <Text size="caption" dimColor>{ago(c.updatedAt)}</Text>}
          </Box>
          <Box flexDirection="row" gap="xs" overflow="hidden">
            {moving && <Text size="caption" color={YELLOW}>movendo…</Text>}
            {!moving && prev && (
              <Button key={`move-prev-${c.itemId}`} plain onPress={() => moveCard($, c.itemId, prev.id)}>
                <Text color={laneColor(prev)}>◂</Text> {short(prev.name, 9)}
              </Button>
            )}
            {!moving && next && (
              <Button key={`move-next-${c.itemId}`} plain onPress={() => moveCard($, c.itemId, next.id)}>
                {short(next.name, 9)} <Text color={laneColor(next)}>▸</Text>
              </Button>
            )}
            {c.url && <Link href={c.url} label="Abrir" />}
          </Box>
        </Box>
      )
    }
    const kanbanMatches = (c: KanbanCard) =>
      !v.issueQuery || `${c.repo ?? ''} ${c.number ?? ''} ${c.title}`.toLowerCase().includes(v.issueQuery.toLowerCase())
    const kanbanBoard =
      k &&
      laneBoard(
        'kanban',
        k.lanes.map(l => ({
          id: l.id ?? 'sem-status',
          label: l.name,
          color: laneColor(l),
          cards: l.items.filter(kanbanMatches).map(c => kanbanCard(c, l)),
        })),
      )

    // Trabalho: a hierarquia do GitHub em cards, como árvore ou agrupada por estágio.
    const orgs = [...new Set(nodes.map(n => n.repo.split('/')[0] ?? ''))].sort()
    const roots = (w?.roots ?? []).filter(k => w && matches(w.nodes[k] as WorkNode))
    const withChildren = roots.filter(k => (w?.nodes[k]?.children.length ?? 0) > 0)
    const loose = roots.filter(k => (w?.nodes[k]?.children.length ?? 0) === 0)
    const stageCards = openLeafs.filter(matches).filter(n => v.stage === 'todas' || n.stage === v.stage)
    const trabalho = (
      <Box flexDirection="column" gap="md">
        {r.workError && <Text size="caption" color={w ? YELLOW : PINK}>{w ? `⚠ ${r.workError}` : `Não deu para ler o GitHub: ${r.workError}`}</Text>}
        {!w && !r.workError && <Text dimColor>Lendo a hierarquia do GitHub…</Text>}
        {w && (
          <Box flexDirection="column" gap="md">
            <Text size="caption" dimColor>
              {w.count} issues ligadas ao seu trabalho · {Object.entries(w.byType).map(([t, n]) => `${typeStyle(t === 'Sem tipo' ? null : t).label} ${n}`).join(' · ')} · lido há {ago(w.generatedAt)}
            </Text>
            <Box flexDirection={narrow ? 'column' : 'row'} gap="sm" alignItems={narrow ? 'stretch' : 'flex-end'} flexWrap="wrap">
              <Select
                key="modo"
                label="Ver como"
                value={v.workMode}
                options={[
                  { value: 'arvore', label: 'Árvore' },
                  { value: 'estagio', label: 'Por estágio' },
                  { value: 'kanban', label: 'Kanban' },
                ]}
                onSelect={(value: string) => setView($, { workMode: value as View['workMode'] })}
              />
              <Select
                key="org"
                label="Organização"
                value={v.org}
                options={[{ value: 'todas', label: 'Todas' }, ...orgs.map(o => ({ value: o, label: o }))]}
                onSelect={(value: string) => setView($, { org: value })}
              />
              {v.workMode === 'estagio' && (
                <Select
                  key="stage"
                  label="Estágio"
                  value={v.stage}
                  options={[{ value: 'todas', label: 'Todos' }, ...STAGES.map(s => ({ value: s, label: `${s} (${byStage[s] ?? 0})` }))]}
                  onSelect={(value: string) => setView($, { stage: value })}
                />
              )}
              <Input key="busca-issue" label="Busca" placeholder="título ou repositório" value={v.issueQuery} submitLabel="Buscar" onInput={(value: string) => setView($, { issueQuery: value })} onSubmit={(value: string) => setView($, { issueQuery: value })} />
            </Box>
            {v.workMode === 'arvore' && (
              <Box flexDirection="column" gap="sm">
                <Box flexDirection="row" gap="sm" flexWrap="wrap">
                  <Button key="expand-all" plain onPress={() => setView($, { expanded: nodes.filter(n => n.children.length).map(n => n.key) })}>▾ Expandir tudo</Button>
                  <Button key="collapse-all" plain onPress={() => setView($, { expanded: [] })}>▸ Recolher tudo</Button>
                </Box>
                {withChildren.length === 0 && loose.length === 0 && <Text dimColor>Nada com esses filtros.</Text>}
                {withChildren.flatMap(k => tree(k, 0))}
                {loose.length > 0 && <Text size="footnote" weight="semibold">Fora de uma iniciativa ({loose.length})</Text>}
                <Box flexDirection="row" gap="xs" flexWrap="wrap">{loose.slice(0, 15).map(k => card(w.nodes[k] as WorkNode, 0))}</Box>
              </Box>
            )}
            {v.workMode === 'kanban' && fluxoBoard}
            {v.workMode === 'estagio' && (
              <Box flexDirection="column" gap="sm">
                {STAGES.filter(s => stageCards.some(n => n.stage === s)).map(s => (
                  <Box key={`grp-${s}`} flexDirection="column" gap="xs">
                    <Text size="footnote" weight="semibold" color={STAGE_COLOR[s]}>● {s} ({stageCards.filter(n => n.stage === s).length})</Text>
                    <Box flexDirection="row" gap="xs" flexWrap="wrap">{stageCards.filter(n => n.stage === s).slice(0, 12).map(n => card(n, 0))}</Box>
                  </Box>
                ))}
                {stageCards.length === 0 && <Text dimColor>Nada com esses filtros.</Text>}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap="md" padding="sm" minWidth={0} overflow="hidden">
        {header}
        {v.tab === 'visao' && visao}
        {v.tab === 'sessoes' && sessoes}
        {v.tab === 'kanban' && (
          <Box flexDirection="column" gap="md">
            {r.kanbanError && <Text size="caption" color={k ? YELLOW : PINK}>{k ? `⚠ ${r.kanbanError}` : `Não deu para ler o GitHub Project: ${r.kanbanError}`}</Text>}
            {!k && !r.kanbanError && <Text dimColor>Lendo o GitHub Project…</Text>}
            {k && (
              <Box flexDirection="row" gap="xs" flexWrap="wrap" alignItems="center">
                <Text size="footnote" weight="semibold" wrap="truncate-end">{k.title}</Text>
                <Text size="caption" dimColor>· {k.count} itens por {k.field} · lido há {ago(new Date(k.fetchedAt).toISOString())}</Text>
                <Link href={k.url} label="Abrir no GitHub" />
              </Box>
            )}
            {k && (
              <Input key="busca-kanban" label="Busca" placeholder="título ou número" value={v.issueQuery} submitLabel="Buscar" onInput={(value: string) => setView($, { issueQuery: value })} onSubmit={(value: string) => setView($, { issueQuery: value })} />
            )}
            {kanbanBoard}
          </Box>
        )}
        {v.tab === 'trabalho' && trabalho}
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          <Button key="refresh" label="Atualizar agora" variant="primary" onPress={() => Promise.all([pollFleet($), pollWork($), pollKanban($, true)])} />
          <Button
            key="clear"
            label="Limpar filtros"
            variant="secondary"
            onPress={() => setView($, { filter: 'todas', query: '', stage: 'todas', org: 'todas', issueQuery: '' })}
          />
        </Box>
      </Box>
    )
  })
}
