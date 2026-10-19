// As decisões da sessão no painel (#102): contagem, lista por escopo, conta, Confirmar e Descartar,
// pela montagem e pela API em 127.0.0.1. Dados do simulador (P9) e rascunhos sintéticos.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, MontadorDoPainel, TrabalhoPorBranch, iniciarApiLocal, type DecisaoDoPainel, type ListaDeDecisoes, type Painel } from '../../src/api/index.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { registerDecision } from '../../src/decisoes/registro.ts';
import { FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel, semearDecisoesDoPainel, type CenarioDoPainel } from '../../src/simulador/painel.ts';
import { T0, session } from '../fixtures.ts';

const AGORA = Date.parse(T0);
const BRANCH = 'feat/42-kanban-de-sessoes';
const REPO = '/simulacao/ahrena-demo';
const EQUIPE = '00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1';
const CLIENTE = '00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1';

async function cenario(nome: CenarioDoPainel = 'p9') {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisoes = new SqliteDecisionStore(storage.db);
  await semearCenariosDoPainel(storage, nome, AGORA);
  await semearDecisoesDoPainel(decisoes, nome, AGORA);
  const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
  const montador = new MontadorDoPainel({
    storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, decisoes, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL,
  });
  await montador.montar({ sessionId: 'qualquer' });
  await trabalho.esperar();
  return { storage, decisoes, montador };
}

const titulos = (l: ListaDeDecisoes) => l.itens.map((i) => `${i.rotulo} ${i.estado}`);

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
    assert.deepEqual(p.decisoes, { vigentes: 4, aConfirmar: 1, retomada: null, lista: null });
    await storage.close();

    const semPorta = openSqliteStorage({ path: ':memory:' });
    await semearCenariosDoPainel(semPorta, 'p1', AGORA);
    const m = new MontadorDoPainel({ storage: semPorta, contas: new Contas({ storage: semPorta, arquivo: null }), desktop: null, trabalho: null, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL });
    assert.equal((await m.montar({ sessionId: 'qualquer' })).decisoes, null);
    await semPorta.close();
  });

  test('P9: sessão, família e branch, mais recentes primeiro, com a substituída apontando a nova', async () => {
    const { storage, montador } = await cenario();
    const sessao = (await montador.montar({ sessionId: 'qualquer', decisoes: 'sessao' })).decisoes!.lista!;
    assert.deepEqual(titulos(sessao), ['D6 a_confirmar', 'D4 vigente', 'D5 vigente', 'D3 substituida', 'D2 vigente']);
    assert.equal(sessao.vigentes, 3);
    assert.equal(sessao.aConfirmar, 1);

    const familia = (await montador.listaDeDecisoes({ sessionId: 'qualquer' }, 'familia'))!;
    assert.deepEqual(titulos(familia), ['D6 a_confirmar', 'D4 vigente', 'D5 vigente', 'D3 substituida', 'D2 vigente', 'D1 vigente']);
    const porRotulo = Object.fromEntries(familia.itens.map((i) => [i.rotulo, i])) as Record<string, DecisaoDoPainel>;
    assert.equal(porRotulo.D3!.substituidaPor, 'D4');
    assert.deepEqual(porRotulo.D6!.nao, ['20 por coluna', 'rolagem infinita']);
    assert.equal(porRotulo.D6!.decididaPor, 'agente');
    assert.equal(porRotulo.D1!.sessao, 'mae');
    assert.equal(porRotulo.D1!.toolUseId, null, 'a mensagem da mãe não está nesta conversa');
    assert.equal(porRotulo.D4!.toolUseId, 'sim-toolu-p9-4');
    assert.equal(familia.vigentes, 4);
    await storage.close();
  });

  test('branch: entra a decisão de escopo branch de outra sessão da mesma conta; a de outra conta, não', async () => {
    const { storage, decisoes, montador } = await cenario();
    await deOutraSessao(storage, decisoes, 'sim-outra-equipe', EQUIPE, 'Raias com cor por status');
    await deOutraSessao(storage, decisoes, 'sim-outra-cliente', CLIENTE, 'Segredo do cliente');
    await deOutraSessao(storage, decisoes, 'sim-outra-sem-conta', null, 'Raias com contador');
    const branch = (await montador.listaDeDecisoes({ sessionId: 'qualquer' }, 'branch'))!;
    const nomes = branch.itens.map((i) => i.titulo);
    assert.ok(nomes.includes('Raias com cor por status'));
    assert.ok(nomes.includes('Raias com contador'), 'sem conta conhecida, não há como dizer que é de outra');
    assert.ok(!nomes.includes('Segredo do cliente'));
    assert.equal(branch.itens.find((i) => i.titulo === 'Raias com cor por status')?.sessao, 'branch');
    const familia = (await montador.listaDeDecisoes({ sessionId: 'qualquer' }, 'familia'))!;
    assert.ok(!familia.itens.some((i) => i.sessao === 'branch'), 'a família não pega o branch');
    await storage.close();
  });

  test('todo campo da resposta está nos tipos do plugin', async () => {
    const { storage, montador } = await cenario();
    const painel = await montador.montar({ sessionId: 'qualquer', decisoes: 'familia' });
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
});

