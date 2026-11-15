// Valida docs/brand/tokens.json: cores obrigatórias, contraste AA nos dois temas e os 5 status.
// Roda com: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const tokens = JSON.parse(readFileSync(new URL('../docs/brand/tokens.json', import.meta.url), 'utf8'))

const STATUS = ['active', 'waiting', 'completed', 'error', 'abandoned']
const THEMES = ['dark', 'light']
const AA_TEXT = 4.5 // WCAG 1.4.3
const AA_NON_TEXT = 3 // WCAG 1.4.11

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Matiz em LCh (Lab D65), em graus.
function lab(hex) {
  const lin = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  const [r, g, b] = lin
  const xyz = [
    (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047,
    0.2126 * r + 0.7152 * g + 0.0722 * b,
    (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883,
  ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116))
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])]
}
function hue(hex) {
  const [, a, b] = lab(hex)
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
}
const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b)) % 360
  return Math.min(d, 360 - d)
}

const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v)

function assertContrast(fg, bg, min, what) {
  const ratio = contrast(fg, bg)
  assert.ok(ratio >= min, `${what}: ${fg} sobre ${bg} tem ${ratio.toFixed(2)}:1, precisa de ${min}:1`)
}

test('cores obrigatórias da marca e do CI estão presentes e intactas', () => {
  assert.equal(tokens.orange['500'], '#f47720', 'o laranja não muda')
  assert.equal(tokens.rose['500'], '#df285d', 'o rosa substituiu o roxo')
  assert.deepEqual(tokens.ci, { success: '#d7d7d9', failure: '#e34948', pending: '#ffc30a' })
  for (const theme of THEMES) {
    assert.equal(tokens.themes[theme].accent, '#f47720', `o destaque do tema ${theme} é o laranja`)
    assert.equal(tokens.themes[theme].rose, '#df285d', `o rosa do tema ${theme}`)
  }
})

test('os dois temas têm os mesmos papéis, todos em hex', () => {
  const roles = Object.keys(tokens.themes.dark).filter((k) => !k.startsWith('_')).sort()
  assert.deepEqual(Object.keys(tokens.themes.light).filter((k) => !k.startsWith('_')).sort(), roles)
  for (const theme of THEMES) for (const role of roles) assert.ok(isHex(tokens.themes[theme][role]), `${theme}.${role}`)
})

test('texto dos temas passa AA sobre fundo, cartão e realce', () => {
  for (const theme of THEMES) {
    const t = tokens.themes[theme]
    for (const fg of ['text', 'muted', 'accentText']) {
      for (const bg of ['bg', 'surface', 'raised']) assertContrast(t[fg], t[bg], AA_TEXT, `${theme}.${fg} em ${bg}`)
    }
    assertContrast(t.onAccent, t.accent, AA_TEXT, `${theme}.onAccent sobre o laranja`)
  }
})

test('os 5 status existem, na ordem, com rótulo, glifo e motivo', () => {
  assert.deepEqual(tokens.status._ordem, STATUS)
  assert.deepEqual(Object.keys(tokens.status).filter((k) => !k.startsWith('_')), STATUS)
  for (const id of STATUS) {
    const s = tokens.status[id]
    assert.ok(s.label?.trim(), `${id} sem rótulo`)
    assert.ok(s.glyph?.trim(), `${id} sem glifo`)
    assert.ok(s.motivo?.length > 40, `${id} sem motivo`)
    assert.ok(isHex(s.color), `${id} sem cor`)
  }
  const unique = (key) => new Set(STATUS.map((id) => tokens.status[id][key])).size
  assert.equal(unique('color'), 5, 'cada status tem uma cor')
  assert.equal(unique('glyph'), 5, 'cada status tem um glifo')
  assert.equal(unique('label'), 5, 'cada status tem um rótulo')
})

test('status seguem as cores do CI e o laranja', () => {
  assert.equal(tokens.status.active.color, tokens.orange['500'])
  assert.equal(tokens.status.waiting.color, tokens.ci.pending)
  assert.equal(tokens.status.completed.color, tokens.ci.success)
  assert.equal(tokens.status.error.color, tokens.ci.failure)
})

