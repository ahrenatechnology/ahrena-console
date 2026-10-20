// The session's decisions in the panel (#102): count, list by scope, account, Confirm and Dismiss,
// through the builder and through the API on 127.0.0.1. Simulator data (P9) and synthetic drafts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, LEGACY_BODIES, MontadorDoPainel, TrabalhoPorBranch, iniciarApiLocal, translateBody, type DecisaoDoPainel, type ListaDeDecisoes, type Painel } from '../../src/api/index.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { registerDecision } from '../../src/decisions/registry.ts';
import { SimulatorWorkSource, PANEL_SESSION, seedPanelScenario, seedPanelDecisions, type PanelScenario } from '../../src/simulator/panel.ts';
import { T0, session } from '../fixtures.ts';

const AGORA = Date.parse(T0);
const BRANCH = 'feat/42-kanban-de-sessoes';
const REPO = '/simulacao/ahrena-demo';
const EQUIPE = '00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1';
const CLIENTE = '00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1';

async function cenario(nome: PanelScenario = 'p9') {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisoes = new SqliteDecisionStore(storage.db);
  await seedPanelScenario(storage, nome, AGORA);
  await seedPanelDecisions(decisoes, nome, AGORA);
  const trabalho = new TrabalhoPorBranch({ fonte: new SimulatorWorkSource(), git: SimulatorWorkSource.git, agora: () => AGORA });
  const montador = new MontadorDoPainel({
    storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, decisoes, agora: () => AGORA, apelido: () => PANEL_SESSION,
  });
  await montador.montar({ sessionId: 'qualquer' });
  await trabalho.esperar();
  return { storage, decisoes, montador };
}

const titulos = (l: ListaDeDecisoes) => l.items.map((i) => `${i.label} ${i.state}`);

// Uma decisão de escopo branch de outra família, no mesmo branch e pasta, com a conta dada.
async function deOutraSessao(storage: ReturnType<typeof openSqliteStorage>, decisoes: SqliteDecisionStore, id: string, conta: string | null, choice: string) {
  await storage.putSession({ ...session({ id, cwd: REPO }), accountId: conta, accountSource: conta ? 'env' : null });
  await registerDecision(
    decisoes,
    {
      sourceKey: `teste:${id}`, sessionId: id, repo: REPO, branch: BRANCH, topic: `outro:${id}`, context: null, choice, alternatives: [],
      decidedBy: 'usuario', origin: 'pergunta', inferred: false, scope: 'branch', decidedAt: new Date(AGORA - 2 * 60_000).toISOString(),
    },
    T0,
  );
}

