// #262 (P15, P16): the "Ver" list across machines. The core of this Mac joins the machines (the #243
// route) and answers the list for the scope the panel asks (`needYou=<scope>` on every tick); this
// module only reads that answer: the scope and its Select, the list, the line of a remote that is down,
// the by-machine split of the tooltip and the console links. Pure functions, no drawing.

import type { NeedsYou, NeedYouMachine, NeedYouScope, Panel, View } from '../types'
import { clockTime, machineIsDown } from './format'
import { LEGACY_PORT } from './discover'

/** The scope values the core accepts (its `PARAM`): anything else is not sent. */
const SCOPE_ID = /^[A-Za-z0-9_.[\]-]{1,64}$/

/** The core answers the list across machines (`needYou.items`); an older one does not (P7 as before). */
export const hasMachineList = (p: Panel | null | undefined): boolean => Array.isArray(p?.needYou?.items)

/**
 * A scope saved by any version of the panel: the old `machine` ("Máquina inteira") is now `all`;
 * a value the core would refuse is dropped (the width's default applies).
 */
export function normalizeScope(v: unknown): NeedYouScope | null {
  if (v === 'machine') return 'all'
  return typeof v === 'string' && SCOPE_ID.test(v) ? v : null
}

/** The width's default: the family in the narrow panel (every machine when the family is empty), every machine in the wide one. */
export function defaultScope(narrow: boolean, p: Panel | null | undefined): NeedYouScope {
  if (!narrow) return 'all'
  return p && p.needYou.family.length === 0 ? 'all' : 'family'
}

/** The scope the list shows: the person's choice, or the width's default. */
export const scopeOf = (view: Pick<View, 'scope'>, narrow: boolean, p: Panel | null | undefined): NeedYouScope => view.scope ?? defaultScope(narrow, p)

/** The remote machines of the answer (empty from an older core or without remotes). */
export const remoteMachines = (p: Panel | null | undefined): NeedYouMachine[] => p?.needYou?.machines ?? []

/** The Select: Família · Todas as máquinas · Esta máquina · one per remote, "<label> · sem conexão" when it is down. */
export function scopeOptions(p: Panel): { value: string; label: string }[] {
  return [
    { value: 'family', label: 'Família' },
    { value: 'all', label: 'Todas as máquinas' },
    { value: 'local', label: 'Esta máquina' },
    ...remoteMachines(p).map((m) => ({ value: m.id, label: machineIsDown(m) ? `${m.label} · sem conexão` : m.label })),
  ]
}

/** Oldest `since` first; a stable sort, so the core's order holds between equal times. */
export function oldestFirst(items: NeedsYou[]): NeedsYou[] {
  const at = (i: NeedsYou) => {
    const t = Date.parse(i.since)
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
  }
  return items
    .map((i, n) => ({ i, n }))
    .sort((a, b) => at(a.i) - at(b.i) || a.n - b.n)
    .map((x) => x.i)
}

/**
 * The list for a scope. The answer is for the scope asked; right after the Select changes (before the
 * next answer) it may be for another one: then the closest list the answer has.
 */
export function scopeList(p: Panel, scope: NeedYouScope): NeedsYou[] {
  const n = p.needYou
  if (n.scope === scope && n.items) return oldestFirst(n.items)
  if (scope === 'family') return oldestFirst(n.family)
  if (scope === 'local') return oldestFirst(n.machine)
  if (scope === 'all') return oldestFirst(n.items ?? n.machine)
  return oldestFirst((n.items ?? []).filter((i) => i.machine?.id === scope))
}

/**
 * The scope's counts for the header, SUA VEZ and the "+N" line: the core's, before its cap of the list
 * (`itemsTotal`, `itemsNeeds`, `itemsYourTurn`); `own`, the list's, from a core without them or while
 * the answer is for another scope (right after the Select changes). Never below the list's own.
 */
export function scopeCounts(p: Panel, scope: NeedYouScope, own: { needs: number; yourTurn: number }): { needs: number; yourTurn: number; total: number } {
  const n = p.needYou
  if (n.scope !== scope || !n.items) return { ...own, total: own.needs + own.yourTurn }
  const count = (v: unknown, min: number) => (Number.isInteger(v) && (v as number) >= min ? (v as number) : min)
  const needs = count(n.itemsNeeds, own.needs)
  const yourTurn = count(n.itemsYourTurn, own.yourTurn)
  return { needs, yourTurn, total: count(n.itemsTotal, needs + yourTurn) }
}

