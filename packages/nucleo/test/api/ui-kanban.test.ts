// A tela do Kanban na /ui (#31): as funções puras dos cards, o registro da tela e os arquivos dela
// (screens/kanban.js e kanban.css), que o núcleo serve e que seguem as regras da /ui.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { describe, test } from 'node:test';
import { UI_FOLDER, respondUi } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { findScreen, SCREENS } from '../../ui/screens.js';
import {
  columnColor,
  missing,
  formatCost,
  formatDuration,
  shortId,
  touchesBoard,
  viewQuery,
  kanbanRoute,
  agentsLabel,
  cardTone,
  status,
  viewFromUrl,
  mount,
  // @ts-expect-error: idem
} from '../../ui/screens/kanban.js';

const ARQUIVOS = ['screens/kanban.js', 'kanban.css'];

describe('Kanban: funções da tela', () => {
  test('duração: segundos, minutos e horas com minutos', () => {
    assert.equal(formatDuration(40_000), '40 s');
    assert.equal(formatDuration(0), '0 s');
    assert.equal(formatDuration(59_999), '59 s');
    assert.equal(formatDuration(60_000), '1 min');
    assert.equal(formatDuration(12 * 60_000 + 30_000), '12 min');
    assert.equal(formatDuration((3 * 60 + 10) * 60_000), '3 h 10');
    assert.equal(formatDuration((3 * 60 + 5) * 60_000), '3 h 05');
    assert.equal(formatDuration(2 * 3_600_000), '2 h');
    for (const ruim of [null, undefined, -1, Number.NaN, '12']) assert.equal(formatDuration(ruim), '—');
  });

  test('custo em pt-BR, com til; sem custo, nada', () => {
    assert.equal(formatCost(1.84), '~US$ 1,84');
    assert.equal(formatCost(0), '~US$ 0,00');
    assert.equal(formatCost(1234.5), '~US$ 1.234,50');
    assert.equal(formatCost(0.004), '~US$ 0,00');
    assert.equal(formatCost(null), null);
    assert.equal(formatCost(undefined), null);
  });

  test('id curto, contagem de agentes', () => {
    assert.equal(shortId('7f3a2c1e-4b5d-4e6f-8a9b-0c1d2e3f4a5b'), '7f3a2c1e');
    assert.equal(shortId('abc'), 'abc');
    assert.equal(shortId(null), '');
    assert.equal(agentsLabel(1), '1 agente');
    assert.equal(agentsLabel(3), '3 agentes');
    assert.equal(agentsLabel(0), '0 agentes');
  });

  test('card tone: the attention first (blocked, idle, error), then the status; waiting without attention is active (issue 245)', () => {
    assert.equal(cardTone({ status: 'waiting', attention: { level: 'blocked', reason: 'permission' } }), 'blocked');
    assert.equal(cardTone({ status: 'waiting', attention: { level: 'idle', reason: 'turn_ended' } }), 'idle');
    assert.equal(cardTone({ status: 'error', attention: { level: 'blocked', reason: 'error' } }), 'error');
    assert.equal(cardTone({ status: 'waiting', attention: null }), 'active', 'delegating: not waiting on you');
    assert.equal(cardTone({ status: 'working', attention: null }), 'active');
  });

  test('status: session and agent share the pill; the columns of both views get the right color (issue 245)', () => {
    assert.deepEqual(status('active'), { cor: 'active', rotulo: 'Ativa' });
    assert.deepEqual(status('working'), { cor: 'active', rotulo: 'Ativa' });
    assert.equal(status('completed').rotulo, 'Concluída');
    assert.equal(status('error').rotulo, 'Com erro');
    assert.equal(status('abandoned').rotulo, 'Abandonada');
    assert.equal(status('waiting').rotulo, '—', 'a waiting one is drawn by its attention, never as a raw value');
    const cores = (ids: string[]) => ids.map(columnColor);
    assert.deepEqual(cores(['active', 'blocked', 'idle', 'completed', 'abandoned']), ['active', 'blocked', 'idle', 'completed', 'abandoned']);
    assert.deepEqual(cores(['working', 'blocked', 'idle', 'done', 'error']), ['active', 'blocked', 'idle', 'completed', 'error']);
  });

  test('visão na URL e rotas da API', () => {
    assert.equal(viewFromUrl(''), 'sessions');
    assert.equal(viewFromUrl('?view=agents'), 'agents');
    assert.equal(viewFromUrl('?view=sessions'), 'sessions');
    assert.equal(viewFromUrl('?view=<x>'), 'sessions');
    assert.equal(viewFromUrl('?visao=agentes'), 'sessions', 'the old query is not read (#173, phase 6)');
    assert.equal(viewQuery('agents'), '?view=agents');
    assert.equal(viewQuery('sessions'), '');
    assert.equal(kanbanRoute('sessions'), '/api/kanban?view=sessions');
    assert.equal(kanbanRoute('agents', 'idle', 2), '/api/kanban?view=agents&column=idle&page=2');
  });

  test('"mostrar mais N": o que falta; ao vivo só relê com mudança de sessão', () => {
    assert.equal(missing({ total: 13 }, 10), 3);
    assert.equal(missing({ total: 4 }, 10), 0);
    assert.equal(touchesBoard([{ type: 'session' }]), true);
    assert.equal(touchesBoard([{ type: 'state' }]), true);
    assert.equal(touchesBoard([{ type: 'decision' }, { type: 'account' }]), false);
    assert.equal(touchesBoard(null), false);
  });
});

