import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Contas,
  MontadorDoMural,
  MontadorDoPainel,
  TrabalhoPorBranch,
  ehAberta,
  iniciarApiLocal,
  muralDoPainel,
  type IndiceDoDesktop,
  type Mural,
  type SessaoDoDesktop,
} from '../../src/api/index.ts';
import { FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import type { StoragePort } from '../../src/storage-port.ts';
import { T0, session } from '../fixtures.ts';

const AGORA = Date.parse(T0);
const MIN = 60_000;
const iso = (minAtras: number) => new Date(AGORA - minAtras * MIN).toISOString();

/**
 * As sessões do simulador: o P4 (esta sessão delegando, uma na sua vez, uma ativa e uma concluída há
 * 20 min) e as outras do P6 (permissão, Esc e erro). Mais três que não estão abertas: abandonada,
 * concluída há 200 min e erro encerrado há 200 min (o abandono do vigia é 180 min). O P4 por último:
 * o git falso responde o branch dele. O simulador grava `metadata.branch` e `metadata.esforco`.
 */
async function semear() {
  const storage = openSqliteStorage({ path: ':memory:' });
  await semearCenariosDoPainel(storage, 'p6', AGORA);
  await semearCenariosDoPainel(storage, 'p4', AGORA);
  await storage.putSession(session({ id: 'sim-mural-abandonada', cwd: '/simulacao/abandonada', status: 'abandoned', endedAt: iso(200), updatedAt: iso(200), metadata: { simulado: true } }));
  await storage.putSession(session({ id: 'sim-mural-antiga', cwd: '/simulacao/antiga', status: 'completed', endedAt: iso(200), updatedAt: iso(200), metadata: { simulado: true } }));
  await storage.putSession(session({ id: 'sim-mural-erro-velho', cwd: '/simulacao/erro-velho', status: 'error', endedAt: iso(200), updatedAt: iso(200), metadata: { simulado: true } }));
  return storage;
}

function painelDe(storage: StoragePort, desktop: IndiceDoDesktop | null = null, trabalho: TrabalhoPorBranch | null = null) {
  return new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop, trabalho, agora: () => AGORA });
}

const muralDe = (storage: StoragePort, desktop: IndiceDoDesktop | null = null) => muralDoPainel(painelDe(storage, desktop));

