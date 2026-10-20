// A tela Analytics da /ui (#95 e #32, C12 e C13): a formatação, o que cada parte mostra e a
// montagem da tela num DOM mínimo, com respostas sintéticas no formato de /api/analytics.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
// @ts-expect-error: módulo do navegador, em JavaScript puro
import { findScreen, SCREENS } from '../../ui/screens.js';

// ---------- Um DOM mínimo: só o que dom.js, states.js e a tela usam ----------

class No {
  filhos: No[] = [];
  append(...nos: (No | string)[]) {
    for (const n of nos) this.filhos.push(typeof n === 'string' ? new Texto(n) : n);
  }
  replaceChildren(...nos: No[]) {
    this.filhos = [];
    this.append(...nos);
  }
  get textContent(): string {
    return this.filhos.map((f) => f.textContent).join('');
  }
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
  set innerHTML(v: string) {
    this.html = v;
  }
  get classes() {
    return (this.getAttribute('class') ?? '').split(/\s+/);
  }
}
const head = new Elemento('head');
const raiz = new Elemento('html');
Object.assign(globalThis, {
  Node: No,
  document: {
    head,
    documentElement: raiz,
    createElement: (t: string) => new Elemento(t),
    createElementNS: (_ns: string, t: string) => new Elemento(t),
    createTextNode: (t: string) => new Texto(t),
    querySelector: (sel: string) => head.todos((e) => sel === `link[href="${e.getAttribute('href')}"]`)[0] ?? null,
  },
});

// @ts-expect-error: módulo do navegador, em JavaScript puro
const tela = await import('../../ui/screens/analytics.js');
const { mount, quantity, usd, shortDate, modelName, millions, percent, axisTop, slicesByModel, accountClass, fileName } = tela;

const comClasse = (r: No, c: string) => r.todos((e) => e.classes.includes(c));
const porTag = (r: No, t: string) => r.todos((e) => e.tag === t);
/** O texto que se lê na tela, sem os <title> (as dicas dos gráficos). */
const visivel = (n: No): string => (n instanceof Texto ? n.dado : n instanceof Elemento && n.tag === 'title' ? '' : n.filhos.map(visivel).join(''));

// ---------- Respostas sintéticas ----------

