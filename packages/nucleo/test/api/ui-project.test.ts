// Kanban do projeto (C11, issue 80): a tela monta as raias e os cards de um quadro falso, filtra por
// marco, move otimista (e volta quando o GitHub recusa), desfaz, mostra os estados de erro, e a camada
// de escrita só fala com a API do núcleo local. Nada de rede: a tela recebe um transporte falso.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto, type EventoFalso } from './fake-dom.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { WriteError, ReadError, httpWriter } from '../../ui/api.js';
// @ts-expect-error: idem
import { filter, mount, cardType } from '../../ui/screens/project.js';
// @ts-expect-error: idem
import { findScreen, SCREENS } from '../../ui/screens.js';

instalarDomFalso();

// The board as the API answers it (English since issue 173, phase 2b).
type Card = Record<string, unknown> & { itemId: string; laneId: string | null; milestone: string | null };
type Lane = { id: string | null; name: string; color: string | null; cards: Card[] };
type Quadro = { project: Record<string, unknown>; lanes: Lane[]; milestones: string[]; total: number; fetchedAt: number; stale: boolean; reason: string | null; source: string };

const card = (itemId: string, laneId: string | null, extra: Record<string, unknown>): Card => ({
  itemId,
  type: 'Issue',
  issueType: null,
  number: null,
  title: '',
  url: null,
  repo: 'dono/repo',
  state: 'OPEN',
  milestone: null,
  subIssues: null,
  pr: null,
  laneId,
  ...extra,
});

function quadroFalso(): Quadro {
  return {
    project: { owner: 'dono', number: 3, title: 'Ahrena Console', url: null, field: 'Status' },
    lanes: [
      { id: null, name: 'Sem status', color: null, cards: [card('I-1', null, { issueType: 'Epic', number: 1, title: 'Épico solto' })] },
      { id: 'bk', name: 'Backlog', color: 'GRAY', cards: [card('I-80', 'bk', { issueType: 'Tech Task', number: 80, title: 'Kanban do projeto no artefato', milestone: 'M2 · Artefato' })] },
      { id: 'rd', name: 'Ready', color: 'BLUE', cards: [card('I-35', 'rd', { issueType: 'Story', number: 35, title: 'Esta sessão: estado, contexto e custo', milestone: 'M1 · Local' })] },
      {
        id: 'ip',
        name: 'In Progress',
        color: 'YELLOW',
        cards: [card('I-42', 'ip', { issueType: 'User Story', number: 42, title: 'Kanban de sessões', milestone: 'M1 · Local', subIssues: { done: 2, total: 4 }, pr: { number: 78, url: null, ci: 'running', review: null } })],
      },
      {
        id: 'rv',
        name: 'In Review',
        color: 'PURPLE',
        cards: [
          card('I-92', 'rv', { issueType: 'Task', number: 92, title: 'Wireframes do painel e da bandeja', milestone: 'M1 · Local', pr: { number: 93, url: null, ci: 'ok', review: 'pending' } }),
          card('I-64', 'rv', { issueType: 'Bug', number: 64, title: 'Paleta: cor de erro', milestone: 'M1 · Local', pr: { number: 69, url: null, ci: 'failed', review: 'changes-requested' } }),
        ],
      },
      { id: 'dn', name: 'Done', color: 'GREEN', cards: [card('I-40', 'dn', { issueType: 'Spike', number: 40, title: 'Spike: consulta ao GitHub', milestone: 'M1 · Local', pr: { number: 67, url: null, ci: 'ok', review: 'approved' } })] },
    ],
    milestones: ['M1 · Local', 'M2 · Artefato'],
    total: 7,
    fetchedAt: Date.UTC(2026, 9, 20, 13, 5),
    stale: false,
    reason: null,
    source: 'demo',
  };
}

/** O que o núcleo faria com um mover: o mesmo quadro, com o card na raia nova (`{ board, moved }`). */
function moverNoQuadro(q: Quadro, itemId: string, para: string) {
  const copia: Quadro = JSON.parse(JSON.stringify(q));
  let de: string | null = null;
  for (const r of copia.lanes) {
    const i = r.cards.findIndex((c) => c.itemId === itemId);
    if (i >= 0) {
      de = r.id;
      const [c] = r.cards.splice(i, 1);
      c!.laneId = para;
      copia.lanes.find((x) => x.id === para)!.cards.push(c!);
      break;
    }
  }
  return { board: copia, moved: { itemId, from: de, to: para } };
}

