// Os três estados que toda tela tem (C19): carregando, vazio e erro, e a faixa de erro parcial.
// Cada função devolve um nó; a tela põe onde quiser (a área inteira ou um cartão).

import { el, icone } from './dom.js';

/** Esqueleto em blocos de três linhas, enquanto a primeira leitura não volta. */
export function carregando({ rotulo = 'Carregando', blocos = 3 } = {}) {
  const linhas = [];
  for (let i = 0; i < blocos; i++) linhas.push(el('div', { class: 'bone short' }), el('div', { class: 'bone' }), el('div', { class: 'bone medium' }));
  return el('section', { class: 'card state loading', 'aria-busy': 'true', 'aria-label': rotulo }, el('div', { class: 'eyebrow' }, rotulo), ...linhas);
}

/** Nada para mostrar: ícone, título, texto e, se houver, uma ação em botão contornado. */
export function vazio({ icone: nome = 'empty', titulo, texto, acao = null }) {
  return el(
    'section',
    { class: 'card state center' },
    el('div', { class: 'seal' }, icone(nome)),
    el('h2', {}, titulo),
    texto ? el('p', {}, texto) : null,
    acao ? el('button', { type: 'button', class: 'btn outline', aoClicar: acao.aoClicar }, acao.icone ? icone(acao.icone) : null, acao.rotulo) : null,
  );
}

/** A leitura falhou: ícone de sem conexão, a explicação e "Tentar de novo" em destaque. */
export function erro({ titulo = 'Sem conexão com o núcleo', texto, tentar = null }) {
  return el(
    'section',
    { class: 'card state center', role: 'alert' },
    el('div', { class: 'seal error' }, icone('offline')),
    el('h2', {}, titulo),
    texto ? el('p', {}, texto) : null,
    tentar ? el('button', { type: 'button', class: 'btn filled', aoClicar: tentar }, icone('refresh'), 'Tentar de novo') : null,
  );
}

/** Erro de uma parte, com o resto da tela no ar: a faixa vermelha com o título em destaque. */
export function faixaDeErro({ titulo, texto, acao = null }) {
  return el(
    'div',
    { class: 'error-band', role: 'alert' },
    icone('error'),
    el('p', {}, el('b', {}, titulo), texto ? ` ${texto}` : null),
    acao ? el('button', { type: 'button', class: 'btn outline', aoClicar: acao.aoClicar }, acao.rotulo) : null,
  );
}
