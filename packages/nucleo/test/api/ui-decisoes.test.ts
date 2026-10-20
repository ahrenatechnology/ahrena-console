// As Decisões na /ui (issue 103), do lado do navegador: o transporte das escritas (ler.js), os rótulos do
// card e as rotas que a página (C21) e a aba (C20) leem. O DOM fica para o navegador; aqui vão as
// funções puras e as travas.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { ErroDeLeitura, escritorHttp } from '../../ui/ler.js';
// @ts-expect-error: idem
import { haQuanto, linkDaConversa, pedidoDaAcao, pedidoDePromover, quemDecidiu, rotuloDoEscopo, rotuloDoEstado, rotuloDoTipo } from '../../ui/telas/decisoes-comum.js';
// @ts-expect-error: idem
import { resumoDoGrupo, rotaDasDecisoes } from '../../ui/telas/decisoes.js';
// @ts-expect-error: idem
import { criar, partesDaChamada, rotaDaAba } from '../../ui/telas/detalhe-decisoes.js';
// @ts-expect-error: idem
import { acharTela, TELAS } from '../../ui/telas.js';

interface Pedido {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string };
}

function fetchFalso(status = 200, corpo: unknown = { ok: true }) {
  const pedidos: Pedido[] = [];
  const f = async (url: URL, init: Pedido['init']) => {
    pedidos.push({ url: String(url), init });
    return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
  };
  return { f, pedidos };
}

describe('escrever (ler.js)', () => {
  test('POST em JSON na própria origem, sem credenciais', async () => {
    const { f, pedidos } = fetchFalso(200, { decisao: { id: 'd1' } });
    const escrever = escritorHttp({ base: 'http://127.0.0.1:4791', fetch: f });
    const r = await escrever('/api/decisoes/d1/confirmar', { sessao: 's1' });
    assert.deepEqual(r, { decisao: { id: 'd1' } });
    assert.equal(pedidos.length, 1);
    const [p] = pedidos;
    assert.equal(p!.url, 'http://127.0.0.1:4791/api/decisoes/d1/confirmar');
    assert.equal(p!.init.method, 'POST');
    assert.equal(p!.init.headers!['content-type'], 'application/json');
    assert.equal(p!.init.credentials, 'omit');
    assert.deepEqual(JSON.parse(p!.init.body!), { sessao: 's1' });
  });

  test('recusa host de fora, https e rota que não é escrita das decisões, antes de sair', async () => {
    assert.throws(() => escritorHttp({ base: 'http://exemplo.com:4720', fetch: fetchFalso().f }), /só fala com o núcleo local/);
    assert.throws(() => escritorHttp({ base: 'https://127.0.0.1:4720', fetch: fetchFalso().f }), /só fala com o núcleo local/);
    const { f, pedidos } = fetchFalso();
    const escrever = escritorHttp({ base: 'http://localhost:4791', fetch: f });
    for (const rota of ['/api/hooks', '/api/decisoes/d1/apagar', '/api/decisoes/d1/confirmar?x=1', '/api/decisoes/../hooks/confirmar', '/api/decisoes/../confirmar', '/api/decisoes/.d1/confirmar', 'https://exemplo.com/api/decisoes/d1/confirmar', '/ui/decisoes']) {
      await assert.rejects(escrever(rota, { sessao: 's' }), (e: InstanceType<typeof ErroDeLeitura>) => e instanceof ErroDeLeitura, rota);
    }
    assert.equal(pedidos.length, 0, 'nada saiu');
  });

  test('a recusa do núcleo vira ErroDeLeitura com o status e a mensagem dele', async () => {
    const escrever = escritorHttp({ base: 'http://127.0.0.1:4791', fetch: fetchFalso(409, { error: 'a decisão já não está a confirmar' }).f });
    await assert.rejects(escrever('/api/decisoes/d1/descartar', { sessao: 's' }), (e: InstanceType<typeof ErroDeLeitura>) => e.status === 409 && /já não está/.test(e.message));
    const caido = escritorHttp({ base: 'http://127.0.0.1:1' });
    await assert.rejects(caido('/api/decisoes/d1/confirmar', { sessao: 's' }), (e: InstanceType<typeof ErroDeLeitura>) => e.status === 0 && /não respondeu/.test(e.message));
  });
});

