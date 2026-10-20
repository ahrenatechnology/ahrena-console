// O histórico das sessões encerradas (#33, C15), no domínio: quem entra, o dia no fuso, a página
// por dias com sessão, o cursor `antes`, a busca e a validação do pedido. Sessões sintéticas.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DIAS_PADRAO,
  encerradaDe,
  nomeDoModelo,
  lerPedidoDoHistorico,
  paginaDoHistorico,
  type SessaoEncerrada,
} from '../../src/historico/modelo.ts';
import { normalizeLegacyQuery } from '../../src/api/legacy-routes.ts';
import { session } from '../fixtures.ts';

function encerrada(id: string, fim: string, over: Partial<SessaoEncerrada> = {}): SessaoEncerrada {
  return { id, title: `sessão ${id}`, project: 'vitrine-demo', model: 'claude-opus-5-5', status: 'completed', start: new Date(Date.parse(fim) - 30 * 60_000).toISOString(), end: fim, ...over };
}

const dias = (p: ReturnType<typeof paginaDoHistorico>) => p.days.map((d) => `${d.day}:${d.sessions.map((s) => s.id).join(',')}`);

describe('histórico: quem entra', () => {
  test('só a sessão com endedAt; o projeto é a pasta, o título é o dado (ou o nome da sessão)', () => {
    assert.equal(encerradaDe(session({ endedAt: null })), null);
    const s = session({ id: 'x1', status: 'completed', cwd: '/simulacao/vitrine-demo', startedAt: '2026-11-02T10:00:00.000Z', endedAt: '2026-11-02T10:45:00.000Z' });
    assert.deepEqual(encerradaDe(s), {
      id: 'x1', title: 'ajuste do login', project: 'vitrine-demo', model: 'Opus 5.5', status: 'completed',
      start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T10:45:00.000Z',
    });
    assert.equal(encerradaDe(s, 'título do Desktop')?.title, 'título do Desktop');
    assert.equal(encerradaDe({ ...s, cwd: null, name: null })?.project, null);
    assert.equal(encerradaDe({ ...s, cwd: null, name: null })?.title, null);
  });
});