const erroDoNucleo = (Classe: typeof ReadError, status: number, corpo: Record<string, unknown>) => new Classe(String(corpo.error), { status, route: '/api/project', body: corpo });

interface Montada {
  area: ElementoFalso;
  leituras: string[];
  escritas: { rota: string; corpo: { itemId: string; optionId: string } }[];
  aoMudar: Set<() => void>;
  aoReiniciar: Set<() => void>;
  limpar: () => void;
  raia: (nome: string) => ElementoFalso;
  nomesNaRaia: (nome: string) => string[];
}

async function montarTela({
  read,
  write,
}: {
  read: (rota: string) => Promise<unknown>;
  write?: (rota: string, corpo: { itemId: string; optionId: string }) => Promise<unknown>;
}): Promise<Montada> {
  const area = new ElementoFalso('main');
  const leituras: string[] = [];
  const escritas: Montada['escritas'] = [];
  const aoMudar = new Set<() => void>();
  const aoReiniciar = new Set<() => void>();
  const sair = new AbortController();
  const ctx = {
    params: {},
    signal: sair.signal,
    read: (rota: string) => (leituras.push(rota), read(rota)),
    write: (rota: string, corpo: { itemId: string; optionId: string }) => (escritas.push({ rota, corpo }), (write ?? (() => Promise.reject(new Error('sem escritor'))))(rota, corpo)),
    onChange: (f: () => void) => aoMudar.add(f),
    onRestart: (f: () => void) => aoReiniciar.add(f),
    liveState: () => 'live',
    counter: () => {},
    titulo: () => {},
    navigate: () => {},
  };
  const limpar = await mount(area, ctx);
  const raia = (nome: string) => area.querySelectorAll('section.prj-col').find((s) => texto(s.querySelector('.name')) === nome)!;
  return {
    area,
    leituras,
    escritas,
    onChange: aoMudar,
    onRestart: aoReiniciar,
    limpar: () => (sair.abort(), limpar()),
    raia,
    nomesNaRaia: (nome) => raia(nome).querySelectorAll('article.prj-card').map((c) => c.getAttribute('data-item')!),
  };
}

const arrastar = (tela: Montada, itemId: string, para: string) => {
  const dataTransfer = { setData() {}, getData: () => itemId, effectAllowed: '', dropEffect: '' };
  const cartao = tela.area.querySelector(`[data-item="${itemId}"]`)!;
  cartao.dispatchEvent({ type: 'dragstart', dataTransfer });
  const destino = tela.raia(para);
  const sobre: EventoFalso = { type: 'dragover', dataTransfer };
  destino.dispatchEvent(sobre);
  destino.dispatchEvent({ type: 'drop', dataTransfer });
  return sobre;
};

const esperar = () => new Promise((r) => setTimeout(r, 0));

