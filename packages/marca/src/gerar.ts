// Gera os tokens da marca a partir de docs/brand/tokens.json, a única fonte:
// - gerado/marca.ts: as cores como strings hex, para o painel (elementos nativos, sem CSS);
// - gerado/marca.css: variáveis CSS para o artefato HTML, escuro por padrão e claro
//   por prefers-color-scheme ou data-theme, e uma cópia dele na interface que o núcleo serve
//   (packages/nucleo/ui), que vai junto quando o núcleo é empacotado sem este pacote;
// - uma cópia do marca.ts em cada plugin que o usa, porque um módulo de hooks só
//   importa arquivos de dentro do próprio plugin.
// Roda com: node packages/marca/src/gerar.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const raiz = new URL('../../../', import.meta.url)

export const FONTE = new URL('docs/brand/tokens.json', raiz)

// Caminho relativo à raiz do repositório e conteúdo de cada saída.
export const SAIDAS = {
  ts: ['packages/marca/gerado/marca.ts', 'spikes/painel-teste/hooks/marca.ts', 'plugins/ahrena-console/hooks/marca.ts'],
  css: ['packages/marca/gerado/marca.css', 'packages/nucleo/ui/marca.css'],
}

// Escalas que o tokens.json guarda só como histórico e marca como "não usar".
const FORA = new Set(['purple', 'pink'])
const PALETA = ['orange', 'rose', 'yellow', 'green', 'red', 'gray', 'mono']
const TEMAS = ['dark', 'light'] as const

type Tokens = Record<string, any>

export function lerTokens(): Tokens {
  return JSON.parse(readFileSync(FONTE, 'utf8'))
}

// Tira as notas (_chave) e o texto explicativo (motivo), que não são tokens.
function limpo(valor: any): any {
  if (Array.isArray(valor) || valor === null || typeof valor !== 'object') return valor
  return Object.fromEntries(
    Object.entries(valor)
      .filter(([k]) => !k.startsWith('_') && k !== 'motivo')
      .map(([k, v]) => [k, limpo(v)]),
  )
}

const cabecalho = (comentario: string) =>
  `${comentario} Gerado por packages/marca/src/gerar.ts a partir de docs/brand/tokens.json. Não edite: mude o tokens.json e rode \`node packages/marca/src/gerar.ts\`.\n`

export function gerarTs(tokens: Tokens): string {
  for (const escala of Object.keys(tokens)) {
    if (!escala.startsWith('_') && !FORA.has(escala) && !PALETA.includes(escala) && !['ci', 'themes', 'status', 'typography'].includes(escala)) {
      throw new Error(`escala nova no tokens.json: ${escala}. Decida se entra na paleta (PALETA) ou fica de fora (FORA).`)
    }
  }
  const paleta = Object.fromEntries(PALETA.map(k => [k, limpo(tokens[k])]))
  const status = limpo(tokens.status)
  const partes = [
    ['paleta', paleta],
    ['ci', limpo(tokens.ci)],
    ['temas', limpo(tokens.themes)],
    ['ordemStatus', tokens.status._ordem],
    ['status', status],
    ['tipografia', limpo(tokens.typography)],
  ] as const
  const corpo = partes.map(([nome, valor]) => `export const ${nome} = ${JSON.stringify(valor, null, 2)} as const\n`).join('\n')
  return `${cabecalho('//')}\n${corpo}\nexport type Tema = keyof typeof temas\nexport type StatusId = (typeof ordemStatus)[number]\n`
}

const variavel = (nome: string, valor: string | number) => `  --${nome}: ${valor};`
const kebab = (s: string) => s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

function variaveisDoTema(tokens: Tokens, tema: (typeof TEMAS)[number]): string[] {
  const linhas = Object.entries(limpo(tokens.themes[tema])).map(([papel, cor]) => variavel(kebab(papel), cor as string))
  for (const id of tokens.status._ordem) {
    for (const [papel, cor] of Object.entries(tokens.status[id][tema])) linhas.push(variavel(`status-${id}-${papel}`, cor as string))
  }
  return linhas
}

export function gerarCss(tokens: Tokens): string {
  const fixas: string[] = []
  for (const escala of PALETA) {
    for (const [degrau, cor] of Object.entries(limpo(tokens[escala]))) fixas.push(variavel(`${escala}-${degrau}`, cor as string))
  }
  for (const [nome, cor] of Object.entries(limpo(tokens.ci))) fixas.push(variavel(`ci-${nome}`, cor as string))
  for (const id of tokens.status._ordem) fixas.push(variavel(`status-${id}`, tokens.status[id].color))
  fixas.push(variavel('badge-alpha', tokens.status._badgeAlpha))
  const tipo = tokens.typography
  fixas.push(variavel('font-sans', tipo.sans), variavel('font-mono', tipo.mono))
  for (const [nome, v] of Object.entries(tipo.size)) fixas.push(variavel(`text-${nome}`, v as string))
  for (const [nome, v] of Object.entries(tipo.weight)) fixas.push(variavel(`weight-${nome}`, v as number))

  const escuro = variaveisDoTema(tokens, 'dark')
  const claro = variaveisDoTema(tokens, 'light')
  const indentar = (linhas: string[]) => linhas.map(l => `  ${l}`)
  return [
    cabecalho('/*').replace(/\n$/, ' */\n'),
    `/* Fontes: ${tipo.googleFonts} */`,
    '',
    '/* Escuro é o padrão. */',
    ':root {',
    '  color-scheme: dark;',
    ...fixas,
    ...escuro,
    '}',
    '',
    '/* Claro: pelo sistema, a menos que a página fixe data-theme="dark". */',
    '@media (prefers-color-scheme: light) {',
    '  :root:not([data-theme="dark"]) {',
    '    color-scheme: light;',
    ...indentar(claro),
    '  }',
    '}',
    '',
    '/* Claro: fixado pela página. */',
    ':root[data-theme="light"] {',
    '  color-scheme: light;',
    ...claro,
    '}',
    '',
  ].join('\n')
}

export function gerar(tokens: Tokens = lerTokens()): Record<string, string> {
  const ts = gerarTs(tokens)
  const css = gerarCss(tokens)
  return Object.fromEntries([...SAIDAS.ts.map(p => [p, ts]), ...SAIDAS.css.map(p => [p, css])])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [caminho, conteudo] of Object.entries(gerar())) {
    writeFileSync(new URL(caminho, raiz), conteudo)
    console.log(`gerado ${caminho}`)
  }
}