test('o modelo pelo nome da tabela de preços; fora dela, o id', () => {
  assert.equal(nomeDoModelo('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(nomeDoModelo('claude-sonnet-5-5-20261001'), 'Sonnet 5.5');
  assert.equal(nomeDoModelo('claude-opus-5-5[1m]'), 'Opus 5.5 1M');
  assert.equal(nomeDoModelo('modelo-desconhecido'), 'modelo-desconhecido');
  assert.equal(nomeDoModelo(null), null);
});

describe('histórico: dias', () => {
  const sessoes = [
    encerrada('a', '2026-11-02T09:00:00.000Z'),
    encerrada('b', '2026-11-02T11:00:00.000Z'),
    encerrada('c', '2026-11-01T23:30:00.000Z'),
    encerrada('d', '2026-10-30T15:00:00.000Z'),
  ];

  test('do dia mais recente ao mais antigo; no dia, do fim mais recente ao mais antigo', () => {
    const p = paginaDoHistorico(sessoes, { antes: null, dias: DIAS_PADRAO, busca: null }, 'UTC');
    assert.deepEqual(dias(p), ['2026-11-02:b,a', '2026-11-01:c', '2026-10-30:d']);
    assert.equal(p.next, null);
  });

  test('o dia é o do fim, no fuso dado: 23h30 UTC já é outro dia em Tóquio e o mesmo em São Paulo', () => {
    assert.deepEqual(dias(paginaDoHistorico(sessoes, { antes: null, dias: 7, busca: null }, 'Asia/Tokyo')), ['2026-11-02:b,a,c', '2026-10-31:d']);
    assert.deepEqual(dias(paginaDoHistorico(sessoes, { antes: null, dias: 7, busca: null }, 'America/Sao_Paulo')), ['2026-11-02:b,a', '2026-11-01:c', '2026-10-30:d']);
  });

  test('empate no fim desempata pelo id, para a ordem não depender da leitura', () => {
    const p = paginaDoHistorico([encerrada('m', '2026-11-02T09:00:00.000Z'), encerrada('z', '2026-11-02T09:00:00.000Z')], { antes: null, dias: 7, busca: null }, 'UTC');
    assert.deepEqual(dias(p), ['2026-11-02:z,m']);
  });
});

describe('histórico: página e cursor', () => {
  const sessoes = ['2026-11-02', '2026-11-01', '2026-10-30', '2026-10-28', '2026-10-20'].map((d, i) => encerrada(`s${i}`, `${d}T12:00:00.000Z`));

  test('`dias` conta só os dias com sessão; `proximo` é o último dia da página, enquanto houver mais', () => {
    const p1 = paginaDoHistorico(sessoes, { antes: null, dias: 2, busca: null }, 'UTC');
    assert.deepEqual(p1.days.map((d) => d.day), ['2026-11-02', '2026-11-01']);
    assert.equal(p1.next, '2026-11-01');
    const p2 = paginaDoHistorico(sessoes, { antes: p1.next, dias: 2, busca: null }, 'UTC');
    assert.deepEqual(p2.days.map((d) => d.day), ['2026-10-30', '2026-10-28']);
    assert.equal(p2.next, '2026-10-28');
    const p3 = paginaDoHistorico(sessoes, { antes: p2.next, dias: 2, busca: null }, 'UTC');
    assert.deepEqual(p3.days.map((d) => d.day), ['2026-10-20']);
    assert.equal(p3.next, null);
  });

  test('`antes` é estrito e não precisa ser um dia com sessão; depois do fim, página vazia', () => {
    assert.deepEqual(paginaDoHistorico(sessoes, { antes: '2026-10-31', dias: 7, busca: null }, 'UTC').days.map((d) => d.day), ['2026-10-30', '2026-10-28', '2026-10-20']);
    assert.deepEqual(paginaDoHistorico(sessoes, { antes: '2026-10-20', dias: 7, busca: null }, 'UTC'), { days: [], next: null });
    assert.equal(paginaDoHistorico(sessoes, { antes: null, dias: 5, busca: null }, 'UTC').next, null, 'página exata: não há mais');
  });
});

describe('histórico: busca', () => {
  const sessoes = [
    encerrada('sim-aaa', '2026-11-02T10:00:00.000Z', { title: 'Separar PAGAMENTOS', project: 'vitrine-demo' }),
    encerrada('sim-bbb', '2026-11-01T10:00:00.000Z', { title: null, project: 'motor-de-regras' }),
    encerrada('sim-ccc', '2026-10-31T10:00:00.000Z', { title: 'Relatório', project: null }),
  ];
  const ids = (busca: string) => paginaDoHistorico(sessoes, { antes: null, dias: 7, busca }, 'UTC').days.flatMap((d) => d.sessions.map((s) => s.id));

  test('substring sem diferenciar maiúsculas, no título, no id e no projeto; dias sem resultado somem', () => {
    assert.deepEqual(ids('pagamentos'), ['sim-aaa']);
    assert.deepEqual(ids('MOTOR'), ['sim-bbb']);
    assert.deepEqual(ids('ccc'), ['sim-ccc']);
    assert.deepEqual(ids('relatório'), ['sim-ccc']);
    assert.deepEqual(ids('sim-'), ['sim-aaa', 'sim-bbb', 'sim-ccc']);
    assert.deepEqual(ids('nada disso'), []);
  });

  test('a paginação conta os dias depois da busca', () => {
    const p = paginaDoHistorico(sessoes, { antes: null, dias: 1, busca: 'r' }, 'UTC');
    assert.deepEqual(p.days.map((d) => d.day), ['2026-11-02']);
    assert.equal(p.next, '2026-11-02');
  });
});

describe('histórico: o pedido', () => {
  // The old parameter names pass through the alias map, as on the server.
  const ler = (q: string) => lerPedidoDoHistorico(normalizeLegacyQuery(new URLSearchParams(q)));

  test('sem parâmetros: do mais recente, 7 dias, sem busca', () => {
    assert.deepEqual(ler(''), { ok: true, pedido: { antes: null, dias: 7, busca: null } });
    assert.deepEqual(ler('antes=2026-10-18&dias=31&busca=%20Pagamentos%20'), { ok: true, pedido: { antes: '2026-10-18', dias: 31, busca: 'Pagamentos' } });
    assert.deepEqual(ler('busca=%20%20'), { ok: true, pedido: { antes: null, dias: 7, busca: null } });
  });

  test('inválido diz o porquê', () => {
    for (const q of ['antes=ontem', 'antes=2026-02-30', 'antes=2026-1-08', 'dias=0', 'dias=32', 'dias=1.5', 'dias=abc', 'dias=', `busca=${'x'.repeat(101)}`]) {
      const r = ler(q);
      assert.equal(r.ok, false, q);
      if (!r.ok) assert.match(r.erro, /^(before|days|search): /, q);
    }
    assert.equal(ler(`busca=${'x'.repeat(100)}`).ok, true);
  });
});