function diasAte(ate: string, n: number): string[] {
  const fim = Date.parse(`${ate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(fim - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

const CONTA_A = { id: 'conta-a/org-a', label: 'pessoal', color: null };
const CONTA_B = { id: 'conta-b/org-b', label: 'equipe', color: null };

function visao({ contas = [CONTA_A], sessoes = 412 } = {}) {
  const dias = diasAte('2026-10-18', 364);
  const ultimos = diasAte('2026-10-18', 30).map((day, i) => ({ day, sessions: i === 24 ? 47 : (i * 7) % 30 }));
  return {
    generatedAt: '2026-10-18T23:12:40.000Z',
    timeZone: 'UTC',
    today: '2026-10-18',
    since: dias[0],
    until: '2026-10-18',
    accounts: contas,
    numbers: {
      sessions: { total: sessoes, active: 4 },
      agents: { total: 1086, active: 7 },
      tokens: { total: 1_900_000_000, cachePct: 71 },
      cost: { usd: 341.2, days: 30, unpriced: [], byAccount: contas.length > 1 ? [{ account: CONTA_A.id, usd: 300, unpriced: [] as string[] }, { account: CONTA_B.id, usd: 41.2, unpriced: ['modelo-novo'] }] : [{ account: CONTA_A.id, usd: 341.2, unpriced: [] as string[] }] },
      events: { total: 48_100, perSession: 116.7 },
    },
    activity: { weeks: 52, days: dias.map((day, i) => ({ day, events: i % 5 === 0 ? 0 : (i * 13) % 97 })) },
    last30: { days: ultimos, peak: { day: ultimos[24]!.day, sessions: 47 }, total: 742 },
    tokensByModel: [
      { model: 'claude-opus-5-5', tokens: 1_180_000_000 },
      { model: 'claude-sonnet-5-5', tokens: 610_000_000 },
      { model: 'claude-haiku-5-5', tokens: 128_000_000 },
    ],
    tools: [
      { name: 'Bash', uses: 4100 },
      { name: 'Edit', uses: 2542 },
      { name: 'Read', uses: 2255 },
      { name: 'Grep', uses: 861 },
      { name: 'Agent', uses: 492 },
      { name: 'Write', uses: 100 },
    ],
    weekday: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day, i) => ({ day, sessions: [58, 71, 64, 80, 52, 14, 9][i] })),
  };
}

function cost(dias = 30, { contas = [CONTA_A], semPrecoNoDia = false, vazio: empty = false } = {}) {
  const lista = diasAte('2026-10-18', dias);
  const porDia = lista.map((day, i) => ({ day, usd: semPrecoNoDia && i === 3 ? null : 5 + (i % 7) }));
  return {
    generatedAt: '2026-10-18T23:12:40.000Z',
    timeZone: 'UTC',
    days: dias,
    since: lista[0],
    until: '2026-10-18',
    estimate: true,
    currency: 'USD',
    accounts: contas,
    today: '2026-10-18',
    todaySummary: { usd: 12.4 as number | null, sessions: 9, byAccount: contas.map((c, i) => ({ account: c.id, label: c.label, color: c.color, usd: i === 0 ? 9.3 : (null as number | null), unpriced: i === 0 ? [] : ['modelo-novo'] })) },
    period: { usd: empty ? null : 341.2, dailyAverage: empty ? null : 11.4 },
    cache: { pct: 71 },
    unpriced: { models: ['modelo-novo'], totalTokens: 1000 },
    byDay: empty ? [] : porDia,
    peak: empty ? null : { day: lista.at(-2), usd: 18.4 },
    byModel: empty
      ? []
      : [
          { model: 'claude-opus-5-5', usd: 211.5, pct: 62, totalTokens: 1 },
          { model: 'claude-sonnet-5-5', usd: 105.8, pct: 31, totalTokens: 1 },
          { model: 'claude-haiku-5-5', usd: 23.9, pct: 7, totalTokens: 1 },
          { model: 'modelo-novo', usd: null, pct: null, totalTokens: 1000 },
        ],
    byProject: empty
      ? []
      : [
          { project: 'motor-de-regras', usd: 128.4 },
          { project: 'painel-de-metricas', usd: 74.9 },
          { project: 'sem-tabela', usd: null },
        ],
    byAccount: contas.map((c, i) => ({ account: c.id, label: c.label, color: c.color, usd: i === 0 ? 300 : 41.2, unpriced: i === 0 ? [] : ['modelo-novo'], byDay: [] })),
  };
}

async function montarTela({ aba, read }: { aba?: string; read: (rota: string) => Promise<unknown> }) {
  const area = new Elemento('main');
  const rotas: string[] = [];
  const mudar: (() => void)[] = [];
  const reiniciar: (() => void)[] = [];
  const navegou: string[] = [];
  const ctx = {
    params: aba === undefined ? {} : { tab: aba },
    signal: new AbortController().signal,
    read: async (rota: string) => (rotas.push(rota), read(rota)),
    onChange: (f: () => void) => mudar.push(f),
    onRestart: (f: () => void) => reiniciar.push(f),
    counter: () => {},
    titulo: () => {},
    navigate: (r: string) => navegou.push(r),
    liveState: () => 'live',
  };
  const limpar = await mount(area, ctx, { releituraMs: 5 });
  return { area, rotas, mudar, reiniciar, navegou, limpar };
}

const ate = async (cond: () => boolean, ms = 2000) => {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('não aconteceu a tempo');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ---------- Formatação ----------

describe('Analytics: formatação', () => {
  test('quantidades em pt-BR, como no C12', () => {
    assert.equal(quantity(412), '412');
    assert.equal(quantity(1086), '1.086');
    assert.equal(quantity(48_100), '48,1 mil');
    assert.equal(quantity(2_100_000), '2,1 mi');
    assert.equal(quantity(1_900_000_000), '1,9 B');
  });
  test('custo com "~US$"; null é "sem preço", nunca US$ 0', () => {
    assert.equal(usd(12.4), '~US$ 12,40');
    assert.equal(usd(341.2, { curto: true }), '~US$ 341');
    assert.equal(usd(128.4), '~US$ 128,40');
    assert.equal(usd(0), '~US$ 0,00');
    assert.equal(usd(null), 'sem preço');
    assert.equal(usd(null, { curto: true }), 'sem preço');
  });
  test('datas, milhões, porcentagem e o topo do eixo', () => {
    assert.equal(shortDate('2026-10-13'), '13 out');
    assert.equal(shortDate('2026-01-02'), '2 jan');
    assert.equal(millions(1_180_000_000), '1.180');
    assert.equal(millions(4_240_000), '4,2');
    assert.equal(percent(71.4), '71%');
    assert.equal(percent(null), '—');
    assert.equal(percent(0.4), '<1%');
    assert.equal(percent(0), '0%');
    assert.equal(axisTop(18.4), 20);
    assert.equal(axisTop(0.7), 1);
    assert.equal(axisTop(0), 1);
  });
  test('nome do modelo', () => {
    assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(modelName('claude-sonnet-5'), 'Sonnet 5');
    assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
    assert.equal(modelName('claude-opus-4-20250514'), 'Opus 4');
    assert.equal(modelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
    assert.equal(modelName('claude-opus-5-5[1m]'), 'Opus 5.5');
    assert.equal(modelName('outro-modelo'), 'outro-modelo');
    assert.equal(modelName(null), null);
  });
  test('rosca: até quatro modelos; mais que isso vira "Outros"; sem preço fica fora do arco', () => {
    const m = (model: string, v: number | null, pct: number | null) => ({ model, usd: v, pct, totalTokens: 1 });
    const cinco = slicesByModel([m('claude-opus-5-5', 50, 50), m('claude-sonnet-5-5', 20, 20), m('claude-haiku-5-5', 10, 10), m('a', 10, 10), m('b', 10, 10), m('c', null, null)]);
    assert.deepEqual(
      cinco.map((f: { nome: string; pct: number | null }) => [f.nome, f.pct]),
      [['Opus 5.5', 50], ['Sonnet 5.5', 20], ['Haiku 5.5', 10], ['Outros (2)', 20], ['c', null]],
    );
  });
  test('a cor da conta vira classe só quando é uma cor da marca; senão, nenhuma', () => {
    assert.equal(accountClass('#df285d'), null, 'sem getComputedStyle, sem classe');
    const vars: Record<string, string> = { '--rose-500': ' #df285d', '--green-500': '#1baf7a', '--yellow-500': '#ffc30a', '--gray-200': '#a6a6aa' };
    Object.assign(globalThis, { getComputedStyle: () => ({ getPropertyValue: (k: string) => vars[k] ?? '' }) });
    try {
      assert.equal(accountClass('#DF285D'), 'an-account-pink');
      assert.equal(accountClass('#1baf7a'), 'an-account-green');
      assert.equal(accountClass('#123456'), null);
      assert.equal(accountClass(null), null);
    } finally {
      delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    }
  });
  test('o nome do arquivo exportado', () => {
    assert.equal(fileName('overview', { until: '2026-10-18' }, 30), 'ahrena-analytics-2026-10-18.json');
    assert.equal(fileName('cost', { until: '2026-10-18' }, 7), 'ahrena-analytics-cost-7d-2026-10-18.json');
  });
});

// ---------- Visão geral (C12) ----------

describe('Analytics: Visão geral', () => {
  test('cabeçalho, os cinco números, as duas abas e os gráficos', async () => {
    const { area, rotas, limpar } = await montarTela({ read: async () => visao() });
    try {
      assert.match(rotas[0]!, /^\/api\/analytics\?tz=[^&]+$/);
      const texto = area.textContent;
      assert.match(texto, /Analytics/);
      assert.match(texto, /Uso, custo e produtividade das sessões/);
      assert.match(texto, /Exportar/);

      const stats = comClasse(area, 'an-stat');
      assert.deepEqual(stats.map((s) => s.getAttribute('data-card')), ['sessions', 'agents', 'tokens', 'cost', 'events']);
      assert.deepEqual(
        stats.map((s) => s.textContent),
        ['Sessões4124 ativas', 'Agentes1.0867 ativos', 'Tokens1,9 B71% de cache', 'Custo~US$ 341estimativa · 30 dias', 'Eventos48,1 mil~117 por sessão'],
      );
      assert.equal(comClasse(area, 'an-accounts').length, 0, 'uma conta só: sem divisão');

      const abas = comClasse(area, 'an-tabs');
      assert.equal(abas.length, 1);
      const links = porTag(abas[0]!, 'a');
      assert.deepEqual(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]), [
        ['Visão geral', '/ui/analytics', 'page'],
        ['Custo', '/ui/analytics/cost', null],
      ]);

      assert.equal(comClasse(area, 'an-cell').length, 364, 'heatmap: uma célula por dia');
      assert.ok(comClasse(area, 'an-cell').every((c) => porTag(c, 'title').length === 1), 'toda célula tem <title>');
      assert.ok(comClasse(area, 'an-n4').length > 0 && comClasse(area, 'an-n0').length > 0);
      assert.match(texto, /seg.*qua.*sex/);
      assert.match(texto, /menos.*mais/);

      const colunas = comClasse(area, 'an-col');
      assert.equal(colunas.length, 30);
      assert.ok(colunas.at(-1)!.classes.includes('an-current'));
      assert.match(texto, /Pico 47 em 13 out/);
      assert.match(texto, /Total 742/);

      const listas = comClasse(area, 'an-list');
      assert.equal(listas.length, 3);
      assert.deepEqual(comClasse(listas[0]!, 'an-list-row').map(visivel), ['Opus 5.51.180', 'Sonnet 5.5610', 'Haiku 5.5128']);
      assert.equal(comClasse(listas[1]!, 'an-list-row').length, 5, 'ferramentas: top 5');
      assert.deepEqual(comClasse(listas[2]!, 'an-list-row').map((l) => l.textContent.slice(0, 3)), ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']);
      for (const g of comClasse(area, 'an-chart')) assert.ok(g.getAttribute('aria-label'), 'todo gráfico tem aria-label');
      assert.match(texto, /\d{2}:\d{2}:\d{2}/, 'a hora em que os números foram calculados');
    } finally {
      limpar();
    }
  });

  test('com duas contas, o custo leva a divisão por conta', async () => {
    const { area, limpar } = await montarTela({ read: async () => visao({ contas: [CONTA_A, CONTA_B] }) });
    try {
      const custoCard = comClasse(area, 'an-stat').find((s) => s.getAttribute('data-card') === 'cost')!;
      const linhas = porTag(comClasse(custoCard, 'an-accounts')[0]!, 'li');
      assert.deepEqual(linhas.map((l) => l.textContent), ['pessoal~US$ 300,00', 'equipe~US$ 41,20 · parcial']);
      assert.equal(linhas[0]!.getAttribute('title'), null);
      assert.equal(linhas[1]!.getAttribute('title'), 'Parcial: sem preço para modelo-novo');
      assert.equal(comClasse(area, 'an-accounts').length, 1);
    } finally {
      limpar();
    }
  });

  test('conta sem dono (id null) entra na divisão; heatmap que começa na segunda tem uma célula por dia', async () => {
    const d = visao({ contas: [CONTA_A, { id: null, label: 'Sem conta', color: null }] as never });
    d.numbers.cost.byAccount = [{ account: CONTA_A.id, usd: 300, unpriced: [] }, { account: null as never, usd: null as never, unpriced: ['modelo-novo'] }];
    d.activity.days = d.activity.days.slice(6); // 358 dias, de uma segunda até hoje
    const { area, limpar } = await montarTela({ read: async () => d });
    try {
      const linhas = porTag(comClasse(area, 'an-accounts')[0]!, 'li');
      assert.deepEqual(linhas.map((l) => [l.getAttribute('data-account'), l.textContent]), [[CONTA_A.id, 'pessoal~US$ 300,00'], ['no-account', 'Sem contasem preço']]);
      assert.equal(comClasse(area, 'an-cell').length, 358);
    } finally {
      limpar();
    }
  });

  test('sem sessão nenhuma, o estado vazio', async () => {
    const { area, limpar } = await montarTela({ read: async () => visao({ sessoes: 0 }) });
    try {
      assert.match(area.textContent, /Nenhuma sessão ainda/);
      assert.equal(comClasse(area, 'an-stat').length, 0);
    } finally {
      limpar();
    }
  });

  test('sem o núcleo, o erro com "Tentar de novo", que relê', async () => {
    let falha = true;
    const { area, rotas, limpar } = await montarTela({
      read: async () => {
        if (falha) throw Object.assign(new Error('O núcleo não respondeu'), { status: 0 });
        return visao();
      },
    });
    try {
      assert.match(area.textContent, /Sem conexão com o núcleo.*Tentar de novo/);
      falha = false;
      porTag(area, 'button').find((b) => /Tentar de novo/.test(b.textContent))!.click();
      await ate(() => comClasse(area, 'an-stat').length === 5);
      assert.equal(rotas.length, 2);
    } finally {
      limpar();
    }
  });

  test('ao vivo: uma rajada de mudanças relê uma vez; reiniciar relê; uma falha mantém os números', async () => {
    let falha = false;
    const { area, rotas, mudar, reiniciar, limpar } = await montarTela({
      read: async () => {
        if (falha) throw new Error('caiu');
        return visao();
      },
    });
    try {
      for (let i = 0; i < 5; i++) mudar.forEach((f) => f());
      await ate(() => rotas.length === 2);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(rotas.length, 2, 'uma releitura por rajada');
      falha = true;
      reiniciar.forEach((f) => f());
      await ate(() => comClasse(area, 'error-band').length === 1);
      assert.equal(comClasse(area, 'an-stat').length, 5, 'os números da última leitura ficam');
    } finally {
      limpar();
    }
  });
});

// ---------- Custo (C13) ----------

describe('Analytics: Custo', () => {
  test('seletor 7/30/90, quatro números, linha, rosca e por projeto; trocar o período relê com ?days=', async () => {
    const { area, rotas, limpar } = await montarTela({ aba: 'cost', read: async (rota) => cost(Number(/days=(\d+)/.exec(rota)![1]), { semPrecoNoDia: true }) });
    try {
      assert.match(rotas[0]!, /^\/api\/analytics\/cost\?days=30&tz=[^&]+$/);
      const texto = area.textContent;
      assert.match(texto, /Custo estimado pelo transcript, com o preço de cada modelo/);
      const botoes = porTag(area, 'button').filter((b) => b.getAttribute('data-days'));
      assert.deepEqual(botoes.map((b) => [b.textContent, b.getAttribute('aria-pressed')]), [['7 dias', 'false'], ['30 dias', 'true'], ['90 dias', 'false']]);
      assert.equal(porTag(comClasse(area, 'an-tabs')[0]!, 'a').find((a) => a.getAttribute('aria-current') === 'page')!.textContent, 'Custo');

      assert.deepEqual(
        comClasse(area, 'an-stat').map((s) => s.textContent),
        ['Hoje~US$ 12,409 sessões', '30 dias~US$ 341média ~US$ 11,40 por dia', 'Cache71%dos tokens de entrada', 'Sem preço1modelo sem tabela'],
      );
      assert.equal(comClasse(area, 'an-row').length, 2, 'o dia sem preço interrompe a linha');
      assert.equal(comClasse(area, 'an-target').length, 30);
      assert.ok(comClasse(area, 'an-target').some((a) => /sem preço/.test(a.textContent)));
      assert.match(texto, /Pico ~US\$ 18,40 em 17 out/);
      assert.match(texto, /Total ~US\$ 341/);

      assert.equal(comClasse(area, 'an-slice').length, 3);
      const legenda = porTag(comClasse(area, 'an-legend')[0]!, 'li').map((l) => l.textContent);
      assert.deepEqual(legenda, ['Opus 5.562%', 'Sonnet 5.531%', 'Haiku 5.57%', 'modelo-novosem preço']);
      assert.match(comClasse(area, 'an-donut')[0]!.textContent, /~US\$ 34130 dias/);

      const projetos = comClasse(comClasse(area, 'an-projects')[0]!, 'an-list-row').map(visivel);
      assert.deepEqual(projetos, ['motor-de-regras~US$ 128,40', 'painel-de-metricas~US$ 74,90', 'sem-tabelasem preço']);
      assert.doesNotMatch(texto, /US\$ 0[,.]00/, 'sem preço nunca vira US$ 0');

      botoes[0]!.click();
      await ate(() => rotas.length === 2);
      assert.match(rotas[1]!, /^\/api\/analytics\/cost\?days=7&tz=/);
      await ate(() => comClasse(area, 'an-target').length === 7);
      assert.match(area.textContent, /7 dias~US\$ 341/);
      assert.equal(porTag(area, 'button').find((b) => b.getAttribute('data-days') === '7')!.getAttribute('aria-pressed'), 'true');
    } finally {
      limpar();
    }
  });

  test('com duas contas, hoje e o período levam a divisão por conta (parcial quando falta preço); com uma, não', async () => {
    const duas = await montarTela({ aba: 'cost', read: async () => cost(30, { contas: [CONTA_A, CONTA_B] }) });
    try {
      const card = (id: string) => comClasse(duas.area, 'an-stat').find((s) => s.getAttribute('data-card') === id)!;
      const periodo = porTag(comClasse(card('period'), 'an-accounts')[0]!, 'li');
      assert.deepEqual(periodo.map((l) => l.textContent), ['pessoal~US$ 300,00', 'equipe~US$ 41,20 · parcial']);
      assert.equal(periodo[1]!.getAttribute('title'), 'Parcial: sem preço para modelo-novo');
      const hoje = porTag(comClasse(card('today'), 'an-accounts')[0]!, 'li');
      assert.deepEqual(hoje.map((l) => l.textContent), ['pessoal~US$ 9,30', 'equipesem preço'], 'usd null é "sem preço", não parcial');
      assert.equal(hoje[1]!.getAttribute('title'), null);
    } finally {
      duas.limpar();
    }
    const uma = await montarTela({ aba: 'cost', read: async () => cost(30) });
    try {
      assert.equal(comClasse(uma.area, 'an-accounts').length, 0);
    } finally {
      uma.limpar();
    }
  });

  test('custo sem preço no período mostra "sem preço", não US$ 0', async () => {
    const d = cost(30);
    d.period = { usd: null, dailyAverage: null };
    d.todaySummary = { usd: null, sessions: 2, byAccount: [] };
    const { area, limpar } = await montarTela({ aba: 'cost', read: async () => d });
    try {
      const textos = comClasse(area, 'an-stat').map((s) => s.textContent);
      assert.equal(textos[0], 'Hojesem preço2 sessões');
      assert.equal(textos[1], '30 diassem preçomédia: sem preço');
    } finally {
      limpar();
    }
  });

  test('período sem custo: o estado vazio, com o seletor no ar', async () => {
    const { area, limpar } = await montarTela({ aba: 'cost', read: async () => cost(7, { vazio: true }) });
    try {
      assert.match(area.textContent, /Nenhum custo nos últimos 30 dias/);
      assert.equal(porTag(area, 'button').filter((b) => b.getAttribute('data-days')).length, 3);
    } finally {
      limpar();
    }
  });

  test('erro na leitura do custo', async () => {
    const { area, limpar } = await montarTela({ aba: 'cost', read: async () => Promise.reject(new Error('O núcleo respondeu 500')) });
    try {
      assert.match(area.textContent, /Sem conexão com o núcleo.*O núcleo respondeu 500.*Tentar de novo/);
    } finally {
      limpar();
    }
  });

  test('aba que não existe: não lê nada e oferece a Visão geral', async () => {
    const { area, rotas, navegou, limpar } = await montarTela({ aba: 'tokens', read: async () => visao() });
    try {
      assert.equal(rotas.length, 0);
      assert.match(area.textContent, /Aba não encontrada/);
      porTag(area, 'button')[0]!.click();
      assert.deepEqual(navegou, ['/ui/analytics']);
    } finally {
      limpar();
    }
  });
});

// ---------- Registro, rotas e regras da página ----------

test('the registry: Analytics in the sidebar; /ui/analytics/cost opens the same screen and lights Analytics', () => {
  const a = findScreen('/ui/analytics');
  assert.equal(a.screen.id, 'analytics');
  assert.deepEqual(a.screen.item, { label: 'Analytics', icon: 'analytics', section: 'main' });
  const c = findScreen('/ui/analytics/cost');
  assert.equal(c.screen.highlights, 'analytics');
  assert.deepEqual(c.params, { tab: 'cost' });
  assert.equal(c.screen.file, a.screen.file);
  assert.equal(SCREENS.filter((t: { item?: { label: string } }) => t.item?.label === 'Analytics').length, 1, 'um item só na barra');
});

test('as rotas e os períodos da tela são os do núcleo', async () => {
  const { ANALYTICS_ROUTE, COST_ROUTE, DIAS_DO_CUSTO } = await import('../../src/api/analytics-route.ts');
  assert.equal(tela.OVERVIEW_ROUTE, ANALYTICS_ROUTE);
  assert.equal(tela.COST_ROUTE, COST_ROUTE);
  assert.deepEqual(tela.PERIODS, [...DIAS_DO_CUSTO]);
});

test('a tela e o estilo dela não escrevem cor à mão, não chamam endereço de fora nem põem estilo inline', () => {
  for (const arquivo of ['screens/analytics.js', 'analytics.css']) {
    const texto = readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8');
    assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${arquivo} escreve cor à mão`);
    const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(urls, [], `${arquivo} chama endereço de fora`);
    assert.doesNotMatch(texto, /innerHTML|style=|\.style\b|'style'/, `${arquivo} põe HTML ou estilo inline`);
  }

  // O CSS de cada tela fica carregado depois que ela abre: classe própria sem prefixo, ou repetida
  // em outra tela, desmonta a outra (o `.linha` do Dashboard desmontava a tabela de Sessões, #151).
  test('analytics.css só estiliza classes an-* ou da moldura, e nenhuma de outra tela', () => {
    const classes = (arquivo: string) => new Set([...readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const daMoldura = classes('shell.css');
    const minhas = [...classes('analytics.css')].filter((c) => !daMoldura.has(c));
    assert.deepEqual(minhas.filter((c) => !c.startsWith('an-')), [], 'classe própria do Analytics sem o prefixo an-');
    const outras = readdirSync(UI_FOLDER).filter((a) => a.endsWith('.css') && !['analytics.css', 'shell.css', 'brand.css'].includes(a));
    for (const outra of outras) {
      const comuns = [...classes(outra)].filter((c) => minhas.includes(c));
      assert.deepEqual(comuns, [], `analytics.css e ${outra} estilizam as mesmas classes`);
    }
  });
});
