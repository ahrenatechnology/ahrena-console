// Kanban do projeto (C11, issue 80): a tela monta as raias e os cards de um quadro falso, filtra por
// marco, move otimista (e volta quando o GitHub recusa), desfaz, mostra os estados de erro, e a camada
// de escrita só fala com a API do núcleo local. Nada de rede: a tela recebe um transporte falso.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto, type EventoFalso } from './dom-falso.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { ErroDeEscrita, ErroDeLeitura, escritorHttp } from '../../ui/api.js';
// @ts-expect-error: idem
import { filtrar, montar, tipoDoCard } from '../../ui/screens/project.js';
// @ts-expect-error: idem
import { findScreen, SCREENS } from '../../ui/screens.js';

instalarDomFalso();

type Card = Record<string, unknown> & { itemId: string; raiaId: string | null; marco: string | null };
type Raia = { id: string | null; nome: string; cor: string | null; cards: Card[] };
type Quadro = { projeto: Record<string, unknown>; raias: Raia[]; marcos: string[]; total: number; lidoEm: number; desatualizado: boolean; motivo: string | null; fonte: string };

const card = (itemId: string, raiaId: string | null, extra: Record<string, unknown>): Card => ({
  itemId,
  tipo: 'Issue',
  tipoDaIssue: null,
  numero: null,
  titulo: '',
  url: null,
  repo: 'dono/repo',
  estado: 'OPEN',
  marco: null,
  subIssues: null,
  pr: null,
  raiaId,
  ...extra,
});

function quadroFalso(): Quadro {
  return {
    projeto: { dono: 'dono', numero: 3, titulo: 'Ahrena Console', url: null, campo: 'Status' },
    raias: [
      { id: null, nome: 'Sem status', cor: null, cards: [card('I-1', null, { tipoDaIssue: 'Epic', numero: 1, titulo: 'Épico solto' })] },
      { id: 'bk', nome: 'Backlog', cor: 'GRAY', cards: [card('I-80', 'bk', { tipoDaIssue: 'Tech Task', numero: 80, titulo: 'Kanban do projeto no artefato', marco: 'M2 · Artefato' })] },
      { id: 'rd', nome: 'Ready', cor: 'BLUE', cards: [card('I-35', 'rd', { tipoDaIssue: 'Story', numero: 35, titulo: 'Esta sessão: estado, contexto e custo', marco: 'M1 · Local' })] },
      {
        id: 'ip',
        nome: 'In Progress',
        cor: 'YELLOW',
        cards: [card('I-42', 'ip', { tipoDaIssue: 'User Story', numero: 42, titulo: 'Kanban de sessões', marco: 'M1 · Local', subIssues: { feitas: 2, total: 4 }, pr: { numero: 78, url: null, ci: 'rodando', review: null } })],
      },
      {
        id: 'rv',
        nome: 'In Review',
        cor: 'PURPLE',
        cards: [
          card('I-92', 'rv', { tipoDaIssue: 'Task', numero: 92, titulo: 'Wireframes do painel e da bandeja', marco: 'M1 · Local', pr: { numero: 93, url: null, ci: 'ok', review: 'pendente' } }),
          card('I-64', 'rv', { tipoDaIssue: 'Bug', numero: 64, titulo: 'Paleta: cor de erro', marco: 'M1 · Local', pr: { numero: 69, url: null, ci: 'falhou', review: 'ajustes' } }),
        ],
      },
      { id: 'dn', nome: 'Done', cor: 'GREEN', cards: [card('I-40', 'dn', { tipoDaIssue: 'Spike', numero: 40, titulo: 'Spike: consulta ao GitHub', marco: 'M1 · Local', pr: { numero: 67, url: null, ci: 'ok', review: 'aprovado' } })] },
    ],
    marcos: ['M1 · Local', 'M2 · Artefato'],
    total: 7,
    lidoEm: Date.UTC(2026, 9, 20, 13, 5),
    desatualizado: false,
    motivo: null,
    fonte: 'demo',
  };
}

