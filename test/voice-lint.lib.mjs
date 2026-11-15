// The voice lint of issue 665: holds the pt-BR on-screen text to docs/brand/voice-rules.json.
// Shared by voice-lint.test.mjs. The rules, the heuristic that picks the on-screen text and how a
// string is classified are documented in the rules file itself and in docs/brand/voice.md.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function loadRules(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------------------------------------
// The rules on one text

const LETTER = '\\p{L}\\p{N}_'
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A whole-word, case-insensitive, accent-aware matcher: the characters around it are not letters. */
function wordMatcher(phrase, flags = 'giu') {
  const body = phrase.trim().split(/\s+/).map(escapeRegex).join('\\s+')
  return new RegExp(`(?<![${LETTER}])${body}(?![${LETTER}])`, flags)
}

/** The words of a text: the tokens that hold a letter, a digit or an interpolation. */
const wordsOf = (text) => text.split(/\s+/).filter((t) => /[\p{L}\p{N}]|\{\}/u.test(t))

/** Sentences end at . ! ? or an ellipsis followed by white space and an upper case letter. */
function sentencesOf(text) {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return 1 + (trimmed.match(/[.!?…]+\s+(?=\p{Lu})/gu) ?? []).length
}

const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u

/**
 * The findings of one text. `kind` is 'label', 'title', 'support' or absent (unclassified: no length
 * limits). A finding: { rule, match, suggestion?, message }.
 */
export function lintText(text, rules, { kind } = {}) {
  const findings = []
  const add = (rule, match, message, suggestion) => findings.push({ rule, match, message, ...(suggestion ? { suggestion } : {}) })
  const words = wordsOf(text).length
  const { limits } = rules

  if (kind === 'label') {
    if (words > limits.label.maxWords) add('limit-label-words', String(words), `a label has at most ${limits.label.maxWords} words, this has ${words}`)
    if ([...text].length > limits.label.maxCharacters) add('limit-label-characters', String([...text].length), `a label has at most ${limits.label.maxCharacters} characters, this has ${[...text].length}`)
  } else if (kind === 'title') {
    if (words > limits.title.maxWords) add('limit-title-words', String(words), `a title has at most ${limits.title.maxWords} words, this has ${words}`)
  } else if (kind === 'support') {
    if (words > limits.support.maxWords) add('limit-support-words', String(words), `a support text has at most ${limits.support.maxWords} words, this has ${words}`)
    const sentences = sentencesOf(text)
    if (sentences > limits.support.maxSentences) add('limit-support-sentences', String(sentences), `a support text has at most ${limits.support.maxSentences} sentences, this has ${sentences}`)
  }

  for (const term of rules.forbiddenTerms) {
    for (const m of text.matchAll(wordMatcher(term))) add(`forbidden-term:${term}`, m[0], `forbidden term "${term}"`)
  }
  for (const { avoid, use } of rules.preferredTerms) {
    for (const m of text.matchAll(wordMatcher(avoid))) add(`preferred-term:${avoid.toLowerCase()}`, m[0], `prefer "${use}" to "${avoid}"`, use)
  }
  for (const phrase of rules.fillerPatterns.phrases) {
    for (const m of text.matchAll(wordMatcher(phrase))) add(`filler-phrase:${phrase}`, m[0], `filler phrase "${phrase}"`)
  }
  if (rules.fillerPatterns.exclamationMark && text.includes('!')) add('filler-exclamation-mark', '!', 'no exclamation mark')
  if (rules.fillerPatterns.longDash && text.includes('—')) add('filler-long-dash', '—', 'no long dash')
  if (rules.fillerPatterns.emoji && EMOJI.test(text)) add('filler-emoji', text.match(EMOJI)[0], 'no emoji')

  // The public rule ids of the rule kinds that carry a term in the id are kept whole in the baseline,
  // but a test or a reader asks for the kind: forbidden-term, preferred-term, filler-phrase.
  return findings.map((f) => ({ ...f, rule: f.rule.replace(/^(forbidden-term|preferred-term|filler-phrase):.*/, '$1'), key: f.rule }))
}

// ---------------------------------------------------------------------------------------------
// Classification and the on-screen text heuristic

const lastWord = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).pop()?.toLowerCase()

/** 'label', 'title', 'support' or null, by the key first, then the element. */
export function classify({ key, tag }, rules) {
  const c = rules.classification
  const word = key ? lastWord(key) : null
  if (word) {
    if (c.labelKeys.includes(word)) return 'label'
    if (c.titleKeys.includes(word)) return 'title'
    if (c.supportKeys.includes(word)) return 'support'
  }
  if (tag) {
    if (c.labelElements.includes(tag)) return 'label'
    if (c.titleElements.includes(tag)) return 'title'
  }
  return null
}

