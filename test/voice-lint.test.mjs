// Guard for the voice of the pt-BR on-screen text (issue 665): the rules are docs/brand/voice-rules.json,
// the lint is voice-lint.lib.mjs, and what already broke them is frozen in voice-lint.baseline.json.
// A ratchet: a finding that is not in the baseline fails, and so does a baseline entry that no longer
// occurs, so the baseline only shrinks.
//
// Run with: node --test --test-concurrency=1 test/voice-lint.test.mjs
// Create the baseline (only when the file does not exist): VOICE_LINT_FREEZE=1 node --test test/voice-lint.test.mjs
// Remove stale entries:                                     VOICE_LINT_SHRINK=1 node --test test/voice-lint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  baselineEntries,
  compareToBaseline,
  extractHtml,
  extractJs,
  lintFiles,
  lintText,
  loadRules,
  shrinkBaseline,
} from './voice-lint.lib.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = process.env.ROOT ?? join(HERE, '..')
const BASELINE_FILE = join(HERE, 'voice-lint.baseline.json')

const rules = loadRules(join(ROOT, 'docs/brand/voice-rules.json'))
const ruleIds = (findings) => findings.map((f) => f.rule)
const count = (findings, rule) => findings.filter((f) => f.rule === rule).length

test('the rules file exists and is well-formed', () => {
  assert.equal(rules.version, 1)
  assert.equal(rules.approvedOn, '2026-11-14')
  assert.equal(rules.approvedBy, 'product owner')
  assert.equal(rules.language, 'pt-BR')
  assert.deepEqual(rules.limits, {
    label: { maxWords: 4, maxCharacters: 28 },
    title: { maxWords: 6 },
    support: { maxWords: 20, maxSentences: 2 },
  })
  const strings = (list) => Array.isArray(list) && list.length > 0 && list.every((s) => typeof s === 'string' && s.trim() === s && s !== '')
  assert.ok(strings(rules.forbiddenTerms))
  assert.equal(rules.forbiddenTerms.length, 11)
  assert.ok(Array.isArray(rules.preferredTerms) && rules.preferredTerms.length === 5)
  for (const p of rules.preferredTerms) assert.ok(strings([p.avoid, p.use]), JSON.stringify(p))
  assert.ok(strings(rules.fillerPatterns.phrases))
  assert.equal(rules.fillerPatterns.phrases.length, 11)
  for (const flag of ['exclamationMark', 'longDash', 'emoji']) assert.equal(rules.fillerPatterns[flag], true, flag)
  for (const section of ['classification', 'matching', 'scope', 'ratchet']) assert.ok(rules[section], `section ${section}`)
  for (const key of ['labelKeys', 'titleKeys', 'supportKeys', 'labelElements', 'titleElements']) assert.ok(strings(rules.classification[key]), key)
  assert.ok(strings(rules.scope.includedFiles))
})

test('the good examples pass', () => {
  assert.deepEqual(lintText('Não deu para guardar a credencial', rules), [])
  assert.deepEqual(lintText('Conferir a conexão', rules, { kind: 'label' }), [])
  assert.equal(lintText('Ops', rules, { kind: 'label' }).length, 1)
})

test('label limits: words and characters', () => {
  assert.deepEqual(lintText('Uma duas três quatro', rules, { kind: 'label' }), [])
  assert.deepEqual(ruleIds(lintText('Uma duas três quatro cinco', rules, { kind: 'label' })), ['limit-label-words'])
  // 4 words, 29 characters
  const long = 'Abcdefgh abcdefgh abcdefgh abc'
  assert.equal(long.length, 30)
  assert.deepEqual(ruleIds(lintText(long, rules, { kind: 'label' })), ['limit-label-characters'])
  assert.deepEqual(lintText('Abcdefgh abcdefgh abcdefgh a', rules, { kind: 'label' }), [])
})