/** The remotes that are down in a scope: every one under "Todas as máquinas", the chosen one alone. */
export function downInScope(p: Panel, scope: NeedYouScope): NeedYouMachine[] {
  const down = remoteMachines(p).filter(machineIsDown)
  if (scope === 'all') return down
  return down.filter((m) => m.id === scope)
}

/** "22:41": when the remote went down (or its last reading); `null` without either. */
export function downSince(m: Pick<NeedYouMachine, 'since' | 'lastReadAt'>): string | null {
  for (const iso of [m.since, m.lastReadAt]) {
    const t = iso ? Date.parse(iso) : Number.NaN
    if (Number.isFinite(t)) return clockTime(t)
  }
  return null
}

/**
 * The neutral line of P16. Wide, one sentence: "Workstation sem conexão desde 22:41 · as sessões de lá
 * voltam sozinhas". Narrow, "Workstation sem conexão" with the time apart, in the right column.
 */
export function offlineLineTexts(m: NeedYouMachine, wide: boolean): { text: string; time: string | null } {
  const time = downSince(m)
  if (wide) return { text: `${m.label} sem conexão${time ? ` desde ${time}` : ''} · as sessões de lá voltam sozinhas`, time: null }
  return { text: `${m.label} sem conexão`, time }
}

/** The empty list, in words; `null` when a down remote is chosen (its neutral line says it). */
export function emptyText(p: Panel, scope: NeedYouScope): string | null {
  if (scope === 'family') return 'ninguém da família precisa de você agora'
  if (scope === 'all') return 'ninguém precisa de você agora'
  if (scope === 'local') return 'ninguém nesta máquina precisa de você agora'
  const m = remoteMachines(p).find((x) => x.id === scope)
  if (m && machineIsDown(m)) return null
  return `ninguém na ${m?.label ?? 'máquina'} precisa de você agora`
}

/** The footer of the list: oldest first; in the wide panel, that the machines are one list. */
export const listFooter = (wide: boolean) => `mais antigas primeiro${wide ? ' · as máquinas numa lista só · as ociosas ficam em "na sua vez"' : ''}`

/**
 * The tooltip of "N precisam de você": the by-machine split, then the by-account one. Narrow, two lines
 * ("máquina: esta 3 · Workstation 2" / "conta: pessoal 4 · empresa 1"), with a line of its own for each
 * remote that is down; wide, one line. Without remote machines, today's line ("por conta: …").
 */
export function needYouTooltip(p: Panel, narrow: boolean, accounts: string): string[] {
  const machines = remoteMachines(p)
  const counts = p.needYou.byMachine ?? []
  if (!machines.length) return [`por conta: ${accounts}`]
  const up: string[] = []
  const down: string[] = []
  for (const b of counts) {
    if (b.id === 'local') {
      up.push(`${narrow ? 'esta' : b.label || 'Esta máquina'} ${b.n}`)
      continue
    }
    const m = machines.find((x) => x.id === b.id)
    if (m && machineIsDown(m)) {
      const time = downSince(m)
      down.push(narrow ? `${m.label} sem conexão${time ? ` · ${time}` : ''}` : `${m.label} sem conexão${time ? ` desde ${time}` : ''}`)
    } else up.push(`${m?.label ?? b.label} ${b.n}`)
  }
  if (narrow) return [`máquina: ${up.join(' · ')}`, ...down, `conta: ${accounts}`]
  return [`por máquina: ${[...up, ...down].join(' · ')} · por conta: ${accounts}`]
}

/** The console's detail of a remote session, on the core the panel reads (`Link` only takes `http://localhost`). */
export function remoteSessionUrl(core: string, i: Pick<NeedsYou, 'id' | 'machine'>): string {
  const port = core.split(':')[1] ?? String(LEGACY_PORT)
  return `http://localhost:${port}/ui/sessions/${encodeURIComponent(i.id)}?machine=${encodeURIComponent(i.machine!.id)}`
}

/** The scope to keep after an answer: the core's, when it answered another one (a remote no longer in machines.json). */
export function scopeAfterAnswer(asked: NeedYouScope | null, p: Panel): NeedYouScope | null {
  const answered = p.needYou.scope
  if (asked === null || !answered || answered === asked) return null
  return normalizeScope(answered)
}