/** Whether a literal of a source is on-screen text; `kind` is its classification. See the rules file. */
function isScreenText(text, kind) {
  if (!/\p{L}/u.test(text)) return false
  if (/^(\/|\.|#|https?:|data:|[a-z][a-z0-9+.-]*:\/\/)/i.test(text)) return false
  if (kind) return true
  if (!/\s/.test(text)) return /^\p{Lu}\p{L}*$/u.test(text)
  // white space and every token lower case ASCII: a class list
  return !text.split(/\s+/).every((t) => /^[a-z0-9_:.,\-[\]#>*=/~()'"]+$/.test(t))
}

// ---------------------------------------------------------------------------------------------
// The extractors

const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$/
const KEYWORD_BEFORE = /(?:^|[^\w$.])(?:return|typeof|case|of|in|delete|void|throw|new|else|yield|await)$/

/**
 * The string literals of JavaScript source: { text, line, key, tag, skip }. Comments and regular
 * expression literals are skipped; a template literal is one text with each interpolation as {}
 * and the strings inside an interpolation are found on their own. `skip` is set when the literal is
 * not on-screen text by its position (an operand of a comparison, an argument of a DOM or module call).
 */
export function extractJs(source) {
  const out = []
  let i = 0
  let line = 1
  const n = source.length

  const lineStart = (pos) => source.lastIndexOf('\n', pos - 1) + 1
  const context = (start) => {
    const before = source.slice(Math.max(0, start - 80), start)
    const head = source.slice(lineStart(start), start)
    const keyMatch = /(?:^|[{,(])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*$/.exec(head)
    const key = keyMatch ? (keyMatch[1] ?? keyMatch[2] ?? keyMatch[3]) : null
    let tag = null
    for (const m of head.matchAll(/\bel\(\s*['"]([a-z0-9]+)['"]/g)) tag = m[1]
    const operand = /(?:===|!==|==|!=|\bcase)\s*$/.test(before)
    const importFrom = /\bfrom\s*$/.test(before) || /^\s*(?:import|export)\b.*\bfrom\b/.test(head)
    const callOnLine = /\b(?:console\.\w+|querySelector(?:All)?|classList\.\w+|getAttribute|setAttribute|addEventListener|removeEventListener|dispatchEvent|require)\(/.test(head) && !/\bel\(/.test(head)
    return { key, tag, skip: operand || importFrom || callOnLine }
  }

  const skipRegex = () => {
    let inClass = false
    i++
    while (i < n) {
      const ch = source[i]
      if (ch === '\\') i += 2
      else if (ch === '\n') break
      else if (ch === '[') { inClass = true; i++ }
      else if (ch === ']') { inClass = false; i++ }
      else if (ch === '/' && !inClass) { i++; break }
      else i++
    }
    while (i < n && /[a-z]/i.test(source[i])) i++
  }

  const readQuoted = (quote) => {
    const start = i
    const startLine = line
    i++
    let text = ''
    while (i < n && source[i] !== quote && source[i] !== '\n') {
      if (source[i] === '\\') {
        const next = source[i + 1]
        const map = { n: '\n', t: '\t', r: '\r' }
        if (next === 'u' && /^[0-9a-fA-F]{4}/.test(source.slice(i + 2, i + 6))) { text += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16)); i += 6; continue }
        text += map[next] ?? next
        i += 2
      } else text += source[i++]
    }
    i++
    // a literal that starts a property and is followed by a colon is a key (`'aria-label': …`), not text
    const isKey = /^\s*:/.test(source.slice(i, i + 40)) && /[{,]\s*$/.test(source.slice(Math.max(0, start - 40), start))
    if (!isKey) out.push({ text, line: startLine, ...context(start) })
  }

  const readTemplate = () => {
    const start = i
    const startLine = line
    i++
    let text = ''
    const inner = []
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') { text += source[i + 1]; i += 2; continue }
      if (source[i] === '$' && source[i + 1] === '{') {
        i += 2
        text += '{}'
        const before = out.length
        scanCode(true)
        inner.push(...out.splice(before))
        continue
      }
      if (source[i] === '\n') line++
      text += source[i++]
    }
    i++
    out.push({ text, line: startLine, ...context(start) })
    out.push(...inner)
  }

  function scanCode(untilBrace = false) {
    let depth = 0
    let last = ''
    while (i < n) {
      const ch = source[i]
      if (ch === '\n') { line++; i++; continue }
      if (/\s/.test(ch)) { i++; continue }
      if (ch === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue }
      if (ch === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2)
        const stop = end === -1 ? n : end + 2
        line += (source.slice(i, stop).match(/\n/g) ?? []).length
        i = stop
        continue
      }
      if (ch === '"' || ch === "'") { readQuoted(ch); last = 'x'; continue }
      if (ch === '`') { readTemplate(); last = 'x'; continue }
      if (ch === '/') {
        const prefix = source.slice(Math.max(0, i - 20), i).trimEnd()
        if (last === '' || REGEX_BEFORE.test(prefix) || KEYWORD_BEFORE.test(prefix)) { skipRegex(); last = 'x'; continue }
      }
      if (ch === '{') depth++
      if (ch === '}') {
        if (untilBrace && depth === 0) { i++; return }
        depth--
      }
      last = ch
      i++
    }
  }

  scanCode()
  return out
}

/** Text nodes and the aria-label, placeholder and title attributes of an HTML page. */
export function extractHtml(html) {
  const out = []
  const lineOf = (pos) => (html.slice(0, pos).match(/\n/g) ?? []).length + 1
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  const source = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, blank)
  for (const m of source.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const [, tag, attrs] = m
    for (const a of attrs.matchAll(/\b(aria-label|placeholder|title)\s*=\s*"([^"]*)"/gi)) {
      out.push({ text: a[2].replace(/\s+/g, ' ').trim(), line: lineOf(m.index), key: a[1].toLowerCase(), tag: tag.toLowerCase(), skip: false })
    }
    const after = m.index + m[0].length
    const text = /^[^<]*/.exec(source.slice(after))[0]
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean) out.push({ text: clean, line: lineOf(after), key: null, tag: tag.toLowerCase(), skip: false })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The lint over files

const UI_DIRS = ['packages/nucleo/ui', 'packages/nucleo/ui/screens']

function uiFiles(root) {
  const files = []
  for (const dir of UI_DIRS) {
    for (const f of readdirSync(join(root, dir)).sort()) {
      if (f.endsWith('.js')) files.push({ file: `${dir}/${f}`, source: readFileSync(join(root, dir, f), 'utf8') })
    }
  }
  files.push({ file: 'packages/nucleo/ui/index.html', source: readFileSync(join(root, 'packages/nucleo/ui/index.html'), 'utf8') })
  return files
}

/**
 * Every finding over the UI strings: { file, line, rule, key, match, text, kind, message, suggestion? }.
 * `{ root }` reads the files of the checkout; `{ virtual: [{ file, source }] }` reads the given ones.
 */
export function lintFiles({ root, virtual }, rules) {
  const files = virtual ?? uiFiles(root)
  const findings = []
  for (const { file, source } of files) {
    const literals = file.endsWith('.html') ? extractHtml(source) : extractJs(source)
    for (const lit of literals) {
      if (lit.skip) continue
      const kind = classify(lit, rules)
      if (!isScreenText(lit.text, kind)) continue
      for (const f of lintText(lit.text, rules, { kind })) {
        findings.push({ file, line: lit.line, text: lit.text, kind, ...f })
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------------------------
// The ratchet

/** The key of a finding: file, rule and text. No line number, so an unrelated edit does not churn it. */
const keyOf = (f) => `${f.file}\u0000${f.key ?? f.rule}\u0000${f.text}`

/** The baseline of a list of findings: one entry per file, rule and text, with a count. */
export function baselineEntries(findings) {
  const map = new Map()
  for (const f of findings) {
    const k = keyOf(f)
    const e = map.get(k) ?? { file: f.file, rule: f.key ?? f.rule, text: f.text, count: 0 }
    e.count++
    map.set(k, e)
  }
  return [...map.values()].sort((a, b) => (a.file + a.rule + a.text).localeCompare(b.file + b.rule + b.text))
}

const describe = (e) => `${e.file} ${e.rule}: ${JSON.stringify(e.text)}`

/** What the findings add to the baseline (`added`) and what the baseline holds that no longer occurs (`stale`). */
export function compareToBaseline(findings, baseline) {
  const actual = new Map(baselineEntries(findings).map((e) => [keyOf(e), e]))
  const frozen = new Map(baseline.map((e) => [keyOf(e), e]))
  const added = []
  const stale = []
  for (const [k, e] of actual) {
    const allowed = frozen.get(k)?.count ?? 0
    if (e.count > allowed) added.push(`${describe(e)} (${e.count} found, ${allowed} in the baseline)`)
  }
  for (const [k, e] of frozen) {
    const found = actual.get(k)?.count ?? 0
    if (found < e.count) stale.push(`${describe(e)} (${found} found, ${e.count} in the baseline)`)
  }
  return { added, stale }
}

/** The baseline with the stale entries removed or lowered. Never adds one. */
export function shrinkBaseline(findings, baseline) {
  const actual = new Map(baselineEntries(findings).map((e) => [keyOf(e), e]))
  return baseline
    .map((e) => ({ ...e, count: Math.min(e.count, actual.get(keyOf(e))?.count ?? 0) }))
    .filter((e) => e.count > 0)
}
