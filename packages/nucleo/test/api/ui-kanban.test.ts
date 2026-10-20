// A tela do Kanban na /ui (#31): as funções puras dos cards, o registro da tela e os arquivos dela
// (screens/kanban.js e kanban.css), que o núcleo serve e que seguem as regras da /ui.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { describe, test } from 'node:test';
import { PASTA_DA_UI, responderUi } from '../../src/api/ui.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { findScreen, SCREENS } from '../../ui/screens.js';
import {
  corDaColuna,
  faltam,
  formatarCusto,
  formatarDuracao,
  idCurto,
  mexeNoQuadro,
  motivo,
  queryDaVisao,
  rotaDoKanban,
  rotuloAgentes,
  rotuloMotivo,
  status,
  visaoDaUrl,
  // @ts-expect-error: idem
} from '../../ui/screens/kanban.js';

const ARQUIVOS = ['screens/kanban.js', 'kanban.css'];

describe('Kanban: funções da tela', () => {
  test('duração: segundos, minutos e horas com minutos', () => {
    assert.equal(formatarDuracao(40_000), '40 s');
    assert.equal(formatarDuracao(0), '0 s');
    assert.equal(formatarDuracao(59_999), '59 s');
    assert.equal(formatarDuracao(60_000), '1 min');
    assert.equal(formatarDuracao(12 * 60_000 + 30_000), '12 min');
    assert.equal(formatarDuracao((3 * 60 + 10) * 60_000), '3 h 10');
    assert.equal(formatarDuracao((3 * 60 + 5) * 60_000), '3 h 05');
    assert.equal(formatarDuracao(2 * 3_600_000), '2 h');
    for (const ruim of [null, undefined, -1, Number.NaN, '12']) assert.equal(formatarDuracao(ruim), '—');
  });

  test('custo em pt-BR, com til; sem custo, nada', () => {
    assert.equal(formatarCusto(1.84), '~US$ 1,84');
    assert.equal(formatarCusto(0), '~US$ 0,00');
    assert.equal(formatarCusto(1234.5), '~US$ 1.234,50');
    assert.equal(formatarCusto(0.004), '~US$ 0,00');
    assert.equal(formatarCusto(null), null);
    assert.equal(formatarCusto(undefined), null);
  });

  test('id curto, contagem de agentes', () => {
    assert.equal(idCurto('7f3a2c1e-4b5d-4e6f-8a9b-0c1d2e3f4a5b'), '7f3a2c1e');
    assert.equal(idCurto('abc'), 'abc');
    assert.equal(idCurto(null), '');
    assert.equal(rotuloAgentes(1), '1 agente');
    assert.equal(rotuloAgentes(3), '3 agentes');
    assert.equal(rotuloAgentes(0), '0 agentes');
  });

  test('motivo da espera: rótulo e peso', () => {
    assert.equal(rotuloMotivo('notification'), 'Pede permissão');
    assert.equal(rotuloMotivo('interrupted'), 'Interrompida');
    assert.equal(rotuloMotivo('stop'), 'Sua vez');
    assert.equal(rotuloMotivo('session_start'), 'Sua vez');
    assert.equal(rotuloMotivo(null), null);
    assert.equal(motivo('notification').urgente, true);
    assert.equal(motivo('stop').urgente, false);
  });

  test('status: sessão e agente no mesmo selo; colunas das duas visões na cor certa', () => {
    assert.deepEqual(status('active'), { cor: 'active', rotulo: 'Ativa' });
    assert.deepEqual(status('working'), { cor: 'active', rotulo: 'Ativa' });
    assert.equal(status('waiting').rotulo, 'Esperando você');
    assert.equal(status('completed').rotulo, 'Concluída');
    assert.equal(status('error').rotulo, 'Com erro');
    assert.equal(status('abandoned').rotulo, 'Abandonada');
    const cores = (ids: string[]) => ids.map(corDaColuna);
    assert.deepEqual(cores(['ativa', 'esperando', 'concluida', 'erro', 'abandonada']), ['active', 'waiting', 'completed', 'error', 'abandoned']);
    assert.deepEqual(cores(['trabalhando', 'esperando', 'concluidos', 'erro']), ['active', 'waiting', 'completed', 'error']);
  });

  test('visão na URL e rotas da API', () => {
    assert.equal(visaoDaUrl(''), 'sessoes');
    assert.equal(visaoDaUrl('?view=agents'), 'agentes');
    assert.equal(visaoDaUrl('?view=sessions'), 'sessoes');
    assert.equal(visaoDaUrl('?view=<x>'), 'sessoes');
    assert.equal(visaoDaUrl('?visao=agentes'), 'sessoes', 'the old query is the shell router\'s job (legacyUrl)');
    assert.equal(queryDaVisao('agentes'), '?view=agents');
    assert.equal(queryDaVisao('sessoes'), '');
    assert.equal(rotaDoKanban('sessoes'), '/api/kanban?view=sessions');
    assert.equal(rotaDoKanban('agentes', 'esperando', 2), '/api/kanban?view=agents&column=esperando&page=2');
  });

  test('"mostrar mais N": o que falta; ao vivo só relê com mudança de sessão', () => {
    assert.equal(faltam({ total: 13 }, 10), 3);
    assert.equal(faltam({ total: 4 }, 10), 0);
    assert.equal(mexeNoQuadro([{ tipo: 'sessao' }]), true);
    assert.equal(mexeNoQuadro([{ tipo: 'estado' }]), true);
    assert.equal(mexeNoQuadro([{ tipo: 'decisao' }, { tipo: 'conta' }]), false);
    assert.equal(mexeNoQuadro(null), false);
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
    assert.match(readFileSync(`${PASTA_DA_UI}dom.js`, 'utf8'), /\n {2}kanban: '/);
  });

  test('os arquivos da tela não chamam nada de fora, não escrevem cor nem estilo inline', () => {
    for (const a of ARQUIVOS) {
      const texto = readFileSync(`${PASTA_DA_UI}${a}`, 'utf8');
      const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `${a} cita endereço externo`);
      assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${a} escreve cor à mão`);
      assert.doesNotMatch(texto, /style=|innerHTML|\bfetch\(/, `${a} usa estilo inline, innerHTML ou fetch direto`);
    }
  });

  // O CSS de cada tela fica carregado depois que ela abre: classe com o mesmo nome em duas telas
  // desmonta a outra (o `.linha` do Dashboard desmontava a tabela de Sessões). Tudo do Kanban é `kb-`.
  test('o CSS do Kanban só estiliza classe kb- ou da moldura, e nenhuma de outra tela', () => {
    const classes = (arquivo: string) => new Set([...readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const daMoldura = classes('shell.css');
    const minhas = [...classes('kanban.css')].filter((c) => !daMoldura.has(c));
    assert.deepEqual(minhas.filter((c) => !c.startsWith('kb-')), [], 'classe própria sem o prefixo kb-');
    const outras = readdirSync(PASTA_DA_UI).filter((a) => a.endsWith('.css') && !['kanban.css', 'shell.css', 'brand.css'].includes(a));
    for (const outra of outras) {
      const delas = classes(outra);
      assert.deepEqual(minhas.filter((c) => delas.has(c)), [], `kanban.css e ${outra} estilizam as mesmas classes`);
    }
    // E a tela só usa classes que existem (as kb- do CSS, as da moldura e o `cartao`).
    const js = readFileSync(`${PASTA_DA_UI}screens/kanban.js`, 'utf8');
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
      await responderUi(res, `/ui/${a}`);
      assert.equal(status, 200, a);
      assert.match(String(headers['content-type']), tipo, a);
      assert.equal(corpo, readFileSync(`${PASTA_DA_UI}${a}`, 'utf8'), a);
    }
  });
});
