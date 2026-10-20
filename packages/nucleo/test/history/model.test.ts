// The history of ended sessions (#33, C15), in the domain: who goes in, the day in the time zone, the
// page by days with a session, the `before` cursor, the search and the request validation. Synthetic sessions.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_DAYS,
  endedSessionOf,
  modelDisplayName,
  parseHistoryRequest,
  historyPage,
  type EndedSession,
} from '../../src/history/model.ts';
import { session } from '../fixtures.ts';

function ended(id: string, end: string, over: Partial<EndedSession> = {}): EndedSession {
  return { id, title: `sessão ${id}`, project: 'vitrine-demo', model: 'claude-opus-5-5', status: 'completed', start: new Date(Date.parse(end) - 30 * 60_000).toISOString(), end, ...over };
}

const dayList = (p: ReturnType<typeof historyPage>) => p.days.map((d) => `${d.day}:${d.sessions.map((s) => s.id).join(',')}`);

describe('history: who goes in', () => {
  test('only a session with endedAt; the project is the folder, the title is the one given (or the session name)', () => {
    assert.equal(endedSessionOf(session({ endedAt: null })), null);
    const s = session({ id: 'x1', status: 'completed', cwd: '/simulacao/vitrine-demo', startedAt: '2026-11-02T10:00:00.000Z', endedAt: '2026-11-02T10:45:00.000Z' });
    assert.deepEqual(endedSessionOf(s), {
      id: 'x1', title: 'ajuste do login', project: 'vitrine-demo', model: 'Opus 5.5', status: 'completed',
      start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T10:45:00.000Z',
    });
    assert.equal(endedSessionOf(s, 'título do Desktop')?.title, 'título do Desktop');
    assert.equal(endedSessionOf({ ...s, cwd: null, name: null })?.project, null);
    assert.equal(endedSessionOf({ ...s, cwd: null, name: null })?.title, null);
  });
});

test('the model by its name in the price table; outside it, the id', () => {
  assert.equal(modelDisplayName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelDisplayName('claude-sonnet-5-5-20261001'), 'Sonnet 5.5');
  assert.equal(modelDisplayName('claude-opus-5-5[1m]'), 'Opus 5.5 1M');
  assert.equal(modelDisplayName('modelo-desconhecido'), 'modelo-desconhecido');
  assert.equal(modelDisplayName(null), null);
});

describe('history: days', () => {
  const sessions = [
    ended('a', '2026-11-02T09:00:00.000Z'),
    ended('b', '2026-11-02T11:00:00.000Z'),
    ended('c', '2026-11-01T23:30:00.000Z'),
    ended('d', '2026-10-30T15:00:00.000Z'),
  ];

  test('from the newest day to the oldest; within a day, from the latest end to the earliest', () => {
    const p = historyPage(sessions, { before: null, days: DEFAULT_DAYS, search: null }, 'UTC');
    assert.deepEqual(dayList(p), ['2026-11-02:b,a', '2026-11-01:c', '2026-10-30:d']);
    assert.equal(p.next, null);
  });

  test('the day is the end day, in the given time zone: 23:30 UTC is already another day in Tokyo and the same in São Paulo', () => {
    assert.deepEqual(dayList(historyPage(sessions, { before: null, days: 7, search: null }, 'Asia/Tokyo')), ['2026-11-02:b,a,c', '2026-10-31:d']);
    assert.deepEqual(dayList(historyPage(sessions, { before: null, days: 7, search: null }, 'America/Sao_Paulo')), ['2026-11-02:b,a', '2026-11-01:c', '2026-10-30:d']);
  });

  test('a tie on the end is broken by the id, so the order does not depend on the read', () => {
    const p = historyPage([ended('m', '2026-11-02T09:00:00.000Z'), ended('z', '2026-11-02T09:00:00.000Z')], { before: null, days: 7, search: null }, 'UTC');
    assert.deepEqual(dayList(p), ['2026-11-02:z,m']);
  });
});

