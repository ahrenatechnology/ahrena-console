// Painel do Ahrena Console (teste): explora todos os elementos que a aba Code do
// Claude Desktop oferece a um mod: Box, Text, Button, Input, Select, Svg, Link,
// Code, Markdown e Client. Lê o núcleo local em http://127.0.0.1:4720/api/fleet.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Fleet, Reading, SessionRow, View } from '../types'

const PANE = 'ahrena-console'
const URL = 'http://127.0.0.1:4720/api/fleet'
const REPO = 'https://github.com/ahrenatechnology/ahrena-console'
const EVERY_MS = 5000

const ORANGE = '#f47720'
const PINK = '#df285d'
const MUTED = '#a6a6aa'
const STATE_COLOR: Record<SessionRow['state'], string> = { ativa: ORANGE, ociosa: '#ffc30a', encerrada: MUTED }

const reading = atom({ plugin: 'ahrena-console-painel', key: 'reading' } as const, {
  fleet: null,
  error: null,
  polls: 0,
  latencies: [],
} as Reading)
const view = atom({ plugin: 'ahrena-console-painel', key: 'view' } as const, {
  filter: 'todas',
  query: '',
  selected: null,
} as View)

let timer: { cancel: () => void } | undefined

async function poll($: Engine) {
  const t0 = await $.clock.now()
  try {
    const res = await $.http.fetch(URL)
    const ms = (await $.clock.now()) - t0
    const fleet = res.ok ? (JSON.parse(res.text) as Fleet) : null
    await update($, reading, r => ({
      fleet: fleet ?? r.fleet ?? null,
      error: res.ok ? null : `HTTP ${res.status}`,
      polls: (r.polls ?? 0) + 1,
      latencies: [...(r.latencies ?? []), ms].slice(-24),
    }))
    $.ui.status(fleet ? `ahrena-console ● ${fleet.totals.active} ativa · ${fleet.totals.idle} ociosa` : 'ahrena-console ○ erro')
  } catch (err) {
    await update($, reading, r => ({ fleet: r.fleet ?? null, latencies: r.latencies ?? [], error: String(err), polls: (r.polls ?? 0) + 1 }))
    $.ui.status('ahrena-console ○ offline')
  }
}

function start($: Engine) {
  timer?.cancel()
  void poll($)
  timer = $.clock.every(EVERY_MS, () => void poll($))
}

