// The session Detail in the /ui (#29 and #30): the `/api/sessions/<id>…` routes over the simulator's
// data (the P4 demo plus the session asking for permission), and the "Abrir no Claude Desktop"
// through the page itself, without opening the door to another Origin (decision 0003).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Accounts,
  startLocalApi,
  LeiturasDoDetalhe,
  MontadorDoPainel,
  TrabalhoPorBranch,
  type AgentesDoDetalhe,
  type LocalApi,
  type CabecaDoDetalhe,
  type ConversaDoDetalhe,
  type EventosDoDetalhe,
} from '../../src/api/index.ts';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { SimulatorWorkSource, PANEL_SESSION, seedPanelScenario } from '../../src/simulator/panel.ts';
import { DETAIL_LOCAL, demoLocal, DETAIL_SESSION, seedDetail } from '../../src/simulator/detail.ts';
// @ts-expect-error: módulo do navegador, em JavaScript puro
import { modelName } from '../../ui/screens/session-detail.js';

const AGORA = Date.now();

describe('Detalhe da sessão: /api/sessions/<id>', () => {
  let storage: SqliteStorage;
  let api: LocalApi;
  let host: string;
  const abertos: string[] = [];
  const read = async <T>(caminho: string): Promise<T> => {
    const r = await fetch(`${api.url}${caminho}`);
    assert.equal(r.status, 200, `${caminho}: ${r.status}`);
    return (await r.json()) as T;
  };

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await seedPanelScenario(storage, 'p4', AGORA);
    await seedDetail(storage, AGORA);
    const trabalho = new TrabalhoPorBranch({ fonte: new SimulatorWorkSource(), git: SimulatorWorkSource.git, agora: () => AGORA });
    // Como na --demo: o painel troca qualquer id pelo da sessão do cenário; o Detalhe, não.
    const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho, agora: () => AGORA, apelido: () => PANEL_SESSION });
    const detalhe = new LeiturasDoDetalhe({ storage, montador, agora: () => AGORA, local: demoLocal });
    api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, detail: detalhe, openInDesktop: async (url) => void abertos.push(url) });
    host = new URL(api.url).host;
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('o topo (A5): a sessão pedida, não a do apelido, com status, motivo, faixa, pílulas e o local', async () => {
    const c = await read<CabecaDoDetalhe>(`/api/sessions/${DETAIL_SESSION}`);
    assert.equal(c.session.id, DETAIL_SESSION);
    assert.equal(c.session.title, 'Migração do esquema de pedidos');
    assert.equal(c.session.status, 'waiting');
    assert.equal(c.session.reason, 'notification');
    assert.equal(c.session.banner?.type, 'permission');
    assert.match(c.session.banner!.text, /npm run migrate/);
    assert.equal(c.session.model, 'claude-opus-5-5');
    assert.equal(c.session.cwd, '/simulacao/motor-de-regras');
    assert.equal(c.branch, 'feat/58-pedidos');
    assert.equal(c.local, DETAIL_LOCAL);
    assert.equal(c.command, 'npm run migrate', 'a faixa mostra o comando em código');
    assert.ok(c.cost && c.cost.usd! > 1, 'o custo das mensagens da sessão');
    assert.equal(c.endedAt, null);
    assert.deepEqual(c.counts, { agents: 2, events: (await storage.listEvents(DETAIL_SESSION, { limit: 500 })).items.length });

    const p4 = await read<CabecaDoDetalhe>(`/api/sessions/${PANEL_SESSION}`);
    assert.equal(p4.session.title, 'Separar pagamentos em serviços');
    assert.equal(p4.local, null, 'sessão sem Desktop: sem local');
    assert.equal(p4.session.banner, null);
    assert.equal(p4.command, null);
    // The old Portuguese route is gone (#173 phase 6).
    const antigo = await fetch(`${api.url}/api/sessoes/${DETAIL_SESSION}`);
    assert.equal(antigo.status, 404);
    assert.deepEqual(await antigo.json(), { error: 'não encontrado' });
  });

  test('id inválido dá 400; sessão desconhecida, 404; a lista sem id não é desta rota', async () => {
    assert.equal((await fetch(`${api.url}/api/sessions/${encodeURIComponent('a b')}`)).status, 400);
    assert.equal((await fetch(`${api.url}/api/sessions/nao-existe`)).status, 404);
    assert.equal((await fetch(`${api.url}/api/sessions/nao-existe/conversation`)).status, 404);
    assert.equal((await fetch(`${api.url}/api/sessions/${DETAIL_SESSION}/outra`)).status, 404);
    assert.equal((await fetch(`${api.url}/api/sessions`)).status, 404);
  });

  test('Agentes (C4): números, ferramentas contadas uma vez por chamada, tarefas, tokens e custo por nó', async () => {
    const a = await read<AgentesDoDetalhe>(`/api/sessions/${PANEL_SESSION}/agents`);
    assert.equal(a.numbers.subagents, 4);
    assert.equal(a.numbers.errors, 0);
    assert.ok(a.numbers.running);
    assert.ok(a.numbers.durationMin >= 27 && a.numbers.durationMin <= 29);
    // Pre e Post da mesma chamada contam uma vez: 36 do principal, mais o Read e o Grep de cada subagente.
    const bash = a.tools.find((f) => f.name === 'Bash');
    assert.equal(bash?.n, 15);
    assert.equal(a.tools[0]!.name, 'Bash', 'da mais usada para a menos usada');
    assert.equal(a.numbers.tools, a.tools.reduce((s, f) => s + f.n, 0));
    assert.deepEqual(a.tasks && { done: a.tasks.done, total: a.tasks.total, current: a.tasks.current }, { done: 2, total: 6, current: 'Extrair a cobrança' });
    assert.ok(a.tokens && a.tokens.cacheRead > 0 && a.tokens.output > 0);
    assert.equal(a.tokens!.total, a.tokens!.cacheRead + a.tokens!.cacheWrite + a.tokens!.input + a.tokens!.output);

    const [principal, ...subs] = a.agents;
    assert.equal(principal!.type, 'main');
    assert.equal(principal!.turns, 9);
    assert.ok(principal!.costUsd! > 3);
    assert.deepEqual(subs.map((s) => s.name).sort(), ['Explore', 'Plan', 'code-reviewer', 'test-runner']);
    for (const s of subs) {
      assert.equal(s.type, 'subagent');
      assert.ok(s.costUsd! > 0, `${s.name} tem custo próprio`);
      assert.equal(s.parent, principal!.id);
    }
    assert.equal(subs.find((s) => s.name === 'Plan')?.status, 'completed');
  });

  test('Conversa (C5): mensagens em ordem, o prompt do hook e o do transcript uma vez só, e o Bash aguardando permissão', async () => {
    const c = await read<ConversaDoDetalhe>(`/api/sessions/${DETAIL_SESSION}/conversation`);
    assert.equal(c.agent, `${DETAIL_SESSION}:main`);
    assert.deepEqual(c.agents.map((a) => a.name), ['Agente principal', 'Explore']);
    assert.deepEqual(c.messages.map((m) => m.role), ['you', 'assistant', 'you', 'assistant', 'you', 'assistant']);
    assert.equal(c.total, 6);
    assert.equal(c.messages.filter((m) => m.text === 'pode seguir').length, 1);
    const criei = c.messages.find((m) => m.text?.startsWith('Criei'))!;
    assert.deepEqual(criei.tools.map((f) => [f.name, f.state]), [['Edit', 'ok'], ['Bash', 'ok']]);
    assert.equal(criei.model, 'claude-opus-5-5');
    assert.deepEqual(criei.tokens, { input: 4_100, output: 1_200 });
    const ultima = c.messages.at(-1)!;
    assert.equal(ultima.tools.length, 1, 'o ToolUse do transcript e o PreToolUse do hook são uma chamada só');
    assert.deepEqual([ultima.tools[0]!.name, ultima.tools[0]!.summary, ultima.tools[0]!.state], ['Bash', 'npm run migrate', 'permission']);
    assert.match(ultima.tools[0]!.input!, /npm run migrate/);

    const explore = await read<ConversaDoDetalhe>(`/api/sessions/${DETAIL_SESSION}/conversation?agent=${encodeURIComponent(c.agents[1]!.id)}`);
    assert.equal(explore.agent, c.agents[1]!.id);
    assert.deepEqual(explore.messages.map((m) => m.tools.map((f) => f.name)), [['Read', 'Grep'], []]);
    assert.ok(explore.messages.every((m) => m.tools.every((f) => f.state !== 'permission')), 'só o principal espera a permissão');

    const ultimas = await read<ConversaDoDetalhe>(`/api/sessions/${DETAIL_SESSION}/conversation?limit=2`);
    assert.equal(ultimas.total, 6);
    assert.deepEqual(ultimas.messages.map((m) => m.text), ['pode seguir', 'Vou aplicar a migração no banco local.']);
    const outro = await read<ConversaDoDetalhe>(`/api/sessions/${DETAIL_SESSION}/conversation?agent=qualquer`);
    assert.equal(outro.agent, c.agent, 'agente que não é da sessão: o principal');
    // The old Portuguese route is gone (#173 phase 6).
    assert.equal((await fetch(`${api.url}/api/sessoes/${DETAIL_SESSION}/conversa?limite=2`)).status, 404);
  });

  test('Conversa: o texto do transcript volta como texto, sem virar HTML', async () => {
    const id = 'sim-detalhe-html';
    await storage.putSession({ ...(await storage.getSession(DETAIL_SESSION))!, id, awaitingInputSince: null, awaitingReason: null });
    const veneno = '<img src=x onerror="alert(1)"> `<b>`';
    await storage.appendEvent({ id: `${id}-e1`, sessionId: id, agentId: null, type: 'UserPrompt', toolName: null, summary: veneno, data: null, createdAt: new Date(AGORA).toISOString() });
    const c = await read<ConversaDoDetalhe>(`/api/sessions/${id}/conversation`);
    assert.equal(c.messages[0]!.text, veneno);
    // A tela só põe dado no DOM por `textContent` (el()); nunca por innerHTML.
    const tela = readFileSync(`${UI_FOLDER}screens/session-detail.js`, 'utf8');
    assert.doesNotMatch(tela, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  test('Conversa: the full text with its newlines, from data.text or the hook prompt, and the hook prompt once', async () => {
    const id = 'sim-detalhe-texto';
    await storage.putSession({ ...(await storage.getSession(DETAIL_SESSION))!, id, awaitingInputSince: null, awaitingReason: null });
    const at = (s: number) => new Date(AGORA + s * 1000).toISOString();
    const prompt = `# Pedido\n\n- um\n- dois\n\n${'x'.repeat(3_000)}`;
    const reply = `Feito:\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n${'y'.repeat(3_000)}`;
    const summaryOf = (t: string) => `${t.replace(/\s+/g, ' ').slice(0, 199)}…`;
    const ev = (n: number, type: string, summary: string | null, data: unknown) =>
      storage.appendEvent({ id: `${id}-e${n}`, sessionId: id, agentId: null, type, toolName: null, summary, data: data as never, createdAt: at(n) });
    await ev(1, 'UserPromptSubmit', summaryOf(prompt), { prompt });
    await ev(2, 'UserPrompt', summaryOf(prompt), { parentUuid: null, transcriptAgentId: null, text: prompt });
    await ev(3, 'AssistantMessage', summaryOf(reply), { parentUuid: null, transcriptAgentId: null, text: reply });
    // An event stored before data.text: the transcript prompt only has the summary, and still dedupes against the hook.
    const other = 'Segundo pedido\ncom duas linhas';
    await ev(4, 'UserPromptSubmit', other, { prompt: other });
    await ev(5, 'UserPrompt', other.replace(/\s+/g, ' '), null);
    const c = await read<ConversaDoDetalhe>(`/api/sessions/${id}/conversation`);
    assert.deepEqual(c.messages.map((m) => [m.role, m.text]), [['you', prompt], ['assistant', reply], ['you', other]]);
  });

  test('Linha do tempo (C6): do mais novo para o mais velho, filtros e páginas', async () => {
    const base = `/api/sessions/${DETAIL_SESSION}/events`;
    const tudo = await read<EventosDoDetalhe>(`${base}?limit=500`);
    assert.equal(tudo.total, tudo.filtered);
    assert.equal(tudo.items[0]!.type, 'Notification');
    assert.equal(tudo.items[0]!.status, 'waiting');
    assert.equal(tudo.items.at(-1)!.type, 'SessionStart');
    for (let i = 1; i < tudo.items.length; i++) assert.ok(tudo.items[i - 1]!.at >= tudo.items[i]!.at);
    assert.ok(tudo.options.types.includes('PreToolUse') && tudo.options.tools.includes('Bash'));
    assert.equal(tudo.options.agents.length, 2);

    const pagina1 = await read<EventosDoDetalhe>(`${base}?limit=10`);
    assert.equal(pagina1.items.length, 10);
    assert.ok(pagina1.next);
    const pagina2 = await read<EventosDoDetalhe>(`${base}?limit=10&before=${encodeURIComponent(pagina1.next!)}`);
    assert.deepEqual(pagina2.items.map((e) => e.id), tudo.items.slice(10, 20).map((e) => e.id));

    const bash = await read<EventosDoDetalhe>(`${base}?tool=Bash&type=PreToolUse`);
    assert.deepEqual(bash.items.map((e) => e.summary), ['npm run migrate', 'npm test -- pedidos']);
    assert.equal(bash.total, tudo.total);
    const esperando = await read<EventosDoDetalhe>(`${base}?status=waiting`);
    assert.deepEqual(esperando.items.map((e) => e.type), ['Notification', 'Stop']);
    const busca = await read<EventosDoDetalhe>(`${base}?q=${encodeURIComponent('MIGRATIONS/0007')}`);
    assert.ok(busca.filtered > 0 && busca.items.every((e) => `${e.summary} ${e.data}`.toLowerCase().includes('migrations/0007')));
    const doExplore = await read<EventosDoDetalhe>(`${base}?agent=${encodeURIComponent(tudo.options.agents[1]!.id)}`);
    assert.ok(doExplore.filtered > 0 && doExplore.items.every((e) => e.agent?.name === 'Explore'));
    const ultimos = tudo.items[4]!.at;
    const recentes = await read<EventosDoDetalhe>(`${base}?from=${encodeURIComponent(ultimos)}`);
    assert.ok(recentes.items.every((e) => e.at >= ultimos));
    assert.ok(recentes.filtered < tudo.total);
    // Filtro malformado é ignorado, não quebra.
    assert.equal((await read<EventosDoDetalhe>(`${base}?from=ontem&status=talvez&type=${encodeURIComponent('<x>')}`)).filtered, tudo.total);
    // The old parameter names are no longer read: the filter is ignored and the whole timeline comes back.
    assert.equal((await read<EventosDoDetalhe>(`${base}?ferramenta=Bash&tipo=PreToolUse`)).filtered, tudo.total);
    // The old Portuguese route is gone (#173 phase 6).
    assert.equal((await fetch(`${api.url}/api/sessoes/${DETAIL_SESSION}/eventos?ferramenta=Bash&tipo=PreToolUse`)).status, 404);
  });

  test('"Abrir no Claude Desktop": o POST /open da própria página passa; outro Origin, não (decisão 0003)', async () => {
    const local = DETAIL_LOCAL;
    const post = (caminho: string, headers: Record<string, string>) => fetch(`${api.url}${caminho}`, { method: 'POST', headers, body: '{}' });
    const json = { 'content-type': 'application/json' };
    assert.equal((await post(`/open/${local}`, { ...json, origin: `http://${host}` })).status, 200);
    assert.deepEqual(abertos, [`claude://claude.ai/epitaxy/${local}`]);
    for (const origin of ['https://exemplo.com', 'null', 'http://localhost:1', `https://${host}`, `http://${host}.exemplo.com`]) {
      assert.equal((await post(`/open/${local}`, { ...json, origin })).status, 403, origin);
    }
    // Mesma origem, mas sem JSON: o resto da defesa continua.
    assert.equal((await post(`/open/${local}`, { 'content-type': 'text/plain', origin: `http://${host}` })).status, 415);
    // A exceção é só do /open com id estrito: as outras escritas com Origin continuam recusadas.
    assert.equal((await post('/open/local_curto', { ...json, origin: `http://${host}` })).status, 403);
    assert.equal((await post(`/open/${local}?x=1`, { ...json, origin: `http://${host}` })).status, 403);
    const hook = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    assert.equal((await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { ...json, origin: `http://${host}` }, body: hook })).status, 403);
    // As decisões têm a exceção própria (#103), mas só com o caminho exato: query continua 403.
    assert.equal((await post('/api/decisions/d1/confirm?x=1', { ...json, origin: `http://${host}` })).status, 403);
    // The old Portuguese /abrir is gone (#173 phase 6): it has no Origin exception and opens nothing.
    assert.equal((await post(`/abrir/${local}`, { ...json, origin: `http://${host}` })).status, 403);
    assert.equal(abertos.length, 1);
  });

  // O CSS de cada tela fica carregado depois que ela abre uma vez: uma classe com o mesmo nome em
  // duas telas desmonta a outra (#151). O Detalhe só estiliza classes `sd-` e as da moldura.
  test('o CSS do Detalhe só estiliza classes `sd-` e não toca as classes de outra tela', () => {
    const semComentario = (arquivo: string) => readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const classes = (arquivo: string) => new Set([...semComentario(arquivo).matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]!));
    const daMoldura = classes('shell.css');
    const minhas = [...classes('screens/session-detail.css')].filter((c) => !daMoldura.has(c));
    assert.deepEqual(minhas.filter((c) => !c.startsWith('sd-')), [], 'classe sem o prefixo sd-');
    // Nenhum seletor de elemento solto (`code`, `pre`): eles pegariam as outras telas.
    const soltos = semComentario('screens/session-detail.css').split('\n').filter((l) => /^[a-z]/.test(l.trim()) && !l.startsWith('@') && !l.startsWith(' '));
    assert.deepEqual(soltos.filter((l) => !/^select\.sd-/.test(l)), [], 'seletor de elemento fora do Detalhe');
    const outras = [...readdirSync(UI_FOLDER), ...readdirSync(`${UI_FOLDER}screens`).map((a) => `screens/${a}`)].filter((a) => a.endsWith('.css') && !['screens/session-detail.css', 'shell.css', 'brand.css'].includes(a));
    assert.ok(outras.length > 0);
    for (const outra of outras) {
      const comuns = [...classes(outra)].filter((c) => minhas.includes(c));
      assert.deepEqual(comuns, [], `session-detail.css e ${outra} estilizam as mesmas classes`);
    }
  });

  test('o nome do modelo nas pílulas', () => {
    assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
    assert.equal(modelName('claude-haiku-4-20250101'), 'Haiku 4');
    assert.equal(modelName('gpt-x'), 'gpt-x');
    assert.equal(modelName(null), null);
  });
});
