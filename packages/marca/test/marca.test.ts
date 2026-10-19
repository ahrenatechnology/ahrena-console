// Garante que os tokens gerados estão em dia com docs/brand/tokens.json e que o
// painel e o artefato leem as mesmas cores. Roda também a validação da marca
// (contraste AA, os 5 status, o laranja) de test/tokens.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import '../../../test/tokens.test.mjs'
import { gerar, gerarCss, gerarTs, lerTokens, SAIDAS } from '../src/gerar.ts'
import * as marca from '../gerado/marca.ts'
import * as marcaDoPainel from '../../../spikes/painel-teste/hooks/marca.ts'

const raiz = new URL('../../../', import.meta.url)
const ler = (caminho: string) => readFileSync(new URL(caminho, raiz), 'utf8')
const tokens = lerTokens()
const semNotas = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')))
const regenerar = 'rode `node packages/marca/src/gerar.ts` e faça commit do resultado'

test('cada saída gerada está em dia com o tokens.json', () => {
  for (const [caminho, esperado] of Object.entries(gerar(tokens))) {
    assert.equal(ler(caminho), esperado, `${caminho} está desatualizado: ${regenerar}`)
  }
})

test('todo plugin que usa a marca tem a mesma cópia do módulo', () => {
  const [principal, ...copias] = SAIDAS.ts
  for (const copia of copias) assert.equal(ler(copia), ler(principal!), `${copia} difere de ${principal}: ${regenerar}`)
  assert.deepEqual({ ...marcaDoPainel }, { ...marca })
})

test('mudar um token muda a saída', () => {
  const mexido = structuredClone(tokens)
  mexido.themes.light.bg = '#ffffff'
  assert.notEqual(gerarTs(mexido), gerarTs(tokens))
  assert.notEqual(gerarCss(mexido), gerarCss(tokens))
})

test('o módulo do painel traz as cores do tokens.json, em hex', () => {
  assert.equal(marca.paleta.orange['500'], '#f47720', 'o laranja não muda')
  for (const escala of Object.keys(marca.paleta) as (keyof typeof marca.paleta)[]) {
    assert.deepEqual(marca.paleta[escala], semNotas(tokens[escala]), escala)
  }
  assert.ok(!('purple' in marca.paleta) && !('pink' in marca.paleta), 'o roxo e o rosa antigo ficam de fora')
  assert.deepEqual(marca.ci, tokens.ci)
  for (const tema of ['dark', 'light'] as const) assert.deepEqual(marca.temas[tema], semNotas(tokens.themes[tema]))
  assert.deepEqual(marca.ordemStatus, tokens.status._ordem)
  for (const id of marca.ordemStatus) {
    const s = marca.status[id]
    const fonte = tokens.status[id]
    assert.deepEqual([s.label, s.glyph, s.color, s.dark, s.light], [fonte.label, fonte.glyph, fonte.color, fonte.dark, fonte.light], id)
  }
  assert.equal(marca.tipografia.mono, tokens.typography.mono)
})

// Lê as variáveis de um bloco do CSS gerado.
function bloco(css: string, seletor: string): Record<string, string> {
  const inicio = css.indexOf(`${seletor} {`)
  assert.ok(inicio >= 0, `falta o bloco ${seletor}`)
  const corpo = css.slice(inicio, css.indexOf('}', inicio))
  return Object.fromEntries([...corpo.matchAll(/--([\w-]+): ([^;]+);/g)].map(m => [m[1], m[2]]))
}

test('o CSS do artefato: escuro no :root, claro por prefers-color-scheme e por data-theme', () => {
  const css = ler('packages/marca/gerado/marca.css')
  const raizCss = bloco(css, ':root')
  const peloSistema = bloco(css, ':root:not([data-theme="dark"])')
  const fixado = bloco(css, ':root[data-theme="light"]')
  assert.match(css, /@media \(prefers-color-scheme: light\) \{\n {2}:root:not\(\[data-theme="dark"\]\)/)
  const papel = (k: string) => k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
  for (const [k, cor] of Object.entries(semNotas(tokens.themes.dark))) assert.equal(raizCss[papel(k)], cor, `--${papel(k)} no escuro`)
  for (const [k, cor] of Object.entries(semNotas(tokens.themes.light))) {
    assert.equal(peloSistema[papel(k)], cor, `--${papel(k)} no claro pelo sistema`)
    assert.equal(fixado[papel(k)], cor, `--${papel(k)} no claro fixado`)
  }
  assert.deepEqual(peloSistema, fixado, 'os dois blocos do claro são iguais')
  for (const id of tokens.status._ordem) {
    assert.equal(raizCss[`status-${id}`], tokens.status[id].color)
    for (const p of ['dot', 'text', 'badge']) {
      assert.equal(raizCss[`status-${id}-${p}`], tokens.status[id].dark[p], `${id} ${p} no escuro`)
      assert.equal(fixado[`status-${id}-${p}`], tokens.status[id].light[p], `${id} ${p} no claro`)
    }
  }
  assert.equal(raizCss['orange-500'], '#f47720')
  assert.equal(raizCss['font-sans'], tokens.typography.sans)
})

test('o painel de teste não fixa à mão nenhuma cor que já está na marca', () => {
  const fonte = ler('spikes/painel-teste/hooks/register.tsx')
  assert.match(fonte, /from '\.\/marca'/, 'o painel importa o módulo gerado')
  const daMarca = new Set(Object.values(marca.paleta).flatMap(escala => Object.values(escala)).map(c => c.toLowerCase()))
  const fixas = [...fonte.matchAll(/#[0-9a-fA-F]{6}\b/g)].map(m => m[0].toLowerCase())
  for (const cor of fixas) assert.ok(!daMarca.has(cor), `register.tsx fixa ${cor}, que já está no módulo da marca`)
})
