// #262 (P15, P16): the pieces of the "Ver" list across machines, with the mod's native elements: the
// one Select (family and machines), the neutral line of a remote that is down and the console link of a
// remote card. The texts and the choices come from machines.ts; render.tsx places the pieces.

import type { RenderElement } from 'claude-code'

import type { NeedsYou, NeedYouMachine, NeedYouScope, Panel } from '../types'
import type { DrawContext } from './render'
import { paleta } from './brand'
import { offlineLineTexts, remoteSessionUrl, scopeOptions } from './machines'

const ORANGE = paleta.orange['500']
const BORDER = paleta.gray['500']
const CARD_BG = paleta.gray['800']

/** The link of P1 (`pn-link`): orange and underlined. */
function consoleLink(c: DrawContext, key: string, href: string, text: string) {
  const { Link, Text } = c.el
  return (
    <Link key={key} href={href}>
      <Text mono size="footnote" color={ORANGE} underline>
        {text}
      </Text>
    </Link>
  )
}

/** The one Select of P15: Família · Todas as máquinas · Esta máquina · one per remote. */
export function scopeSelect(c: DrawContext, p: Panel, scope: NeedYouScope): RenderElement {
  const { Select } = c.el
  return <Select key="scope" value={scope} options={scopeOptions(p)} onSelect={(v: string) => c.actions.scope(v)} />
}

/** In the narrow panel the Select goes on the line below the label: both do not fit 34 columns. */
export function scopeRow(c: DrawContext, select: RenderElement, width: number): RenderElement {
  const { Box } = c.el
  return (
    <Box key="scope-row" flexDirection="row" width={width}>
      {select}
    </Box>
  )
}

/**
 * P16: a remote that is down, in the neutral footer box (never P14's red band), above the cards, with
 * P14's link to the machine's screen in the console. No icon: the mod draws text.
 */
export function offlineLine(c: DrawContext, m: NeedYouMachine, width: number, wide: boolean, machineHref: string): RenderElement {
  const { Box, Text } = c.el
  const t = offlineLineTexts(m, wide)
  const resolve = consoleLink(c, `machine-resolve-${m.id}`, machineHref, 'resolver no console ›')
  if (wide) {
    return (
      <Box key={`machine-offline-${m.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} width={width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
        <Text mono wrap="truncate-end">
          {t.text}
        </Text>
        <Box flexShrink={0}>{resolve}</Box>
      </Box>
    )
  }
  return (
    <Box key={`machine-offline-${m.id}`} flexDirection="column" width={width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text mono wrap="truncate-end">
          {t.text}
        </Text>
        {t.time ? (
          <Box flexShrink={0}>
            <Text mono dimColor tabular>
              {t.time}
            </Text>
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="row">{resolve}</Box>
    </Box>
  )
}

/** A remote session opens its detail in the console: this Mac's Claude Desktop does not run it. */
export function remoteGo(c: DrawContext, i: NeedsYou): RenderElement {
  return consoleLink(c, `go-${i.id}`, remoteSessionUrl(c.core, i), 'abrir no console ›')
}
