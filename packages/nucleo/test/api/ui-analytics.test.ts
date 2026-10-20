// A tela Analytics da /ui (#95 e #32, C12 e C13): a formatação, o que cada parte mostra e a
// montagem da tela num DOM mínimo, com respostas sintéticas no formato de /api/analytics.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
// @ts-expect-error: módulo do navegador, em JavaScript puro
import { acharTela, TELAS } from '../../ui/telas.js';

// ---------- Um DOM mínimo: só o que dom.js, estados.js e a tela usam ----------

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
const tela = await import('../../ui/telas/analytics.js');
const { montar, quantidade, usd, dataCurta, nomeDoModelo, milhoes, porcento, topoDoEixo, fatiasPorModelo, classeDaConta, nomeDoArquivo } = tela;

const comClasse = (r: No, c: string) => r.todos((e) => e.classes.includes(c));
const porTag = (r: No, t: string) => r.todos((e) => e.tag === t);
/** O texto que se lê na tela, sem os <title> (as dicas dos gráficos). */
const visivel = (n: No): string => (n instanceof Texto ? n.dado : n instanceof Elemento && n.tag === 'title' ? '' : n.filhos.map(visivel).join(''));

// ---------- Respostas sintéticas ----------

function diasAte(ate: string, n: number): string[] {
  const fim = Date.parse(`${ate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(fim - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

const CONTA_A = { id: 'conta-a/org-a', rotulo: 'pessoal', cor: null };
const CONTA_B = { id: 'conta-b/org-b', rotulo: 'equipe', cor: null };

function visao({ contas = [CONTA_A], sessoes = 412 } = {}) {
  const dias = diasAte('2026-10-18', 364);
  const ultimos = diasAte('2026-10-18', 30).map((dia, i) => ({ dia, sessoes: i === 24 ? 47 : (i * 7) % 30 }));
  return {
    geradoEm: '2026-10-18T23:12:40.000Z',
    fusoHorario: 'UTC',
    hoje: '2026-10-18',
    desde: dias[0],
    ate: '2026-10-18',
    contas,
    numeros: {
      sessoes: { total: sessoes, ativas: 4 },
      agentes: { total: 1086, ativos: 7 },
      tokens: { total: 1_900_000_000, cachePct: 71 },
      custo: { usd: 341.2, dias: 30, semPreco: [], porConta: contas.length > 1 ? [{ conta: CONTA_A.id, usd: 300, semPreco: [] as string[] }, { conta: CONTA_B.id, usd: 41.2, semPreco: ['modelo-novo'] }] : [{ conta: CONTA_A.id, usd: 341.2, semPreco: [] as string[] }] },
      eventos: { total: 48_100, porSessao: 116.7 },
    },
    atividade: { semanas: 52, dias: dias.map((dia, i) => ({ dia, eventos: i % 5 === 0 ? 0 : (i * 13) % 97 })) },
    ultimos30: { dias: ultimos, pico: { dia: ultimos[24]!.dia, sessoes: 47 }, total: 742 },
    tokensPorModelo: [
      { modelo: 'claude-opus-5-5', tokens: 1_180_000_000 },
      { modelo: 'claude-sonnet-5-5', tokens: 610_000_000 },
      { modelo: 'claude-haiku-5-5', tokens: 128_000_000 },
    ],
    ferramentas: [
      { nome: 'Bash', usos: 4100 },
      { nome: 'Edit', usos: 2542 },
      { nome: 'Read', usos: 2255 },
      { nome: 'Grep', usos: 861 },
      { nome: 'Agent', usos: 492 },
      { nome: 'Write', usos: 100 },
    ],
    diaDaSemana: ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map((dia, i) => ({ dia, sessoes: [58, 71, 64, 80, 52, 14, 9][i] })),
  };
}

function custo(dias = 30, { contas = [CONTA_A], semPrecoNoDia = false, vazio = false } = {}) {
  const lista = diasAte('2026-10-18', dias);
  const porDia = lista.map((dia, i) => ({ dia, usd: semPrecoNoDia && i === 3 ? null : 5 + (i % 7) }));
  return {
    geradoEm: '2026-10-18T23:12:40.000Z',
    fusoHorario: 'UTC',
    dias,
    desde: lista[0],
    ate: '2026-10-18',
    estimativa: true,
    moeda: 'USD',
    contas,
    hoje: '2026-10-18',
    resumoDeHoje: { usd: 12.4 as number | null, sessoes: 9, porConta: contas.map((c, i) => ({ conta: c.id, rotulo: c.rotulo, cor: c.cor, usd: i === 0 ? 9.3 : (null as number | null), semPreco: i === 0 ? [] : ['modelo-novo'] })) },
    periodo: { usd: vazio ? null : 341.2, mediaPorDia: vazio ? null : 11.4 },
    cache: { pct: 71 },
    semPreco: { modelos: ['modelo-novo'], totalDeTokens: 1000 },
    porDia: vazio ? [] : porDia,
    pico: vazio ? null : { dia: lista.at(-2), usd: 18.4 },
    porModelo: vazio
      ? []
      : [
          { modelo: 'claude-opus-5-5', usd: 211.5, pct: 62, totalDeTokens: 1 },
          { modelo: 'claude-sonnet-5-5', usd: 105.8, pct: 31, totalDeTokens: 1 },
          { modelo: 'claude-haiku-5-5', usd: 23.9, pct: 7, totalDeTokens: 1 },
          { modelo: 'modelo-novo', usd: null, pct: null, totalDeTokens: 1000 },
        ],
    porProjeto: vazio
      ? []
      : [
          { projeto: 'motor-de-regras', usd: 128.4 },
          { projeto: 'painel-de-metricas', usd: 74.9 },
          { projeto: 'sem-tabela', usd: null },
        ],
    porConta: contas.map((c, i) => ({ conta: c.id, rotulo: c.rotulo, cor: c.cor, usd: i === 0 ? 300 : 41.2, semPreco: i === 0 ? [] : ['modelo-novo'], porDia: [] })),
  };
}

async function montarTela({ aba, ler }: { aba?: string; ler: (rota: string) => Promise<unknown> }) {
  const area = new Elemento('main');
  const rotas: string[] = [];
  const mudar: (() => void)[] = [];
  const reiniciar: (() => void)[] = [];
  const navegou: string[] = [];
  const ctx = {
    params: aba === undefined ? {} : { aba },
    sinal: new AbortController().signal,
    ler: async (rota: string) => (rotas.push(rota), ler(rota)),
    aoMudar: (f: () => void) => mudar.push(f),
    aoReiniciar: (f: () => void) => reiniciar.push(f),
    contador: () => {},
    titulo: () => {},
    navegar: (r: string) => navegou.push(r),
    aoVivo: () => 'ao-vivo',
  };
  const limpar = await montar(area, ctx, { releituraMs: 5 });
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
    assert.equal(quantidade(412), '412');
    assert.equal(quantidade(1086), '1.086');
    assert.equal(quantidade(48_100), '48,1 mil');
    assert.equal(quantidade(2_100_000), '2,1 mi');
    assert.equal(quantidade(1_900_000_000), '1,9 B');
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
    assert.equal(dataCurta('2026-10-13'), '13 out');
    assert.equal(dataCurta('2026-01-02'), '2 jan');
    assert.equal(milhoes(1_180_000_000), '1.180');
    assert.equal(milhoes(4_240_000), '4,2');
    assert.equal(porcento(71.4), '71%');
    assert.equal(porcento(null), '—');
    assert.equal(porcento(0.4), '<1%');
    assert.equal(porcento(0), '0%');
    assert.equal(topoDoEixo(18.4), 20);
    assert.equal(topoDoEixo(0.7), 1);
    assert.equal(topoDoEixo(0), 1);
  });
  test('nome do modelo', () => {
    assert.equal(nomeDoModelo('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(nomeDoModelo('claude-sonnet-5'), 'Sonnet 5');
    assert.equal(nomeDoModelo('claude-haiku-4-5-20251001'), 'Haiku 4.5');
    assert.equal(nomeDoModelo('claude-opus-4-20250514'), 'Opus 4');
    assert.equal(nomeDoModelo('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
    assert.equal(nomeDoModelo('claude-opus-5-5[1m]'), 'Opus 5.5');
    assert.equal(nomeDoModelo('outro-modelo'), 'outro-modelo');
    assert.equal(nomeDoModelo(null), null);
  });
  test('rosca: até quatro modelos; mais que isso vira "Outros"; sem preço fica fora do arco', () => {
    const m = (modelo: string, v: number | null, pct: number | null) => ({ modelo, usd: v, pct, totalDeTokens: 1 });
    const cinco = fatiasPorModelo([m('claude-opus-5-5', 50, 50), m('claude-sonnet-5-5', 20, 20), m('claude-haiku-5-5', 10, 10), m('a', 10, 10), m('b', 10, 10), m('c', null, null)]);
    assert.deepEqual(
      cinco.map((f: { nome: string; pct: number | null }) => [f.nome, f.pct]),
      [['Opus 5.5', 50], ['Sonnet 5.5', 20], ['Haiku 5.5', 10], ['Outros (2)', 20], ['c', null]],
    );
  });
  test('a cor da conta vira classe só quando é uma cor da marca; senão, nenhuma', () => {
    assert.equal(classeDaConta('#df285d'), null, 'sem getComputedStyle, sem classe');
    const vars: Record<string, string> = { '--rose-500': ' #df285d', '--green-500': '#1baf7a', '--yellow-500': '#ffc30a', '--gray-200': '#a6a6aa' };
    Object.assign(globalThis, { getComputedStyle: () => ({ getPropertyValue: (k: string) => vars[k] ?? '' }) });
    try {
      assert.equal(classeDaConta('#DF285D'), 'an-conta-rosa');
      assert.equal(classeDaConta('#1baf7a'), 'an-conta-verde');
      assert.equal(classeDaConta('#123456'), null);
      assert.equal(classeDaConta(null), null);
    } finally {
      delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    }
  });
  test('o nome do arquivo exportado', () => {
    assert.equal(nomeDoArquivo('visao', { ate: '2026-10-18' }, 30), 'ahrena-analytics-2026-10-18.json');
    assert.equal(nomeDoArquivo('custo', { ate: '2026-10-18' }, 7), 'ahrena-analytics-custo-7d-2026-10-18.json');
  });
});

// ---------- Visão geral (C12) ----------

describe('Analytics: Visão geral', () => {
  test('cabeçalho, os cinco números, as duas abas e os gráficos', async () => {
    const { area, rotas, limpar } = await montarTela({ ler: async () => visao() });
    try {
      assert.match(rotas[0]!, /^\/api\/analytics\?fuso=[^&]+$/);
      const texto = area.textContent;
      assert.match(texto, /Analytics/);
      assert.match(texto, /Uso, custo e produtividade das sessões/);
      assert.match(texto, /Exportar/);

      const stats = comClasse(area, 'an-stat');
      assert.deepEqual(stats.map((s) => s.getAttribute('data-card')), ['sessoes', 'agentes', 'tokens', 'custo', 'eventos']);
      assert.deepEqual(
        stats.map((s) => s.textContent),
        ['Sessões4124 ativas', 'Agentes1.0867 ativos', 'Tokens1,9 B71% de cache', 'Custo~US$ 341estimativa · 30 dias', 'Eventos48,1 mil~117 por sessão'],
      );
      assert.equal(comClasse(area, 'an-contas').length, 0, 'uma conta só: sem divisão');

      const abas = comClasse(area, 'an-abas');
      assert.equal(abas.length, 1);
      const links = porTag(abas[0]!, 'a');
      assert.deepEqual(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]), [
        ['Visão geral', '/ui/analytics', 'page'],
        ['Custo', '/ui/analytics/custo', null],
      ]);

      assert.equal(comClasse(area, 'an-cel').length, 364, 'heatmap: uma célula por dia');
      assert.ok(comClasse(area, 'an-cel').every((c) => porTag(c, 'title').length === 1), 'toda célula tem <title>');
      assert.ok(comClasse(area, 'an-n4').length > 0 && comClasse(area, 'an-n0').length > 0);
      assert.match(texto, /seg.*qua.*sex/);
      assert.match(texto, /menos.*mais/);

      const colunas = comClasse(area, 'an-col');
      assert.equal(colunas.length, 30);
      assert.ok(colunas.at(-1)!.classes.includes('an-atual'));
      assert.match(texto, /Pico 47 em 13 out/);
      assert.match(texto, /Total 742/);

      const listas = comClasse(area, 'an-lista');
      assert.equal(listas.length, 3);
      assert.deepEqual(comClasse(listas[0]!, 'an-linha-lista').map(visivel), ['Opus 5.51.180', 'Sonnet 5.5610', 'Haiku 5.5128']);
      assert.equal(comClasse(listas[1]!, 'an-linha-lista').length, 5, 'ferramentas: top 5');
      assert.deepEqual(comClasse(listas[2]!, 'an-linha-lista').map((l) => l.textContent.slice(0, 3)), ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']);
      for (const g of comClasse(area, 'an-graf')) assert.ok(g.getAttribute('aria-label'), 'todo gráfico tem aria-label');
      assert.match(texto, /\d{2}:\d{2}:\d{2}/, 'a hora em que os números foram calculados');
    } finally {
      limpar();
    }
  });

  test('com duas contas, o custo leva a divisão por conta', async () => {
    const { area, limpar } = await montarTela({ ler: async () => visao({ contas: [CONTA_A, CONTA_B] }) });
    try {
      const custoCard = comClasse(area, 'an-stat').find((s) => s.getAttribute('data-card') === 'custo')!;
      const linhas = porTag(comClasse(custoCard, 'an-contas')[0]!, 'li');
      assert.deepEqual(linhas.map((l) => l.textContent), ['pessoal~US$ 300,00', 'equipe~US$ 41,20 · parcial']);
      assert.equal(linhas[0]!.getAttribute('title'), null);
      assert.equal(linhas[1]!.getAttribute('title'), 'Parcial: sem preço para modelo-novo');
      assert.equal(comClasse(area, 'an-contas').length, 1);
    } finally {
      limpar();
    }
  });

  test('conta sem dono (id null) entra na divisão; heatmap que começa na segunda tem uma célula por dia', async () => {
    const d = visao({ contas: [CONTA_A, { id: null, rotulo: 'Sem conta', cor: null }] as never });
    d.numeros.custo.porConta = [{ conta: CONTA_A.id, usd: 300, semPreco: [] }, { conta: null as never, usd: null as never, semPreco: ['modelo-novo'] }];
    d.atividade.dias = d.atividade.dias.slice(6); // 358 dias, de uma segunda até hoje
    const { area, limpar } = await montarTela({ ler: async () => d });
    try {
      const linhas = porTag(comClasse(area, 'an-contas')[0]!, 'li');
      assert.deepEqual(linhas.map((l) => [l.getAttribute('data-conta'), l.textContent]), [[CONTA_A.id, 'pessoal~US$ 300,00'], ['sem-conta', 'Sem contasem preço']]);
      assert.equal(comClasse(area, 'an-cel').length, 358);
    } finally {
      limpar();
    }
  });

  test('sem sessão nenhuma, o estado vazio', async () => {
    const { area, limpar } = await montarTela({ ler: async () => visao({ sessoes: 0 }) });
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
      ler: async () => {
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
      ler: async () => {
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
      await ate(() => comClasse(area, 'faixa-erro').length === 1);
      assert.equal(comClasse(area, 'an-stat').length, 5, 'os números da última leitura ficam');
    } finally {
      limpar();
    }
  });
});

// ---------- Custo (C13) ----------

describe('Analytics: Custo', () => {
  test('seletor 7/30/90, quatro números, linha, rosca e por projeto; trocar o período relê com ?dias=', async () => {
    const { area, rotas, limpar } = await montarTela({ aba: 'custo', ler: async (rota) => custo(Number(/dias=(\d+)/.exec(rota)![1]), { semPrecoNoDia: true }) });
    try {
      assert.match(rotas[0]!, /^\/api\/analytics\/custo\?dias=30&fuso=[^&]+$/);
      const texto = area.textContent;
      assert.match(texto, /Custo estimado pelo transcript, com o preço de cada modelo/);
      const botoes = porTag(area, 'button').filter((b) => b.getAttribute('data-dias'));
      assert.deepEqual(botoes.map((b) => [b.textContent, b.getAttribute('aria-pressed')]), [['7 dias', 'false'], ['30 dias', 'true'], ['90 dias', 'false']]);
      assert.equal(porTag(comClasse(area, 'an-abas')[0]!, 'a').find((a) => a.getAttribute('aria-current') === 'page')!.textContent, 'Custo');

      assert.deepEqual(
        comClasse(area, 'an-stat').map((s) => s.textContent),
        ['Hoje~US$ 12,409 sessões', '30 dias~US$ 341média ~US$ 11,40 por dia', 'Cache71%dos tokens de entrada', 'Sem preço1modelo sem tabela'],
      );
      assert.equal(comClasse(area, 'an-linha').length, 2, 'o dia sem preço interrompe a linha');
      assert.equal(comClasse(area, 'an-alvo').length, 30);
      assert.ok(comClasse(area, 'an-alvo').some((a) => /sem preço/.test(a.textContent)));
      assert.match(texto, /Pico ~US\$ 18,40 em 17 out/);
      assert.match(texto, /Total ~US\$ 341/);

      assert.equal(comClasse(area, 'an-fatia').length, 3);
      const legenda = porTag(comClasse(area, 'an-legenda')[0]!, 'li').map((l) => l.textContent);
      assert.deepEqual(legenda, ['Opus 5.562%', 'Sonnet 5.531%', 'Haiku 5.57%', 'modelo-novosem preço']);
      assert.match(comClasse(area, 'an-rosca')[0]!.textContent, /~US\$ 34130 dias/);

      const projetos = comClasse(comClasse(area, 'an-projetos')[0]!, 'an-linha-lista').map(visivel);
      assert.deepEqual(projetos, ['motor-de-regras~US$ 128,40', 'painel-de-metricas~US$ 74,90', 'sem-tabelasem preço']);
      assert.doesNotMatch(texto, /US\$ 0[,.]00/, 'sem preço nunca vira US$ 0');

      botoes[0]!.click();
      await ate(() => rotas.length === 2);
      assert.match(rotas[1]!, /^\/api\/analytics\/custo\?dias=7&fuso=/);
      await ate(() => comClasse(area, 'an-alvo').length === 7);
      assert.match(area.textContent, /7 dias~US\$ 341/);
      assert.equal(porTag(area, 'button').find((b) => b.getAttribute('data-dias') === '7')!.getAttribute('aria-pressed'), 'true');
    } finally {
      limpar();
    }
  });

  test('com duas contas, hoje e o período levam a divisão por conta (parcial quando falta preço); com uma, não', async () => {
    const duas = await montarTela({ aba: 'custo', ler: async () => custo(30, { contas: [CONTA_A, CONTA_B] }) });
    try {
      const card = (id: string) => comClasse(duas.area, 'an-stat').find((s) => s.getAttribute('data-card') === id)!;
      const periodo = porTag(comClasse(card('periodo'), 'an-contas')[0]!, 'li');
      assert.deepEqual(periodo.map((l) => l.textContent), ['pessoal~US$ 300,00', 'equipe~US$ 41,20 · parcial']);
      assert.equal(periodo[1]!.getAttribute('title'), 'Parcial: sem preço para modelo-novo');
      const hoje = porTag(comClasse(card('hoje'), 'an-contas')[0]!, 'li');
      assert.deepEqual(hoje.map((l) => l.textContent), ['pessoal~US$ 9,30', 'equipesem preço'], 'usd null é "sem preço", não parcial');
      assert.equal(hoje[1]!.getAttribute('title'), null);
    } finally {
      duas.limpar();
    }
    const uma = await montarTela({ aba: 'custo', ler: async () => custo(30) });
    try {
      assert.equal(comClasse(uma.area, 'an-contas').length, 0);
    } finally {
      uma.limpar();
    }
  });

  test('custo sem preço no período mostra "sem preço", não US$ 0', async () => {
    const d = custo(30);
    d.periodo = { usd: null, mediaPorDia: null };
    d.resumoDeHoje = { usd: null, sessoes: 2, porConta: [] };
    const { area, limpar } = await montarTela({ aba: 'custo', ler: async () => d });
    try {
      const textos = comClasse(area, 'an-stat').map((s) => s.textContent);
      assert.equal(textos[0], 'Hojesem preço2 sessões');
      assert.equal(textos[1], '30 diassem preçomédia: sem preço');
    } finally {
      limpar();
    }
  });

  test('período sem custo: o estado vazio, com o seletor no ar', async () => {
    const { area, limpar } = await montarTela({ aba: 'custo', ler: async () => custo(7, { vazio: true }) });
    try {
      assert.match(area.textContent, /Nenhum custo nos últimos 30 dias/);
      assert.equal(porTag(area, 'button').filter((b) => b.getAttribute('data-dias')).length, 3);
    } finally {
      limpar();
    }
  });

  test('erro na leitura do custo', async () => {
    const { area, limpar } = await montarTela({ aba: 'custo', ler: async () => Promise.reject(new Error('O núcleo respondeu 500')) });
    try {
      assert.match(area.textContent, /Sem conexão com o núcleo.*O núcleo respondeu 500.*Tentar de novo/);
    } finally {
      limpar();
    }
  });

  test('aba que não existe: não lê nada e oferece a Visão geral', async () => {
    const { area, rotas, navegou, limpar } = await montarTela({ aba: 'tokens', ler: async () => visao() });
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

test('o registro: Analytics na barra; /ui/analytics/custo abre a mesma tela e acende Analytics', () => {
  const a = acharTela('/ui/analytics');
  assert.equal(a.tela.id, 'analytics');
  assert.deepEqual(a.tela.item, { rotulo: 'Analytics', icone: 'analytics' });
  const c = acharTela('/ui/analytics/custo');
  assert.equal(c.tela.acende, 'analytics');
  assert.deepEqual(c.params, { aba: 'custo' });
  assert.equal(c.tela.arquivo, a.tela.arquivo);
  assert.equal(TELAS.filter((t: { item?: { rotulo: string } }) => t.item?.rotulo === 'Analytics').length, 1, 'um item só na barra');
});

test('as rotas e os períodos da tela são os do núcleo', async () => {
  const { ROTA_DO_ANALYTICS, ROTA_DO_CUSTO, DIAS_DO_CUSTO } = await import('../../src/api/rota-analytics.ts');
  assert.equal(tela.ROTA_DA_VISAO, ROTA_DO_ANALYTICS);
  assert.equal(tela.ROTA_DO_CUSTO, ROTA_DO_CUSTO);
  assert.deepEqual(tela.PERIODOS, [...DIAS_DO_CUSTO]);
});

test('a tela e o estilo dela não escrevem cor à mão, não chamam endereço de fora nem põem estilo inline', () => {
  for (const arquivo of ['telas/analytics.js', 'analytics.css']) {
    const texto = readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8');
    assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${arquivo} escreve cor à mão`);
    const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(urls, [], `${arquivo} chama endereço de fora`);
    assert.doesNotMatch(texto, /innerHTML|style=|\.style\b|'style'/, `${arquivo} põe HTML ou estilo inline`);
  }

  // O CSS de cada tela fica carregado depois que ela abre: classe própria sem prefixo, ou repetida
  // em outra tela, desmonta a outra (o `.linha` do Dashboard desmontava a tabela de Sessões, #151).
  test('analytics.css só estiliza classes an-* ou da moldura, e nenhuma de outra tela', () => {
    const classes = (arquivo: string) => new Set([...readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const daMoldura = classes('moldura.css');
    const minhas = [...classes('analytics.css')].filter((c) => !daMoldura.has(c));
    assert.deepEqual(minhas.filter((c) => !c.startsWith('an-')), [], 'classe própria do Analytics sem o prefixo an-');
    const outras = readdirSync(PASTA_DA_UI).filter((a) => a.endsWith('.css') && !['analytics.css', 'moldura.css', 'marca.css'].includes(a));
    for (const outra of outras) {
      const comuns = [...classes(outra)].filter((c) => minhas.includes(c));
      assert.deepEqual(comuns, [], `analytics.css e ${outra} estilizam as mesmas classes`);
    }
  });
});