describe('Kanban: registro e arquivos', () => {
  test('a rota /ui/kanban abre a tela, com o item depois de Sessões e do Feed (a ordem do wireframe)', () => {
    const ids = SCREENS.filter((t: { item?: unknown }) => t.item).map((t: { id: string }) => t.id);
    assert.equal(ids.indexOf('kanban'), Math.max(ids.indexOf('sessions'), ids.indexOf('feed')) + 1);
    const { screen: tela } = findScreen('/ui/kanban');
    assert.equal(tela.id, 'kanban');
    assert.equal(tela.file, '/ui/screens/kanban.js');
    assert.deepEqual(tela.item, { label: 'Kanban', icon: 'kanban', section: 'main' });
    assert.match(readFileSync(`${UI_FOLDER}dom.js`, 'utf8'), /\n {2}kanban: '/);
  });

  test('os arquivos da tela não chamam nada de fora, não escrevem cor nem estilo inline', () => {
    for (const a of ARQUIVOS) {
      const texto = readFileSync(`${UI_FOLDER}${a}`, 'utf8');
      const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `${a} cita endereço externo`);
      assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${a} escreve cor à mão`);
      assert.doesNotMatch(texto, /style=|innerHTML|\bfetch\(/, `${a} usa estilo inline, innerHTML ou fetch direto`);
    }
  });

  // O CSS de cada tela fica carregado depois que ela abre: classe com o mesmo nome em duas telas
  // desmonta a outra (o `.linha` do Dashboard desmontava a tabela de Sessões). Tudo do Kanban é `kb-`.
  test('o CSS do Kanban só estiliza classe kb- ou da moldura, e nenhuma de outra tela', () => {
    const classes = (arquivo: string) => new Set([...readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const daMoldura = classes('shell.css');
    const minhas = [...classes('kanban.css')].filter((c) => !daMoldura.has(c));
    assert.deepEqual(minhas.filter((c) => !c.startsWith('kb-')), [], 'classe própria sem o prefixo kb-');
    const outras = readdirSync(UI_FOLDER).filter((a) => a.endsWith('.css') && !['kanban.css', 'shell.css', 'brand.css'].includes(a));
    for (const outra of outras) {
      const delas = classes(outra);
      assert.deepEqual(minhas.filter((c) => delas.has(c)), [], `kanban.css e ${outra} estilizam as mesmas classes`);
    }
    // E a tela só usa classes que existem (as kb- do CSS, as da moldura e o `cartao`).
    const js = readFileSync(`${UI_FOLDER}screens/kanban.js`, 'utf8');
    const usadas = new Set([...js.matchAll(/\bkb-[a-z0-9-]+/g)].map((m) => m[0]).filter((c) => !c.endsWith('-')));
    for (const c of usadas) assert.ok(minhas.includes(c), `${c} não está no kanban.css`);
  });

  test('o núcleo serve screens/kanban.js e kanban.css com o tipo certo', async () => {
    for (const [a, tipo] of [['screens/kanban.js', /^text\/javascript/], ['kanban.css', /^text\/css/]] as const) {
      let status = 0;
      let headers: Record<string, string | number> = {};
      let corpo = '';
      const res = {
        writeHead(s: number, h: Record<string, string | number>) {
          status = s;
          headers = h ?? {};
          return this;
        },
        setHeader() {},
        end(b?: Buffer | string) {
          corpo = String(b ?? '');
        },
      } as unknown as ServerResponse;
      await respondUi(res, `/ui/${a}`);
      assert.equal(status, 200, a);
      assert.match(String(headers['content-type']), tipo, a);
      assert.equal(corpo, readFileSync(`${UI_FOLDER}${a}`, 'utf8'), a);
    }
  });
});

// issue 245: the old waiting column split in two, "Precisam de você" (with the errors) and "Ociosas".
describe('Kanban: the sessions board with blocked and idle (issue 245)', () => {
  const card = (id: string, extra: Record<string, unknown>) => ({ id, title: `Sessão ${id}`, status: 'active', reason: null, attention: null, lastPrompt: null, lastActivity: '2026-10-20T12:00:00Z', start: '2026-10-20T11:00:00Z', running: true, durationMs: 60_000, agents: 1, model: 'Opus 5.5', costUsd: 1, cwd: '/x', account: null, ...extra });
  const BOARD = {
    view: 'sessions',
    perPage: 10,
    columns: [
      { id: 'active', label: 'Ativas', total: 1, page: 1, hasMore: false, items: [card('a1', {})] },
      { id: 'blocked', label: 'Precisam de você', total: 12, page: 1, hasMore: true, items: [card('b1', { status: 'waiting', attention: { level: 'blocked', reason: 'permission' } }), card('e1', { status: 'error', attention: { level: 'blocked', reason: 'error' } })] },
      { id: 'idle', label: 'Ociosas', total: 1, page: 1, hasMore: false, items: [card('i1', { status: 'waiting', attention: { level: 'idle', reason: 'interrupted' } })] },
      { id: 'completed', label: 'Concluídas', total: 0, page: 1, hasMore: false, items: [] },
      { id: 'abandoned', label: 'Abandonadas', total: 0, page: 1, hasMore: false, items: [] },
    ],
  };

  test('blocked and idle columns, their pills and reason chips; "mostrar mais" asks for the blocked column, never column=waiting', async () => {
    instalarDomFalso();
    Object.assign(globalThis, { location: { search: '', pathname: '/ui/kanban' }, history: { state: null, replaceState: () => {} } });
    const routes: string[] = [];
    const area = new ElementoFalso('main');
    const abort = new AbortController();
    await mount(area, {
      signal: abort.signal,
      read: async (route: string) => (routes.push(route), route.includes('column=') ? { ...BOARD, columns: [{ ...BOARD.columns[1], page: 2, hasMore: false, items: [] }] } : BOARD),
      onChange: () => {},
      onRestart: () => {},
      title: () => {},
    });
    try {
      const columns = area.querySelectorAll('.kb-col');
      assert.equal(columns.length, 5);
      assert.ok(columns[2]!.classList.contains('kb-col-idle'), 'the idle column is dashed and neutral');
      assert.equal(columns[1]!.querySelectorAll('.kb-dot.kb-d-blocked').length, 1);
      assert.equal(columns[2]!.querySelectorAll('.kb-dot.kb-d-idle').length, 1);
      const [blocked, error] = columns[1]!.querySelectorAll('.kb-kc');
      assert.ok(blocked!.classList.contains('kb-st-blocked'));
      assert.match(texto(blocked!), /Precisa de você Pede permissão/);
      assert.ok(error!.classList.contains('kb-st-error'));
      assert.match(texto(error!), /Com erro/);
      assert.equal(error!.querySelectorAll('.attention-chip').length, 0, 'the error keeps only its red pill');
      const idle = columns[2]!.querySelector('.kb-kc')!;
      assert.ok(idle.classList.contains('kb-st-idle'));
      assert.match(texto(idle), /Ociosa Interrompida/);
      assert.equal(idle.querySelectorAll('.attention-chip.attention-chip-light').length, 1);
      assert.doesNotMatch(texto(area), /Esperando/);

      columns[1]!.querySelector('.kb-more')!.click();
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(routes, ['/api/kanban?view=sessions', '/api/kanban?view=sessions&column=blocked&page=2']);
      assert.ok(routes.every((r) => !r.includes('column=waiting')));
    } finally {
      abort.abort();
    }
  });
});