describe('API das decisões em 127.0.0.1', () => {
  test('lista por escopo; Confirmar e Descartar só por JSON, da sessão que enxerga, com quem e quando', async () => {
    const { storage, decisoes, montador } = await cenario();
    const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    const post = (caminho: string, corpo: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
      fetch(`${api.url}${caminho}`, { method: 'POST', headers, body: JSON.stringify(corpo) });
    try {
      const familia = (await (await fetch(`${api.url}/api/decisoes/qualquer?escopo=familia`)).json()) as ListaDeDecisoes;
      assert.equal(familia.itens.length, 6);
      assert.equal((await fetch(`${api.url}/api/decisoes/qualquer?escopo=maquina`)).status, 400);
      const noPainel = (await (await fetch(`${api.url}/api/painel/qualquer?decisoes=sessao`)).json()) as Painel;
      assert.equal(noPainel.decisoes?.lista?.escopo, 'sessao');

      const sugerida = familia.itens.find((i) => i.estado === 'a_confirmar')!;
      const caminho = `/api/decisoes/${encodeURIComponent(sugerida.id)}/confirmar`;
      assert.equal((await fetch(`${api.url}${caminho}`)).status, 405, 'GET não escreve');
      assert.equal((await post(caminho, { sessao: 'qualquer' }, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await post(caminho, { sessao: 'qualquer' }, { 'content-type': 'application/json', origin: 'https://exemplo.com' })).status, 403);
      assert.equal((await post(caminho, {})).status, 400);

      const r = await post(caminho, { sessao: 'qualquer' });
      assert.equal(r.status, 200);
      const { decisao } = (await r.json()) as { decisao: DecisaoDoPainel };
      assert.equal(decisao.estado, 'vigente');
      assert.equal(decisao.confirmadaEm, T0);
      const gravada = await decisoes.getDecision(sugerida.id);
      assert.deepEqual(gravada?.metadata.painel, { acao: 'confirmar', por: 'usuario', sessao: SESSAO_DO_PAINEL, conta: EQUIPE, em: T0 });
      assert.equal(gravada?.decidedBy, 'agente', 'quem propôs continua sendo o agente');
      assert.equal((await post(caminho, { sessao: 'qualquer' })).status, 409, 'já confirmada');

      const depois = (await (await fetch(`${api.url}/api/painel/qualquer`)).json()) as Painel;
      assert.equal(depois.decisoes?.vigentes, 5);
      assert.equal(depois.decisoes?.aConfirmar, 0);

      // Descartar: some da lista, fica no histórico com quem e quando.
      const { decision: outra } = await registerDecision(
        decisoes,
        {
          sourceKey: 'teste:sugerida-2', sessionId: SESSAO_DO_PAINEL, repo: REPO, branch: BRANCH, topic: 'kanban:filtro', context: null,
          choice: 'Filtro por conta no topo', alternatives: [], decidedBy: 'agente', origin: 'sugerida', inferred: true, decidedAt: T0,
        },
        T0,
      );
      assert.equal((await post(`/api/decisoes/${encodeURIComponent(outra.id)}/descartar`, { sessao: 'qualquer' })).status, 200);
      assert.equal((await decisoes.getDecision(outra.id))?.state, 'descartada');
      assert.equal(((await decisoes.getDecision(outra.id))?.metadata.painel as { acao: string }).acao, 'descartar');
      const semEla = (await (await fetch(`${api.url}/api/decisoes/qualquer?escopo=sessao`)).json()) as ListaDeDecisoes;
      assert.ok(!semEla.itens.some((i) => i.id === outra.id));

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
      assert.equal((await post(`/api/decisoes/${encodeURIComponent(alheia.id)}/confirmar`, { sessao: 'qualquer' })).status, 404);
      assert.equal((await decisoes.getDecision(alheia.id))?.state, 'a_confirmar');
      assert.equal((await post(`/api/decisoes/nao-existe/confirmar`, { sessao: 'qualquer' })).status, 404);
    } finally {
      await api.close();
      await storage.close();
    }
  });

});
