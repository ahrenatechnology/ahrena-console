// A minimal DOM to mount the /ui screens in node, with no dependency: only what `dom.js`, `states.js`
// and the screens use (creating nodes, attributes, classes, bubbling events; `stopPropagation` stops the bubbling).
// `querySelector`, `querySelectorAll` and `closest` take what the browser takes of the selectors the screens use: a
// comma-separated list; per item the descendant combinator and the child combinator `>` (#610); per compound selector a tag,
// `*`, `.class`, `#id` and `[attribute]` with `=`, `~=`, `|=`, `^=`, `$=` or `*=` and a double-quoted, single-quoted or
// unquoted value. Pseudo-classes, pseudo-elements and the sibling combinators are not supported. What the grammar does not
// accept (an unterminated value, an empty list item, a stray token) throws a SyntaxError, as in the browser. Also `contains`,
// `firstChild`, `style.setProperty` (a CSS variable through CSSOM) and a `document.head`.

type Ouvinte = (ev: EventoFalso) => void;

export interface EventoFalso {
  type: string;
  target?: ElementoFalso;
  currentTarget?: ElementoFalso;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  [k: string]: unknown;
}

export class NoFalso {
  parentNode: ElementoFalso | null = null;
  get textContent(): string {
    return '';
  }
}

export class TextoFalso extends NoFalso {
  data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
}

export class ElementoFalso extends NoFalso {
  readonly tagName: string;
  childNodes: NoFalso[] = [];
  readonly atributos = new Map<string, string>();
  readonly ouvintes = new Map<string, Set<Ouvinte>>();
  value = '';
  innerHTMLFalso = '';
  // Scroll metrics: 0 by default; a test sets them on a scroll container to drive the stuck-to-bottom logic.
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  scrollIntoView(): void {}
  scrollTo(): void {}

