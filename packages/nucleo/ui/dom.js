// Peças de DOM da interface. Texto entra sempre por `textContent`: nada vindo do núcleo vira HTML.

// Ícones do Lucide (ISC), em traço com `currentColor`: a cor vem do CSS.
const ICONES = {
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  sessoes: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  'ao-vivo': '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
  porta: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  vazio: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  'sem-conexao': '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  erro: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  atualizar: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  voltar: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  // Workflows (issue 96) e a aba Workflow do detalhe (issue 97). Os nomes que o PR 153 também traz
  // (subagente, ok, cronometro, camadas, externo, seta-*) são os mesmos ícones, com o mesmo traço.
  workflows: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  grafo: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  subagente: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
  usuarios: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  repetir: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  cronometro: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  camadas: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  externo: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  'seta-direita': '<path d="m9 18 6-6-6-6"/>',
  'seta-baixo': '<path d="m6 9 6 6 6-6"/>',
  seta: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  gantt: '<path d="M8 6h10"/><path d="M6 12h9"/><path d="M11 18h7"/>',
};

/** Os nomes dos ícones que existem (o teste confere os que as telas usam). */
export const NOMES_DOS_ICONES = Object.keys(ICONES);

const SVG = 'http://www.w3.org/2000/svg';

export function icone(nome) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icone' })) svg.setAttribute(k, v);
  svg.innerHTML = ICONES[nome] ?? '';
  return svg;
}

/** `el('a', { class: 'x', href: '/ui', aoClicar: fn }, 'texto', outroNo)` */
export function el(tag, atributos = {}, ...filhos) {
  const no = document.createElement(tag);
  for (const [k, v] of Object.entries(atributos ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'aoClicar') no.addEventListener('click', v);
    else no.setAttribute(k, v === true ? '' : String(v));
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    no.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return no;
}

/** A pílula "Ao vivo" do cabeçalho, ligada ao estado do long polling pela moldura. */
export function pilulaAoVivo() {
  return el('span', { class: 'live', 'data-ao-vivo': '' }, 'Ao vivo');
}

/** O cabeçalho de uma tela (C1): ícone, título com "Ao vivo", subtítulo e ações à direita. */
export function cabecalho({ icone: nome, titulo, sub, acoes = [] }) {
  return el(
    'header',
    { class: 'cc-cab' },
    el('div', { class: 'ico' }, icone(nome)),
    el('div', {}, el('h1', {}, titulo, ' ', pilulaAoVivo()), sub ? el('div', { class: 'sub' }, sub) : null),
    acoes.length ? el('div', { class: 'acoes' }, ...acoes) : null,
  );
}