test('title limit: words', () => {
  assert.deepEqual(lintText('Seis palavras neste título curto aqui', rules, { kind: 'title' }), [])
  assert.deepEqual(ruleIds(lintText('Sete palavras neste título curto aqui hoje', rules, { kind: 'title' })), ['limit-title-words'])
})

test('support limits: words and sentences', () => {
  const twenty = Array(20).fill('texto').join(' ')
  assert.deepEqual(lintText(twenty, rules, { kind: 'support' }), [])
  assert.deepEqual(ruleIds(lintText(`${twenty} texto`, rules, { kind: 'support' })), ['limit-support-words'])
  assert.deepEqual(lintText('Uma frase. Duas frases.', rules, { kind: 'support' }), [])
  assert.deepEqual(ruleIds(lintText('Uma frase. Duas frases. Três frases.', rules, { kind: 'support' })), ['limit-support-sentences'])
})

test('an unclassified string has no length limit', () => {
  const long = Array(40).fill('texto').join(' ') + '. Outra. E outra. Mais uma.'
  assert.deepEqual(lintText(long, rules), [])
})

test('a forbidden term is a finding, whole word, any case, accent-aware', () => {
  for (const term of rules.forbiddenTerms) {
    const found = lintText(`Texto com ${term} no meio`, rules)
    assert.equal(count(found, 'forbidden-term'), 1, term)
    assert.equal(found.find((f) => f.rule === 'forbidden-term').match.toLowerCase(), term)
  }
  assert.equal(count(lintText('Incrível', rules), 'forbidden-term'), 1)
  assert.equal(count(lintText('INFELIZMENTE não deu', rules), 'forbidden-term'), 1)
  assert.equal(count(lintText('Ops, deu errado', rules), 'forbidden-term'), 1)
  // whole words only
  assert.equal(count(lintText('Fechar os copos e as ópticas', rules), 'forbidden-term'), 0)
  assert.equal(count(lintText('Aguardando a resposta', rules), 'forbidden-term'), 0)
  assert.equal(count(lintText('Por   favor confira', rules), 'forbidden-term'), 1)
})

test('"Por favor, aguarde a verificação" fails with 2 term findings', () => {
  const found = lintText('Por favor, aguarde a verificação', rules)
  assert.equal(count(found, 'forbidden-term'), 2)
  assert.deepEqual(found.map((f) => f.match.toLowerCase()).sort(), ['aguarde', 'por favor'])
  assert.equal(found.length, 2)
})

test('a preferred term is flagged with its suggestion', () => {
  const cases = [
    ['Acessar o painel', 'acessar', 'abrir'],
    ['Utilizar o atalho', 'utilizar', 'usar'],
    ['Visualizar a sessão', 'visualizar', 'ver'],
    ['Tentar novamente', 'novamente', 'de novo'],
    ['Verificar a conexão', 'verificar', 'Conferir'],
  ]
  for (const [text, avoid, use] of cases) {
    const found = lintText(text, rules).filter((f) => f.rule === 'preferred-term')
    assert.equal(found.length, 1, text)
    assert.equal(found[0].match.toLowerCase(), avoid)
    assert.equal(found[0].suggestion, use)
  }
  // exact words: an inflection is not matched
  assert.equal(count(lintText('Acesse o painel', rules), 'preferred-term'), 0)
  assert.equal(count(lintText('A verificação terminou', rules), 'preferred-term'), 0)
})

test('an AI filler phrase is a finding', () => {
  for (const phrase of rules.fillerPatterns.phrases) {
    assert.equal(count(lintText(`Texto ${phrase} texto`, rules), 'filler-phrase'), 1, phrase)
  }
  const found = lintText('Vale ressaltar que a conexão não ficou', rules)
  assert.deepEqual(ruleIds(found), ['filler-phrase'])
  assert.equal(count(lintText('Bem-vindo de volta', rules), 'filler-phrase'), 1)
})