  get children(): ElementoFalso[] {
    return this.childNodes.filter((n): n is ElementoFalso => n instanceof ElementoFalso);
  }
  get lastChild(): NoFalso | null {
    return this.childNodes.at(-1) ?? null;
  }
  get firstChild(): NoFalso | null {
    return this.childNodes[0] ?? null;
  }
  /** As propriedades postas por CSSOM (`style.setProperty('--w', '40%')`). */
  readonly style = (() => {
    const props = new Map<string, string>();
    return {
      setProperty: (k: string, v: string) => void props.set(k, String(v)),
      getPropertyValue: (k: string) => props.get(k) ?? '',
      removeProperty: (k: string) => (props.delete(k), ''),
    };
  })();
  contains(no: unknown): boolean {
    for (let n = no as NoFalso | null; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  closest(seletor: string): ElementoFalso | null {
    const list = selectorList(seletor);
    for (let n: ElementoFalso | null = this; n; n = n.parentNode) if (list.some((parts) => casa(n!, parts, null))) return n;
    return null;
  }
  setAttribute(k: string, v: unknown): void {
    this.atributos.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.atributos.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.atributos.has(k);
  }
  removeAttribute(k: string): void {
    this.atributos.delete(k);
  }
  /** `hidden` reflects the attribute, as in the browser: `el.hidden = true/false` sets or clears it. */
  get hidden(): boolean {
    return this.hasAttribute('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }
  replaceWith(...nos: (NoFalso | string)[]): void {
    const p = this.parentNode;
    if (!p) return;
    for (const n of nos) p.insertBefore(typeof n === 'string' ? new TextoFalso(n) : n, this);
    this.remove();
  }
  get classList() {
    const read = () => new Set((this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
    const gravar = (s: Set<string>) => this.setAttribute('class', [...s].join(' '));
    return {
      contains: (c: string) => read().has(c),
      add: (...cs: string[]) => {
        const s = read();
        for (const c of cs) s.add(c);
        gravar(s);
      },
      remove: (...cs: string[]) => {
        const s = read();
        for (const c of cs) s.delete(c);
        gravar(s);
      },
      toggle: (c: string, forca?: boolean) => {
        const s = read();
        const ligar = forca ?? !s.has(c);
        if (ligar) s.add(c);
        else s.delete(c);
        gravar(s);
        return ligar;
      },
    };
  }
  get dataset(): Record<string, string> {
    const dono = this;
    const nome = (k: string) => `data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    return new Proxy({} as Record<string, string>, {
      get: (_, k: string) => dono.getAttribute(nome(k)) ?? undefined,
      set: (_, k: string, v) => (dono.setAttribute(nome(k), v), true),
    });
  }
  private adotar(n: NoFalso | string): NoFalso {
    const no = typeof n === 'string' ? new TextoFalso(n) : n;
    if (no.parentNode) {
      blurIfInside(no);
      no.parentNode.childNodes = no.parentNode.childNodes.filter((c) => c !== no);
    }
    no.parentNode = this;
    return no;
  }
  append(...nos: (NoFalso | string)[]): void {
    if (nos.some((n) => n === null || n === undefined)) throw new TypeError('append com null');
    for (const n of nos) this.childNodes.push(this.adotar(n));
  }
  insertBefore(n: NoFalso, ref: NoFalso | null): NoFalso {
    const no = this.adotar(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(no);
    else this.childNodes.splice(i, 0, no);
    return no;
  }
  replaceChildren(...nos: (NoFalso | string)[]): void {
    // Como o navegador: `null` viraria o texto "null"; aqui é erro, para pegar o engano.
    if (nos.some((n) => n === null || n === undefined)) throw new TypeError('replaceChildren com null');
    for (const c of this.childNodes) {
      blurIfInside(c);
      c.parentNode = null;
    }
    this.childNodes = [];
    this.append(...nos);
  }
  remove(): void {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  override get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  override set textContent(v: string) {
    this.replaceChildren(new TextoFalso(String(v)));
  }
  set innerHTML(v: string) {
    this.innerHTMLFalso = v;
    this.childNodes = [];
  }
  addEventListener(tipo: string, f: Ouvinte): void {
    if (!this.ouvintes.has(tipo)) this.ouvintes.set(tipo, new Set());
    this.ouvintes.get(tipo)!.add(f);
  }
  removeEventListener(tipo: string, f: Ouvinte): void {
    this.ouvintes.get(tipo)?.delete(f);
  }
  dispatchEvent(ev: EventoFalso): boolean {
    ev.target ??= this;
    ev.preventDefault ??= () => void (ev.defaultPrevented = true);
    let stopped = false;
    ev.stopPropagation ??= () => void (stopped = true);
    for (let no: ElementoFalso | null = this; no && !stopped; no = no.parentNode) {
      ev.currentTarget = no;
      for (const f of no.ouvintes.get(ev.type) ?? []) f(ev);
    }
    return !ev.defaultPrevented;
  }
  focus(): void {
    documentoFalso.activeElement = this;
  }
  click(): void {
    this.dispatchEvent({ type: 'click' });
  }
  querySelectorAll(seletor: string): ElementoFalso[] {
    const list = selectorList(seletor);
    const matches: ElementoFalso[] = [];
    const visitar = (no: ElementoFalso) => {
      for (const filho of no.children) {
        if (list.some((parts) => casa(filho, parts, this))) matches.push(filho);
        visitar(filho);
      }
    };
    visitar(this);
    return matches;
  }
  querySelector(seletor: string): ElementoFalso | null {
    return this.querySelectorAll(seletor)[0] ?? null;
  }
}

const ATTRIBUTE = String.raw`\[\s*([\w-]+)\s*(?:([~|^$*]?)=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]"'\\]+))\s*)?\]`;
const COMPOUND = String.raw`(?:\[\s*[\w-]+\s*(?:[~|^$*]?=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]"'\\]+)\s*)?\]|\\.|[^\s\[\\,>])+`;

/**
 * A selector list as the browser reads it: one array per comma-separated item, each a sequence of compound selectors
 * and `>`. A quoted attribute value ends at the first unescaped quote; whatever the grammar does not accept is a SyntaxError. (#566)
 */
function selectorList(selector: string): string[][] {
  const invalid = () => new SyntaxError(`'${selector}' is not a valid selector`);
  const tokens = [...selector.matchAll(new RegExp(`${COMPOUND}|[,>]`, 'g'))];
  // Anything between two tokens that is not whitespace is something the grammar does not accept. (#566)
  let end = 0;
  for (const t of tokens) {
    if (selector.slice(end, t.index).trim()) throw invalid();
    end = t.index + t[0].length;
  }
  if (selector.slice(end).trim()) throw invalid();
  const list: string[][] = [[]];
  for (const t of tokens) {
    if (t[0] === ',') list.push([]);
    else list.at(-1)!.push(t[0]);
  }
  for (const parts of list) {
    const bad = parts.length === 0 || parts[0] === '>' || parts.at(-1) === '>' || parts.some((p, i) => p === '>' && parts[i - 1] === '>');
    if (bad) throw invalid();
  }
  return list;
}

/** A name or a quoted attribute value with its CSS escapes undone (`\\"` is `"`, `\\\\` is `\`, `\\2f ` is `/`). (#566) */
function cssUnescape(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6}) ?|\\(.)/gi, (_, hex?: string, c?: string) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : c!));
}

/** `CSS.escape` as the CSSOM spec defines it, which Node does not have. (#566) */
function cssEscape(value: unknown): string {
  const s = String(value);
  return Array.from(s, (ch, i) => {
    const c = ch.codePointAt(0)!;
    if (c === 0) return '\uFFFD';
    if ((c >= 1 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) || (i === 1 && c >= 0x30 && c <= 0x39 && s[0] === '-')) return `\\${c.toString(16)} `;
    if (i === 0 && c === 0x2d && s.length === 1) return `\\${ch}`;
    if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return ch;
    return `\\${ch}`;
  }).join('');
}

function casaSimples(no: ElementoFalso, simple: string): boolean {
  // The class, id and tag are read outside the `[...]` blocks: an attribute value is not a class or an id. (#566)
  const bare = simple.replace(new RegExp(ATTRIBUTE, 'g'), '');
  const tag = /^(?:[a-z][a-z0-9-]*|\*)/i.exec(bare)?.[0];
  if (tag && tag !== '*' && no.tagName !== tag.toUpperCase()) return false;
  for (const [, c] of bare.matchAll(/\.((?:[\w-]|\\.)+)/g)) if (!no.classList.contains(cssUnescape(c!))) return false;
  for (const [, id] of bare.matchAll(/#((?:[\w-]|\\.)+)/g)) if (no.getAttribute('id') !== cssUnescape(id!)) return false;
  for (const [, k, op, double, single, bareValue] of simple.matchAll(new RegExp(ATTRIBUTE, 'g'))) {
    if (!no.hasAttribute(k!)) return false;
    const raw = double ?? single ?? bareValue;
    if (raw === undefined) continue;
    const expected = cssUnescape(raw);
    const actual = no.getAttribute(k!)!;
    if (op === '') {
      if (actual !== expected) return false;
    } else if (!expected) {
      return false; // `^=`, `$=`, `*=` and `~=` with an empty value match nothing (#566)
    } else if (op === '^') {
      if (!actual.startsWith(expected)) return false;
    } else if (op === '$') {
      if (!actual.endsWith(expected)) return false;
    } else if (op === '*') {
      if (!actual.includes(expected)) return false;
    } else if (op === '~') {
      if (/\s/.test(expected) || !actual.split(/\s+/).includes(expected)) return false;
    } else if (actual !== expected && !actual.startsWith(`${expected}-`)) return false;
  }
  return true;
}

function casa(no: ElementoFalso, partes: string[], raiz: ElementoFalso | null): boolean {
  if (!casaSimples(no, partes.at(-1)!)) return false;
  let i = partes.length - 2;
  let p = no.parentNode;
  while (i >= 0) {
    // The child combinator (`a > b`, #610): the parent itself must match, not just an ancestor.
    const isChild = partes[i] === '>';
    const target = partes[isChild ? i - 1 : i];
    if (target === undefined) return false;
    if (isChild) {
      if (!p || p === raiz || !casaSimples(p, target)) return false;
      p = p.parentNode;
      i -= 2;
    } else {
      for (; p && p !== raiz; p = p.parentNode) if (casaSimples(p, target)) break;
      if (!p || p === raiz) return false;
      p = p.parentNode;
      i--;
    }
  }
  return true;
}

/** Like the browser, a focused element taken out of the tree (even to be put back) loses the focus. */
function blurIfInside(no: NoFalso): void {
  const active = documentoFalso.activeElement;
  if (active && no instanceof ElementoFalso && no.contains(active)) documentoFalso.activeElement = null;
}

const cabecaFalsa = new ElementoFalso('head');

const ouvintesDoDocumento = new Map<string, Set<Ouvinte>>();

export const documentoFalso = {
  activeElement: null as ElementoFalso | null,
  addEventListener: (tipo: string, ouvinte: Ouvinte) => void (ouvintesDoDocumento.get(tipo) ?? ouvintesDoDocumento.set(tipo, new Set()).get(tipo)!).add(ouvinte),
  removeEventListener: (tipo: string, ouvinte: Ouvinte) => void ouvintesDoDocumento.get(tipo)?.delete(ouvinte),
  /** Entrega o evento aos ouvintes do documento (as teclas que não estão em nenhum campo). */
  dispatchEvent: (ev: EventoFalso) => void [...(ouvintesDoDocumento.get(ev.type) ?? [])].forEach((o) => o({ preventDefault() {}, ...ev })),
  head: cabecaFalsa,
  querySelector: (seletor: string) => cabecaFalsa.querySelector(seletor),
  createElement: (tag: string) => new ElementoFalso(tag),
  createElementNS: (_ns: string, tag: string) => new ElementoFalso(tag),
  createTextNode: (texto: string) => new TextoFalso(texto),
};

/** Põe o DOM falso no global (`document`, `Node` e `Element`), como o navegador. */
export function instalarDomFalso(): void {
  Object.assign(globalThis, { document: documentoFalso, Node: NoFalso, Element: ElementoFalso, CSS: { escape: cssEscape } });
}

/** Todo o texto de um nó, um pedaço por nó de texto, com espaços normalizados. */
export function texto(no: NoFalso | null): string {
  const pedacos: string[] = [];
  const visitar = (n: NoFalso) => (n instanceof ElementoFalso ? n.childNodes.forEach(visitar) : pedacos.push(n.textContent));
  if (no) visitar(no);
  return pedacos.join(' ').replace(/\s+/g, ' ').trim();
}
