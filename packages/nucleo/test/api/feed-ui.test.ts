// O Feed de atividade na /ui (#94): o estado (lista, pausa, cursor, tempo) e a tela montada sobre um
// DOM mínimo, com um `ctx` falso que devolve respostas fixas de `GET /api/events`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import * as E from '../../ui/screens/feed-state.js';

// ---------- um DOM mínimo, só o que el(), icone() e a tela usam ----------

class No {
  childNodes: No[] = [];
  parentNode: No | null = null;
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(t: string) {
    this.replaceChildren(...(t ? [new Texto(t)] : []));
  }
  #entrar(n: No | string) {
    const no = typeof n === 'string' ? new Texto(n) : n;
    no.remove();
    no.parentNode = this;
    return no;
  }
  append(...ns: (No | string)[]) {
    for (const n of ns) this.childNodes.push(this.#entrar(n));
  }
  prepend(...ns: (No | string)[]) {
    this.childNodes.unshift(...ns.map((n) => this.#entrar(n)));
  }
  replaceChildren(...ns: (No | string)[]) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...ns);
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.childNodes = p.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
}

class Texto extends No {
  dado: string;
  constructor(dado: string) {
    super();
    this.dado = dado;
  }
  override get textContent() {
    return this.dado;
  }
}

type Ouvinte = (e: { target: Elemento; stopPropagation(): void }) => void;

class Elemento extends No {
  atributos = new Map<string, string>();
  ouvintes = new Map<string, Ouvinte[]>();
  value = '';
  disabled = false;
  html: string | null = null;
  tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
  setAttribute(k: string, v: string) {
    this.atributos.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.atributos.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.atributos.delete(k);
  }
  get hidden() {
    return this.atributos.has('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.atributos.set('hidden', '');
    else this.atributos.delete('hidden');
  }
  get classes() {
    return (this.atributos.get('class') ?? '').split(/\s+/).filter(Boolean);
  }
  set innerHTML(h: string) {
    this.html = h; // só os ícones usam, com texto fixo de dom.js
  }
  addEventListener(tipo: string, f: Ouvinte) {
    this.ouvintes.set(tipo, [...(this.ouvintes.get(tipo) ?? []), f]);
  }
  /** Clique que sobe pelos pais, como no navegador. */
  click() {
    let parar = false;
    const ev = { target: this as Elemento, stopPropagation: () => (parar = true) };
    for (let no: No | null = this; no && !parar; no = no.parentNode) if (no instanceof Elemento) for (const f of no.ouvintes.get('click') ?? []) f(ev);
  }
  casa(sel: string): boolean {
    return sel.split(',').some((s) => {
      s = s.trim();
      const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(s);
      if (!m) throw new Error(`seletor que o DOM falso não conhece: ${s}`);
      if (m[1] && m[1] !== this.tagName) return false;
      for (const c of m[2]!.split('.').filter(Boolean)) if (!this.classes.includes(c)) return false;
      if (m[3] && this.getAttribute(m[3]) !== m[4]) return false;
      return true;
    });
  }
  closest(sel: string): Elemento | null {
    for (let no: No | null = this; no; no = no.parentNode) if (no instanceof Elemento && no.casa(sel)) return no;
    return null;
  }
  querySelectorAll(sel: string): Elemento[] {
    const achados: Elemento[] = [];
    const andar = (no: No) => {
      for (const c of no.childNodes) if (c instanceof Elemento) (c.casa(sel) && achados.push(c), andar(c));
    };
    andar(this);
    return achados;
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

const documento = {
  head: new Elemento('head'),
  createElement: (t: string) => new Elemento(t),
  createElementNS: (_ns: string, t: string) => new Elemento(t),
  createTextNode: (t: string) => new Texto(t),
};

// ---------- respostas ----------

const agora = Date.now();
const iso = (s: number) => new Date(agora - s * 1000).toISOString();
const evento = (id: string, s: number, extra: Record<string, unknown> = {}) => ({
  id,
  createdAt: iso(s),
  type: 'PreToolUse',
  status: 'active',
  tool: 'Bash',
  summary: `Bash: npm test ${id}`,
  session: { id: 'c3f09b52-4e1', title: 'Separar pagamentos em serviços', project: 'motor-de-regras' },
  agent: { id: 'a7c2e0', name: 'test-runner' },
  detail: { callId: 'toolu_01', input: 'npm test -- cobranca' },
  ...extra,
});

describe('Feed de atividade: estado', () => {
  test('tempo relativo, hora e data local', () => {
    const t = Date.parse('2026-10-18T23:12:04Z');
    assert.equal(E.relativeTime(new Date(t).toISOString(), t + 2000), 'agora');
    assert.equal(E.relativeTime(new Date(t).toISOString(), t + 12_000), '12 s');
    assert.equal(E.relativeTime(new Date(t).toISOString(), t + 61_000), '1 min');
    assert.equal(E.relativeTime(new Date(t).toISOString(), t + 2 * 3600_000), '2 h');
    assert.equal(E.relativeTime('lixo'), '');
    assert.match(E.shortTime(new Date(t).toISOString()), /^\d{2}:\d{2}$/);
    assert.match(E.dateTime(new Date(t).toISOString()), /^\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('a consulta codifica cada parâmetro e pula os vazios', () => {
    assert.equal(E.query({}), '/api/events');
    assert.equal(E.query({ search: ' a&b=c ', type: '', session: 'x/y' }, { after: 'k 1' }), '/api/events?after=k%201&session=x%2Fy&search=a%26b%3Dc');
    assert.ok(E.hasFilter({ status: 'error' }));
    assert.ok(!E.hasFilter({ status: '', search: '  ' }));
  });

  test('o caminho escreve o agente: main é "principal", subagent sem tipo é "subagente", o tipo fica como veio', () => {
    const ev = (name: string | null) => ({ session: { id: 's1', title: 'Título', project: 'proj' }, agent: { id: null, name } });
    assert.equal(E.trail(ev('main')), 'proj › Título › principal');
    assert.equal(E.trail(ev('subagent')), 'proj › Título › subagente');
    assert.equal(E.trail(ev('test-runner')), 'proj › Título › test-runner');
    assert.equal(E.trail({ session: { id: 's1', title: null, project: null }, agent: { name: null } }), 's1');
  });

  test('só id que serve de rota vira link para o Detalhe', () => {
    assert.equal(E.sessionRoute('c3f09b52-4e1'), '/ui/sessions/c3f09b52-4e1');
    for (const ruim of ['../x', 'a b', '', null, 'x'.repeat(129), 'javascript:alert(1)/']) assert.equal(E.sessionRoute(ruim), null, String(ruim));
  });

  test('pausa acumula os novos sem repetir e solta no topo ao retomar', () => {
    const s = E.newState();
    E.load(s, { events: [evento('b', 10), evento('a', 20)], cursor: 'c1', older: 'v1' });
    E.pause(s);
    assert.deepEqual(E.receiveNewer(s, { events: [evento('c', 5)], cursor: 'c2' }).entraram, []);
    E.receiveNewer(s, { events: [evento('d', 1), evento('c', 5)], cursor: 'c3' });
    assert.deepEqual(s.pendentes.map((e: { id: string }) => e.id), ['d', 'c']);
    assert.equal(s.cursor, 'c3');
    assert.deepEqual(s.events.map((e: { id: string }) => e.id), ['b', 'a'], 'a lista congela');
    const { entraram } = E.resume(s);
    assert.deepEqual(entraram.map((e: { id: string }) => e.id), ['d', 'c']);
    assert.deepEqual(s.events.map((e: { id: string }) => e.id), ['d', 'c', 'b', 'a']);
    assert.deepEqual(s.pendentes, []);
  });

  test('o evento gravado atrasado entra no lugar dele, não no topo', () => {
    const s = E.newState();
    E.load(s, { events: [evento('b', 10), evento('a', 30)], cursor: 'c1' });
    const r = E.receiveNewer(s, { events: [evento('novo', 1), evento('atrasado', 20)], cursor: 'c2' });
    assert.equal(r.noTopo, false);
    assert.deepEqual(s.events.map((e: { id: string }) => e.id), ['novo', 'b', 'atrasado', 'a']);
    assert.equal(E.receiveNewer(s, { events: [evento('topo', 0)], cursor: 'c3' }).noTopo, true);
  });

  test('a pausa guarda no máximo o limite, mas conta tudo o que chegou', () => {
    const s = E.newState();
    E.load(s, { events: [], cursor: 'c1' });
    E.pause(s);
    E.receiveNewer(s, { events: Array.from({ length: E.LIMIT }, (_, i) => evento(`p${i}`, 1000 + i)), cursor: 'c2' });
    E.receiveNewer(s, { events: [evento('ultimo', 1)], cursor: 'c3' });
    assert.equal(s.pendentes.length, E.LIMIT);
    assert.equal(s.pendentes[0].id, 'ultimo');
    assert.equal(s.chegados, E.LIMIT + 1);
    E.resume(s);
    assert.equal(s.chegados, 0);
  });

  test('o limite corta o fim e some com o "mostrar mais"', () => {
    const s = E.newState();
    E.load(s, { events: Array.from({ length: E.LIMIT }, (_, i) => evento(`v${i}`, 100 + i)), cursor: 'c', older: 'v' });
    const { cortados } = E.receiveNewer(s, { events: [evento('n1', 1), evento('n2', 2)], cursor: 'c2' });
    assert.equal(s.events.length, E.LIMIT);
    assert.deepEqual(cortados.map((e: { id: string }) => e.id), [`v${E.LIMIT - 2}`, `v${E.LIMIT - 1}`]);
    assert.equal(s.older, null);
  });
});

describe('Feed de atividade: a tela', () => {
  const salvo = { document: globalThis.document, Node: globalThis.Node };
  let mount: (area: unknown, ctx: unknown) => Promise<() => void>;
  before(async () => {
    Object.assign(globalThis, { document: documento, Node: No });
    // @ts-expect-error: idem
    ({ mount } = await import('../../ui/screens/feed.js'));
  });
  after(() => Object.assign(globalThis, salvo));

  function ctxFalso(responder: (rota: string) => unknown) {
    const pedidos: string[] = [];
    const ouvintes = { mudar: [] as (() => void)[], reiniciar: [] as (() => void)[] };
    const sair = new AbortController();
    return {
      pedidos,
      sair,
      mudar: () => ouvintes.mudar.forEach((f) => f()),
      ctx: {
        params: {},
        signal: sair.signal,
        read: async (rota: string) => (pedidos.push(rota), responder(rota)),
        onChange: (f: () => void) => ouvintes.mudar.push(f),
        onRestart: (f: () => void) => ouvintes.reiniciar.push(f),
        liveState: () => 'live',
        counter: () => {},
        titulo: () => {},
        navigate: () => {},
      },
    };
  }

  const linhasDe = (area: Elemento) => area.querySelectorAll('.feed-item').map((i) => i.getAttribute('data-id'));
  const espera = () => new Promise((r) => setTimeout(r, 0));

  test('desenha a lista, abre o detalhe, pausa com "N novos" e solta ao retomar; texto do núcleo entra como texto', async () => {
    const ataque = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    let fila: unknown[] = [
      {
        events: [evento('e2', 12, { summary: ataque, session: { id: '../fora', title: ataque, project: null } }), evento('e1', 70, { status: 'waiting', tool: null })],
        cursor: 'k2',
        older: null,
        options: { types: ['PreToolUse', 'Stop'], tools: ['Bash'], sessions: [{ id: 'c3f09b52-4e1', title: 'Separar pagamentos em serviços', project: 'motor-de-regras' }] },
      },
    ];
    const f = ctxFalso(() => fila.shift());
    const area = new Elemento('main');
    const limpar = await mount(area, f.ctx);

    assert.equal(f.pedidos[0], '/api/events');
    assert.ok(documento.head.querySelector('link[data-screen="feed"]'), 'o CSS da tela entrou no head');
    assert.deepEqual(linhasDe(area), ['e2', 'e1']);
    const [l2, l1] = area.querySelectorAll('.feed-item');
    assert.match(l1!.textContent, /Esperando você/);
    assert.match(l1!.textContent, /motor-de-regras › Separar pagamentos em serviços › test-runner/);
    assert.match(l1!.textContent, /1 min/);
    assert.equal(l1!.querySelector('a')!.getAttribute('href'), '/ui/sessions/c3f09b52-4e1');
    assert.equal(l2!.querySelector('a'), null, 'id de sessão que não serve de rota não vira link');
    assert.ok(l2!.textContent.includes(ataque), 'o <script> do núcleo está lá como texto');
    assert.ok(!area.querySelectorAll('script, img').length, 'e nenhum elemento nasceu dele');
    assert.deepEqual(area.querySelectorAll('select')[1]!.childNodes.map((o) => o.textContent), ['Tipo de evento', 'PreToolUse', 'Stop']);

    // Abre o detalhe de e1 pela seta; abrir e2 fecha e1.
    l1!.querySelector('.feed-arrow')!.click();
    let det = area.querySelector('.feed-detail')!;
    assert.match(det.textContent, /EventoPreToolUse/);
    assert.match(det.textContent, /Sessãoc3f09b52-4e1/);
    assert.match(det.textContent, /Agentetest-runner · a7c2/);
    assert.match(det.textContent, /Call idtoolu_01/);
    assert.match(det.textContent, /Ferramenta—/);
    assert.equal(area.querySelector('.feed-arrow')!.getAttribute('aria-expanded'), 'false');
    area.querySelectorAll('.feed-item')[0]!.querySelector('.feed-row')!.click();
    assert.equal(area.querySelectorAll('.feed-detail').length, 1);
    det = area.querySelector('.feed-detail')!;
    assert.match(det.textContent, /npm test -- cobranca/);
    assert.ok(det.closest('.feed-item')!.getAttribute('data-id') === 'e2');

    // Pausa: os novos esperam no aviso.
    const [pausa] = area.querySelector('.actions')!.querySelectorAll('button');
    pausa!.click();
    assert.match(pausa!.textContent, /Retomar/);
    fila = [{ events: [evento('e3', 1)], cursor: 'k3', older: null, options: null }];
    f.mudar();
    await espera();
    assert.equal(f.pedidos.at(-1), '/api/events?after=k2');
    fila = [{ events: [evento('e4', 0), evento('e3', 1)], cursor: 'k4', older: null, options: null }];
    f.mudar();
    await espera();
    const aviso = area.querySelector('.feed-new')!;
    assert.equal(aviso.hidden, false);
    assert.equal(aviso.textContent, '2 novos');
    assert.deepEqual(linhasDe(area), ['e2', 'e1'], 'pausado, a lista não mexe');

    // Retomar (pelo aviso) solta tudo no topo.
    aviso.click();
    assert.deepEqual(linhasDe(area), ['e4', 'e3', 'e2', 'e1']);
    assert.equal(aviso.hidden, true);
    assert.match(pausa!.textContent, /Pausar/);

    limpar();
    assert.equal(documento.head.querySelector('link[data-screen="feed"]'), null, 'a limpeza tira o CSS');
  });

  test('um pedido do ao vivo em voo por vez; mudança no meio pede um só a mais', async () => {
    let soltar: (v: unknown) => void = () => {};
    let n = 0;
    const f = ctxFalso((rota) => {
      if (!rota.includes('after=')) return { events: [evento('a', 30)], cursor: 'k1', older: 'v1', options: null };
      n++;
      return new Promise((r) => (soltar = r));
    });
    const area = new Elemento('main');
    const limpar = await mount(area, f.ctx);
    f.mudar();
    f.mudar();
    f.mudar();
    await espera();
    assert.equal(n, 1);
    soltar({ events: [evento('b', 1)], cursor: 'k2', older: null });
    await espera();
    await espera();
    assert.equal(n, 2);
    assert.equal(f.pedidos.at(-1), '/api/events?after=k2');
    soltar({ events: [], cursor: 'k2', older: null });
    await espera();
    assert.deepEqual(linhasDe(area), ['b', 'a']);
    limpar();
  });

  test('vazio, vazio com filtro, erro e "mostrar mais"', async () => {
    const area = new Elemento('main');
    let limpar = await mount(area, ctxFalso(() => ({ events: [], cursor: null, older: null, options: null })).ctx);
    assert.match(area.textContent, /Nenhum evento ainda/);
    const status = area.querySelectorAll('select')[0]!;
    status.value = 'error';
    status.ouvintes.get('change')![0]!({ target: status, stopPropagation() {} });
    await espera();
    assert.match(area.textContent, /Nenhum evento com esses filtros/);
    limpar();

    const falha = ctxFalso(() => Promise.reject(Object.assign(new Error('O núcleo respondeu 500'), { name: 'ReadError' })));
    limpar = await mount(area, falha.ctx);
    assert.match(area.textContent, /Sem conexão com o núcleo/);
    assert.match(area.textContent, /Tentar de novo/);
    limpar();

    const mais = ctxFalso((rota) =>
      rota.includes('before=') ? { events: [evento('velho', 900)], cursor: null, older: null } : { events: [evento('novo', 1)], cursor: 'k', older: 'v 1', options: null },
    );
    limpar = await mount(area, mais.ctx);
    const botao = area.querySelector('.feed-more')!;
    assert.equal(botao.hidden, false);
    botao.click();
    await espera();
    assert.equal(mais.pedidos.at(-1), '/api/events?before=v%201');
    assert.deepEqual(linhasDe(area), ['novo', 'velho']);
    assert.equal(botao.hidden, true);
    limpar();
  });

  test('sair durante a primeira carga tira o CSS e para o relógio', async () => {
    const antes = documento.head.querySelectorAll('link').length;
    let soltar: (v: unknown) => void = () => {};
    const f = ctxFalso(() => new Promise((_, rejeitar) => (soltar = rejeitar)));
    const area = documento.createElement('main');
    const montado = mount(area, f.ctx);
    assert.equal(documento.head.querySelectorAll('link').length, antes + 1);
    f.sair.abort();
    soltar(Object.assign(new Error('saiu'), { name: 'AbortError' }));
    await montado;
    assert.equal(documento.head.querySelectorAll('link').length, antes, 'o link do CSS saiu');
  });

  // O CSS de cada tela fica carregado depois que ela abre: classe com o mesmo nome em duas telas quebra
  // a outra. As do Feed levam o prefixo `feed-`; em comum, só as da moldura e os selos de status.
  test('o feed.css só estiliza classes com o prefixo feed-, e nenhuma de outra tela', () => {
    const classes = (arquivo: string) => new Set([...readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const SELOS = new Set(['badge', 'p', 'reason', 'soft', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);
    const daMoldura = classes('shell.css');
    const minhas = [...classes('feed.css')].filter((c) => !daMoldura.has(c) && !SELOS.has(c));
    assert.deepEqual(minhas.filter((c) => !c.startsWith('feed-')), [], 'classe própria sem o prefixo feed-');
    for (const outra of readdirSync(PASTA_DA_UI).filter((a) => a.endsWith('.css') && !['feed.css', 'shell.css', 'brand.css'].includes(a))) {
      const delas = classes(outra);
      assert.deepEqual(minhas.filter((c) => delas.has(c)), [], `feed.css e ${outra} estilizam as mesmas classes`);
    }
  });

  test('a tela não usa fetch, innerHTML nem estilo inline', () => {
    for (const a of ['screens/feed.js', 'screens/feed-state.js']) {
      const texto = readFileSync(`${PASTA_DA_UI}${a}`, 'utf8');
      assert.doesNotMatch(texto, /\bfetch\(|innerHTML|\.style\.|style=/, a);
    }
  });
});