describe('o card de uma decisão', () => {
  test('pílula de tipo, quem e estado como o wireframe escreve', () => {
    assert.deepEqual(['sugerida', 'correcao', 'permissao', 'pergunta', 'plano'].map(rotuloDoTipo), ['Sugerida', 'Correção sua', 'Permissão', 'Pergunta', 'Plano']);
    assert.equal(quemDecidiu({ origem: 'sugerida', decididaPor: 'agente' }), 'agente propôs');
    assert.equal(quemDecidiu({ origem: 'correcao', decididaPor: 'usuario' }), 'você corrigiu');
    assert.equal(quemDecidiu({ origem: 'plano', decididaPor: 'usuario' }), 'você aprovou');
    assert.equal(quemDecidiu({ origem: 'pergunta', decididaPor: 'agente' }), 'agente');
    assert.equal(quemDecidiu({ origem: 'pergunta', decididaPor: 'usuario' }), 'você');
    assert.deepEqual(['vigente', 'a_confirmar', 'substituida'].map(rotuloDoEstado), ['Vigente', 'A confirmar', 'Substituída']);
  });

  test('escopo, e de onde veio só quando não é desta sessão', () => {
    assert.equal(rotuloDoEscopo({ escopo: 'sessao', sessao: 'esta' }), 'escopo: sessão');
    assert.equal(rotuloDoEscopo({ escopo: 'familia', sessao: 'mae' }), 'escopo: família · da sessão mãe');
    assert.equal(rotuloDoEscopo({ escopo: 'branch', sessao: 'branch' }), 'escopo: branch · de outra sessão do branch');
  });

  test('"há X min"', () => {
    const agora = Date.parse('2026-10-20T12:00:00Z');
    const antes = (min: number) => new Date(agora - min * 60_000).toISOString();
    assert.equal(haQuanto(antes(0.5), agora), 'agora');
    assert.equal(haQuanto(antes(14), agora), 'há 14 min');
    assert.equal(haQuanto(antes(3 * 60 + 5), agora), 'há 3 h');
    assert.equal(haQuanto(antes(30 * 60), agora), 'ontem');
    assert.equal(haQuanto(antes(4 * 24 * 60), agora), 'há 4 d');
    assert.equal(haQuanto('não é data', agora), '');
  });

  test('Ver na conversa só com rota da própria interface', () => {
    assert.equal(linkDaConversa({ conversa: '/ui/sessoes/sess-1' }), '/ui/sessoes/sess-1');
    for (const conversa of ['https://exemplo.com/ui/sessoes/x', 'javascript:alert(1)', '/ui/sessoes/x/../../api', null]) assert.equal(linkDaConversa({ conversa }), null, String(conversa));
  });

  test('os pedidos de escrita: Confirmar, Descartar e as duas fases do Promover', () => {
    assert.deepEqual(pedidoDaAcao('d1', 'confirmar', { sessao: 's1' }), { rota: '/api/decisoes/d1/confirmar', corpo: { sessao: 's1' } });
    // O id do núcleo tem `:` ("dec:…"): vai cru, como a regra de origem do servidor espera.
    assert.equal(pedidoDaAcao('dec:4b1f', 'confirmar', { sessao: 's1' }).rota, '/api/decisoes/dec:4b1f/confirmar');
    assert.deepEqual(pedidoDaAcao('d1', 'descartar', { sessao: 's1' }), { rota: '/api/decisoes/d1/descartar', corpo: { sessao: 's1' } });
    assert.deepEqual(pedidoDePromover('d1', 's1'), { rota: '/api/decisoes/d1/promover', corpo: { sessao: 's1' } });
    assert.deepEqual(pedidoDePromover('d1', 's1', { caminho: 'docs/decisoes/0008-x.md' }), {
      rota: '/api/decisoes/d1/promover',
      corpo: { sessao: 's1', confirmar: true, caminho: 'docs/decisoes/0008-x.md' },
    });
    assert.deepEqual(pedidoDePromover('d1', 's1', { caminho: 'docs/decisoes/0008-x.md', hash: 'ab'.repeat(32) }).corpo, {
      sessao: 's1', confirmar: true, caminho: 'docs/decisoes/0008-x.md', hash: 'ab'.repeat(32),
    }, 'o hash do rascunho vai junto no confirmar');
    assert.throws(() => pedidoDaAcao('../x', 'confirmar', { sessao: 's1' }), /id de decisão/);
    assert.throws(() => pedidoDaAcao('d1', 'apagar', { sessao: 's1' }), /ação desconhecida/);
    assert.throws(() => pedidoDaAcao('d1', 'confirmar', {}), /precisa da sessão/);
  });
});

