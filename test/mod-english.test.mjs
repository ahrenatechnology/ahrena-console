// The mod (plugins/ahrena-console) talks to the core in English since 0.0.31 (#187, decision 0009):
// no route, query parameter, JSON key, fixed value, state key or option of its own in Portuguese.
// On-screen text stays pt-BR and is not checked here.
//
// Run with: node --test 'test/*.test.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portugueseWords, words } from './english-internals.lib.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MOD = join(ROOT, 'plugins/ahrena-console')
const read = (rel) => readFileSync(join(MOD, rel), 'utf8')
const HOOKS = readdirSync(join(MOD, 'hooks')).filter((f) => /\.(ts|tsx|mjs)$/.test(f)).map((f) => `hooks/${f}`)
// Without the comments that open a line (a `/*` inside a regex literal is code, not a comment).
const code = (rel) => read(rel).replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '')

// The mod's own old words (its internals up to 0.0.30) that the repository's detector does not know.
const MOD_WORDS = new Set(`
  abandonada abandonado abre abrem achou acima aconfirmar agrupado agrupar aguardando aguarde
  ajustando ajustes alcancaveis alcancavel alcance alerta alternar altura alturas amarelo anda
  anteriores antigo aparece aprovado arco arquivada arquivadas ate ativo ativos borda botoes cabe
  cabem cada cancelar carregado casos celula chamada chamadas como compactada compactando compactar
  concluido concluidos confirmada conjunto consultar contar contratos copia corta corte couberam curta
  decidida decidido decidir decidiu delegando dentro desarquivar descartada descendentes desconhecido
  desenhar destaque direita direto encerrados endereco enviados enviar erros escondido escopos espaco
  esperado esquerda esta estimativa estouros estreito falhas falsos familia fazendo fechadas feitas
  feitos ficam fileiras filha filhas filhos filtrados fim foco folga fora glifo grade grupos iguais
  iniciada iniciar inteira inteiro interrompida irma laranja larg largo largura lendo ligar listas
  livres longa longe longo mae manuais marcas maximo mergeado mesmo minimo minuto minutos montar
  mostrar motivos mudar mudou nao negrito neutra neutro nivel nomes normalizar nosso ociosa onda ondas
  onde origens pagina1 pagina2 paginar pai palavra parada paralelo paralelos parar partes passo pe
  pedir perguntas porque precisa precisam prefixo primeira primeiro principal proxima quando quantos
  quem raiz raizes rascunho recuo recusar redesenho regua relogio respiro responder restantes
  resultado resumos retomada revisor rolagens serie sim solta soltar soltos sombra sua subagente
  subagentes substituida sugerida tem tentar textos tinta todas todos trabalhando trecho urgente
  usadas usados uso util varias varios vazia velha ver vermelho vetar vez vigente vigentes virgula
  visitar visiveis vista vistos volta
`.split(/\s+/).filter(Boolean))

/** The Portuguese words of a name: the repository's detector and the mod's old words. */
const pt = (name) => [...new Set([...portugueseWords(name), ...words(name).filter((w) => MOD_WORDS.has(w))])]
/** The names with Portuguese words, as `name (words)`. */
const refused = (names) => [...new Set(names)].map((n) => [n, pt(n)]).filter(([, w]) => w.length).map(([n, w]) => `${n} (${w.join(', ')})`)

test('the detector sees the old names of the mod', () => {
  assert.deepEqual(refused(['/api/painel/*', 'decisoes', 'precisam', 'sua-vez', 'leitura', 'porta', 'escopoDecisoes']).length, 7)
  assert.deepEqual(refused(['/api/panel/*', 'decisions', 'needYou', 'your-turn', 'reading', 'port', 'decisionsScope']), [])
})

