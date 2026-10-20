// Frontmatter YAML mínimo, sem dependência: só `chave: valor` no primeiro nível, com aspas simples
// ou duplas, e o valor em várias linhas (dobrado `>`, literal `|`, ou a continuação indentada de um
// valor simples). Basta para o `name` e a `description` de skills e subagentes; o resto do YAML
// (listas, objetos) é ignorado sem erro.

const ABRE = /^﻿?---[ \t]*\r?\n/;
const CHAVE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;

function semAspas(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Os campos de texto do frontmatter; `{}` sem frontmatter. */
export function lerFrontmatter(texto: string): Record<string, string> {
  const abre = ABRE.exec(texto);
  if (!abre) return {};
  const resto = texto.slice(abre[0].length);
  const fim = /^---[ \t]*$/m.exec(resto);
  if (!fim) return {};
  const linhas = resto.slice(0, fim.index).split(/\r?\n/);
  const campos: Record<string, string> = {};
  for (let i = 0; i < linhas.length; i++) {
    const m = CHAVE.exec(linhas[i]);
    if (!m) continue;
    const valor = m[2].trim();
    const continuacao: string[] = [];
    while (i + 1 < linhas.length && (linhas[i + 1].trim() === '' || /^[ \t]/.test(linhas[i + 1]))) continuacao.push(linhas[++i].trim());
    while (continuacao.length && continuacao[continuacao.length - 1] === '') continuacao.pop();
    if (/^[>|][+-]?$/.test(valor)) {
      campos[m[1]] = valor.startsWith('|') ? continuacao.join('\n') : continuacao.join(' ').replace(/ {2,}/g, ' ').trim();
    } else if (valor !== '') {
      campos[m[1]] = semAspas([valor, ...continuacao.filter(Boolean)].join(' '));
    } else if (continuacao.length && !continuacao[0].startsWith('-')) {
      campos[m[1]] = continuacao.filter(Boolean).join(' ');
    }
  }
  return campos;
}