/** Conta as leituras de custo e tokens que passam pela porta. */
function contando(storage: StoragePort) {
  const n = { usos: 0 };
  const porta = new Proxy(storage, {
    get(alvo, chave, rec) {
      const v = Reflect.get(alvo, chave, rec);
      if (chave === 'listTokenUsage') return (...a: unknown[]) => (n.usos++, (v as (...x: unknown[]) => unknown).apply(alvo, a));
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
  return { porta, n };
}

const sim = (slug: string) => `sim-painel-${slug}`;

describe('mural ao vivo (#34)', () => {
  test('critério de aberta: viva, ou encerrada com atividade recente; nunca abandonada nem arquivada', () => {
    const base = { endedAt: null, updatedAt: iso(500) };
    assert.equal(ehAberta({ ...base, status: 'active' }, null, AGORA), true, 'ativa (e esperando) entra, por mais parada que esteja: o vigia a abandona');
    assert.equal(ehAberta({ ...base, status: 'error' }, null, AGORA), true, 'erro sem fim entra');
    assert.equal(ehAberta({ status: 'error', endedAt: iso(120), updatedAt: iso(120) }, null, AGORA), true, 'erro encerrado há 2 h ainda entra');
    assert.equal(ehAberta({ status: 'error', endedAt: iso(181), updatedAt: iso(181) }, null, AGORA), false, 'erro encerrado há mais que o abandono sai');
    assert.equal(ehAberta({ status: 'completed', endedAt: iso(179), updatedAt: iso(179) }, null, AGORA), true, 'concluída dentro do abandono do vigia (180 min) entra');
    assert.equal(ehAberta({ status: 'completed', endedAt: iso(181), updatedAt: iso(181) }, null, AGORA), false, 'concluída há mais de 180 min sai');
    assert.equal(ehAberta({ status: 'abandoned', endedAt: iso(1), updatedAt: iso(1) }, null, AGORA), false, 'abandonada nunca entra');
    assert.equal(ehAberta({ ...base, status: 'active' }, { arquivada: true }, AGORA), false, 'arquivada no Desktop sai');
  });

  test('formato, ordem e contagem', async () => {
    const storage = await semear();
    const mural = await muralDe(storage).montar();
    assert.equal(mural.versao, 1);
    assert.equal(mural.geradoEm, T0);
    assert.deepEqual(
      mural.cards.map((c) => c.id),
      [
        // Precisam de você: urgentes e erro, o pedido mais recente primeiro; depois a sua vez.
        sim('motor-de-regras'), sim('painel-de-metricas'), sim('app-receitas'), sim('fila-de-tarefas'),
        // As outras, pela atividade mais recente; a concluída há 20 min ainda está aberta.
        SESSAO_DO_PAINEL, sim('catalogo-exemplo'), sim('blog-estatico'),
      ],
    );
    assert.deepEqual(mural.contagem, { todas: 7, esperando: 4, ativas: 2 });
    const [permissao, erro, , suaVez] = mural.cards;
    assert.deepEqual([permissao.status, permissao.estado, permissao.motivo, permissao.urgente, permissao.atividade.type], ['waiting', 'waiting', 'notification', true, 'permission']);
    assert.deepEqual([erro.status, erro.estado, erro.urgente, erro.atividade.type], ['error', 'error', true, 'error']);
    assert.equal(erro.desde, iso(3));
    assert.deepEqual([suaVez.urgente, suaVez.atividade], [false, { type: 'your-turn', text: '"Terminei a migração. Rodo os testes?"' }]);
    const concluida = mural.cards.at(-1)!;
    assert.deepEqual([concluida.status, concluida.atividade.type], ['completed', 'completed']);
    await storage.close();
  });

  test('o card de uma sessão com plano, subagentes, contexto e custo', async () => {
    const storage = await semear();
    const mural = await muralDe(storage).montar();
    const esta = mural.cards.find((c) => c.id === SESSAO_DO_PAINEL)!;
    assert.equal(esta.titulo, 'Separar pagamentos em serviços');
    assert.equal(esta.projeto, 'vitrine-demo');
    assert.equal(esta.branch, 'feat/63-separar-pagamentos', 'sem o Desktop, o branch da metadata');
    assert.equal(esta.estado, 'delegating');
    assert.equal(esta.modelo, 'claude-opus-5-5');
    assert.equal(esta.esforco, 'high', 'sem o índice do Desktop, o esforço da metadata');
    assert.deepEqual(esta.agentes, { ativos: 4, total: 5 }, 'o principal conta');
    assert.deepEqual(esta.plano, { feitos: 2, total: 6, atual: 'Extrair a cobrança' });
    assert.equal(esta.contexto?.limite, 200_000);
    assert.equal(esta.contexto?.usados, 114_000);
    assert.equal(esta.contexto?.pct, 57);
    assert.equal(typeof esta.contexto?.rotulo, 'string');
    assert.equal(esta.custo.estimativa, true);
    assert.ok(esta.custo.usd !== null && Math.abs(esta.custo.usd - 3.47) < 0.05, `custo ${esta.custo.usd}`);
    await storage.close();
  });

  test('sessão sem plano, sem contexto e sem uso', async () => {
    const storage = await semear();
    const mural = await muralDe(storage).montar();
    const catalogo = mural.cards.find((c) => c.id === sim('catalogo-exemplo'))!;
    assert.equal(catalogo.plano, null);
    assert.equal(catalogo.contexto, null);
    assert.deepEqual(catalogo.custo, { usd: 0, estimativa: true });
    assert.deepEqual(catalogo.agentes, { ativos: catalogo.estado === 'active' ? 1 : 0, total: 1 });
    assert.equal(catalogo.esforco, 'medium');
    assert.equal(catalogo.branch, 'feat/31-csv');
    await storage.close();
  });

  test('o custo vem do cache: um segundo pedido não recalcula', async () => {
    const storage = await semear();
    const { porta, n } = contando(storage);
    const painel = painelDe(porta);
    const mural = new MontadorDoMural({ painel, storage: porta, agora: () => AGORA, cacheMs: 0 });
    const primeiro = await mural.montar();
    const lidos = n.usos;
    assert.ok(lidos >= primeiro.contagem.todas, 'o primeiro pedido calcula o custo de cada sessão aberta');
    const segundo = await mural.montar();
    assert.notEqual(segundo, primeiro, 'sem o cache da resposta, montou de novo');
    assert.equal(n.usos, lidos, 'mas o custo saiu do cache: nada novo lido');
    assert.deepEqual(segundo.cards.map((c) => c.custo), primeiro.cards.map((c) => c.custo));
    await storage.close();
  });

  test('a resposta inteira fica guardada por cacheMs, e pedidos juntos esperam a mesma montagem', async () => {
    const storage = await semear();
    const mural = muralDe(storage);
    const [a, b] = await Promise.all([mural.montar(), mural.montar()]);
    assert.equal(a, b);
    assert.equal(await mural.montar(), a);
    await storage.close();
  });

  test('o esforço e a arquivada vêm do índice do Desktop', async () => {
    const storage = await semear();
    const sessao = (cli: string, extra: Partial<SessaoDoDesktop>): SessaoDoDesktop => ({
      localId: `local_${cli}`, cliSessionId: cli, titulo: null, branch: null, cwd: null, maeLocalId: null, arquivada: false, contas: [], ...extra,
    });
    const doDesktop: Record<string, SessaoDoDesktop> = {
      [SESSAO_DO_PAINEL]: sessao(SESSAO_DO_PAINEL, { esforco: 'max', branch: 'feat/63-do-desktop' }),
      [sim('catalogo-exemplo')]: sessao(sim('catalogo-exemplo'), { arquivada: true }),
    };
    const desktop = { atualizar: async () => {}, sessaoPorCli: (id: string) => doDesktop[id] ?? null, sessaoPorLocal: () => null, filhasDe: () => [] } as unknown as IndiceDoDesktop;
    const mural = await muralDe(storage, desktop).montar();
    const esta = mural.cards.find((c) => c.id === SESSAO_DO_PAINEL)!;
    assert.equal(esta.esforco, 'max', 'o Desktop vale mais que a metadata');
    assert.equal(esta.branch, 'feat/63-do-desktop');
    assert.equal(mural.cards.some((c) => c.id === sim('catalogo-exemplo')), false, 'a arquivada no Desktop sai do mural');
    assert.deepEqual(mural.contagem, { todas: 6, esperando: 4, ativas: 1 });
    await storage.close();
  });

  test('sessão de terminal sem branch: o do git da pasta, em cache, sem GitHub', async () => {
    const storage = await semear();
    await storage.putSession(session({ id: 'sim-mural-terminal', cwd: '/simulacao/terminal', status: 'active', updatedAt: iso(1), metadata: { simulado: true } }));
    const pastas: string[] = [];
    const git = async (cwd: string, args: string[]) => (args[0] === 'branch' ? (pastas.push(cwd), cwd === '/simulacao/terminal' ? 'feat/7-terminal' : null) : null);
    const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git, agora: () => AGORA });
    const mural = muralDoPainel(painelDe(storage, null, trabalho), { cacheMs: 0 });
    const doTerminal = async () => (await mural.montar()).cards.find((c) => c.id === 'sim-mural-terminal')?.branch;
    assert.equal(await doTerminal(), null, 'o primeiro pedido não espera o git');
    await trabalho.esperar();
    assert.equal(await doTerminal(), 'feat/7-terminal');
    assert.deepEqual(pastas, ['/simulacao/terminal'], 'só a sessão sem branch roda git, uma vez (cache de 60 s)');
    assert.deepEqual(trabalho.chamadas, { github: 0, git: 1 }, 'nunca o GitHub');
    await storage.close();
  });

  test('GET /api/mural pela API local', async () => {
    const storage = await semear();
    const api = await iniciarApiLocal({ montador: painelDe(storage), hooks: { storage }, port: 0, log: () => {} });
    try {
      const r = await fetch(`${api.url}/api/mural`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      const mural = (await r.json()) as Mural;
      assert.equal(mural.versao, 1);
      assert.equal(mural.cards.length, 7);
      assert.equal((await fetch(`${api.url}/api/mural`, { headers: { origin: 'https://exemplo.com' } })).status, 403);
      assert.equal((await fetch(`${api.url}/api/mural`, { method: 'POST' })).status, 405);
    } finally {
      await api.close();
      await storage.close();
    }
  });
});