async function setView($: Engine, patch: Partial<View>) {
  await update($, view, v => ({ ...v, ...patch }))
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
      const color = i === values.length - 1 ? ORANGE : PINK
      return `<rect x="${i * 12 + 2}" y="${40 - h}" width="8" height="${h}" rx="2" fill="${color}"/>`
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
    const raw = await read($, reading)
    // Estado salvo por uma versão anterior do painel pode vir sem campos novos.
    const r: Reading = { fleet: raw?.fleet?.totals ? raw.fleet : null, error: raw?.error ?? null, polls: raw?.polls ?? 0, latencies: raw?.latencies ?? [] }
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
    const v: View = { filter: 'todas', query: '', selected: null, ...((await read($, view)) as Partial<View> | undefined) }
    const f = r.fleet

    if (!f) {
      return (
        <Box flexDirection="column" gap="sm" padding="sm">
          <Text size="heading" weight="semibold" color={ORANGE}>Ahrena Console</Text>
          <Text color={PINK}>Sem conexão com o núcleo: {r.error ?? 'aguardando a primeira leitura'}</Text>
          <Button key="retry" label="Tentar de novo" variant="primary" onPress={() => poll($)} />
        </Box>
      )
    }

    const rows = f.recent
      .filter(s => v.filter === 'todas' || s.state === v.filter)
      .filter(s => !v.query || s.project.toLowerCase().includes(v.query.toLowerCase()))
    const sel = f.recent.find(s => s.id === v.selected) ?? null
    const avgMs = r.latencies.length ? Math.round(r.latencies.reduce((a, b) => a + b, 0) / r.latencies.length) : 0

    return (
      <Box flexDirection="column" gap="md" padding="sm">
        {/* Cabeçalho: Svg (logo), Text (tamanhos e pesos) e Link */}
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Svg source={logoSvg()} alt="Ahrena Console" width={28} height={28} />
          <Box flexDirection="column" flexGrow={1}>
            <Text size="heading" weight="bold" color={ORANGE}>Ahrena Console</Text>
            <Text size="caption" dimColor>v0.0.1 · teste de componentes</Text>
          </Box>
          <Link href={REPO} label="GitHub" />
        </Box>

        {/* Client: pulso animado com timer próprio */}
        <Client key="pulso" module="./pulso.tsx" props={{ generatedAt: f.generatedAt }} />

        {/* Cards: Box com borda e cor de fundo, Text tabular */}
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          {[
            { k: 'Ativas', n: f.totals.active, c: ORANGE },
            { k: 'Ociosas', n: f.totals.idle, c: '#ffc30a' },
            { k: 'Sessões', n: f.totals.sessions, c: PINK },
            { k: 'Projetos', n: f.totals.projects, c: PINK },
          ].map(card => (
            <Box key={card.k} flexDirection="column" borderStyle="round" borderColor={card.c} paddingX="sm" minWidth={11}>
              <Text size="caption" dimColor>{card.k}</Text>
              <Text size="title" weight="bold" tabular color={card.c}>{card.n}</Text>
            </Box>
          ))}
        </Box>

        {/* Gráficos em Svg */}
        <Box flexDirection="column" gap="xs">
          <Text size="footnote" weight="semibold">Atividade nas últimas 12 h</Text>
          <Svg source={barsSvg(f.activityByHour)} alt={`Sessões com atividade por hora: ${f.activityByHour.join(', ')}`} width={260} height={46} />
        </Box>
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Text size="caption" dimColor>Latência do núcleo</Text>
          <Svg source={sparkSvg(r.latencies)} alt={`Latência média ${avgMs} ms`} width={120} height={20} />
          <Text size="caption" tabular>{avgMs} ms</Text>
        </Box>

        {/* Filtros: Select e Input */}
        <Box flexDirection="row" gap="sm" alignItems="flex-end" flexWrap="wrap">
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
            onSelect={(value: string) => void setView($, { filter: value as View['filter'] })}
          />
          <Input
            key="busca"
            label="Projeto"
            placeholder="filtrar por nome"
            value={v.query}
            submitLabel="Filtrar"
            onInput={(value: string) => void setView($, { query: value })}
            onSubmit={(value: string) => void setView($, { query: value })}
          />
        </Box>

        {/* Lista: Buttons planos com Text colorido dentro */}
        <Box flexDirection="column">
          <Text size="footnote" weight="semibold">Sessões recentes ({rows.length})</Text>
          {rows.length === 0 && <Text dimColor>Nenhuma sessão com esse filtro.</Text>}
          {rows.map(s => (
            <Button key={s.id} plain onPress={() => void setView($, { selected: v.selected === s.id ? null : s.id })}>
              <Text color={STATE_COLOR[s.state]}>●</Text> {s.project} <Text dimColor>{s.state} · {ago(s.lastActivity)}</Text>
            </Button>
          ))}
        </Box>

        {/* Detalhe: Code (JSON) e Markdown */}
        {sel && (
          <Box flexDirection="column" gap="xs" borderStyle="round" borderColor={PINK} padding="sm">
            <Text weight="semibold" color={PINK}>{sel.project}</Text>
            <Code language="json" source={JSON.stringify(sel, null, 2)} />
            <Button label="Fechar detalhe" role="dismiss" onPress={() => void setView($, { selected: null })} />
          </Box>
        )}

        <Markdown
          dimColor
          text={`**Projetos mais usados:** ${f.topProjects.map(p => `${p.project} (${p.sessions})`).join(', ')}\n\nOs resultados das validações estão em [docs/validacoes-0.0.1.md](${REPO}/blob/main/docs/validacoes-0.0.1.md). Leituras: ${r.polls}, a cada ${EVERY_MS / 1000} s.`}
        />

        {/* Ações: Button primário e secundário */}
        <Box flexDirection="row" gap="sm">
          <Button label="Atualizar agora" variant="primary" onPress={() => void poll($)} />
          <Button label="Limpar filtros" variant="secondary" onPress={() => void setView($, { filter: 'todas', query: '' })} />
        </Box>
      </Box>
    )
  })
}