/** O que o núcleo faria com um mover: o mesmo quadro, com o card na raia nova. */
function moverNoQuadro(q: Quadro, itemId: string, para: string) {
  const copia: Quadro = JSON.parse(JSON.stringify(q));
  let de: string | null = null;
  for (const r of copia.raias) {
    const i = r.cards.findIndex((c) => c.itemId === itemId);
    if (i >= 0) {
      de = r.id;
      const [c] = r.cards.splice(i, 1);
      c!.raiaId = para;
      copia.raias.find((x) => x.id === para)!.cards.push(c!);
      break;
    }
  }
  return { quadro: copia, movido: { itemId, de, para } };
}

const erroDoNucleo = (Classe: typeof ErroDeLeitura, status: number, corpo: Record<string, unknown>) => new Classe(String(corpo.error), { status, rota: '/api/projeto', corpo });

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
  ler,
  escrever,
}: {
  ler: (rota: string) => Promise<unknown>;
  escrever?: (rota: string, corpo: { itemId: string; optionId: string }) => Promise<unknown>;
}): Promise<Montada> {
  const area = new ElementoFalso('main');
  const leituras: string[] = [];
  const escritas: Montada['escritas'] = [];
  const aoMudar = new Set<() => void>();
  const aoReiniciar = new Set<() => void>();
  const sair = new AbortController();
  const ctx = {
    params: {},
    sinal: sair.signal,
    ler: (rota: string) => (leituras.push(rota), ler(rota)),
    escrever: (rota: string, corpo: { itemId: string; optionId: string }) => (escritas.push({ rota, corpo }), (escrever ?? (() => Promise.reject(new Error('sem escritor'))))(rota, corpo)),
    aoMudar: (f: () => void) => aoMudar.add(f),
    aoReiniciar: (f: () => void) => aoReiniciar.add(f),
    aoVivo: () => 'ao-vivo',
    contador: () => {},
    titulo: () => {},
    navegar: () => {},
  };
  const limpar = await montar(area, ctx);
  const raia = (nome: string) => area.querySelectorAll('section.pj-col').find((s) => texto(s.querySelector('.nome')) === nome)!;
  return {
    area,
    leituras,
    escritas,
    aoMudar,
    aoReiniciar,
    limpar: () => (sair.abort(), limpar()),
    raia,
    nomesNaRaia: (nome) => raia(nome).querySelectorAll('article.pj-card').map((c) => c.getAttribute('data-item')!),
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
    tela = await montarTela({ ler: async () => quadroFalso() });
    const { area } = tela;
    assert.deepEqual(tela.leituras, ['/api/project']);
    const cab = area.querySelector('header.cc-cab')!;
    assert.match(texto(cab), /Kanban do projeto Ao vivo/);
    assert.equal(texto(cab.querySelector('.sub')), 'GitHub Project “Ahrena Console” · por Status · arraste para mudar');
    assert.equal(texto(cab.querySelector('.pj-marco')), 'Marco: Todos os marcos M1 · Local M2 · Artefato');
    assert.ok(cab.querySelectorAll('button').some((b) => texto(b) === 'Atualizar'));

    const cabecas = area.querySelectorAll('section.pj-col .cab').map(texto);
    assert.deepEqual(cabecas, ['Sem status 1', 'Backlog 1', 'Ready 1', 'In Progress 1', 'In Review 2', 'Done 1']);

    const c = (id: string) => area.querySelector(`[data-item="${id}"]`)!;
    assert.equal(texto(c('I-42').querySelector('.tipo')), 'História #42');
    assert.ok(c('I-42').querySelector('.pj-tipo')!.classList.contains('historia'));
    assert.equal(texto(c('I-42').querySelector('.tt')), 'Kanban de sessões');
    assert.equal(texto(c('I-42').querySelector('.pe')), '2/4 #78 CI …');
    assert.equal(texto(c('I-80').querySelector('.pj-tipo')), 'Tarefa técnica');
    assert.equal(texto(c('I-92').querySelector('.pe')), '#93 CI ✓ review');
    assert.equal(texto(c('I-64').querySelector('.pe')), '#69 CI ✕ ajustes');
    assert.ok(c('I-64').querySelector('.pj-tipo')!.classList.contains('bug'));
    assert.equal(texto(c('I-40').querySelector('.pe')), '#67 CI ✓ aprovado');
    assert.equal(texto(c('I-1').querySelector('.pj-tipo')), 'Epic', 'tipo desconhecido sai cru');
    assert.equal(c('I-1').querySelector('.pe'), null, 'sem PR nem sub-issues, sem pé');
    assert.equal(c('I-42').getAttribute('draggable'), 'true');
  });

  test('o tipo do GitHub vira o rótulo do wireframe', () => {
    const r = (tipoDaIssue: string | null, tipo = 'Issue') => tipoDoCard({ tipoDaIssue, tipo }).rotulo;
    assert.deepEqual(['Story', 'User Story', 'Tech Task', 'Task', 'Spike', 'Bug', 'Epic'].map((t) => r(t)), ['História', 'História', 'Tarefa técnica', 'Tarefa técnica', 'Spike', 'Bug', 'Epic']);
    assert.equal(r(null, 'DraftIssue'), 'Rascunho');
    assert.equal(tipoDoCard({ tipoDaIssue: 'Spike' }).classe, 'spike');
    assert.equal(filtrar([{ marco: 'a' }, { marco: 'b' }], 'a').length, 1);
  });

  test('o filtro Marco mostra só os cards do marco, e "Todos os marcos" volta tudo', async () => {
    tela = await montarTela({ ler: async () => quadroFalso() });
    const sel = tela.area.querySelector('select.pj-sel')!;
    sel.value = 'M2 · Artefato';
    sel.dispatchEvent({ type: 'change' });
    assert.deepEqual(tela.area.querySelectorAll('article.pj-card').map((c) => c.getAttribute('data-item')), ['I-80']);
    assert.equal(texto(tela.raia('In Review').querySelector('.n')), '0');
    sel.value = '';
    sel.dispatchEvent({ type: 'change' });
    assert.equal(tela.area.querySelectorAll('article.pj-card').length, 7);
  });

  test('Atualizar lê com ?refresh=1; o "Ao vivo" relê sem forçar', async () => {
    tela = await montarTela({ ler: async () => quadroFalso() });
    tela.area.querySelectorAll('header button').find((b) => texto(b) === 'Atualizar')!.click();
    await esperar();
    for (const f of tela.aoReiniciar) f();
    await esperar();
    assert.deepEqual(tela.leituras, ['/api/project', '/api/project?refresh=1', '/api/project']);
  });

  test('arrastar move otimista, manda o POST e mostra o toast; Desfazer manda a raia de antes', async () => {
    let quadro = quadroFalso();
    let soltar!: () => void;
    tela = await montarTela({
      ler: async () => quadro,
      escrever: async (_rota, { itemId, optionId }) => {
        await new Promise<void>((r) => (soltar = r));
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.quadro;
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
    const toast = tela.area.querySelector('.pj-toast')!;
    assert.equal(texto(toast), '#80 movido para In Review no GitHub Desfazer');

    toast.querySelector('button')!.click();
    assert.deepEqual(tela.nomesNaRaia('Backlog'), ['I-80'], 'desfazer também é otimista');
    soltar();
    await esperar();
    assert.deepEqual(tela.escritas.at(-1), { rota: '/api/project/move', corpo: { itemId: 'I-80', optionId: 'bk' } });
    assert.deepEqual(tela.nomesNaRaia('Backlog'), ['I-80']);
    assert.equal(texto(tela.area.querySelector('.pj-toast')), '#80 movido para Backlog no GitHub Desfazer');
  });

  test('o GitHub recusa: o card volta para a raia de antes e a faixa diz por quê', async () => {
    tela = await montarTela({
      ler: async () => quadroFalso(),
      escrever: async () => {
        throw erroDoNucleo(ErroDeEscrita, 502, { error: 'O GitHub recusou a mudança.', codigo: 'github-recusou' });
      },
    });
    arrastar(tela, 'I-92', 'Done');
    await esperar();
    assert.deepEqual(tela.nomesNaRaia('In Review'), ['I-92', 'I-64']);
    assert.deepEqual(tela.nomesNaRaia('Done'), ['I-40']);
    const faixa = tela.area.querySelector('.faixa-erro')!;
    assert.match(texto(faixa), /O GitHub não aceitou mover #92\. O GitHub recusou a mudança\. O card voltou para In Review\./);
    assert.equal(tela.area.querySelector('.pj-toast'), null);
  });

  test('a recusa por falta de escopo mostra o comando do gh', async () => {
    tela = await montarTela({
      ler: async () => quadroFalso(),
      escrever: async () => {
        throw erroDoNucleo(ErroDeEscrita, 401, { error: 'O token do gh não tem o escopo project.', codigo: 'sem-escopo', comando: 'gh auth refresh -s project' });
      },
    });
    arrastar(tela, 'I-35', 'In Progress');
    await esperar();
    assert.deepEqual(tela.nomesNaRaia('Ready'), ['I-35']);
    assert.equal(texto(tela.area.querySelector('.faixa-erro code')), 'gh auth refresh -s project');
  });

  test('a raia "Sem status" não aceita card, e soltar na mesma raia não escreve', async () => {
    tela = await montarTela({ ler: async () => quadroFalso() });
    const sobre = arrastar(tela, 'I-80', 'Sem status');
    assert.notEqual(sobre.defaultPrevented, true);
    arrastar(tela, 'I-80', 'Backlog');
    assert.deepEqual(tela.escritas, []);
    assert.deepEqual(tela.nomesNaRaia('Backlog'), ['I-80']);
  });

  test('Alt+→ no card focado move para a próxima raia; nada entra em "Sem status"', async () => {
    let quadro = quadroFalso();
    tela = await montarTela({
      ler: async () => quadro,
      escrever: async (_r, { itemId, optionId }) => {
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.quadro;
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
      ler: async () => {
        throw erroDoNucleo(ErroDeLeitura, 401, { error: 'O token do gh não tem o escopo project.', codigo: 'sem-escopo', comando: 'gh auth refresh -s project' });
      },
    });
    const caixa = tela.area.querySelector('section.estado')!;
    assert.equal(caixa.getAttribute('role'), 'alert');
    assert.match(texto(caixa), /Falta o escopo project no gh/);
    assert.equal(texto(caixa.querySelector('code')), 'gh auth refresh -s project');
    assert.ok(caixa.querySelector('button'), 'Tentar de novo');
  });

  test('503 desligado: estado vazio explicando que o núcleo subiu sem GitHub', async () => {
    tela = await montarTela({
      ler: async () => {
        throw erroDoNucleo(ErroDeLeitura, 503, { error: 'Sem GitHub.', codigo: 'desligado' });
      },
    });
    const caixa = tela.area.querySelector('section.estado')!;
    assert.equal(caixa.getAttribute('role'), null, 'não é erro, é vazio');
    assert.match(texto(caixa), /O núcleo subiu sem GitHub.*--sem-github/);
  });

  test('503 sem-projeto: estado vazio que explica como escolher o Project', async () => {
    tela = await montarTela({
      ler: async () => {
        throw erroDoNucleo(ErroDeLeitura, 503, { error: 'Nenhum Project.', codigo: 'sem-projeto' });
      },
    });
    const caixa = tela.area.querySelector('section.estado')!;
    assert.equal(caixa.getAttribute('role'), null, 'não é erro, é vazio');
    assert.match(texto(caixa), /Escolha o GitHub Project/);
    assert.equal(texto(caixa.querySelector('code')!), 'AHRENA_CONSOLE_PROJECT=dono/número');
  });

  test('502 sem cache: estado de erro com Tentar de novo, que lê de novo', async () => {
    let n = 0;
    tela = await montarTela({
      ler: async () => {
        if (n++ === 0) throw erroDoNucleo(ErroDeLeitura, 502, { error: 'O GitHub não respondeu.', codigo: 'github-fora' });
        return quadroFalso();
      },
    });
    assert.match(texto(tela.area.querySelector('section.estado')), /GitHub indisponível O GitHub não respondeu\./);
    tela.area.querySelector('section.estado button')!.click();
    await esperar();
    assert.equal(tela.area.querySelectorAll('section.pj-col').length, 6);
  });

  test('desatualizado: o quadro fica na tela com a faixa e o motivo', async () => {
    tela = await montarTela({ ler: async () => ({ ...quadroFalso(), desatualizado: true, motivo: 'O GitHub limitou as consultas.' }) });
    assert.equal(tela.area.querySelectorAll('article.pj-card').length, 7);
    assert.match(texto(tela.area.querySelector('.faixa-erro')), /GitHub indisponível\. Mostrando o quadro em cache, de .*\. O GitHub limitou as consultas\./);
  });

  test('releitura que falha com o quadro na tela vira faixa, sem apagar o quadro', async () => {
    let n = 0;
    tela = await montarTela({
      ler: async () => {
        if (n++ === 0) return quadroFalso();
        throw new ErroDeLeitura('O núcleo em 127.0.0.1 não respondeu', { rota: '/api/projeto' });
      },
    });
    for (const f of tela.aoReiniciar) f();
    await esperar();
    assert.equal(tela.area.querySelectorAll('article.pj-card').length, 7);
    assert.match(texto(tela.area.querySelector('.faixa-erro')), /Não deu para reler o quadro\./);
  });

  test('uma leitura em voo antes do movimento não desfaz o card na tela; relê depois', async () => {
    let quadro = quadroFalso();
    const pendentes: (() => void)[] = [];
    let n = 0;
    tela = await montarTela({
      ler: async () => {
        if (n++ === 0) return quadro;
        const velho = JSON.parse(JSON.stringify(quadro));
        await new Promise<void>((r) => pendentes.push(r));
        return velho;
      },
      escrever: async (_r, { itemId, optionId }) => {
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.quadro;
        return r;
      },
    });
    for (const f of tela.aoReiniciar) f(); // GET sai com o quadro de antes
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
      ler: async () => quadro,
      escrever: async (_r, { itemId, optionId }) => {
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.quadro;
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
    tela = await montarTela({ ler: async () => quadroFalso() });
    tela.area.querySelector('[data-item="I-80"]')!.dispatchEvent({ type: 'dragstart' });
    for (const f of tela.aoReiniciar) f();
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
      ler: async () => quadro,
      escrever: async (_r, { itemId, optionId }) => {
        const r = moverNoQuadro(quadro, itemId, optionId);
        quadro = r.quadro;
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
    tela = await montarTela({ ler: async () => ({ ...quadroFalso(), desatualizado: true, motivo: 'Limitado.' }) });
    const faixa = tela.area.querySelector('.faixa-erro');
    tela.area.querySelector('[data-item="I-92"]')!.focus();
    for (const f of tela.aoReiniciar) f();
    await esperar();
    assert.equal(tela.area.querySelector('.faixa-erro'), faixa, 'o mesmo nó: o alerta não é anunciado de novo');
    assert.equal(documentoFalso.activeElement?.getAttribute('data-item'), 'I-92');
    assert.notEqual(documentoFalso.activeElement, null);
  });

  test('tipo com nome de Object.prototype não derruba o card', () => {
    assert.deepEqual(tipoDoCard({ tipoDaIssue: 'Constructor' }), { rotulo: 'Constructor', classe: 'outro' });
    assert.deepEqual(tipoDoCard({ tipoDaIssue: '__proto__' }), { rotulo: '__proto__', classe: 'outro' });
  });

  test('sair da tela cancela a releitura do "Ao vivo" que estava marcada', async () => {
    const t = await montarTela({ ler: async () => quadroFalso() });
    for (const f of t.aoMudar) f();
    t.limpar();
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(t.leituras.length, 1);
  });

  test('a tela não escreve cor à mão nem cita endereço externo, e está no registro', () => {
    const fonte = readFileSync(`${PASTA_DA_UI}screens/project.js`, 'utf8');
    assert.doesNotMatch(fonte, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i);
    assert.doesNotMatch(fonte, /https?:\/\//);
    assert.doesNotMatch(fonte, /innerHTML|style=|\bfetch\(/);
    assert.ok(readdirSync(`${PASTA_DA_UI}screens`).includes('project.js'));
    const achada = findScreen('/ui/project');
    assert.equal(achada.screen.id, 'project');
    assert.equal(achada.screen.file, '/ui/screens/project.js');
    assert.deepEqual(SCREENS.find((t: { id: string }) => t.id === 'project').item, { label: 'Kanban do projeto', icon: 'github', section: 'main' });
  });

  // O CSS de cada tela fica na página depois que ela abre: uma classe de nome igual em duas telas quebra a outra.
  test('o CSS da tela fica em project.css, que a tela carrega, com as classes próprias em pj-', () => {
    const semComentario = (arquivo: string) => readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const css = semComentario('project.css');
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(|https?:\/\//i);
    assert.doesNotMatch(semComentario('shell.css'), /\.pj-/, 'nada da tela na moldura');
    assert.match(readFileSync(`${PASTA_DA_UI}screens/project.js`, 'utf8'), /'\/ui\/project\.css'/);
    // Toda regra começa por uma classe pj-: o resto (.cab, .tipo, .pe…) só vale dentro dela.
    for (const regra of css.split('}').map((r) => r.split('{')[0]!.trim()).filter((r) => r && !r.startsWith('@'))) {
      for (const seletor of regra.split(',')) assert.match(seletor.trim(), /^\.pj-/, seletor);
    }
    const outras = readdirSync(PASTA_DA_UI).filter((a) => a.endsWith('.css') && a !== 'project.css');
    for (const outra of outras) assert.doesNotMatch(semComentario(outra), /\.pj-/, outra);
  });
});

describe('a camada de escrita', () => {
  test('manda POST com JSON, sem credenciais, e devolve o JSON', async () => {
    const pedidos: { url: string; init: RequestInit }[] = [];
    const escrever = escritorHttp({
      base: 'http://127.0.0.1:4720',
      fetch: async (url: URL, init: RequestInit) => (pedidos.push({ url: String(url), init }), new Response(JSON.stringify({ ok: true }), { status: 200 })),
    });
    assert.deepEqual(await escrever('/api/projeto/mover', { itemId: 'I-1', optionId: 'rv' }), { ok: true });
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
    const escrever = escritorHttp({ base: 'http://127.0.0.1:4720', fetch });
    await assert.rejects(escrever('/ui', {}), (e: Error) => e instanceof ErroDeEscrita && /rota fora da API/.test(e.message));
    await assert.rejects(escrever('https://exemplo.com/api/projeto/mover', {}), /rota fora da API/);
    await assert.rejects(escrever('/api/../../ui', {}), /rota fora do núcleo/);
    assert.throws(() => escritorHttp({ base: 'http://exemplo.com:4720', fetch }), /só escreve no núcleo local/);
    assert.throws(() => escritorHttp({ base: 'https://127.0.0.1:4720', fetch }), /só escreve no núcleo local/);
    assert.equal(chamou, 0);
  });

  test('erro do núcleo vira ErroDeEscrita com status, corpo e Retry-After', async () => {
    const escrever = escritorHttp({
      base: 'http://localhost:4720',
      fetch: async () => new Response(JSON.stringify({ error: 'Calma.', codigo: 'limitado' }), { status: 429, headers: { 'retry-after': '7' } }),
    });
    await assert.rejects(escrever('/api/projeto/mover', {}), (e: InstanceType<typeof ErroDeEscrita>) => {
      assert.ok(e instanceof ErroDeLeitura, 'é também um ErroDeLeitura');
      assert.equal(e.name, 'ErroDeEscrita');
      assert.equal(e.status, 429);
      assert.equal(e.tentarEm, 7000);
      assert.deepEqual(e.corpo, { error: 'Calma.', codigo: 'limitado' });
      assert.equal(e.message, 'Calma.');
      return true;
    });
    const fora = escritorHttp({ base: 'http://127.0.0.1:1', fetch: async () => Promise.reject(new TypeError('fetch failed')) });
    await assert.rejects(fora('/api/projeto/mover', {}), (e: InstanceType<typeof ErroDeEscrita>) => e.status === 0 && /não respondeu/.test(e.message));
  });
});