test('an exclamation mark, a long dash and an emoji are findings', () => {
  assert.deepEqual(ruleIds(lintText('Salvo!', rules)), ['filler-exclamation-mark'])
  assert.deepEqual(ruleIds(lintText('Salvo — sem erro', rules)), ['filler-long-dash'])
  assert.deepEqual(ruleIds(lintText('Salvo 🎉', rules)), ['filler-emoji'])
  assert.deepEqual(ruleIds(lintText('Atenção ⚠️ aqui', rules)), ['filler-emoji'])
  // the status glyphs, the arrows and the middle dot are text symbols, not emoji; the short dash is allowed
  assert.deepEqual(lintText('● ✓ ✕ ◐ ○ → · – Ativa', rules), [])
})

test('a template literal reads each interpolation as {}', () => {
  const found = extractJs('const a = `Faltam ${n} itens, por favor aguarde`')
  assert.deepEqual(found.map((s) => s.text), ['Faltam {} itens, por favor aguarde'])
})

test('the JavaScript extractor finds string literals with their key and element', () => {
  const source = [
    "import { el } from './dom.js'",
    "// 'Comentário! com exclamação'",
    '/* "Outro! comentário" */',
    "const x = el('h2', {}, 'Um título simples')",
    "const y = { label: 'Abrir sessão', 'aria-label': 'Fechar painel', hint: 'Texto de apoio aqui' }",
    "const re = /'Falso! texto'/.test(s)",
    "const z = `Olá ${nome} e ${el('b', {}, 'Dentro do molde')}`",
  ].join('\n')
  const found = extractJs(source)
  const byText = Object.fromEntries(found.map((s) => [s.text, s]))
  assert.equal(byText['Um título simples'].tag, 'h2')
  assert.equal(byText['Abrir sessão'].key, 'label')
  assert.equal(byText['Fechar painel'].key, 'aria-label')
  assert.equal(byText['Texto de apoio aqui'].key, 'hint')
  assert.equal(byText['Dentro do molde'].tag, 'b')
  assert.equal(byText['Olá {} e {}'].line, 7)
  assert.ok(!('Comentário! com exclamação' in byText))
  assert.ok(!('Outro! comentário' in byText))
  assert.ok(!('Falso! texto' in byText))
})

test('the HTML extractor finds text nodes and the text attributes', () => {
  const html = [
    '<h1>Um título</h1>',
    '<button aria-label="Fechar o painel">x</button>',
    '<input placeholder="Buscar sessão">',
    '<script>const a = "Não é texto! de tela"</script>',
    '<style>.a::after { content: "Falso! texto" }</style>',
    '<!-- Comentário! -->',
    '<p>Texto   com\n quebra</p>',
  ].join('\n')
  const found = extractHtml(html)
  const texts = found.map((s) => s.text)
  assert.ok(texts.includes('Um título'))
  assert.ok(texts.includes('Fechar o painel'))
  assert.ok(texts.includes('Buscar sessão'))
  assert.ok(texts.includes('Texto com quebra'))
  assert.ok(!texts.some((t) => /Falso|Não é texto|Comentário/.test(t)))
  assert.equal(found.find((s) => s.text === 'Um título').tag, 'h1')
  assert.equal(found.find((s) => s.text === 'Fechar o painel').key, 'aria-label')
})

test('what is not on-screen text is skipped', () => {
  const source = [
    "import x from './dom-util!.js'",
    "a.classList.add('cc-nav-dot active')",
    "const url = '/api/sessions/!x'",
    "const id = 'session-detail-tab'",
    "if (kind === 'Fechar tudo agora, por favor') {}",
    "document.querySelector('.a > .b, por favor')",
    "console.log('Erro interno! por favor aguarde')",
    "const e = 'app-update'",
    "const k = '12 !!! 34'.length",
    "const n = '12:30'",
    "const u = 'https://exemplo.com/a b!'",
  ].join('\n')
  const rows = lintFiles({ virtual: [{ file: 'x.js', source }] }, rules)
  assert.deepEqual(rows.map((f) => f.text), [])
})

