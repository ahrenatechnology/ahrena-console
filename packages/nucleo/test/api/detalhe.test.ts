// O Detalhe da sessão na /ui (#29 e #30): as rotas `/api/sessoes/<id>…` sobre os dados do
// simulador (a demonstração do P4 mais a sessão que pede permissão), e o "Abrir no Claude Desktop"
// pela própria página, sem abrir a porta a outro Origin (decisão 0003).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Contas,
  iniciarApiLocal,
  LeiturasDoDetalhe,
  MontadorDoPainel,
  TrabalhoPorBranch,
  type AgentesDoDetalhe,
  type ApiLocal,
  type CabecaDoDetalhe,
  type ConversaDoDetalhe,
  type EventosDoDetalhe,
} from '../../src/api/index.ts';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
import { FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { LOCAL_DO_DETALHE, localDaDemo, SESSAO_DO_DETALHE, semearDetalhe } from '../../src/simulador/detalhe.ts';
// @ts-expect-error: módulo do navegador, em JavaScript puro
import { abridorHttp } from '../../ui/api.js';
// @ts-expect-error: idem
import { nomeDoModelo } from '../../ui/screens/session-detail.js';

const AGORA = Date.now();

describe('Detalhe da sessão: /api/sessoes/<id>', () => {
  let storage: SqliteStorage;
  let api: ApiLocal;
  let host: string;
  const abertos: string[] = [];
  const ler = async <T>(caminho: string): Promise<T> => {
    const r = await fetch(`${api.url}${caminho}`);
    assert.equal(r.status, 200, `${caminho}: ${r.status}`);
    return (await r.json()) as T;
  };

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await semearCenariosDoPainel(storage, 'p4', AGORA);
    await semearDetalhe(storage, AGORA);
    const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
    // Como na --demo: o painel troca qualquer id pelo da sessão do cenário; o Detalhe, não.
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL });
    const detalhe = new LeiturasDoDetalhe({ storage, montador, agora: () => AGORA, local: localDaDemo });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, detalhe, abrirNoDesktop: async (url) => void abertos.push(url) });
    host = new URL(api.url).host;
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('o topo (A5): a sessão pedida, não a do apelido, com status, motivo, faixa, pílulas e o local', async () => {
    const c = await ler<CabecaDoDetalhe>(`/api/sessoes/${SESSAO_DO_DETALHE}`);
    assert.equal(c.sessao.id, SESSAO_DO_DETALHE);
    assert.equal(c.sessao.titulo, 'Migração do esquema de pedidos');
    assert.equal(c.sessao.status, 'waiting');
    assert.equal(c.sessao.motivo, 'notification');
    assert.equal(c.sessao.faixa?.tipo, 'permissao');
    assert.match(c.sessao.faixa!.texto, /npm run migrate/);
    assert.equal(c.sessao.modelo, 'claude-opus-5-5');
    assert.equal(c.sessao.cwd, '/simulacao/motor-de-regras');
    assert.equal(c.branch, 'feat/58-pedidos');
    assert.equal(c.local, LOCAL_DO_DETALHE);
    assert.equal(c.comando, 'npm run migrate', 'a faixa mostra o comando em código');
    assert.ok(c.custo && c.custo.usd! > 1, 'o custo das mensagens da sessão');
    assert.equal(c.encerradaEm, null);
    assert.deepEqual(c.contagens, { agentes: 2, eventos: (await storage.listEvents(SESSAO_DO_DETALHE, { limit: 500 })).items.length });

    const p4 = await ler<CabecaDoDetalhe>(`/api/sessoes/${SESSAO_DO_PAINEL}`);
    assert.equal(p4.sessao.titulo, 'Separar pagamentos em serviços');
    assert.equal(p4.local, null, 'sessão sem Desktop: sem local');
    assert.equal(p4.sessao.faixa, null);
    assert.equal(p4.comando, null);
  });

  test('id inválido dá 400; sessão desconhecida, 404; a lista sem id não é desta rota', async () => {
    assert.equal((await fetch(`${api.url}/api/sessoes/${encodeURIComponent('a b')}`)).status, 400);
    assert.equal((await fetch(`${api.url}/api/sessoes/nao-existe`)).status, 404);
    assert.equal((await fetch(`${api.url}/api/sessoes/nao-existe/conversa`)).status, 404);
    assert.equal((await fetch(`${api.url}/api/sessoes/${SESSAO_DO_DETALHE}/outra`)).status, 404);
    assert.equal((await fetch(`${api.url}/api/sessoes`)).status, 404);
  });

  test('Agentes (C4): números, ferramentas contadas uma vez por chamada, tarefas, tokens e custo por nó', async () => {
    const a = await ler<AgentesDoDetalhe>(`/api/sessoes/${SESSAO_DO_PAINEL}/agentes`);
    assert.equal(a.numeros.subagentes, 4);
    assert.equal(a.numeros.erros, 0);
    assert.ok(a.numeros.rodando);
    assert.ok(a.numeros.duracaoMin >= 27 && a.numeros.duracaoMin <= 29);
    // Pre e Post da mesma chamada contam uma vez: 36 do principal, mais o Read e o Grep de cada subagente.
    const bash = a.ferramentas.find((f) => f.nome === 'Bash');
    assert.equal(bash?.n, 15);
    assert.equal(a.ferramentas[0]!.nome, 'Bash', 'da mais usada para a menos usada');
    assert.equal(a.numeros.ferramentas, a.ferramentas.reduce((s, f) => s + f.n, 0));
    assert.deepEqual(a.tarefas && { feitos: a.tarefas.feitos, total: a.tarefas.total, atual: a.tarefas.atual }, { feitos: 2, total: 6, atual: 'Extrair a cobrança' });
    assert.ok(a.tokens && a.tokens.cacheLido > 0 && a.tokens.saida > 0);
    assert.equal(a.tokens!.total, a.tokens!.cacheLido + a.tokens!.cacheGravado + a.tokens!.entrada + a.tokens!.saida);

    const [principal, ...subs] = a.agentes;
    assert.equal(principal!.tipo, 'principal');
    assert.equal(principal!.turnos, 9);
    assert.ok(principal!.custoUsd! > 3);
    assert.deepEqual(subs.map((s) => s.nome).sort(), ['Explore', 'Plan', 'code-reviewer', 'test-runner']);
    for (const s of subs) {
      assert.ok(s.custoUsd! > 0, `${s.nome} tem custo próprio`);
      assert.equal(s.pai, principal!.id);
    }
    assert.equal(subs.find((s) => s.nome === 'Plan')?.status, 'completed');
  });

  test('Conversa (C5): mensagens em ordem, o prompt do hook e o do transcript uma vez só, e o Bash aguardando permissão', async () => {
    const c = await ler<ConversaDoDetalhe>(`/api/sessoes/${SESSAO_DO_DETALHE}/conversa`);
    assert.equal(c.agente, `${SESSAO_DO_DETALHE}:main`);
    assert.deepEqual(c.agentes.map((a) => a.nome), ['Agente principal', 'Explore']);
    assert.deepEqual(c.mensagens.map((m) => m.papel), ['voce', 'assistente', 'voce', 'assistente', 'voce', 'assistente']);
    assert.equal(c.total, 6);
    assert.equal(c.mensagens.filter((m) => m.texto === 'pode seguir').length, 1);
    const criei = c.mensagens.find((m) => m.texto?.startsWith('Criei'))!;
    assert.deepEqual(criei.ferramentas.map((f) => [f.nome, f.estado]), [['Edit', 'ok'], ['Bash', 'ok']]);
    assert.equal(criei.modelo, 'claude-opus-5-5');
    assert.deepEqual(criei.tokens, { entrada: 4_100, saida: 1_200 });
    const ultima = c.mensagens.at(-1)!;
    assert.equal(ultima.ferramentas.length, 1, 'o ToolUse do transcript e o PreToolUse do hook são uma chamada só');
    assert.deepEqual([ultima.ferramentas[0]!.nome, ultima.ferramentas[0]!.resumo, ultima.ferramentas[0]!.estado], ['Bash', 'npm run migrate', 'permissao']);
    assert.match(ultima.ferramentas[0]!.entrada!, /npm run migrate/);

    const explore = await ler<ConversaDoDetalhe>(`/api/sessoes/${SESSAO_DO_DETALHE}/conversa?agente=${encodeURIComponent(c.agentes[1]!.id)}`);
    assert.equal(explore.agente, c.agentes[1]!.id);
    assert.deepEqual(explore.mensagens.map((m) => m.ferramentas.map((f) => f.nome)), [['Read', 'Grep'], []]);
    assert.ok(explore.mensagens.every((m) => m.ferramentas.every((f) => f.estado !== 'permissao')), 'só o principal espera a permissão');

    const ultimas = await ler<ConversaDoDetalhe>(`/api/sessoes/${SESSAO_DO_DETALHE}/conversa?limite=2`);
    assert.equal(ultimas.total, 6);
    assert.deepEqual(ultimas.mensagens.map((m) => m.texto), ['pode seguir', 'Vou aplicar a migração no banco local.']);
    const outro = await ler<ConversaDoDetalhe>(`/api/sessoes/${SESSAO_DO_DETALHE}/conversa?agente=qualquer`);
    assert.equal(outro.agente, c.agente, 'agente que não é da sessão: o principal');
  });

  test('Conversa: o texto do transcript volta como texto, sem virar HTML', async () => {
    const id = 'sim-detalhe-html';
    await storage.putSession({ ...(await storage.getSession(SESSAO_DO_DETALHE))!, id, awaitingInputSince: null, awaitingReason: null });
    const veneno = '<img src=x onerror="alert(1)"> `<b>`';
    await storage.appendEvent({ id: `${id}-e1`, sessionId: id, agentId: null, type: 'UserPrompt', toolName: null, summary: veneno, data: null, createdAt: new Date(AGORA).toISOString() });
    const c = await ler<ConversaDoDetalhe>(`/api/sessoes/${id}/conversa`);
    assert.equal(c.mensagens[0]!.texto, veneno);
    // A tela só põe dado no DOM por `textContent` (el()); nunca por innerHTML.
    const tela = readFileSync(`${PASTA_DA_UI}screens/session-detail.js`, 'utf8');
    assert.doesNotMatch(tela, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  test('Linha do tempo (C6): do mais novo para o mais velho, filtros e páginas', async () => {
    const base = `/api/sessoes/${SESSAO_DO_DETALHE}/eventos`;
    const tudo = await ler<EventosDoDetalhe>(`${base}?limite=500`);
    assert.equal(tudo.total, tudo.filtrados);
    assert.equal(tudo.itens[0]!.tipo, 'Notification');
    assert.equal(tudo.itens[0]!.status, 'waiting');
    assert.equal(tudo.itens.at(-1)!.tipo, 'SessionStart');
    for (let i = 1; i < tudo.itens.length; i++) assert.ok(tudo.itens[i - 1]!.em >= tudo.itens[i]!.em);
    assert.ok(tudo.opcoes.tipos.includes('PreToolUse') && tudo.opcoes.ferramentas.includes('Bash'));
    assert.equal(tudo.opcoes.agentes.length, 2);

    const pagina1 = await ler<EventosDoDetalhe>(`${base}?limite=10`);
    assert.equal(pagina1.itens.length, 10);
    assert.ok(pagina1.proximo);
    const pagina2 = await ler<EventosDoDetalhe>(`${base}?limite=10&antes=${encodeURIComponent(pagina1.proximo!)}`);
    assert.deepEqual(pagina2.itens.map((e) => e.id), tudo.itens.slice(10, 20).map((e) => e.id));

    const bash = await ler<EventosDoDetalhe>(`${base}?ferramenta=Bash&tipo=PreToolUse`);
    assert.deepEqual(bash.itens.map((e) => e.resumo), ['npm run migrate', 'npm test -- pedidos']);
    assert.equal(bash.total, tudo.total);
    const esperando = await ler<EventosDoDetalhe>(`${base}?status=waiting`);
    assert.deepEqual(esperando.itens.map((e) => e.tipo), ['Notification', 'Stop']);
    const busca = await ler<EventosDoDetalhe>(`${base}?q=${encodeURIComponent('MIGRATIONS/0007')}`);
    assert.ok(busca.filtrados > 0 && busca.itens.every((e) => `${e.resumo} ${e.dados}`.toLowerCase().includes('migrations/0007')));
    const doExplore = await ler<EventosDoDetalhe>(`${base}?agente=${encodeURIComponent(tudo.opcoes.agentes[1]!.id)}`);
    assert.ok(doExplore.filtrados > 0 && doExplore.itens.every((e) => e.agente?.nome === 'Explore'));
    const ultimos = tudo.itens[4]!.em;
    const recentes = await ler<EventosDoDetalhe>(`${base}?de=${encodeURIComponent(ultimos)}`);
    assert.ok(recentes.itens.every((e) => e.em >= ultimos));
    assert.ok(recentes.filtrados < tudo.total);
    // Filtro malformado é ignorado, não quebra.
    assert.equal((await ler<EventosDoDetalhe>(`${base}?de=ontem&status=talvez&tipo=${encodeURIComponent('<x>')}`)).filtrados, tudo.total);
  });

  test('"Abrir no Claude Desktop": o POST /abrir da própria página passa; outro Origin, não (decisão 0003)', async () => {
    const local = LOCAL_DO_DETALHE;
    const post = (caminho: string, headers: Record<string, string>) => fetch(`${api.url}${caminho}`, { method: 'POST', headers, body: '{}' });
    const json = { 'content-type': 'application/json' };
    assert.equal((await post(`/abrir/${local}`, { ...json, origin: `http://${host}` })).status, 200);
    assert.deepEqual(abertos, [`claude://claude.ai/epitaxy/${local}`]);
    for (const origin of ['https://exemplo.com', 'null', 'http://localhost:1', `https://${host}`, `http://${host}.exemplo.com`]) {
      assert.equal((await post(`/abrir/${local}`, { ...json, origin })).status, 403, origin);
    }
    // Mesma origem, mas sem JSON: o resto da defesa continua.
    assert.equal((await post(`/abrir/${local}`, { 'content-type': 'text/plain', origin: `http://${host}` })).status, 415);
    // A exceção é só do /abrir com id estrito: as outras escritas com Origin continuam recusadas.
    assert.equal((await post('/abrir/local_curto', { ...json, origin: `http://${host}` })).status, 403);
    assert.equal((await post(`/abrir/${local}?x=1`, { ...json, origin: `http://${host}` })).status, 403);
    const hook = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    assert.equal((await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { ...json, origin: `http://${host}` }, body: hook })).status, 403);
    // As decisões têm a exceção própria (#103), mas só com o caminho exato: query continua 403.
    assert.equal((await post('/api/decisoes/d1/confirmar?x=1', { ...json, origin: `http://${host}` })).status, 403);
    assert.equal(abertos.length, 1);
  });

  test('o abridor da página manda o POST em JSON e só com um local_… estrito', async () => {
    const abrir = abridorHttp({ base: api.url });
    assert.deepEqual(await abrir(LOCAL_DO_DETALHE), { ok: true });
    await assert.rejects(abrir('local_x"><script>'), /inválido/);
    await assert.rejects(abrir('../api/hooks'), /inválido/);
    assert.throws(() => abridorHttp({ base: 'http://exemplo.com:4720' }), /núcleo local/);
  });

  // O CSS de cada tela fica carregado depois que ela abre uma vez: uma classe com o mesmo nome em
  // duas telas desmonta a outra (#151). O Detalhe só estiliza classes `det-` e as da moldura.
  test('o CSS do Detalhe só estiliza classes `det-` e não toca as classes de outra tela', () => {
    const semComentario = (arquivo: string) => readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const classes = (arquivo: string) => new Set([...semComentario(arquivo).matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]!));
    const daMoldura = classes('shell.css');
    const minhas = [...classes('screens/session-detail.css')].filter((c) => !daMoldura.has(c));
    assert.deepEqual(minhas.filter((c) => !c.startsWith('det-')), [], 'classe sem o prefixo det-');
    // Nenhum seletor de elemento solto (`code`, `pre`): eles pegariam as outras telas.
    const soltos = semComentario('screens/session-detail.css').split('\n').filter((l) => /^[a-z]/.test(l.trim()) && !l.startsWith('@') && !l.startsWith(' '));
    assert.deepEqual(soltos.filter((l) => !/^select\.det-/.test(l)), [], 'seletor de elemento fora do Detalhe');
    const outras = [...readdirSync(PASTA_DA_UI), ...readdirSync(`${PASTA_DA_UI}screens`).map((a) => `screens/${a}`)].filter((a) => a.endsWith('.css') && !['screens/session-detail.css', 'shell.css', 'brand.css'].includes(a));
    assert.ok(outras.length > 0);
    for (const outra of outras) {
      const comuns = [...classes(outra)].filter((c) => minhas.includes(c));
      assert.deepEqual(comuns, [], `session-detail.css e ${outra} estilizam as mesmas classes`);
    }
  });

  test('o nome do modelo nas pílulas', () => {
    assert.equal(nomeDoModelo('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(nomeDoModelo('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
    assert.equal(nomeDoModelo('claude-haiku-4-20250101'), 'Haiku 4');
    assert.equal(nomeDoModelo('gpt-x'), 'gpt-x');
    assert.equal(nomeDoModelo(null), null);
  });
});