describe('decisões no painel', () => {
  test('a linha conta as vigentes e as a confirmar da família; sem a porta, não vem', async () => {
    const { storage, montador } = await cenario();
    const p = await montador.montar({ sessionId: 'qualquer' });
    assert.deepEqual(p.decisions, { current: 4, toConfirm: 1, resume: null, list: null });
    await storage.close();

    const semPorta = openSqliteStorage({ path: ':memory:' });
    await seedPanelScenario(semPorta, 'p1', AGORA);
    const m = new MontadorDoPainel({ storage: semPorta, contas: new Contas({ storage: semPorta, arquivo: null }), desktop: null, trabalho: null, agora: () => AGORA, apelido: () => PANEL_SESSION });
    assert.equal((await m.montar({ sessionId: 'qualquer' })).decisions, null);
    await semPorta.close();
  });

  test('P9: sessão, família e branch, mais recentes primeiro, com a substituída apontando a nova', async () => {
    const { storage, montador } = await cenario();
    const sessao = (await montador.montar({ sessionId: 'qualquer', decisoes: 'session' })).decisions!.list!;
    assert.deepEqual(titulos(sessao), ['D6 to_confirm', 'D4 current', 'D5 current', 'D3 superseded', 'D2 current']);
    assert.equal(sessao.current, 3);
    assert.equal(sessao.toConfirm, 1);

    const familia = (await montador.listaDeDecisoes({ sessionId: 'qualquer' }, 'family'))!;
    assert.deepEqual(titulos(familia), ['D6 to_confirm', 'D4 current', 'D5 current', 'D3 superseded', 'D2 current', 'D1 current']);
    const porRotulo = Object.fromEntries(familia.items.map((i) => [i.label, i])) as Record<string, DecisaoDoPainel>;
    assert.equal(porRotulo.D3!.supersededBy, 'D4');
    assert.deepEqual(porRotulo.D6!.rejected, ['20 por coluna', 'rolagem infinita']);
    assert.equal(porRotulo.D6!.decidedBy, 'agent');
    assert.equal(porRotulo.D1!.session, 'parent');
    assert.equal(porRotulo.D1!.toolUseId, null, 'a mensagem da mãe não está nesta conversa');
    assert.equal(porRotulo.D4!.toolUseId, 'sim-toolu-p9-4');
    assert.equal(familia.current, 4);
    await storage.close();
  });

  test('branch: entra a decisão de escopo branch de outra sessão da mesma conta; a de outra conta, não', async () => {
    const { storage, decisoes, montador } = await cenario();
    await deOutraSessao(storage, decisoes, 'sim-outra-equipe', EQUIPE, 'Raias com cor por status');
    await deOutraSessao(storage, decisoes, 'sim-outra-cliente', CLIENTE, 'Segredo do cliente');
    await deOutraSessao(storage, decisoes, 'sim-outra-sem-conta', null, 'Raias com contador');
    const branch = (await montador.listaDeDecisoes({ sessionId: 'qualquer' }, 'branch'))!;
    const nomes = branch.items.map((i) => i.title);
    assert.ok(nomes.includes('Raias com cor por status'));
    assert.ok(nomes.includes('Raias com contador'), 'sem conta conhecida, não há como dizer que é de outra');
    assert.ok(!nomes.includes('Segredo do cliente'));
    assert.equal(branch.items.find((i) => i.title === 'Raias com cor por status')?.session, 'branch');
    const familia = (await montador.listaDeDecisoes({ sessionId: 'qualquer' }, 'family'))!;
    assert.ok(!familia.items.some((i) => i.session === 'branch'), 'a família não pega o branch');
    await storage.close();
  });

  // #173 phase 2b: the published mod reads the old route, so its types cover the old body (back-translated).
  test('todo campo da resposta está nos tipos do plugin', async () => {
    const { storage, montador } = await cenario();
    const painel = translateBody(LEGACY_BODIES.panel.response, await montador.montar({ sessionId: 'qualquer', decisoes: 'family' })) as { decisoes: unknown };
    const tipos = readFileSync(new URL('../../../../plugins/ahrena-console/types/index.d.ts', import.meta.url), 'utf8');
    const chaves = new Set<string>();
    const juntar = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(juntar);
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (chaves.add(k), juntar(x));
    };
    juntar(painel.decisoes);
    juntar({ retomada: { n: 1, tokens: 1, de: 'x' } });
    assert.deepEqual([...chaves].filter((k) => !new RegExp(`\\b${k}\\??:`).test(tipos)), []);
    await storage.close();
  });

  test('sem branch pelo Desktop, metadado ou git, o painel usa o que a sessão gravou, como a lista e o Confirmar', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const decisoes = new SqliteDecisionStore(storage.db);
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null, decisoes, agora: () => AGORA });
    const gravar = (sessionId: string, scope: 'sessao' | 'branch', choice: string) =>
      registerDecision(
        decisoes,
        {
          sourceKey: `teste:${sessionId}`, sessionId, repo: '/r', branch: 'feat/x', topic: `t:${sessionId}`, context: null, choice, alternatives: [],
          decidedBy: 'usuario', origin: 'pergunta', inferred: false, scope, decidedAt: new Date(AGORA - 60_000).toISOString(),
        },
        T0,
      );
    await storage.putSession(session({ id: 'sess-a', cwd: null }));
    await storage.putSession(session({ id: 'sess-b', cwd: '/r' }));
    await gravar('sess-a', 'sessao', 'A própria');
    await gravar('sess-b', 'branch', 'De outra família');

    const doPainel = (await montador.montar({ sessionId: 'sess-a', decisoes: 'branch' })).decisions!.list!;
    const daLista = (await montador.listaDeDecisoes({ sessionId: 'sess-a' }, 'branch'))!;
    assert.deepEqual(doPainel.byScope, daLista.byScope);
    assert.equal(doPainel.items.length, daLista.items.length);
    assert.ok(daLista.items.some((i) => i.title === 'De outra família'), 'o cenário tem a decisão de branch');
    await storage.close();
  });
});