test('a single capitalised word and a classified word are on-screen text', () => {
  const rows = lintFiles({ virtual: [{ file: 'x.js', source: "const a = el('button', {}, 'Aguarde')\nconst b = { label: 'incrível' }\nconst c = 'aguarde'" }] }, rules)
  assert.deepEqual(rows.map((f) => f.text), ['Aguarde', 'incrível'])
})

test('the lint classifies by key and element, and holds each kind to its limit', () => {
  const source = [
    "const a = { label: 'Uma duas três quatro cinco' }",
    "const b = el('h2', {}, 'Um dois três quatro cinco seis sete')",
    "const c = { hint: 'Uma frase. Outra frase. Mais uma frase.' }",
    "const d = { stateLabel: 'Uma duas três quatro cinco' }",
    "const e = el('p', {}, 'Uma duas três quatro cinco seis sete oito')",
  ].join('\n')
  const rows = lintFiles({ virtual: [{ file: 'x.js', source }] }, rules)
  assert.deepEqual(rows.map((f) => f.rule).sort(), ['limit-label-words', 'limit-label-words', 'limit-support-sentences', 'limit-title-words'])
})

test('the baseline comparison reports what is new and what is stale', () => {
  const finding = (file, rule, text) => ({ file, rule, text, match: '', line: 1 })
  const baseline = [
    { file: 'a.js', rule: 'filler-exclamation-mark', text: 'Salvo!', count: 1 },
    { file: 'a.js', rule: 'forbidden-term:ops', text: 'Ops', count: 2 },
  ]
  const same = compareToBaseline([finding('a.js', 'filler-exclamation-mark', 'Salvo!'), finding('a.js', 'forbidden-term:ops', 'Ops'), finding('a.js', 'forbidden-term:ops', 'Ops')], baseline)
  assert.deepEqual(same, { added: [], stale: [] })
  const changed = compareToBaseline([finding('a.js', 'filler-exclamation-mark', 'Salvo!'), finding('a.js', 'forbidden-term:ops', 'Ops'), finding('b.js', 'filler-long-dash', 'a — b')], baseline)
  assert.equal(changed.added.length, 1)
  assert.equal(changed.stale.length, 1)
  assert.match(changed.stale[0], /ops/)
  // a third copy of a baselined text is new
  const more = compareToBaseline(Array(3).fill(finding('a.js', 'forbidden-term:ops', 'Ops')), baseline.slice(1))
  assert.equal(more.added.length, 1)
  // shrink drops what is stale and never adds
  const shrunk = shrinkBaseline([finding('a.js', 'forbidden-term:ops', 'Ops'), finding('z.js', 'filler-long-dash', 'x — y')], baseline)
  assert.deepEqual(shrunk, [{ file: 'a.js', rule: 'forbidden-term:ops', text: 'Ops', count: 1 }])
})

test('the UI strings hold the rules, with no new violation and no stale baseline entry', () => {
  const findings = lintFiles({ root: ROOT }, rules)
  if (process.env.VOICE_LINT_FREEZE === '1' && !existsSync(BASELINE_FILE)) {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(baselineEntries(findings), null, 2)}\n`)
  }
  assert.ok(existsSync(BASELINE_FILE), 'test/voice-lint.baseline.json is missing')
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  assert.ok(Array.isArray(baseline))
  for (const e of baseline) {
    assert.deepEqual(Object.keys(e).sort(), ['count', 'file', 'rule', 'text'], JSON.stringify(e))
    assert.ok(Number.isInteger(e.count) && e.count > 0)
  }
  if (process.env.VOICE_LINT_SHRINK === '1') {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(shrinkBaseline(findings, baseline), null, 2)}\n`)
    return
  }
  const { added, stale } = compareToBaseline(findings, baseline)
  assert.deepEqual(added, [], `new voice violations (fix the text, do not add to the baseline):\n${added.join('\n')}`)
  assert.deepEqual(stale, [], `baseline entries that no longer occur (run VOICE_LINT_SHRINK=1 to remove them):\n${stale.join('\n')}`)
})
