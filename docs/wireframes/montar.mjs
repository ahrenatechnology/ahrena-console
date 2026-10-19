// Copia packages/marca/gerado/marca.css para dentro de docs/wireframes/index.html, entre os
// marcadores "marca:inicio" e "marca:fim". O artefato publicado não carrega CSS de outro
// endereço, então as cores vão embutidas, sempre iguais às geradas do tokens.json.
//   node docs/wireframes/montar.mjs          atualiza a página
//   node docs/wireframes/montar.mjs --checar falha se a cópia estiver velha
import { readFileSync, writeFileSync } from 'node:fs'

const raiz = new URL('../../', import.meta.url)
const pagina = new URL('docs/wireframes/index.html', raiz)
const marca = readFileSync(new URL('packages/marca/gerado/marca.css', raiz), 'utf8').trim()
const html = readFileSync(pagina, 'utf8')
const re = /(\/\* marca:inicio[^\n]*\*\/\n)[\s\S]*?(\/\* marca:fim \*\/)/
if (!re.test(html)) throw new Error('marcadores marca:inicio/marca:fim não encontrados')
const novo = html.replace(re, (_, a, b) => `${a}${marca}\n${b}`)
if (process.argv.includes('--checar')) {
  if (novo !== html) { console.error('A cópia do marca.css em index.html está velha: rode node docs/wireframes/montar.mjs'); process.exit(1) }
  console.log('marca.css em dia')
} else {
  writeFileSync(pagina, novo)
  console.log('marca.css copiado para docs/wireframes/index.html')
}
