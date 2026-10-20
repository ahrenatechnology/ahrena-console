// The three states every screen has (C19): loading, empty and error, and the partial error band.
// Each function returns a node; the screen puts it where it wants (the whole area or a card).

import { el, icon } from './dom.js';

/** Skeleton in blocks of three lines, while the first read has not come back. */
export function loading({ label = 'Carregando', blocks = 3 } = {}) {
  const lines = [];
  for (let i = 0; i < blocks; i++) lines.push(el('div', { class: 'bone short' }), el('div', { class: 'bone' }), el('div', { class: 'bone medium' }));
  return el('section', { class: 'card state loading', 'aria-busy': 'true', 'aria-label': label }, el('div', { class: 'eyebrow' }, label), ...lines);
}

/** Nothing to show: icon, title, text and, when there is one, an action in an outline button. */
export function empty({ icon: name = 'empty', title, text, action = null }) {
  return el(
    'section',
    { class: 'card state center' },
    el('div', { class: 'seal' }, icon(name)),
    el('h2', {}, title),
    text ? el('p', {}, text) : null,
    action ? el('button', { type: 'button', class: 'btn outline', onClick: action.onClick }, action.icon ? icon(action.icon) : null, action.label) : null,
  );
}

/** The read failed: the offline icon, the explanation and "Tentar de novo" highlighted. */
export function error({ title = 'Sem conexão com o núcleo', text, retry = null }) {
  return el(
    'section',
    { class: 'card state center', role: 'alert' },
    el('div', { class: 'seal error' }, icon('offline')),
    el('h2', {}, title),
    text ? el('p', {}, text) : null,
    retry ? el('button', { type: 'button', class: 'btn filled', onClick: retry }, icon('refresh'), 'Tentar de novo') : null,
  );
}

/** Error in one part, with the rest of the screen still up: the red band with the title highlighted. */
export function errorBand({ title, text, action = null }) {
  return el(
    'div',
    { class: 'error-band', role: 'alert' },
    icon('error'),
    el('p', {}, el('b', {}, title), text ? ` ${text}` : null),
    action ? el('button', { type: 'button', class: 'btn outline', onClick: action.onClick }, action.label) : null,
  );
}