describe('history: page and cursor', () => {
  const sessions = ['2026-11-02', '2026-11-01', '2026-10-30', '2026-10-28', '2026-10-20'].map((d, i) => ended(`s${i}`, `${d}T12:00:00.000Z`));

  test('`days` counts only the days with a session; `next` is the page\'s last day while there are more', () => {
    const p1 = historyPage(sessions, { before: null, days: 2, search: null }, 'UTC');
    assert.deepEqual(p1.days.map((d) => d.day), ['2026-11-02', '2026-11-01']);
    assert.equal(p1.next, '2026-11-01');
    const p2 = historyPage(sessions, { before: p1.next, days: 2, search: null }, 'UTC');
    assert.deepEqual(p2.days.map((d) => d.day), ['2026-10-30', '2026-10-28']);
    assert.equal(p2.next, '2026-10-28');
    const p3 = historyPage(sessions, { before: p2.next, days: 2, search: null }, 'UTC');
    assert.deepEqual(p3.days.map((d) => d.day), ['2026-10-20']);
    assert.equal(p3.next, null);
  });

  test('`before` is strict and need not be a day with a session; past the end, an empty page', () => {
    assert.deepEqual(historyPage(sessions, { before: '2026-10-31', days: 7, search: null }, 'UTC').days.map((d) => d.day), ['2026-10-30', '2026-10-28', '2026-10-20']);
    assert.deepEqual(historyPage(sessions, { before: '2026-10-20', days: 7, search: null }, 'UTC'), { days: [], next: null });
    assert.equal(historyPage(sessions, { before: null, days: 5, search: null }, 'UTC').next, null, 'exact page: there is no more');
  });
});

describe('history: search', () => {
  const sessions = [
    ended('sim-aaa', '2026-11-02T10:00:00.000Z', { title: 'Separar PAGAMENTOS', project: 'vitrine-demo' }),
    ended('sim-bbb', '2026-11-01T10:00:00.000Z', { title: null, project: 'motor-de-regras' }),
    ended('sim-ccc', '2026-10-31T10:00:00.000Z', { title: 'Relatório', project: null }),
  ];
  const ids = (search: string) => historyPage(sessions, { before: null, days: 7, search }, 'UTC').days.flatMap((d) => d.sessions.map((s) => s.id));

  test('case-insensitive substring on the title, the id and the project; days with no result disappear', () => {
    assert.deepEqual(ids('pagamentos'), ['sim-aaa']);
    assert.deepEqual(ids('MOTOR'), ['sim-bbb']);
    assert.deepEqual(ids('ccc'), ['sim-ccc']);
    assert.deepEqual(ids('relatório'), ['sim-ccc']);
    assert.deepEqual(ids('sim-'), ['sim-aaa', 'sim-bbb', 'sim-ccc']);
    assert.deepEqual(ids('nada disso'), []);
  });

  test('paging counts the days after the search', () => {
    const p = historyPage(sessions, { before: null, days: 1, search: 'r' }, 'UTC');
    assert.deepEqual(p.days.map((d) => d.day), ['2026-11-02']);
    assert.equal(p.next, '2026-11-02');
  });
});

describe('history: the request', () => {
  const parse = (q: string) => parseHistoryRequest(new URLSearchParams(q));

  test('no parameters: from the newest, 7 days, no search', () => {
    assert.deepEqual(parse(''), { ok: true, request: { before: null, days: 7, search: null } });
    assert.deepEqual(parse('before=2026-10-18&days=31&search=%20Pagamentos%20'), { ok: true, request: { before: '2026-10-18', days: 31, search: 'Pagamentos' } });
    assert.deepEqual(parse('search=%20%20'), { ok: true, request: { before: null, days: 7, search: null } });
  });

  test('invalid says why', () => {
    for (const q of ['before=ontem', 'before=2026-02-30', 'before=2026-1-08', 'days=0', 'days=32', 'days=1.5', 'days=abc', 'days=', `search=${'x'.repeat(101)}`]) {
      const r = parse(q);
      assert.equal(r.ok, false, q);
      if (!r.ok) assert.match(r.error, /^(before|days|search): /, q);
    }
    assert.equal(parse(`search=${'x'.repeat(100)}`).ok, true);
  });
});
