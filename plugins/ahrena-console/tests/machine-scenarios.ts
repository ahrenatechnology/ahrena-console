// #262 (P15, P16): synthetic answers of `GET /api/panel?needYou=<scope>` with a remote machine, as in
// the wireframes (docs/wireframes, `panelMachines`): three sessions of this Mac, two of the
// "Workstation", accounts "pessoal" and "empresa". Every name is made up.
import type { NeedsYou, NeedYouMachine, Panel, PanelAccount } from '../types'
import { NOW, SCENARIOS } from './scenarios'

export const REMOTE = { id: 'workstation', label: 'Workstation' } as const
const PERSONAL: PanelAccount = { id: 'acc-personal', label: 'pessoal', color: '#df285d', source: 'env' }
const COMPANY: PanelAccount = { id: `remote:${REMOTE.id}:empresa`, label: 'empresa', color: '#1baf7a', source: 'config' }

/** The hour the Workstation went down, 22:41 in the viewer's time zone. */
export const DOWN_SINCE = (() => {
  const d = new Date(NOW)
  d.setHours(22, 41, 0, 0)
  return d.toISOString()
})()

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

function item(id: string, title: string, minutes: number, extra: Partial<NeedsYou>): NeedsYou {
  return {
    id: `sim-p15-${id}`,
    level: 'needs',
    why: 'decision',
    local: null,
    title,
    state: 'waiting',
    reason: 'notification',
    urgent: false,
    since: minutesAgo(minutes),
    text: 'Abro o PR agora ou espero o review?',
    model: 'claude-opus-5-5',
    relation: null,
    sameProject: false,
    account: PERSONAL,
    machine: null,
    ...extra,
  }
}

export const LOCAL_ITEMS: NeedsYou[] = [
  item('notes-cli', 'cli-de-notas', 9, { why: 'decision', model: 'claude-sonnet-5-5' }),
  item('sample-calendar', 'agenda-ficticia', 7, { why: 'plan', text: 'Plano de 5 passos espera aprovação' }),
  item('sample-catalog', 'catalogo-exemplo', 4, { why: 'question', relation: 'child', text: 'Redis ou cache em memória? · 2 opções', account: COMPANY }),
]
export const REMOTE_ITEMS: NeedsYou[] = [
  item('metrics-dashboard', 'painel-de-metricas', 3, { why: 'error', state: 'error', reason: null, text: 'API 529 · overloaded_error', machine: { ...REMOTE } }),
  item('rules-engine', 'motor-de-regras', 2, { why: 'permission', text: 'Bash: npm run migrate', machine: { ...REMOTE } }),
]
/** An idle session of this Mac: it goes to the separate "sua vez" group. */
export const IDLE_ITEM = item('task-queue', 'fila-de-tarefas', 1, { level: 'your-turn', why: 'your-turn', reason: 'stop', relation: 'parent', text: 'Terminei. Rodo os testes?' })

function machine(offline: boolean): NeedYouMachine {
  return {
    ...REMOTE,
    state: offline ? 'tunnel-down' : 'connected',
    reason: offline ? 'o túnel caiu' : null,
    lastReadAt: offline ? DOWN_SINCE : minutesAgo(0),
    connection: offline ? { state: 'down', since: DOWN_SINCE, lastError: { reason: 'sso-expired' } } : { state: 'up', since: minutesAgo(60), lastError: null },
    since: offline ? DOWN_SINCE : null,
  }
}

/**
 * The answer for a scope (P15; P16 with `offline`). Like the core, an unknown id answers `all`; the
 * items come in the order given by `shuffle` when set, to check the panel sorts them itself.
 */
export function machinesPanel(scope: string | null, opts: { offline?: boolean; withRemote?: boolean; shuffle?: boolean } = {}): Panel {
  const offline = opts.offline ?? false
  const withRemote = opts.withRemote ?? true
  const remote = withRemote && !offline ? REMOTE_ITEMS : []
  const known = ['family', 'all', 'local', ...(withRemote ? [REMOTE.id] : [])]
  const answered = scope === null ? null : known.includes(scope) ? scope : 'all'
  const family = [LOCAL_ITEMS[2]!, IDLE_ITEM]
  const local = [...LOCAL_ITEMS, IDLE_ITEM]
  const lists: Record<string, NeedsYou[]> = { family, local, all: [...LOCAL_ITEMS, ...remote, IDLE_ITEM], [REMOTE.id]: remote }
  const items = answered ? lists[answered]! : undefined
  const base = SCENARIOS.p1
  if (answered === null) return { ...base, needYou: { ...base.needYou, total: 3, yourTurn: 1, family, machine: local } }
  return {
    ...base,
    needYou: {
      total: 3 + remote.length,
      yourTurn: 1,
      byAccount: [
        { account: PERSONAL, n: 2 + remote.length },
        { account: COMPANY, n: 1 },
      ],
      family,
      machine: local,
      scope: answered,
      items: opts.shuffle ? [...items!].reverse() : items,
      byMachine: [{ id: 'local', label: 'Esta máquina', n: 3 }, ...(withRemote ? [{ ...REMOTE, n: remote.length }] : [])],
      machines: withRemote ? [machine(offline)] : [],
    },
  }
}