describe('API das decisões em 127.0.0.1', () => {
  test('lista por escopo; Confirmar e Descartar só por JSON, da sessão que enxerga, com quem e quando', async () => {
    const { storage, decisoes, montador } = await cenario();
    const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    const post = (caminho: string, corpo: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
      fetch(`${api.url}${caminho}`, { method: 'POST', headers, body: JSON.stringify(corpo) });
    try {
      const familia = (await (await fetch(`${api.url}/api/decisions/qualquer?scope=family`)).json()) as ListaDeDecisoes;
      assert.equal(familia.items.length, 6);
      assert.equal((await fetch(`${api.url}/api/decisions/qualquer?scope=maquina`)).status, 400);
      const noPainel = (await (await fetch(`${api.url}/api/panel/qualquer?decisions=session`)).json()) as Painel;
      assert.equal(noPainel.decisions?.list?.scope, 'session');

      const sugerida = familia.items.find((i) => i.state === 'to_confirm')!;
      const caminho = `/api/decisions/${encodeURIComponent(sugerida.id)}/confirm`;
      assert.equal((await fetch(`${api.url}${caminho}`)).status, 405, 'GET não escreve');
      assert.equal((await post(caminho, { session: 'qualquer' }, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await post(caminho, { session: 'qualquer' }, { 'content-type': 'application/json', origin: 'https://exemplo.com' })).status, 403);
      assert.equal((await post(caminho, {})).status, 400);

      const r = await post(caminho, { session: 'qualquer' });
      assert.equal(r.status, 200);
      const { decision: decisao } = (await r.json()) as { decision: DecisaoDoPainel };
      assert.equal(decisao.state, 'current');
      assert.equal(decisao.confirmedAt, T0);
      const gravada = await decisoes.getDecision(sugerida.id);
      assert.deepEqual(gravada?.metadata.painel, { acao: 'confirmar', por: 'usuario', sessao: PANEL_SESSION, conta: EQUIPE, em: T0, antes: 'a_confirmar' });
      assert.equal(gravada?.decidedBy, 'agente', 'quem propôs continua sendo o agente');
      assert.equal((await post(caminho, { session: 'qualquer' })).status, 409, 'já confirmada');

      const depois = (await (await fetch(`${api.url}/api/panel/qualquer`)).json()) as Painel;
      assert.equal(depois.decisions?.current, 5);
      assert.equal(depois.decisions?.toConfirm, 0);

      // Descartar: some da lista, fica no histórico com quem e quando.
      const { decision: outra } = await registerDecision(
        decisoes,
        {
          sourceKey: 'teste:sugerida-2', sessionId: PANEL_SESSION, repo: REPO, branch: BRANCH, topic: 'kanban:filtro', context: null,
          choice: 'Filtro por conta no topo', alternatives: [], decidedBy: 'agente', origin: 'sugerida', inferred: true, decidedAt: T0,
        },
        T0,
      );
      assert.equal((await post(`/api/decisions/${encodeURIComponent(outra.id)}/dismiss`, { session: 'qualquer' })).status, 200);
      assert.equal((await decisoes.getDecision(outra.id))?.state, 'descartada');
      assert.equal(((await decisoes.getDecision(outra.id))?.metadata.painel as { acao: string }).acao, 'descartar');
      const semEla = (await (await fetch(`${api.url}/api/decisions/qualquer?scope=session`)).json()) as ListaDeDecisoes;
      assert.ok(!semEla.items.some((i) => i.id === outra.id));

      // Uma sugerida que esta sessão não enxerga (outra família, outra conta) não é alcançável.
      await storage.putSession({ ...session({ id: 'sim-de-fora', cwd: '/simulacao/outro' }), accountId: CLIENTE, accountSource: 'env' });
      const { decision: alheia } = await registerDecision(
        decisoes,
        {
          sourceKey: 'teste:alheia', sessionId: 'sim-de-fora', repo: '/simulacao/outro', branch: 'main', topic: null, context: null,
          choice: 'Algo de outra conta', alternatives: [], decidedBy: 'agente', origin: 'sugerida', inferred: true, decidedAt: T0,
        },
        T0,
      );
      assert.equal((await post(`/api/decisions/${encodeURIComponent(alheia.id)}/confirm`, { session: 'qualquer' })).status, 404);
      assert.equal((await decisoes.getDecision(alheia.id))?.state, 'a_confirmar');
      assert.equal((await post(`/api/decisions/nao-existe/confirm`, { session: 'qualquer' })).status, 404);
      // The old body `{ sessao }` is read on the new route too.
      assert.equal((await post(`/api/decisions/nao-existe/confirm`, { sessao: 'qualquer' })).status, 404);
    } finally {
      await api.close();
      await storage.close();
    }
  });


  test('#131: Desfazer volta o Confirmar e o Descartar; Ajustar grava a versão da pessoa e o Desfazer a devolve', async () => {
    const { storage, decisoes, montador } = await cenario();
    const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    const post = async (id: string, acao: string, corpo: Record<string, unknown> = {}) => {
      const r = await fetch(`${api.url}/api/decisions/${encodeURIComponent(id)}/${acao}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 'qualquer', ...corpo }) });
      return { status: r.status, decisao: r.ok ? ((await r.json()) as { decision: DecisaoDoPainel }).decision : null };
    };
    const sugerida = async (n: number, topic: string | null) =>
      (
        await registerDecision(
          decisoes,
          {
            sourceKey: `teste:sug-${n}`, sessionId: PANEL_SESSION, repo: REPO, branch: BRANCH, topic, context: 'Qual filtro primeiro?',
            choice: `Filtro ${n} no topo`, alternatives: [], decidedBy: 'agente', origin: 'sugerida', inferred: true, decidedAt: new Date(AGORA - 60_000).toISOString(),
          },
          T0,
        )
      ).decision;
    try {
      // Descartar sem querer, e desfazer.
      const a = await sugerida(1, 'kanban:filtro-a');
      assert.equal((await post(a.id, 'dismiss')).decisao?.undo, 'dismiss');
      const volta = await post(a.id, 'undo');
      assert.equal(volta.status, 200);
      assert.equal(volta.decisao?.state, 'to_confirm');
      assert.equal(volta.decisao?.undo, null);
      assert.equal((await decisoes.getDecision(a.id))?.state, 'a_confirmar');
      assert.equal((await post(a.id, 'undo')).status, 409, 'nada mais a desfazer');

      // Confirmar e desfazer.
      await post(a.id, 'confirm');
      assert.equal((await post(a.id, 'undo')).decisao?.state, 'to_confirm');

      // Ajustar: "sim, mas com tal ajuste" vira correção sua, que substitui a sugerida.
      assert.equal((await post(a.id, 'adjust', { text: '   ' })).status, 400);
      const ajuste = 'Sim, filtro por conta no topo. Mas o de status fica na lateral.';
      const ajustada = await post(a.id, 'adjust', { text: ajuste });
      assert.equal(ajustada.status, 200);
      assert.equal(ajustada.decisao?.state, 'superseded');
      assert.equal(ajustada.decisao?.undo, 'adjust');
      const nova = (await decisoes.listDecisions({ sessionId: PANEL_SESSION, states: ['vigente'] })).items.find((d) => d.metadata.ajusteDe === a.id)!;
      assert.equal(nova.origin, 'correcao');
      assert.equal(nova.inferred, false);
      assert.equal(nova.choice, 'Sim, filtro por conta no topo.');
      assert.equal(nova.metadata.texto, ajuste);
      assert.deepEqual(nova.alternatives, ['Filtro 1 no topo']);
      assert.equal(nova.supersedes, a.id);
      const lista = (await (await fetch(`${api.url}/api/decisions/qualquer?scope=session`)).json()) as ListaDeDecisoes;
      const noPainel = lista.items.find((i) => i.id === nova.id)!;
      assert.equal(noPainel.text, ajuste);
      assert.equal(noPainel.context, 'Filtro 1 no topo');

      // Desfazer o ajuste: a correção sai, a sugerida volta a confirmar.
      const desfeito = await post(a.id, 'undo');
      assert.equal(desfeito.decisao?.state, 'to_confirm');
      assert.equal((await decisoes.getDecision(nova.id))?.state, 'revertida');

      // Ajustar uma vigente sem assunto: as duas ficam no mesmo assunto, a nova vale.
      const b = await sugerida(2, null);
      await post(b.id, 'confirm');
      const b2 = await post(b.id, 'adjust', { text: 'Filtro 2 só no largo' });
      assert.equal(b2.decisao?.state, 'superseded');
      assert.equal((await post(b.id, 'undo')).decisao?.state, 'current', 'volta ao estado de antes do ajuste');
    } finally {
      await api.close();
      await storage.close();
    }
  });

  test('#131: /abrir/<local_…> redireciona para a conversa no Claude Desktop; outro id, não', async () => {
    const { storage, montador } = await cenario();
    const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    try {
      const local = 'local_00000000-0000-4000-8000-0000000000f1';
      const r = await fetch(`${api.url}/abrir/${local}`, { redirect: 'manual' });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), `claude://claude.ai/epitaxy/${local}`);
      assert.equal((await fetch(`${api.url}/abrir/javascript:alert(1)`, { redirect: 'manual' })).status, 404);
      assert.equal((await fetch(`${api.url}/abrir/local_x"><script>`, { redirect: 'manual' })).status, 404);
    } finally {
      await api.close();
      await storage.close();
    }
  });

  test('#131: POST /abrir/<local_…> abre a sessão no Claude Desktop pelo `open`, só com id estrito, JSON e 127.0.0.1', async () => {
    const { storage, montador } = await cenario();
    const abertos: string[] = [];
    let falhar = false;
    const abrirNoDesktop = async (url: string) => {
      if (falhar) throw new Error('open saiu com 1');
      abertos.push(url);
    };
    const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, abrirNoDesktop });
    const post = (caminho: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => fetch(`${api.url}${caminho}`, { method: 'POST', headers, body: '{}' });
    const local = 'local_00000000-0000-4000-8000-0000000000f1';
    try {
      assert.equal((await post(`/abrir/${local}`)).status, 200);
      assert.deepEqual(abertos, [`claude://claude.ai/epitaxy/${local}`]);
      assert.equal((await post(`/abrir/${local}`, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await post(`/abrir/${local}`, { 'content-type': 'application/json', origin: 'https://exemplo.com' })).status, 403);
      assert.equal((await post('/abrir/local_curto')).status, 400);
      assert.equal((await post(`/abrir/${encodeURIComponent(`${local};rm -rf`)}`)).status, 400);
      falhar = true;
      assert.equal((await post(`/abrir/${local}`)).status, 502);
      assert.equal(abertos.length, 1);
    } finally {
      await api.close();
    }
    // Sem quem abra (fora do macOS): 501, e o painel fica com o link de reserva.
    const semOpen = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    try {
      assert.equal((await fetch(`${semOpen.url}/abrir/${local}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 501);
      assert.equal(((await (await fetch(`${semOpen.url}/api/panel/qualquer`)).json()) as Painel).api.opensSession, false);
    } finally {
      await semOpen.close();
      await storage.close();
    }
  });
});
