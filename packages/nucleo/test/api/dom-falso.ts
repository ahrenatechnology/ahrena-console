// Um DOM mínimo para montar as telas da /ui no node, sem dependência: só o que `dom.js`, `estados.js`
// e as telas usam (criar nós, atributos, classes, eventos com bolha e um `querySelector` de seletores
// simples: tag, `.classe`, `[atributo]`, `[atributo="valor"]` e descendente). Também `closest`,
// `contains`, `firstChild`, `style.setProperty` (variável CSS por CSSOM) e um `document.head`.

type Ouvinte = (ev: EventoFalso) => void;

export interface EventoFalso {
  type: string;
  target?: ElementoFalso;
  currentTarget?: ElementoFalso;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
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

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

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
    for (let n: ElementoFalso | null = this; n; n = n.parentNode) if (casaSimples(n, seletor.trim())) return n;
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
  get classList() {
    const ler = () => new Set((this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
    const gravar = (s: Set<string>) => this.setAttribute('class', [...s].join(' '));
    return {
      contains: (c: string) => ler().has(c),
      add: (...cs: string[]) => {
        const s = ler();
        for (const c of cs) s.add(c);
        gravar(s);
      },
      remove: (...cs: string[]) => {
        const s = ler();
        for (const c of cs) s.delete(c);
        gravar(s);
      },
      toggle: (c: string, forca?: boolean) => {
        const s = ler();
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
    if (no.parentNode) no.parentNode.childNodes = no.parentNode.childNodes.filter((c) => c !== no);
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
    for (const c of this.childNodes) c.parentNode = null;
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
    for (let no: ElementoFalso | null = this; no; no = no.parentNode) {
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
    const partes = seletor.trim().split(/\s+/);
    const achados: ElementoFalso[] = [];
    const visitar = (no: ElementoFalso) => {
      for (const filho of no.children) {
        if (casa(filho, partes, this)) achados.push(filho);
        visitar(filho);
      }
    };
    visitar(this);
    return achados;
  }
  querySelector(seletor: string): ElementoFalso | null {
    return this.querySelectorAll(seletor)[0] ?? null;
  }
}

function casaSimples(no: ElementoFalso, simples: string): boolean {
  const tag = /^[a-z][a-z0-9-]*/i.exec(simples)?.[0];
  if (tag && no.tagName !== tag.toUpperCase()) return false;
  for (const [, c] of simples.matchAll(/\.([\w-]+)/g)) if (!no.classList.contains(c!)) return false;
  for (const [, k, v] of simples.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (!no.hasAttribute(k!)) return false;
    if (v !== undefined && no.getAttribute(k!) !== v) return false;
  }
  return true;
}

function casa(no: ElementoFalso, partes: string[], raiz: ElementoFalso): boolean {
  if (!casaSimples(no, partes.at(-1)!)) return false;
  let i = partes.length - 2;
  for (let p = no.parentNode; p && p !== raiz && i >= 0; p = p.parentNode) if (casaSimples(p, partes[i]!)) i--;
  return i < 0;
}

const cabecaFalsa = new ElementoFalso('head');

export const documentoFalso = {
  activeElement: null as ElementoFalso | null,
  head: cabecaFalsa,
  querySelector: (seletor: string) => cabecaFalsa.querySelector(seletor),
  createElement: (tag: string) => new ElementoFalso(tag),
  createElementNS: (_ns: string, tag: string) => new ElementoFalso(tag),
  createTextNode: (texto: string) => new TextoFalso(texto),
};

/** Põe o DOM falso no global (`document`, `Node` e `Element`), como o navegador. */
export function instalarDomFalso(): void {
  Object.assign(globalThis, { document: documentoFalso, Node: NoFalso, Element: ElementoFalso });
}

/** Todo o texto de um nó, um pedaço por nó de texto, com espaços normalizados. */
export function texto(no: NoFalso | null): string {
  const pedacos: string[] = [];
  const visitar = (n: NoFalso) => (n instanceof ElementoFalso ? n.childNodes.forEach(visitar) : pedacos.push(n.textContent));
  if (no) visitar(no);
  return pedacos.join(' ').replace(/\s+/g, ' ').trim();
}