describe('a página (C21) e a aba (C20)', () => {
  test('a página está registrada na barra, depois de Sessões', () => {
    const ids = TELAS.filter((t: { item?: unknown }) => t.item).map((t: { id: string }) => t.id);
    assert.deepEqual(ids.slice(ids.indexOf('sessoes')), ['sessoes', 'decisoes']);
    const { tela } = acharTela('/ui/decisoes');
    assert.equal(tela.item.rotulo, 'Decisões');
    assert.equal(tela.item.icone, 'decisao', 'o desenho do main (git-commit-horizontal), não um nome novo');
    assert.equal(tela.icone, 'decisao');
  });

  test('as rotas de leitura levam só os filtros que não são o padrão', () => {
    assert.equal(rotaDasDecisoes(), '/api/decisoes?agrupar=branch');
    assert.equal(rotaDasDecisoes({ agrupar: 'familia', estado: 'a_confirmar', q: 'banco de testes', grupo: 'b:abc' }), '/api/decisoes?agrupar=familia&estado=a_confirmar&q=banco+de+testes&grupo=b%3Aabc');
    assert.equal(rotaDasDecisoes({ q: 'x'.repeat(500) }).length, '/api/decisoes?agrupar=branch&q='.length + 200);
    assert.equal(rotaDaAba('/api/sessoes/s1'), '/api/sessoes/s1/decisoes?escopo=familia');
    assert.equal(rotaDaAba('/api/sessoes/s1', { escopo: 'branch', estado: 'vigentes', q: 'kanban' }), '/api/sessoes/s1/decisoes?escopo=branch&estado=vigentes&q=kanban');
  });

  test('o resumo do grupo e a chamada do MCP', () => {
    assert.equal(resumoDoGrupo({ tipo: 'branch', pasta: 'vitrine-demo', vigentes: 6, aConfirmar: 1 }), 'vitrine-demo · 6 vigentes · 1 a confirmar');
    assert.equal(resumoDoGrupo({ tipo: 'branch', pasta: 'motor-de-regras', vigentes: 1, aConfirmar: 0 }), 'motor-de-regras · 1 vigente');
    assert.equal(resumoDoGrupo({ tipo: 'familia', titulo: 'Kanban da vitrine', pasta: 'vitrine-demo', vigentes: 2, aConfirmar: 0 }), 'vitrine-demo · 2 vigentes');
    assert.equal(resumoDoGrupo({ tipo: 'familia', titulo: 'motor-de-regras', pasta: 'motor-de-regras', vigentes: 2, aConfirmar: 0 }), '2 vigentes');
    assert.deepEqual(partesDaChamada({ ferramenta: 'session_decisions', chamada: 'session_decisions branch: "feat/42-kanban"' }), ['session_decisions', 'branch: "feat/42-kanban"']);
  });

  test('a aba lê a rota dela e rotula com o total, mesmo escondida', async () => {
    const lidas: string[] = [];
    const rotulos: (string | null)[] = [];
    const ouvintes: ((m: { tipo: string }[]) => void)[] = [];
    const ctx = {
      ler: async (rota: string) => (lidas.push(rota), { sessao: 's1', total: 4, itens: [], porEscopo: { sessao: 4, familia: 5, branch: 6 }, injecao: {}, mcp: {} }),
      aoMudar: (f: (m: { tipo: string }[]) => void) => ouvintes.push(f),
    };
    const aba = criar(ctx, '/api/sessoes/s1', { cabeca: () => null, rotular: (t: string | null) => rotulos.push(t) });
    assert.equal(typeof aba.mostrar, 'function');
    assert.equal(typeof aba.esconder, 'function');
    await aba.atualizar();
    assert.deepEqual(lidas, ['/api/sessoes/s1/decisoes?escopo=familia'], 'o escopo padrão é a família');
    assert.deepEqual(rotulos, ['4'], 'o texto entre parênteses');
    assert.equal(ouvintes.length, 1, 'a aba escuta as mudanças de decisão');
  });
});

