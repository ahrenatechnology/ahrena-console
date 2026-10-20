// As Decisões na /ui (issue 103), do lado do navegador: o transporte das escritas (ler.js), os rótulos do
// card e as rotas que a página (C21) e a aba (C20) leem. O DOM fica para o navegador; aqui vão as
// funções puras e as travas.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
    for (const rota of ['/api/hooks', '/api/decisoes/d1/apagar', '/api/decisoes/d1/confirmar?x=1', '/api/decisoes/../hooks/confirmar', 'https://exemplo.com/api/decisoes/d1/confirmar', '/ui/decisoes']) {
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
    assert.equal(tela.item.icone, 'decisoes');
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