test('the mod calls only English routes', () => {
  // The routes the mod builds, with each `${…}` as `*`: `/api/panel/*`, `/api/decisions/*/*`, `/open/*`.
  const found = HOOKS.flatMap((f) => [...code(f).replace(/\$\{[^}]*\}/g, '*').matchAll(/(?<![\w.~-])\/(?:api|open|abrir)(?:\/[A-Za-z0-9_*-]+)*/g)].map((m) => m[0]))
  assert.ok(found.some((r) => r.startsWith('/api/panel/')), `the mod reads the panel: ${found.join(', ')}`)
  assert.ok(found.some((r) => r.startsWith('/api/decisions/')), found.join(', '))
  assert.ok(found.some((r) => r.startsWith('/open/')), found.join(', '))
  assert.deepEqual(refused(found), [], 'Route in Portuguese: the mod uses the English API (#173).')
})

test('the mod sends only English query parameters and body keys', () => {
  const src = HOOKS.map(code).join('\n')
  // `add('account', …)` builds the panel's query; `…}decisions=${…}` adds to it.
  const params = [...src.matchAll(/(?<![.\w])add\(\s*'([^']+)'/g), ...src.matchAll(/[?&}]([A-Za-z_]+)=\$\{/g)].map((m) => m[1])
  assert.ok(params.includes('account') && params.includes('model') && params.includes('decisions'), params.join(', '))
  // The JSON bodies the mod POSTs: `{ session, text }` for a decision.
  const bodies = [...src.matchAll(/body:\s*JSON\.stringify\((.*)\),?\s*$/gm)].flatMap((m) => [...m[1].matchAll(/([A-Za-z_]\w*)\s*:(?!\s*\{\s*\})|\{\s*([A-Za-z_]\w*)\s*\}/g)].map((k) => k[1] ?? k[2]))
  assert.ok(bodies.includes('session') && bodies.includes('text'), bodies.join(', '))
  assert.deepEqual(refused([...params, ...bodies]), [], 'Query parameter or body key in Portuguese.')
})

test('the API contract and the state of the mod have English keys and values', () => {
  const types = code('types/index.d.ts')
  const keys = [...types.matchAll(/^\s*(?:readonly\s+)?['"]?([A-Za-z_][\w-]*)['"]?\??\s*:/gm), ...types.matchAll(/[{;,]\s*([A-Za-z_]\w*)\??\s*:/g)].map((m) => m[1])
  const values = [...types.matchAll(/'([^'\s]+)'/g)].map((m) => m[1]).filter((v) => v !== 'claude-code' && v !== 'ahrena-console')
  assert.ok(keys.includes('needYou') && keys.includes('decisionsScope'), keys.join(', '))
  assert.deepEqual(refused([...keys, ...values]), [], 'Key or fixed value in Portuguese in types/index.d.ts.')
})

test('the state keys and the options of the mod are English', () => {
  const src = HOOKS.map(code).join('\n')
  const atoms = [...src.matchAll(/atom\(\{\s*plugin:\s*'[^']+',\s*key:\s*'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(atoms.sort(), ['question', 'reading', 'view'])
  const options = Object.keys(JSON.parse(read('.claude-plugin/plugin.json')).userConfig ?? {})
  assert.deepEqual(options, ['port'])
})

test('the recorded scenarios are the English body of /api/panel', () => {
  const scenarios = read('tests/scenarios.ts')
  assert.match(scenarios, /record-panel-scenarios\.ts/)
  const keys = [...scenarios.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]).filter((k) => !/^p\d+$/.test(k))
  assert.deepEqual(refused(keys), [], 'Key in Portuguese in tests/scenarios.ts: record it again from /api/panel.')
})

test('the files of the mod have English names', () => {
  const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? (f === 'types' && dir.endsWith('.claude-plugin') ? [] : [f, ...walk(join(dir, f))]) : [f.replace(/\.[^.]+$/, '').replace(/\.test$/, '')]))
  assert.deepEqual(refused(walk(MOD).map((n) => relative(MOD, n))), [])
})