// O estilo das Decisões, lido como texto: o navegador fica com o dono; aqui vão as travas que um
// arquivo .css e o JS que o usa conseguem provar sozinhos.
const TELA = 'decisoes.css';
const PREFIXO = 'dec-';
const JS_DA_TELA = ['telas/decisoes.js', 'telas/detalhe-decisoes.js', 'telas/decisoes-comum.js'];
// Igual ao `classes()` e ao `SELOS` de test/api/sessoes.test.ts (no main), para os dois testes andarem juntos.
const classesDoCss = (caminho: string) => new Set([...readFileSync(caminho, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
const classes = (arquivo: string) => classesDoCss(`${PASTA_DA_UI}${arquivo}`);
const SELOS = new Set(['badge', 'p', 'mot', 'leve', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);
const permitida = (c: string, daMoldura: Set<string>) => c.startsWith(PREFIXO) || daMoldura.has(c) || SELOS.has(c);

/** Os css das outras telas: `ui/*.css` e `ui/telas/*.css`, fora a moldura, a marca e o desta tela. */
function outrosCss(): string[] {
  const fora = new Set([TELA, 'moldura.css', 'marca.css']);
  return ['', 'telas/'].flatMap((sub) => readdirSync(`${PASTA_DA_UI}${sub}`).filter((a) => a.endsWith('.css') && !fora.has(a)).map((a) => `${PASTA_DA_UI}${sub}${a}`));
}

/** As classes que `tela` e cada css de `outras` estilizam em comum, fora a moldura e os selos. */
function repetidas(tela: string, outras: string[]): Record<string, string[]> {
  const daMoldura = classes('moldura.css');
  const minhas = new Set([...classesDoCss(tela)].filter((c) => !daMoldura.has(c)));
  const out: Record<string, string[]> = {};
  for (const outra of outras) {
    const comuns = [...classesDoCss(outra)].filter((c) => minhas.has(c) && !SELOS.has(c));
    if (comuns.length) out[outra] = comuns;
  }
  return out;
}

/**
 * As classes que o JS põe num `class:`. Cada valor é lido até a vírgula ou a chave que fecha o objeto;
 * dele saem as strings, menos as que são comparadas (`g.tipo === 'branch' ? … : …`). Num template, o
 * pedaço antes de `${…}` tem de ser a classe inteira até ali (`dec-e-${estado}` conta como `dec-e-`).
 */
function classesDoJs(texto: string): string[] {
  const achadas: string[] = [];
  for (const m of texto.matchAll(/\bclass:\s*/g)) {
    let i = m.index! + m[0].length;
    let fundo = 0;
    let expr = '';
    for (; i < texto.length; i++) {
      const ch = texto[i]!;
      if (ch === "'" || ch === '"' || ch === '`') {
        const fim = texto.indexOf(ch, i + 1);
        expr += texto.slice(i, fim + 1);
        i = fim;
        continue;
      }
      if ('([{'.includes(ch)) fundo++;
      if (')]}'.includes(ch)) {
        if (fundo === 0) break;
        fundo--;
      }
      if (ch === ',' && fundo === 0) break;
      expr += ch;
    }
    for (const s of expr.matchAll(/(===|!==)?\s*(['"`])([^'"`]*)\2/g)) {
      if (s[1]) continue;
      for (const nome of s[3]!.split(/\s+/).filter(Boolean)) achadas.push(nome.includes('${') ? nome.slice(0, nome.indexOf('${')) : nome);
    }
  }
  return achadas;
}

describe('sem padrão interno', () => {
  // A pasta dos registros, o repositório e o host vêm do núcleo (o rascunho traz o caminho); a tela não
  // aponta para recurso nenhum da Ahrena nem supõe a pasta de um projeto.
  test('o front das Decisões não cita org, repositório, host, caminho de máquina nem pasta de registros', () => {
    for (const arquivo of [...JS_DA_TELA, TELA, 'ler.js']) {
      const texto = readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8');
      for (const proibido of [/ahrena/i, /github|gitlab/i, /\/Users\/|\/home\//, /docs\/decisoes/, /\b[a-z0-9-]+\.(com|io|dev|ai)\b/i]) assert.doesNotMatch(texto, proibido, `${arquivo}: ${proibido}`);
    }
  });
});

describe('o estilo das Decisões (ui/decisoes.css)', () => {
  test('o CSS fica na raiz de ui/, como o das outras telas, e as duas telas carregam de lá', () => {
    assert.ok(readdirSync(PASTA_DA_UI).includes(TELA));
    assert.ok(!readdirSync(`${PASTA_DA_UI}telas`).includes(TELA), 'nada de cópia em telas/');
    assert.match(readFileSync(`${PASTA_DA_UI}telas/decisoes-comum.js`, 'utf8'), /href: '\/ui\/decisoes\.css'/);
  });

  // O CSS de cada tela fica carregado quando se troca de tela: uma classe com o mesmo nome em duas
  // telas desmonta a outra. Mesmo teste do sessoes.test.ts do main, para o decisoes.css.
  test('o CSS desta tela não estiliza classe de outra tela, fora os selos de status em comum', (t) => {
    const outras = outrosCss();
    if (outras.length === 0) return t.skip('sem outro css até o rebase');
    assert.deepEqual(repetidas(`${PASTA_DA_UI}${TELA}`, outras), {});
  });

  test('a comparação acima pega a classe repetida num css de outra tela', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'ui-decisoes-'));
    try {
      const outra = join(pasta, 'outra.css');
      writeFileSync(outra, '.dec-seg { color: red; }\n.badge { color: blue; }\n.so-dela { margin: 0; }\n');
      assert.deepEqual(repetidas(`${PASTA_DA_UI}${TELA}`, [outra]), { [outra]: ['dec-seg'] }, 'a repetida entra; o selo e a só dela, não');
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });

  test('toda classe do CSS e do JS das Decisões é dec-*, da moldura ou dos selos', () => {
    const daMoldura = classes('moldura.css');
    assert.deepEqual([...classes(TELA)].filter((c) => !permitida(c, daMoldura)), [], `${TELA} tem classe sem o prefixo ${PREFIXO}`);
    for (const js of JS_DA_TELA) {
      const usadas = classesDoJs(readFileSync(`${PASTA_DA_UI}${js}`, 'utf8'));
      assert.ok(usadas.length > 0, `${js}: nenhuma classe lida (o leitor de class: quebrou?)`);
      assert.deepEqual(usadas.filter((c) => !permitida(c, daMoldura)), [], `${js} usa classe sem o prefixo ${PREFIXO}`);
    }
  });

  test('o leitor de class: do teste acima', () => {
    assert.deepEqual(classesDoJs("el('a', { class: 'mono dec-x', href: y })"), ['mono', 'dec-x']);
    assert.deepEqual(classesDoJs("el('a', { class: g.tipo === 'branch' ? 'mono dec-n' : 'dec-n' })"), ['mono', 'dec-n', 'dec-n']);
    assert.deepEqual(classesDoJs('el(\'a\', { class: `cartao dec-e-${d.estado}` })'), ['cartao', 'dec-e-']);
    assert.deepEqual(classesDoJs("el('a', { class: v === w ? 'on' : null })"), ['on'], 'e acha a que não tem prefixo');
  });

  // A janela abre com 1100 × 760 (#150) e vai a 1440: a área da tela é a janela menos a barra (220) e o
  // respiro (2 × 24). Nada pode rolar na horizontal.
  test('nada rola na horizontal: sem overflow-x auto, pre com pre-wrap, e as larguras declaradas cabem', () => {
    const css = readFileSync(`${PASTA_DA_UI}${TELA}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const area = (janela: number) => janela - 220 - 2 * 24;
    const FOLGA = 15; // a barra de rolagem da área, quando o sistema não a esconde

    assert.doesNotMatch(css, /overflow(-x)?\s*:\s*(auto|scroll)\b/, 'nada rola na horizontal');
    assert.doesNotMatch(css, /white-space:\s*pre\s*;/, 'pre sem quebra');

    // Todo <pre> das telas quebra a linha.
    const pres = JS_DA_TELA.flatMap((js) => [...readFileSync(`${PASTA_DA_UI}${js}`, 'utf8').matchAll(/el\('pre', \{ class: '([^']+)'/g)].flatMap((m) => m[1]!.split(' ').filter((c) => c.startsWith(PREFIXO))));
    assert.ok(pres.length >= 2, 'a injeção e o rascunho são <pre>');
    for (const c of pres) {
      const regra = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel!.split(',').some((s) => s.trim() === `.${c}`));
      assert.ok(regra, `.${c} sem regra`);
      assert.match(regra![2]!, /white-space:\s*pre-wrap/, `.${c} sem pre-wrap`);
      assert.match(regra![2]!, /overflow-wrap:\s*anywhere/, `.${c} sem overflow-wrap`);
    }

    // C20: lista e coluna lateral lado a lado só enquanto cabem com o mínimo das duas.
    const grade = /\.dec-grade \{[^}]*grid-template-columns: minmax\((\d+)px, 1fr\) minmax\((\d+)px, (\d+)px\); gap: (\d+)px;/.exec(css);
    assert.ok(grade, 'a grade da aba declara os mínimos em px');
    const [lista, lado, ladoMax, gap] = grade!.slice(1).map(Number) as [number, number, number, number];
    const corte = /@media \(max-width: (\d+)px\) \{\s*\.dec-grade \{ grid-template-columns: minmax\(0, 1fr\); \}/.exec(css);
    assert.ok(corte, 'abaixo de uma largura a coluna lateral empilha');
    const empilha = Number(corte![1]);
    assert.ok(lista + gap + lado + FOLGA <= area(empilha + 1), `lado a lado em ${empilha + 1}: ${lista + gap + lado + FOLGA} > ${area(empilha + 1)}`);
    for (const janela of [1100, 1440]) {
      assert.ok(janela > empilha, `em ${janela} a aba tem a coluna lateral`);
      assert.ok(lista + gap + lado <= area(janela), `${janela}: a grade não cabe`);
    }
    assert.ok(area(1440) - gap - ladoMax >= lista, 'em 1440 a lista fica com o resto');

    // Largura fixa maior que um botão só no diálogo, e ele com max-width relativo à janela.
    const largas = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , corpo]) => [...corpo!.matchAll(/(?:^|[;\s])(?:min-)?width:\s*(\d+)px/g)].some((w) => Number(w[1]) > 120));
    assert.deepEqual(largas.map(([, sel]) => sel!.trim()), ['.dec-dlg'], 'largura fixa fora do diálogo');
    assert.match(largas[0]![2]!, /max-width:\s*calc\(100vw - \d+px\)/, 'o diálogo encolhe com a janela');
    assert.doesNotMatch(css, /min-width:\s*[1-9]\d*px/, 'min-width em px empurra a linha para fora');
  });
});
