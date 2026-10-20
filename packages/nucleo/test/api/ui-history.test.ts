// A tela Histórico (C15, #33) na interface do console: registrada na barra depois de Sessões, servida
// pelo núcleo, dentro das regras da página (sem cor à mão, sem estilo inline, sem `fetch`, sem
// `innerHTML`), com os ícones novos e as funções puras de rota, data e valores.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { describe, test } from 'node:test';
import { PASTA_DA_UI, responderUi } from '../../src/api/ui.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { SCREENS } from '../../ui/screens.js';
// @ts-expect-error: idem
import * as historico from '../../ui/screens/history.js';

const { rotaDoHistorico, rotuloDoDia, formatarCusto, formatarDuracao, idCurto, juntarDias, anexarDias, DIAS_POR_PAGINA, BUSCA_MAXIMA } = historico;

interface Screen {
  id: string;
  route: string;
  item?: { label: string; icon: string; section: string };
  file: string | null;
}

/** Uma resposta HTTP de mentira: guarda o status, os cabeçalhos e o corpo. */
function respostaFalsa() {
  const r = {
    status: 0,
    headers: {} as Record<string, unknown>,
    corpo: '',
    writeHead(status: number, headers: Record<string, unknown>) {
      r.status = status;
      r.headers = headers;
      return r;
    },
    setHeader(k: string, v: unknown) {
      r.headers[k.toLowerCase()] = v;
    },
    end(corpo?: Buffer | string) {
      r.corpo = corpo ? String(corpo) : '';
    },
  };
  return r;
}

describe('Histórico: registro e arquivo', () => {
  test('está na barra na ordem do wireframe (depois de Sessões e Analytics), em /ui/history, com o arquivo da tela', () => {
    const telas = SCREENS as Screen[];
    const naBarra = telas.filter((t) => t.item).map((t) => t.id);
    for (const antes of ['dashboard', 'sessions', 'analytics', 'workflows']) {
      if (naBarra.includes(antes)) assert.ok(naBarra.indexOf(antes) < naBarra.indexOf('history'), antes);
    }
    const h = telas.find((t) => t.id === 'history')!;
    assert.equal(h.route, '/ui/history');
    assert.deepEqual(h.item, { label: 'Histórico', icon: 'history', section: 'main' });
    assert.equal(h.file, '/ui/screens/history.js');
  });

  test('o arquivo existe e o núcleo o serve como JavaScript', async () => {
    assert.ok(existsSync(`${PASTA_DA_UI}screens/history.js`));
    const res = respostaFalsa();
    await responderUi(res as unknown as ServerResponse, '/ui/screens/history.js');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/javascript/);
    assert.match(res.corpo, /export function montar\(/);
  });

  test('history.js segue as regras da página', () => {
    for (const a of ['history.js']) {
      const texto = readFileSync(`${PASTA_DA_UI}screens/${a}`, 'utf8');
      const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `${a} cita endereço externo`);
      assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${a} escreve cor à mão`);
      assert.doesNotMatch(texto, /innerHTML/, `${a} usa innerHTML`);
      assert.doesNotMatch(texto, /style=|\.style\b|setAttribute\(\s*['"]style/, `${a} usa estilo inline`);
      assert.doesNotMatch(texto, /\bfetch\(/, `${a} lê sem passar por ctx.ler`);
    }
  });

  test('o histórico não desenha a sessão seguinte e limita a busca ao que o núcleo aceita', () => {
    const texto = readFileSync(`${PASTA_DA_UI}screens/history.js`, 'utf8');
    assert.doesNotMatch(texto, /\.seguinte\b/);
    assert.equal(BUSCA_MAXIMA, 100);
    assert.match(texto, /maxlength: BUSCA_MAXIMA/);
    assert.match(texto, /el\('h2', \{ class: 'eyebrow hist-day' \}/);
  });

  test('history.css não escreve cor à mão, a tela o carrega e shell.css não tem nada do histórico', () => {
    const css = readFileSync(`${PASTA_DA_UI}history.css`, 'utf8');
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i);
    for (const classe of ['.badge', '.b-completed', '.hist-search', '.hist-rows', '.hist-row', '.hist-target::after', '.hist-previous']) assert.ok(css.includes(classe), classe);
    assert.match(readFileSync(`${PASTA_DA_UI}screens/history.js`, 'utf8'), /href: '\/ui\/history\.css', 'data-screen': 'history'/);
    assert.doesNotMatch(readFileSync(`${PASTA_DA_UI}shell.css`, 'utf8'), /\.hist-/);
  });

  // O CSS de cada tela fica carregado quando se troca de tela: uma classe com o mesmo nome em duas
  // telas desmonta a outra. Fora os selos de status, toda classe própria leva `hist-`.
  test('history.css só estiliza classes hist-, os selos em comum e as da moldura', () => {
    const classes = (arquivo: string) => new Set([...readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const SELOS = new Set(['badge', 'p', 'reason', 'soft', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);
    const daMoldura = classes('shell.css');
    const minhas = [...classes('history.css')].filter((c) => !daMoldura.has(c) && !SELOS.has(c));
    assert.deepEqual(minhas.filter((c) => !c.startsWith('hist-')), [], 'classe própria sem o prefixo hist-');
    const outras = readdirSync(PASTA_DA_UI).filter((a) => a.endsWith('.css') && !['history.css', 'shell.css', 'brand.css'].includes(a));
    for (const outra of outras) {
      const comuns = [...classes(outra)].filter((c) => minhas.includes(c));
      assert.deepEqual(comuns, [], `history.css e ${outra} estilizam as mesmas classes`);
    }
  });

  test('os ícones novos estão em dom.js', () => {
    const dom = readFileSync(`${PASTA_DA_UI}dom.js`, 'utf8');
    for (const nome of ['history', 'calendar', 'continued', "'chevron-right'", 'search']) assert.match(dom, new RegExp(`^\\s+${nome}: '<`, 'm'), nome);
  });
});