describe('Kanban do projeto (C11)', () => {
  let tela: Montada | null = null;
  beforeEach(() => (tela = null));
  afterEach(() => tela?.limpar());

  test('desenha o cabeçalho, as raias com contagem e os cards com tipo, número, sub-issues, PR, CI e review', async () => {
    tela = await montarTela({ read: async () => quadroFalso() });
    const { area } = tela;
    assert.deepEqual(tela.leituras, ['/api/project']);
    const cab = area.querySelector('header.cc-head')!;
    assert.match(texto(cab), /Kanban do projeto Ao vivo/);
    assert.equal(texto(cab.querySelector('.sub')), 'GitHub Project “Ahrena Console” · por Status · arraste para mudar');
    assert.equal(texto(cab.querySelector('.prj-milestone')), 'Marco: Todos os marcos M1 · Local M2 · Artefato');
    assert.ok(cab.querySelectorAll('button').some((b) => texto(b) === 'Atualizar'));

    const cabecas = area.querySelectorAll('section.prj-col .head').map(texto);
    assert.deepEqual(cabecas, ['Sem status 1', 'Backlog 1', 'Ready 1', 'In Progress 1', 'In Review 2', 'Done 1']);

    const c = (id: string) => area.querySelector(`[data-item="${id}"]`)!;
    assert.equal(texto(c('I-42').querySelector('.type')), 'História #42');
    assert.ok(c('I-42').querySelector('.prj-type')!.classList.contains('story'));
    assert.equal(texto(c('I-42').querySelector('.tt')), 'Kanban de sessões');
    assert.equal(texto(c('I-42').querySelector('.foot')), '2/4 #78 CI …');
    assert.equal(texto(c('I-80').querySelector('.prj-type')), 'Tarefa técnica');
    assert.equal(texto(c('I-92').querySelector('.foot')), '#93 CI ✓ review');
    assert.equal(texto(c('I-64').querySelector('.foot')), '#69 CI ✕ ajustes');
    assert.ok(c('I-64').querySelector('.prj-type')!.classList.contains('bug'));
    assert.equal(texto(c('I-40').querySelector('.foot')), '#67 CI ✓ aprovado');
    assert.equal(texto(c('I-1').querySelector('.prj-type')), 'Epic', 'tipo desconhecido sai cru');
    assert.equal(c('I-1').querySelector('.foot'), null, 'sem PR nem sub-issues, sem pé');
    assert.equal(c('I-42').getAttribute('draggable'), 'true');
  });

  test('o tipo do GitHub vira o rótulo do wireframe', () => {
    const r = (issueType: string | null, type = 'Issue') => cardType({ issueType, type }).label;
    assert.deepEqual(['Story', 'User Story', 'Tech Task', 'Task', 'Spike', 'Bug', 'Epic'].map((t) => r(t)), ['História', 'História', 'Tarefa técnica', 'Tarefa técnica', 'Spike', 'Bug', 'Epic']);
    assert.equal(r(null, 'DraftIssue'), 'Rascunho');
    assert.equal(cardType({ issueType: 'Spike' }).className, 'spike');
    assert.equal(filter([{ milestone: 'a' }, { milestone: 'b' }], 'a').length, 1);
  });

  test('o filtro Marco mostra só os cards do marco, e "Todos os marcos" volta tudo', async () => {
    tela = await montarTela({ read: async () => quadroFalso() });
    const sel = tela.area.querySelector('select.prj-sel')!;
    sel.value = 'M2 · Artefato';
    sel.dispatchEvent({ type: 'change' });
    assert.deepEqual(tela.area.querySelectorAll('article.prj-card').map((c) => c.getAttribute('data-item')), ['I-80']);
    assert.equal(texto(tela.raia('In Review').querySelector('.n')), '0');
    sel.value = '';
    sel.dispatchEvent({ type: 'change' });
    assert.equal(tela.area.querySelectorAll('article.prj-card').length, 7);
  });

  test('Atualizar lê com ?refresh=1; o "Ao vivo" relê sem forçar', async () => {
    tela = await montarTela({ read: async () => quadroFalso() });
    tela.area.querySelectorAll('header button').find((b) => texto(b) === 'Atualizar')!.click();
    await esperar();
    for (const f of tela.onRestart) f();
    await esperar();
    assert.deepEqual(tela.leituras, ['/api/project', '/api/project?refresh=1', '/api/project']);
  });

  test('arrastar move otimista, manda o POST e mostra o toast; Desfazer manda a raia de antes', async () => {
    let quadro = quadroFalso();
    let soltar!: () => void;
    tela = await montarTela({
      read: async () => quadro,
      write: async (_rota, { itemId, optionId }) => {
        await new Promise<void>((r) => (soltar = r));
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.board;
        return r;
      },
    });
    const sobre = arrastar(tela, 'I-80', 'In Review');
    assert.equal(sobre.defaultPrevented, true, 'a raia aceita o card');
    // Otimista: antes da resposta, o card já está na raia nova.
    assert.deepEqual(tela.nomesNaRaia('In Review'), ['I-92', 'I-64', 'I-80']);
    assert.deepEqual(tela.nomesNaRaia('Backlog'), []);
    assert.deepEqual(tela.escritas, [{ rota: '/api/project/move', corpo: { itemId: 'I-80', optionId: 'rv' } }]);
    soltar();
    await esperar();
    assert.deepEqual(tela.nomesNaRaia('In Review'), ['I-92', 'I-64', 'I-80']);
    const toast = tela.area.querySelector('.prj-toast')!;
    assert.equal(texto(toast), '#80 movido para In Review no GitHub Desfazer');

    toast.querySelector('button')!.click();
    assert.deepEqual(tela.nomesNaRaia('Backlog'), ['I-80'], 'desfazer também é otimista');
    soltar();
    await esperar();
    assert.deepEqual(tela.escritas.at(-1), { rota: '/api/project/move', corpo: { itemId: 'I-80', optionId: 'bk' } });
    assert.deepEqual(tela.nomesNaRaia('Backlog'), ['I-80']);
    assert.equal(texto(tela.area.querySelector('.prj-toast')), '#80 movido para Backlog no GitHub Desfazer');
  });

  test('o GitHub recusa: o card volta para a raia de antes e a faixa diz por quê', async () => {
    tela = await montarTela({
      read: async () => quadroFalso(),
      write: async () => {
        throw erroDoNucleo(WriteError, 502, { error: 'O GitHub recusou a mudança.', code: 'github-refused' });
      },
    });
    arrastar(tela, 'I-92', 'Done');
    await esperar();
    assert.deepEqual(tela.nomesNaRaia('In Review'), ['I-92', 'I-64']);
    assert.deepEqual(tela.nomesNaRaia('Done'), ['I-40']);
    const band = tela.area.querySelector('.error-band')!;
    assert.match(texto(band), /O GitHub não aceitou mover #92\. O GitHub recusou a mudança\. O card voltou para In Review\./);
    assert.equal(tela.area.querySelector('.prj-toast'), null);
  });

  test('a recusa por falta de escopo mostra o comando do gh', async () => {
    tela = await montarTela({
      read: async () => quadroFalso(),
      write: async () => {
        throw erroDoNucleo(WriteError, 401, { error: 'O token do gh não tem o escopo project.', code: 'no-scope', command: 'gh auth refresh -s project' });
      },
    });
    arrastar(tela, 'I-35', 'In Progress');
    await esperar();
    assert.deepEqual(tela.nomesNaRaia('Ready'), ['I-35']);
    assert.equal(texto(tela.area.querySelector('.error-band code')), 'gh auth refresh -s project');
  });

  test('a raia "Sem status" não aceita card, e soltar na mesma raia não escreve', async () => {
    tela = await montarTela({ read: async () => quadroFalso() });
    const sobre = arrastar(tela, 'I-80', 'Sem status');
    assert.notEqual(sobre.defaultPrevented, true);
    arrastar(tela, 'I-80', 'Backlog');
    assert.deepEqual(tela.escritas, []);
    assert.deepEqual(tela.nomesNaRaia('Backlog'), ['I-80']);
  });

  test('Alt+→ no card focado move para a próxima raia; nada entra em "Sem status"', async () => {
    let quadro = quadroFalso();
    tela = await montarTela({
      read: async () => quadro,
      write: async (_r, { itemId, optionId }) => {
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.board;
        return r;
      },
    });
    tela.area.querySelector('[data-item="I-80"]')!.dispatchEvent({ type: 'keydown', key: 'ArrowRight', altKey: true });
    await esperar();
    assert.deepEqual(tela.escritas.map((e) => e.corpo), [{ itemId: 'I-80', optionId: 'rd' }]);
    assert.deepEqual(tela.nomesNaRaia('Ready'), ['I-35', 'I-80']);
    assert.equal(documentoFalso.activeElement?.getAttribute('data-item'), 'I-80', 'o foco segue o card');
    // Da "Sem status" sai (só não entra).
    tela.area.querySelector('[data-item="I-1"]')!.dispatchEvent({ type: 'keydown', key: 'ArrowRight', altKey: true });
    await esperar();
    assert.deepEqual(tela.escritas.at(-1)!.corpo, { itemId: 'I-1', optionId: 'bk' });
    assert.deepEqual(tela.nomesNaRaia('Sem status'), []);
    // Alt+← no Backlog pularia para "Sem status": não move.
    tela.area.querySelector('[data-item="I-1"]')!.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', altKey: true });
    await esperar();
    assert.equal(tela.escritas.length, 2);
  });

  test('401 sem escopo: o estado de erro mostra o comando gh auth refresh -s project', async () => {
    tela = await montarTela({
      read: async () => {
        throw erroDoNucleo(ReadError, 401, { error: 'O token do gh não tem o escopo project.', code: 'no-scope', command: 'gh auth refresh -s project' });
      },
    });
    const caixa = tela.area.querySelector('section.state')!;
    assert.equal(caixa.getAttribute('role'), 'alert');
    assert.match(texto(caixa), /Falta o escopo project no gh/);
    assert.equal(texto(caixa.querySelector('code')), 'gh auth refresh -s project');
    assert.ok(caixa.querySelector('button'), 'Tentar de novo');
  });

  test('503 desligado: estado vazio explicando que o núcleo subiu sem GitHub', async () => {
    tela = await montarTela({
      read: async () => {
        throw erroDoNucleo(ReadError, 503, { error: 'Sem GitHub.', code: 'off' });
      },
    });
    const caixa = tela.area.querySelector('section.state')!;
    assert.equal(caixa.getAttribute('role'), null, 'não é erro, é vazio');
    assert.match(texto(caixa), /O núcleo subiu sem GitHub.*--sem-github/);
  });

  test('503 sem-projeto: estado vazio que explica como escolher o Project', async () => {
    tela = await montarTela({
      read: async () => {
        throw erroDoNucleo(ReadError, 503, { error: 'Nenhum Project.', code: 'no-project' });
      },
    });
    const caixa = tela.area.querySelector('section.state')!;
    assert.equal(caixa.getAttribute('role'), null, 'não é erro, é vazio');
    assert.match(texto(caixa), /Escolha o GitHub Project/);
    assert.equal(texto(caixa.querySelector('code')!), 'AHRENA_CONSOLE_PROJECT=dono/número');
  });

  test('502 sem cache: estado de erro com Tentar de novo, que lê de novo', async () => {
    let n = 0;
    tela = await montarTela({
      read: async () => {
        if (n++ === 0) throw erroDoNucleo(ReadError, 502, { error: 'O GitHub não respondeu.', code: 'github-down' });
        return quadroFalso();
      },
    });
    assert.match(texto(tela.area.querySelector('section.state')), /GitHub indisponível O GitHub não respondeu\./);
    tela.area.querySelector('section.state button')!.click();
    await esperar();
    assert.equal(tela.area.querySelectorAll('section.prj-col').length, 6);
  });

  test('desatualizado: o quadro fica na tela com a faixa e o motivo', async () => {
    tela = await montarTela({ read: async () => ({ ...quadroFalso(), stale: true, reason: 'O GitHub limitou as consultas.' }) });
    assert.equal(tela.area.querySelectorAll('article.prj-card').length, 7);
    assert.match(texto(tela.area.querySelector('.error-band')), /GitHub indisponível\. Mostrando o quadro em cache, de .*\. O GitHub limitou as consultas\./);
  });

  test('releitura que falha com o quadro na tela vira faixa, sem apagar o quadro', async () => {
    let n = 0;
    tela = await montarTela({
      read: async () => {
        if (n++ === 0) return quadroFalso();
        throw new ReadError('O núcleo em 127.0.0.1 não respondeu', { route: '/api/projeto' });
      },
    });
    for (const f of tela.onRestart) f();
    await esperar();
    assert.equal(tela.area.querySelectorAll('article.prj-card').length, 7);
    assert.match(texto(tela.area.querySelector('.error-band')), /Não deu para reler o quadro\./);
  });

  test('uma leitura em voo antes do movimento não desfaz o card na tela; relê depois', async () => {
    let quadro = quadroFalso();
    const pendentes: (() => void)[] = [];
    let n = 0;
    tela = await montarTela({
      read: async () => {
        if (n++ === 0) return quadro;
        const velho = JSON.parse(JSON.stringify(quadro));
        await new Promise<void>((r) => pendentes.push(r));
        return velho;
      },
      write: async (_r, { itemId, optionId }) => {
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.board;
        return r;
      },
    });
    for (const f of tela.onRestart) f(); // GET sai com o quadro de antes
    arrastar(tela, 'I-80', 'Ready'); // o POST responde antes do GET
    await esperar();
    pendentes.shift()!(); // o GET velho chega
    await esperar();
    assert.deepEqual(tela.nomesNaRaia('Ready'), ['I-35', 'I-80'], 'o GET velho foi descartado');
    assert.equal(tela.leituras.length, 3, 'e o quadro foi relido depois do movimento');
    pendentes.shift()!();
    await esperar();
    assert.deepEqual(tela.nomesNaRaia('Ready'), ['I-35', 'I-80']);
  });

  test('respostas de dois movimentos fora de ordem: vale o último', async () => {
    let quadro = quadroFalso();
    const respostas: (() => void)[] = [];
    tela = await montarTela({
      read: async () => quadro,
      write: async (_r, { itemId, optionId }) => {
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.board;
        await new Promise<void>((ok) => respostas.push(ok));
        return r;
      },
    });
    const alt = () => tela!.area.querySelector('[data-item="I-80"]')!.dispatchEvent({ type: 'keydown', key: 'ArrowRight', altKey: true });
    alt(); // Backlog → Ready
    alt(); // Ready → In Progress
    assert.deepEqual(tela.nomesNaRaia('In Progress'), ['I-42', 'I-80']);
    respostas[1]!(); // o segundo responde primeiro
    await esperar();
    respostas[0]!(); // o primeiro, com o quadro de Ready, chega por último
    await esperar();
    await esperar();
    assert.deepEqual(tela.nomesNaRaia('In Progress'), ['I-42', 'I-80']);
    assert.deepEqual(tela.nomesNaRaia('Ready'), ['I-35']);
  });

  test('a releitura durante um arrasto espera o card cair', async () => {
    tela = await montarTela({ read: async () => quadroFalso() });
    tela.area.querySelector('[data-item="I-80"]')!.dispatchEvent({ type: 'dragstart' });
    for (const f of tela.onRestart) f();
    await esperar();
    assert.equal(tela.leituras.length, 1);
    tela.area.querySelector('[data-item="I-80"]')!.dispatchEvent({ type: 'dragend' });
    await esperar();
    assert.equal(tela.leituras.length, 2);
  });

  test('a resposta de um movimento no meio de outro arrasto não tira do DOM o card que está no ar', async () => {
    let quadro = quadroFalso();
    let responder: () => void = () => {};
    tela = await montarTela({
      read: async () => quadro,
      write: async (_r, { itemId, optionId }) => {
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.board;
        await new Promise<void>((ok) => (responder = ok));
        return r;
      },
    });
    tela.area.querySelector('[data-item="I-80"]')!.dispatchEvent({ type: 'keydown', key: 'ArrowRight', altKey: true });
    const noAr = tela.area.querySelector('[data-item="I-35"]')!;
    noAr.dispatchEvent({ type: 'dragstart' });
    responder();
    await esperar();
    await esperar();
    assert.equal(tela.area.querySelector('[data-item="I-35"]'), noAr, 'o card no ar continua o mesmo nó');
    noAr.dispatchEvent({ type: 'dragend' });
    await esperar();
    assert.notEqual(tela.area.querySelector('[data-item="I-35"]'), noAr, 'o redesenho adiado acontece no fim do arrasto');
    assert.deepEqual(tela.nomesNaRaia('Ready'), ['I-35', 'I-80']);
  });

  test('o foco fica no card numa releitura, e a faixa de aviso não é refeita sem mudar', async () => {
    tela = await montarTela({ read: async () => ({ ...quadroFalso(), stale: true, reason: 'Limitado.' }) });
    const band = tela.area.querySelector('.error-band');
    tela.area.querySelector('[data-item="I-92"]')!.focus();
    for (const f of tela.onRestart) f();
    await esperar();
    assert.equal(tela.area.querySelector('.error-band'), band, 'o mesmo nó: o alerta não é anunciado de novo');
    assert.equal(documentoFalso.activeElement?.getAttribute('data-item'), 'I-92');
    assert.notEqual(documentoFalso.activeElement, null);
  });

  test('tipo com nome de Object.prototype não derruba o card', () => {
    assert.deepEqual(cardType({ issueType: 'Constructor' }), { label: 'Constructor', className: 'other' });
    assert.deepEqual(cardType({ issueType: '__proto__' }), { label: '__proto__', className: 'other' });
  });

  test('sair da tela cancela a releitura do "Ao vivo" que estava marcada', async () => {
    const t = await montarTela({ read: async () => quadroFalso() });
    for (const f of t.onChange) f();
    t.limpar();
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(t.leituras.length, 1);
  });

  test('a tela não escreve cor à mão nem cita endereço externo, e está no registro', () => {
    const fonte = readFileSync(`${UI_FOLDER}screens/project.js`, 'utf8');
    assert.doesNotMatch(fonte, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i);
    assert.doesNotMatch(fonte, /https?:\/\//);
    assert.doesNotMatch(fonte, /innerHTML|style=|\bfetch\(/);
    assert.ok(readdirSync(`${UI_FOLDER}screens`).includes('project.js'));
    const achada = findScreen('/ui/project');
    assert.equal(achada.screen.id, 'project');
    assert.equal(achada.screen.file, '/ui/screens/project.js');
    assert.deepEqual(SCREENS.find((t: { id: string }) => t.id === 'project').item, { label: 'Kanban do projeto', icon: 'github', section: 'delivery' });
  });

  // O CSS de cada tela fica na página depois que ela abre: uma classe de nome igual em duas telas quebra a outra.
  test('o CSS da tela fica em project.css, que a tela carrega, com as classes próprias em prj-', () => {
    const semComentario = (arquivo: string) => readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const css = semComentario('project.css');
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(|https?:\/\//i);
    assert.doesNotMatch(semComentario('shell.css'), /\.prj-/, 'nada da tela na moldura');
    assert.match(readFileSync(`${UI_FOLDER}screens/project.js`, 'utf8'), /'\/ui\/project\.css'/);
    // Toda regra começa por uma classe prj-: o resto (.head, .type, .foot…) só vale dentro dela.
    for (const regra of css.split('}').map((r) => r.split('{')[0]!.trim()).filter((r) => r && !r.startsWith('@'))) {
      for (const seletor of regra.split(',')) assert.match(seletor.trim(), /^\.prj-/, seletor);
    }
    const outras = readdirSync(UI_FOLDER).filter((a) => a.endsWith('.css') && a !== 'project.css');
    for (const outra of outras) assert.doesNotMatch(semComentario(outra), /\.prj-/, outra);
  });
});

describe('a camada de escrita', () => {
  test('manda POST com JSON, sem credenciais, e devolve o JSON', async () => {
    const pedidos: { url: string; init: RequestInit }[] = [];
    const write = httpWriter({
      base: 'http://127.0.0.1:4720',
      fetch: async (url: URL, init: RequestInit) => (pedidos.push({ url: String(url), init }), new Response(JSON.stringify({ ok: true }), { status: 200 })),
    });
    assert.deepEqual(await write('/api/projeto/mover', { itemId: 'I-1', optionId: 'rv' }), { ok: true });
    const [p] = pedidos;
    assert.equal(p!.url, 'http://127.0.0.1:4720/api/projeto/mover');
    assert.equal(p!.init.method, 'POST');
    assert.equal(p!.init.credentials, 'omit');
    assert.equal((p!.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal(p!.init.body, JSON.stringify({ itemId: 'I-1', optionId: 'rv' }));
  });

  test('recusa rota fora de /api/ e origem que não é local, sem chamar o fetch', async () => {
    let chamou = 0;
    const fetch = async () => (chamou++, new Response('{}'));
    const write = httpWriter({ base: 'http://127.0.0.1:4720', fetch });
    await assert.rejects(write('/ui', {}), (e: Error) => e instanceof WriteError && /rota fora da API/.test(e.message));
    await assert.rejects(write('https://exemplo.com/api/projeto/mover', {}), /rota fora da API/);
    await assert.rejects(write('/api/../../ui', {}), /rota fora do núcleo/);
    assert.throws(() => httpWriter({ base: 'http://exemplo.com:4720', fetch }), /só escreve no núcleo local/);
    assert.throws(() => httpWriter({ base: 'https://127.0.0.1:4720', fetch }), /só escreve no núcleo local/);
    assert.equal(chamou, 0);
  });

  test('erro do núcleo vira WriteError com status, body e Retry-After', async () => {
    const write = httpWriter({
      base: 'http://localhost:4720',
      fetch: async () => new Response(JSON.stringify({ error: 'Calma.', code: 'rate-limited' }), { status: 429, headers: { 'retry-after': '7' } }),
    });
    await assert.rejects(write('/api/projeto/mover', {}), (e: InstanceType<typeof WriteError>) => {
      assert.ok(e instanceof ReadError, 'é também um ReadError');
      assert.equal(e.name, 'WriteError');
      assert.equal(e.status, 429);
      assert.equal(e.retryIn, 7000);
      assert.deepEqual(e.body, { error: 'Calma.', code: 'rate-limited' });
      assert.equal(e.message, 'Calma.');
      return true;
    });
    const fora = httpWriter({ base: 'http://127.0.0.1:1', fetch: async () => Promise.reject(new TypeError('fetch failed')) });
    await assert.rejects(fora('/api/projeto/mover', {}), (e: InstanceType<typeof WriteError>) => e.status === 0 && /não respondeu/.test(e.message));
  });
});
