// A tela Mural ao vivo da /ui (#34, C2): a formatação, o que cada card mostra e a montagem da tela
// num DOM mínimo, com um Mural de exemplo (dados inventados) no lugar de `GET /api/mural`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';

// ---------- Um DOM mínimo: só o que dom.js, states.js e a tela usam ----------

class No {
  filhos: No[] = [];
  // Como no navegador, `null` não é pulado: viraria o texto "null". Aqui quebra o teste.
  append(...nos: (No | string)[]) {
    for (const n of nos) {
      assert.ok(n !== null && n !== undefined, 'append/replaceChildren com null');
      this.filhos.push(typeof n === 'string' ? new Texto(n) : n);
    }
  }
  replaceChildren(...nos: (No | string)[]) {
    this.filhos = [];
    this.append(...nos);
  }
  get textContent(): string {
    return this.filhos.map((f) => f.textContent).join('');
  }
  /** Todos os elementos abaixo deste que passam no teste. */
  todos(teste: (e: Elemento) => boolean): Elemento[] {
    const out: Elemento[] = [];
    for (const f of this.filhos) {
      if (f instanceof Elemento && teste(f)) out.push(f);
      out.push(...f.todos(teste));
    }
    return out;
  }
}
class Texto extends No {
  readonly dado: string;
  constructor(dado: string) {
    super();
    this.dado = dado;
  }
  override get textContent() {
    return this.dado;
  }
}
class Elemento extends No {
  atributos = new Map<string, string>();
  ouvintes = new Map<string, ((e: unknown) => void)[]>();
  html = '';
  readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  setAttribute(k: string, v: string) {
    this.atributos.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.atributos.get(k) ?? null;
  }
  addEventListener(tipo: string, f: (e: unknown) => void) {
    this.ouvintes.set(tipo, [...(this.ouvintes.get(tipo) ?? []), f]);
  }
  click() {
    for (const f of this.ouvintes.get('click') ?? []) f({});
  }
  focus() {
    (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = this;
  }
  /** Só o `[data-session]` que a tela usa: o próprio elemento, se tem o atributo. */
  closest(sel: string) {
    return sel === '[data-session]' && this.atributos.has('data-session') ? this : null;
  }
  set innerHTML(v: string) {
    this.html = v;
  }
  get classes() {
    return (this.getAttribute('class') ?? '').split(/\s+/);
  }
}
const head = new Elemento('head');
Object.assign(globalThis, {
  Node: No,
  document: {
    head,
    activeElement: null as unknown,
    createElement: (t: string) => new Elemento(t),
    createElementNS: (_ns: string, t: string) => new Elemento(t),
    createTextNode: (t: string) => new Texto(t),
    querySelector: (sel: string) => head.todos((e) => sel === `link[href="${e.getAttribute('href')}"]`)[0] ?? null,
  },
});

// @ts-expect-error: módulo do navegador, em JavaScript puro
const tela = await import('../../ui/screens/wall.js');
// @ts-expect-error: idem
const { findScreen } = await import('../../ui/screens.js');
const { cost, effort, mount, modelName, cardContent } = tela;

const comClasse = (raiz: No, c: string) => raiz.todos((e) => e.classes.includes(c));
const ate = async (cond: () => boolean, ms = 3000) => {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('não aconteceu a tempo');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ---------- Um Mural de exemplo, inventado ----------

type Card = Record<string, unknown>;
function cardDeExemplo(id: string, extra: Card = {}): Card {
  return {
    id,
    title: `Sessão ${id}`,
    project: 'projeto-exemplo',
    branch: 'feat/1-exemplo',
    status: 'active',
    state: 'active',
    reason: null,
    urgent: false,
    since: '2026-10-20T12:00:00Z',
    activity: { type: 'tool', text: 'Rodar a bateria' },
    model: 'claude-opus-5-5',
    effort: 'high',
    agents: { active: 1, total: 2 },
    cost: { usd: 1.84, estimate: true },
    plan: { done: 3, total: 5, current: 'Escrever o teste' },
    context: { pct: 31, used: 62_000, limit: 200_000, label: '62 mil / 200 mil' },
    ...extra,
  };
}
const MURAL = {
  version: 1,
  generatedAt: '2026-10-20T12:00:00Z',
  count: { all: 5, waiting: 3, active: 1, blocked: 2, idle: 1 },
  cards: [
    cardDeExemplo('ativa-1'),
    cardDeExemplo('espera-1', { status: 'waiting', state: 'waiting', reason: 'notification', urgent: true, attention: { level: 'blocked', reason: 'permission' }, activity: { type: 'permission', text: 'Bash: npm run migrate' }, effort: null, plan: null }),
    cardDeExemplo('espera-2', { status: 'waiting', state: 'waiting', reason: 'stop', attention: { level: 'idle', reason: 'turn_ended' }, activity: { type: 'your-turn', text: 'Rodo os testes?' }, context: null }),
    cardDeExemplo('erro-1', { status: 'error', state: 'error', urgent: true, attention: { level: 'blocked', reason: 'error' }, activity: { type: 'error', text: 'API 529 · overloaded_error' }, context: { pct: 84, used: 168_000, limit: 200_000, label: '' } }),
    cardDeExemplo('feita-1', { title: '<b>negrito</b>', status: 'completed', state: 'completed', activity: { type: 'completed', text: '' }, cost: { usd: null, estimate: true }, model: null }),
  ],
};

async function montarTela(read: (rota: string) => Promise<unknown>) {
  const area = new Elemento('main');
  const sair = new AbortController();
  const ouvintes = { mudar: [] as ((m: unknown[]) => void)[], reiniciar: [] as (() => void)[] };
  const rotas: string[] = [];
  const ctx = {
    params: {},
    signal: sair.signal,
    read: (rota: string) => (rotas.push(rota), read(rota)),
    onChange: (f: (m: unknown[]) => void) => ouvintes.mudar.push(f),
    onRestart: (f: () => void) => ouvintes.reiniciar.push(f),
    counter: () => {},
    titulo: () => {},
    navigate: () => {},
    liveState: () => 'live',
  };
  const pronta = mount(area, ctx);
  return { area, rotas, ouvintes, pronta, sair: async () => (sair.abort(), (await pronta)()) };
}

// ---------- Formatação ----------

describe('Mural: formatação', () => {
  test('custo em pt-BR, sempre com "~" e sem "US$", como no wireframe; sem preço é traço', () => {
    assert.equal(cost(1.84), '~1,84');
    assert.equal(cost(0), '~0,00');
    assert.equal(cost(1234.5), '~1.234,50');
    assert.equal(cost(null), '—');
  });
  test('modelo pela primeira palavra; esforço em português; sem valor é traço', () => {
    assert.equal(modelName('claude-opus-5-5'), 'Opus');
    assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku');
    assert.equal(modelName('Sonnet 5.5'), 'Sonnet');
    assert.equal(modelName(null), '—');
    assert.equal(modelName(' opus'), 'Opus');
    assert.equal(modelName('claude-3-5-sonnet-20241022'), 'Sonnet');
    assert.equal(modelName('   '), '—');
    assert.deepEqual(['low', 'medium', 'high', 'outro', null].map(effort), ['baixo', 'médio', 'alto', 'outro', '—']);
  });
  test('plano nulo é "Plano 0/0"; contexto nulo é "contexto —"; contexto alto a partir de 80%', () => {
    const [, espera1, espera2, erro1] = MURAL.cards.map(cardContent) as any[];
    assert.equal(espera1.plan.label, 'Plano 0/0');
    assert.equal(espera1.grade[1][1], '—');
    assert.equal(espera2.context.label, 'contexto —');
    assert.equal(espera2.context.high, false);
    assert.equal(erro1.context.label, 'contexto 84%');
    assert.equal(erro1.context.high, true);
    assert.equal(cardContent(MURAL.cards[0]).context.high, false);
  });
});

// ---------- A tela ----------

describe('Mural: a tela montada', () => {
  test('header, the selector with the blocked and idle counts and one card per session, each linking to the detail (#245)', async () => {
    const { area, sair } = await montarTela(async () => MURAL);
    try {
      await ate(() => comClasse(area, 'wall-card').length > 0);
      assert.match(area.textContent, /Mural ao vivo.*Um card por sessão aberta nesta máquina/);
      const filtros = area.todos((e) => e.getAttribute('data-filter') !== null);
      assert.deepEqual(filtros.map((f) => f.textContent), ['Todas', 'Precisam de você · 2', 'Ociosas · 1', 'Ativas']);
      assert.equal(filtros[0]!.getAttribute('aria-pressed'), 'true');
      assert.ok(area.todos((e) => e.getAttribute('data-action') === 'refresh').length === 1, 'o Atualizar do wireframe');

      const cards = comClasse(area, 'wall-card');
      assert.equal(cards.length, 5);
      assert.ok(cards.every((c) => c.tag === 'a'));
      assert.deepEqual(
        cards.map((c) => c.getAttribute('href')),
        ['/ui/sessions/ativa-1', '/ui/sessions/espera-1', '/ui/sessions/espera-2', '/ui/sessions/erro-1', '/ui/sessions/feita-1'],
      );
      assert.ok(cards[1]!.classes.includes('wall-st-blocked'));
      assert.ok(cards[2]!.classes.includes('wall-st-idle'), 'idle: neutral edge');
      assert.ok(cards[3]!.classes.includes('wall-st-error'));
      assert.doesNotMatch(area.textContent, /Esperando/);

      // Ativa: título + badge, projeto · branch, o que está fazendo, a grade e as barras.
      assert.match(cards[0]!.textContent, /^Sessão ativa-1Ativaprojeto-exemplo · feat\/1-exemploRodar a bateria/);
      assert.match(cards[0]!.textContent, /ModeloOpusEsforçoaltoAgentes2Custo~1,84Plano 3\/5contexto 31%$/);
      const [plano, contexto] = comClasse(cards[0]!, 'wall-bar');
      assert.equal(plano!.tag, 'progress');
      assert.deepEqual([plano!.getAttribute('value'), plano!.getAttribute('max')], ['3', '5']);
      assert.deepEqual([contexto!.getAttribute('value'), contexto!.getAttribute('max')], ['31', '100']);
      assert.ok(!contexto!.classes.includes('wall-high'));

      // Blocked: "Precisa de você", the strong reason chip and what it asks; without a plan it is 0/0.
      assert.match(cards[1]!.textContent, /Precisa de vocêprojeto-exemplo · feat\/1-exemploPede permissãoBash: npm run migrate/);
      assert.match(cards[1]!.textContent, /Esforço—.*Plano 0\/0/);
      assert.deepEqual(comClasse(cards[1]!, 'attention-pill-blocked').length, 1);
      assert.deepEqual(comClasse(cards[1]!, 'attention-chip').map((m) => m.classes.includes('attention-chip-light')), [false]);
      assert.equal(comClasse(cards[1]!, 'wall-bar')[0]!.getAttribute('value'), '0');
      // Idle: neutral "Ociosa" pill and a light chip.
      assert.deepEqual(comClasse(cards[2]!, 'attention-pill-idle').map((p) => p.textContent), ['Ociosa']);
      assert.ok(comClasse(cards[2]!, 'attention-chip')[0]!.classes.includes('attention-chip-light'), 'Sua vez is light');
      assert.match(cards[2]!.textContent, /Sua vezRodo os testes\?.*contexto —$/);

      // Erro: o texto do erro; contexto 84% pinta a barra de erro.
      assert.match(cards[3]!.textContent, /Com erro.*API 529 · overloaded_error/);
      assert.equal(comClasse(cards[3]!, 'attention-pill-error').length, 1, 'an error keeps the red pill');
      assert.ok(comClasse(cards[3]!, 'wall-bar')[1]!.classes.includes('wall-high'));

      // Concluída: "Terminou sem erro", sem modelo é traço, sem preço é traço.
      assert.match(cards[4]!.textContent, /Terminou sem erro.*Modelo—.*Custo—/);
      assert.ok(head.todos((e) => e.getAttribute('href') === '/ui/wall.css').length === 1, 'a tela carrega o próprio CSS');
    } finally {
      await sair();
    }
  });

  test('waiting without attention (delegating): "Ativa", not idle, no chip', async () => {
    const semMotivo = cardDeExemplo('espera-3', { status: 'waiting', state: 'delegating', reason: null, attention: null, activity: { type: 'tool', text: 'Delegando ao subagente' } });
    const { area, sair } = await montarTela(async () => ({ ...MURAL, cards: [semMotivo] }));
    try {
      await ate(() => comClasse(area, 'wall-card').length === 1);
      const card = comClasse(area, 'wall-card')[0]!;
      assert.equal(comClasse(card, 'attention-chip').length, 0);
      assert.equal(comClasse(card, 'attention-pill').length, 0, 'not waiting on you: no attention pill');
      assert.equal(comClasse(card, 'wall-b-active')[0]!.textContent, 'Ativa');
      assert.ok(card.classes.includes('wall-st-active'));
      assert.equal(comClasse(card, 'wall-row')[0]!.textContent, 'Delegando ao subagente');
    } finally {
      await sair();
    }
  });

  test('montar a tela de novo não duplica o <link> do wall.css', async () => {
    for (let i = 0; i < 3; i++) {
      const { pronta, sair } = await montarTela(async () => MURAL);
      await pronta;
      await sair();
    }
    assert.equal(head.todos((e) => e.tag === 'link' && e.getAttribute('href') === '/ui/wall.css').length, 1);
    assert.equal(head.todos((e) => e.tag === 'link').length, 1);
  });

  test('o título do núcleo entra como texto: <b> não vira HTML', async () => {
    const { area, sair } = await montarTela(async () => MURAL);
    try {
      await ate(() => comClasse(area, 'wall-card').length > 0);
      const feita = comClasse(area, 'wall-card')[4]!;
      const titulo = comClasse(feita, 'wall-tt')[0]!;
      assert.equal(titulo.textContent, '<b>negrito</b>');
      assert.equal(titulo.todos(() => true).length, 0, 'nenhum elemento dentro do título');
      assert.equal(titulo.html, '');
    } finally {
      await sair();
    }
  });

  test('the filter switches on the client, without a new request; blocked and idle apart; an empty filter shows its empty state', async () => {
    const soAtivas = { ...MURAL, count: { all: 1, waiting: 0, active: 1, blocked: 0, idle: 0 }, cards: [MURAL.cards[0]] };
    let dados: unknown = MURAL;
    const { area, rotas, sair } = await montarTela(async () => dados);
    try {
      await ate(() => comClasse(area, 'wall-card').length === 5);
      const botao = (id: string) => area.todos((e) => e.getAttribute('data-filter') === id)[0]!;
      botao('blocked').click();
      assert.deepEqual(comClasse(area, 'wall-card').map((c) => c.getAttribute('data-session')), ['espera-1', 'erro-1'], 'the error needs you too, as in the core count');
      assert.equal(botao('blocked').getAttribute('aria-pressed'), 'true');
      assert.equal(botao('all').getAttribute('aria-pressed'), 'false');
      botao('idle').click();
      assert.deepEqual(comClasse(area, 'wall-card').map((c) => c.getAttribute('data-session')), ['espera-2']);
      botao('active').click();
      assert.deepEqual(comClasse(area, 'wall-card').map((c) => c.getAttribute('data-session')), ['ativa-1']);
      assert.deepEqual(rotas, ['/api/wall'], 'só a primeira leitura');

      dados = soAtivas;
      area.todos((e) => e.getAttribute('data-action') === 'refresh')[0]!.click();
      await ate(() => rotas.length === 2 && comClasse(area, 'wall-card').length === 1);
      botao('blocked').click();
      assert.equal(comClasse(area, 'wall-card').length, 0);
      assert.match(area.textContent, /Ninguém precisa de você agora/);
    } finally {
      await sair();
    }
  });

  test('carregando antes da primeira leitura; vazio sem sessões', async () => {
    let soltar: (v: unknown) => void = () => {};
    const { area, pronta, sair } = await montarTela(() => new Promise((r) => (soltar = r)));
    try {
      assert.equal(comClasse(area, 'loading').length, 1);
      assert.equal(comClasse(area, 'loading')[0]!.getAttribute('aria-busy'), 'true');
      soltar({ ...MURAL, count: { all: 0, waiting: 0, active: 0, blocked: 0, idle: 0 }, cards: [] });
      await pronta;
      assert.equal(comClasse(area, 'loading').length, 0);
      assert.match(area.textContent, /Nenhuma sessão aberta/);
      assert.equal(comClasse(area, 'wall-card').length, 0);
    } finally {
      await sair();
    }
  });

  test('sem o núcleo: o erro com "Tentar de novo", que relê; depois, falha vira a faixa e os cards ficam', async () => {
    let falhar = true;
    const { area, rotas, sair } = await montarTela(async () => {
      if (falhar) throw Object.assign(new Error('O núcleo em 127.0.0.1 não respondeu'), { status: 0 });
      return MURAL;
    });
    try {
      await ate(() => /Sem conexão com o núcleo/.test(area.textContent));
      assert.match(area.textContent, /não respondeu.*Tentar de novo/);
      assert.equal(comClasse(area, 'wall-card').length, 0);

      falhar = false;
      area.todos((e) => e.tag === 'button' && /Tentar de novo/.test(e.textContent))[0]!.click();
      await ate(() => comClasse(area, 'wall-card').length === 5);
      assert.equal(rotas.length, 2);

      falhar = true;
      area.todos((e) => e.getAttribute('data-action') === 'refresh')[0]!.click();
      await ate(() => comClasse(area, 'error-band').length === 1);
      assert.match(comClasse(area, 'error-band')[0]!.textContent, /O mural não atualizou/);
      assert.equal(comClasse(area, 'wall-card').length, 5, 'os cards de antes continuam');
    } finally {
      await sair();
    }
  });

  test('ao vivo: uma mudança relê o mural (juntando a rajada) e reiniciar relê na hora', async () => {
    let dados: typeof MURAL = MURAL;
    const { area, rotas, ouvintes, sair } = await montarTela(async () => dados);
    try {
      await ate(() => comClasse(area, 'wall-card').length === 5);
      dados = { ...MURAL, cards: [cardDeExemplo('nova-1', { title: 'Sessão nova' }), ...MURAL.cards] };
      for (const f of ouvintes.mudar) f([{ type: 'session', key: 'nova-1' }]);
      for (const f of ouvintes.mudar) f([{ type: 'plan', key: 'nova-1' }]);
      await ate(() => comClasse(area, 'wall-card').length === 6);
      assert.equal(rotas.length, 2, 'a rajada vira uma leitura só');
      assert.equal(comClasse(area, 'wall-card')[0]!.getAttribute('href'), '/ui/sessions/nova-1');

      dados = MURAL;
      for (const f of ouvintes.reiniciar) f();
      await ate(() => comClasse(area, 'wall-card').length === 5);
      assert.equal(rotas.length, 3);
    } finally {
      await sair();
    }
  });
});

describe('Mural: ao vivo com atividade contínua', () => {
  test('mudanças a cada 100 ms não adiam a releitura para sempre', async () => {
    const { area, rotas, ouvintes, sair } = await montarTela(async () => MURAL);
    try {
      await ate(() => comClasse(area, 'wall-card').length === 5);
      const fim = Date.now() + 1_500;
      while (Date.now() < fim) {
        for (const f of ouvintes.mudar) f([{ type: 'session', key: 'ativa-1' }]);
        await new Promise((ok) => setTimeout(ok, 100));
      }
      assert.ok(rotas.length >= 3, `releu ${rotas.length - 1} vez(es) em 1,5 s`);
    } finally {
      await sair();
    }
  });

  test('o foco do teclado volta ao card da mesma sessão depois de redesenhar', async () => {
    const { area, rotas, sair } = await montarTela(async () => MURAL);
    try {
      await ate(() => comClasse(area, 'wall-card').length === 5);
      const antes = comClasse(area, 'wall-card').find((c) => c.getAttribute('data-session') === 'espera-2')!;
      antes.focus();
      area.todos((e) => e.getAttribute('data-action') === 'refresh')[0]!.click();
      await ate(() => rotas.length === 2 && comClasse(area, 'wall-card')[0] !== undefined && !comClasse(area, 'wall-card').includes(antes));
      const doc = (globalThis as unknown as { document: { activeElement: Elemento } }).document;
      assert.notEqual(doc.activeElement, antes);
      assert.equal(doc.activeElement.getAttribute('data-session'), 'espera-2');
    } finally {
      (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = null;
      await sair();
    }
  });
});

test('a tela está registrada em /ui/wall, na barra como "Mural ao vivo"', () => {
  const { screen: t } = findScreen('/ui/wall');
  assert.equal(t.id, 'wall');
  assert.equal(t.file, '/ui/screens/wall.js');
  assert.deepEqual(t.item, { label: 'Mural ao vivo', icon: 'wall', section: 'main' });
  assert.equal(t.sub, 'Um card por sessão aberta nesta máquina');
});

test('a tela e o estilo dela não escrevem cor à mão, não chamam endereço de fora nem põem HTML ou estilo inline', () => {
  for (const arquivo of ['screens/wall.js', 'wall.css']) {
    const texto = readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8');
    assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${arquivo} escreve cor à mão`);
    assert.doesNotMatch(texto, /https?:\/\//, `${arquivo} chama endereço de fora`);
    assert.doesNotMatch(texto, /innerHTML|style=|\.style\b/, `${arquivo} põe HTML ou estilo inline`);
  }
});

test('a rota da tela é a do núcleo', async () => {
  const { WALL_ROUTE } = await import('../../src/api/index.ts');
  assert.equal(tela.WALL_ROUTE, WALL_ROUTE);
});

// O CSS de cada tela fica carregado quando se troca de tela: classe com o mesmo nome em duas telas
// desmonta a outra. As do mural levam `wall-`; em comum só a moldura e os selos de status.
test('o wall.css não estiliza classe de outra tela: as próprias levam wall-', () => {
  const classes = (arquivo: string) => new Set([...readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const SELOS = new Set(['badge', 'p', 'reason', 'soft', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);
  const daMoldura = classes('shell.css');
  const minhas = [...classes('wall.css')].filter((c) => !daMoldura.has(c) && !SELOS.has(c));
  assert.deepEqual(minhas.filter((c) => !c.startsWith('wall-')), [], 'classe própria sem o prefixo wall-');
  const css = [...readdirSync(UI_FOLDER), ...readdirSync(`${UI_FOLDER}screens`).map((a) => `screens/${a}`)];
  for (const outra of css.filter((a) => a.endsWith('.css') && !['wall.css', 'shell.css', 'brand.css'].includes(a))) {
    assert.deepEqual([...classes(outra)].filter((c) => minhas.includes(c)), [], `wall.css e ${outra} estilizam as mesmas classes`);
  }
});