test('rótulos e pontos dos status passam AA nos dois temas', () => {
  for (const theme of THEMES) {
    const t = tokens.themes[theme]
    for (const id of STATUS) {
      const s = tokens.status[id][theme]
      for (const bg of ['bg', 'surface', 'raised']) {
        assertContrast(s.text, t[bg], AA_TEXT, `${id}.${theme}.text em ${bg}`)
        assertContrast(s.dot, t[bg], AA_NON_TEXT, `${id}.${theme}.dot em ${bg}`)
      }
      assertContrast(s.text, s.badge, AA_TEXT, `${id}.${theme}.text na pílula`)
    }
  }
})

test('a pílula é a cor canônica, na opacidade de _badgeAlpha, sobre o cartão', () => {
  const alpha = tokens.status._badgeAlpha
  for (const theme of THEMES) {
    const surface = rgb(tokens.themes[theme].surface)
    for (const id of STATUS) {
      const expected = rgb(tokens.status[id].color).map((v, i) => v * alpha + surface[i] * (1 - alpha))
      const actual = rgb(tokens.status[id][theme].badge)
      actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= 1, `${id}.${theme}.badge`))
    }
  }
})

test('o erro não se confunde com o rosa da marca', () => {
  const rose = tokens.rose['500']
  const error = tokens.status.error.color
  // O #db6286 provisório ficava a 10° do rosa: lia como um rosa mais claro.
  // O erro tem de ficar no vermelho, entre o rosa e o laranja, longe dos dois.
  assert.ok(hueGap(error, rose) >= 15, `erro a ${hueGap(error, rose).toFixed(0)}° do rosa`)
  assert.ok(hueGap(error, tokens.orange['500']) >= 20, `erro a ${hueGap(error, tokens.orange['500']).toFixed(0)}° do laranja`)
  for (const id of STATUS) {
    for (const theme of THEMES) {
      assert.notEqual(tokens.status[id][theme].dot, rose, `${id} não pode usar o rosa`)
      assert.notEqual(tokens.status[id][theme].text, rose, `${id} não pode usar o rosa`)
    }
  }
})

test('tipografia: Poppins e JetBrains Mono, com fallback do sistema', () => {
  assert.match(tokens.typography.sans, /^"Poppins"/)
  assert.match(tokens.typography.sans, /sans-serif$/)
  assert.match(tokens.typography.mono, /^"JetBrains Mono"/)
  assert.match(tokens.typography.mono, /monospace$/)
})

test('a amostra usa os mesmos valores dos tokens', () => {
  const html = readFileSync(new URL('../docs/brand/amostra.html', import.meta.url), 'utf8')
  const used = []
  for (const theme of THEMES) {
    used.push(...Object.entries(tokens.themes[theme]).filter(([k]) => !k.startsWith('_')).map(([, v]) => v))
    for (const id of STATUS) used.push(...Object.values(tokens.status[id][theme]))
  }
  for (const id of STATUS) used.push(tokens.status[id].color, tokens.status[id].label, tokens.status[id].glyph)
  for (const value of new Set(used)) assert.ok(html.includes(value), `a amostra não tem ${value}`)
})

// #665: each colour has a value in both themes and the spacing scale is compact
const roleKeys = (theme) => Object.keys(theme).filter((k) => !k.startsWith('_')).sort()

test('dark and light have identical colour keys, each a hex, and nothing is left to one theme', () => {
  const dark = roleKeys(tokens.themes.dark)
  assert.deepEqual(roleKeys(tokens.themes.light), dark)
  assert.deepEqual(Object.keys(tokens.themes).sort(), ['dark', 'light'])
  assert.ok(dark.length >= 10)
  for (const theme of THEMES) for (const role of dark) assert.ok(isHex(tokens.themes[theme][role]), `themes.${theme}.${role} is not a hex`)
})

test('each status has the same keys, all hex, in the dark and the light theme', () => {
  for (const id of STATUS) {
    const dark = roleKeys(tokens.status[id].dark)
    assert.deepEqual(dark, ['badge', 'dot', 'text'], `${id}.dark`)
    assert.deepEqual(roleKeys(tokens.status[id].light), dark, `${id}.light`)
    for (const theme of THEMES) for (const key of dark) assert.ok(isHex(tokens.status[id][theme][key]), `status.${id}.${theme}.${key} is not a hex`)
  }
})