describe('Histórico: funções puras', () => {
  test('rotaDoHistorico só leva os parâmetros presentes', () => {
    assert.equal(DIAS_POR_PAGINA, 7);
    assert.equal(rotaDoHistorico({}), '/api/history?days=7');
    assert.equal(rotaDoHistorico({ antes: '2025-10-11' }), '/api/history?before=2025-10-11&days=7');
    assert.equal(rotaDoHistorico({ busca: 'fetch nativo & cia' }), '/api/history?days=7&search=fetch%20nativo%20%26%20cia');
    assert.equal(rotaDoHistorico({ antes: '2025-10-11', busca: '', dias: 3 }), '/api/history?before=2025-10-11&days=3');
  });

  test('rotuloDoDia: hoje, ontem, outro dia e outro ano', () => {
    const hoje = new Date(2025, 9, 18, 15, 0); // sábado, 18 out 2025
    assert.equal(rotuloDoDia('2025-10-18', hoje), 'Hoje · sábado, 18 out');
    assert.equal(rotuloDoDia('2025-10-17', hoje), 'Ontem · sexta, 17 out');
    assert.equal(rotuloDoDia('2025-10-16', hoje), 'quinta, 16 out');
    assert.equal(rotuloDoDia('2025-10-13', hoje), 'segunda, 13 out');
    assert.equal(rotuloDoDia('2024-10-16', hoje), 'quarta, 16 out 2024');
  });

  test('rotuloDoDia: virada de mês e de ano', () => {
    assert.equal(rotuloDoDia('2025-10-31', new Date(2025, 10, 1, 9)), 'Ontem · sexta, 31 out');
    assert.equal(rotuloDoDia('2026-01-01', new Date(2026, 0, 2, 9)), 'Ontem · quinta, 1 jan');
    assert.equal(rotuloDoDia('2025-12-31', new Date(2026, 0, 1, 9)), 'Ontem · quarta, 31 dez 2025');
    assert.equal(rotuloDoDia('2025-12-30', new Date(2026, 0, 2, 9)), 'terça, 30 dez 2025');
  });

  test('rotuloDoDia: data inexistente ou malformada sai como veio', () => {
    const hoje = new Date(2025, 9, 18, 15, 0);
    assert.equal(rotuloDoDia('2025-02-30', hoje), '2025-02-30');
    assert.equal(rotuloDoDia('2025-13-01', hoje), '2025-13-01');
    assert.equal(rotuloDoDia('ontem', hoje), 'ontem');
    assert.equal(rotuloDoDia('2024-02-29', hoje), 'quinta, 29 fev 2024');
  });

  test('rotuloDoDia lê o dia como data local, perto da meia-noite também', () => {
    assert.equal(rotuloDoDia('2025-10-18', new Date(2025, 9, 18, 0, 5)), 'Hoje · sábado, 18 out');
    assert.equal(rotuloDoDia('2025-10-18', new Date(2025, 9, 18, 23, 55)), 'Hoje · sábado, 18 out');
    assert.equal(rotuloDoDia('2025-10-17', new Date(2025, 9, 18, 23, 55)), 'Ontem · sexta, 17 out');
  });

  test('formatarCusto', () => {
    assert.equal(formatarCusto(1.96), '~US$ 1,96');
    assert.equal(formatarCusto(0.091), '~US$ 0,09');
    assert.equal(formatarCusto(0), '~US$ 0,00');
    assert.equal(formatarCusto(0.004), '<US$ 0,01');
    assert.equal(formatarCusto(0.005), '~US$ 0,01');
    assert.equal(formatarCusto(1234.5), '~US$ 1.234,50');
    assert.equal(formatarCusto(1234567.891), '~US$ 1.234.567,89');
    for (const sem of [null, undefined, Number.NaN, Infinity]) assert.equal(formatarCusto(sem), '—');
  });

  test('formatarDuracao', () => {
    assert.equal(formatarDuracao(0), '<1 min');
    assert.equal(formatarDuracao(59_000), '<1 min');
    assert.equal(formatarDuracao(60_000), '1 min');
    assert.equal(formatarDuracao(52 * 60_000 + 10_000), '52 min');
    assert.equal(formatarDuracao(59 * 60_000 + 40_000), '1 h');
    assert.equal(formatarDuracao(72 * 60_000), '1 h 12 min');
    assert.equal(formatarDuracao(120 * 60_000), '2 h');
    for (const sem of [null, undefined, -1, Number.NaN]) assert.equal(formatarDuracao(sem), '—');
  });

  test('idCurto', () => {
    assert.equal(idCurto('8e1f0c22-4b7a-4d31-9c5e-1c5e7f840000'), '8e1f0c22');
    assert.equal(idCurto('abc'), 'abc');
  });

  const sessao = (id: string) => ({ id, titulo: id, projeto: 'vitrine-demo', modelo: 'Opus 5.5', status: 'completed', inicio: '', fim: '', duracaoMs: 0, custoUsd: 0, anterior: null, seguinte: null });
  const dia = (d: string, ...ids: string[]) => ({ dia: d, sessoes: ids.map(sessao) });

  test('juntarDias: a primeira página relida e os dias carregados mais antigos que ela', () => {
    const atuais = [dia('2025-10-18', 'a'), dia('2025-10-17', 'b'), dia('2025-10-12', 'c'), dia('2025-10-10', 'd')];
    const novos = [dia('2025-10-18', 'e', 'a'), dia('2025-10-17', 'b'), dia('2025-10-12', 'c')];
    assert.deepEqual(juntarDias(atuais, novos), [...novos, dia('2025-10-10', 'd')]);
    // A primeira página ganhou um dia novo: o que estava carregado depois dela continua, sem repetir dia.
    assert.deepEqual(juntarDias(atuais, [dia('2025-10-19', 'f'), dia('2025-10-18', 'a')]).map((d: { dia: string }) => d.dia), ['2025-10-19', '2025-10-18', '2025-10-17', '2025-10-12', '2025-10-10']);
    assert.deepEqual(juntarDias(atuais, []), []);
    assert.deepEqual(juntarDias([], novos), novos);
  });

  test('anexarDias: a página seguinte continua o último dia quando ele se repete', () => {
    const atuais = [dia('2025-10-18', 'a'), dia('2025-10-17', 'b')];
    assert.deepEqual(anexarDias(atuais, [dia('2025-10-17', 'b', 'c'), dia('2025-10-15', 'd')]), [dia('2025-10-18', 'a'), dia('2025-10-17', 'b', 'c'), dia('2025-10-15', 'd')]);
    assert.deepEqual(anexarDias([], [dia('2025-10-15', 'd')]), [dia('2025-10-15', 'd')]);
  });
});