test('the spacing scale is present, compact, in px and strictly ascending', () => {
  const names = Object.keys(tokens.spacing).filter((k) => !k.startsWith('_'))
  assert.deepEqual(names, ['xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl'])
  const px = names.map((n) => {
    assert.match(tokens.spacing[n], /^\d+px$/, `spacing.${n} is not px`)
    return parseInt(tokens.spacing[n], 10)
  })
  assert.deepEqual(px, [2, 4, 6, 8, 12, 16, 24])
  px.forEach((v, i) => i > 0 && assert.ok(v > px[i - 1], `spacing is not ascending at ${names[i]}`))
  assert.ok(px.at(-1) <= 24, 'the scale is dense: nothing above 24px')
})

// issue 700 (part of 698): success is neutral gray with the check glyph; green is history only.
test('#700/AC-3: completed and ci.success are gray-100 in the dark theme and gray-500 in the light one, with the check glyph', () => {
  const completed = tokens.status.completed
  assert.equal(completed.glyph, '\u2713')
  assert.equal(tokens.ci.success, tokens.gray['100'])
  assert.equal(completed.color, tokens.gray['100'])
  assert.equal(completed.dark.dot, tokens.gray['100'])
  assert.equal(completed.dark.text, tokens.gray['100'])
  assert.equal(completed.light.dot, tokens.gray['500'])
  assert.equal(completed.light.text, tokens.gray['500'])
})

test('#700/AC-3: completed is stronger than abandoned on every surface in both themes, and passes AA', () => {
  for (const theme of THEMES) {
    const t = tokens.themes[theme]
    for (const bg of ['bg', 'surface', 'raised']) {
      for (const part of ['dot', 'text']) {
        const done = contrast(tokens.status.completed[theme][part], t[bg])
        const idle = contrast(tokens.status.abandoned[theme][part], t[bg])
        assert.ok(done > idle, `${theme}.${part} on ${bg}: completed ${done.toFixed(2)}:1 is not stronger than abandoned ${idle.toFixed(2)}:1`)
      }
      assertContrast(tokens.status.completed[theme].text, t[bg], AA_TEXT, `completed.${theme}.text on ${bg}`)
      assertContrast(tokens.status.completed[theme].dot, t[bg], AA_NON_TEXT, `completed.${theme}.dot on ${bg}`)
    }
  }
})

test('#700/AC-3: success is never green or rose', () => {
  for (const theme of THEMES) for (const part of ['dot', 'text']) {
    assert.notEqual(tokens.status.completed[theme][part], tokens.rose['500'])
    const [, a] = lab(tokens.status.completed[theme][part])
    assert.ok(a > -5, `completed.${theme}.${part} reads green (a* ${a.toFixed(1)})`)
  }
})

test('#700/AC-1: tokens.json keeps green only as history, marked as not to be used', () => {
  assert.match(tokens.green._nota, /Não usar/)
})

// The files allowed to name the retired green: the history, the core's re-read of a stored green and its test, and this guard.
const GREEN_ALLOWED = new Set([
  'docs/brand/tokens.json',
  'packages/nucleo/src/profiles/colors.ts',
  'packages/nucleo/test/profiles/profiles.test.ts',
  'test/tokens.test.mjs',
])
// The two retired hex values are built from pieces so this guard does not match its own search.
const RETIRED_GREEN_HEX = [['1baf', '7a'], ['0d73', '50']].map((parts) => parts.join('')).join('|')
const GREEN_REFERENCE = new RegExp(`--green-\\d|paleta\\.green|BADGE\\.green|an-account-green|green-(?:5|7)00|${RETIRED_GREEN_HEX}`, 'i')

test('#700/AC-2: no generated or hand-written consumer references a green token', () => {
  const root = new URL('../', import.meta.url)
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  const found = []
  for (const file of files) {
    if (file.startsWith('spikes/') || GREEN_ALLOWED.has(file) || /\.(png|jpe?g|gif|ico|icns|woff2?|ttf|lock|svg)$/i.test(file)) continue
    let text
    try { text = readFileSync(new URL(file, root), "utf8") } catch { continue } // a tracked file that is not readable text (a deleted or binary file) holds no reference
    text.split('\n').forEach((line, i) => { if (GREEN_REFERENCE.test(line)) found.push(`${file}:${i + 1}`) })
  }
  assert.deepEqual(found, [], 'a consumer still references the retired green')
})
