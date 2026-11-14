/*
 * Issue 614 (layer 3 of 578), the wireframe layer's end-to-end skeleton, written red against the approved screens
 * 614-1 (work-board-stale-bands) and 614-2 (work-board-stale-reasons) in docs/wireframes/index.html.
 * The work board screen is mounted in the fake DOM over a fake reader that answers GET /api/work with a stale board
 * and one `staleReason` per test; it asserts the finished band: its title, text, tone, code, action and nothing else.
 * It stays red until the stale band itself is changed (the later layers).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { WORK_BOARD_COLUMNS } from '../../src/github/work-board.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { origin: 'http://127.0.0.1:4317', pathname: '/ui/work', search: '' };
Object.assign(globalThis, {
  location: here,
  history: { state: null, pushState: () => {}, replaceState: () => {} },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });

// @ts-expect-error: browser module, plain JavaScript
import { CONNECT_STATE, CONNECT_UI } from '../../ui/github-connect.js';
// @ts-expect-error: idem
import { mount } from '../../ui/screens/work-board.js';
// @ts-expect-error: idem
import { staleBand } from '../../ui/screens/work-board-parts.js';

const REPO = 'ahrenatechnology/ahrena-console';
const MIN = 60_000;
const SINCE = 'Mostrando o quadro de';
const LIVE = 'As sessões e a fila continuam ao vivo.';

const card = {
  key: `${REPO}#506`, repo: REPO, number: 506, title: 'Issue 506', url: `https://github.com/${REPO}/issues/506`, level: 'item', type: 'story', typeName: 'User Story',
  state: 'open', column: 'planning', columnSince: new Date(Date.now() - 60 * MIN).toISOString(), parent: null, chain: [], projectStatus: null, labels: [], milestone: null,
  plan: null, sessions: { count: 0, state: null, ids: [] }, pullRequest: null, blocked: null, queuePosition: null, doneAt: null, doneBy: null, children: null,
};

/** GET /api/work for a stored (stale) board: what the core sends is `staleReason` (the code) and `retryAt` (epoch ms), never `resumeAt`. */
function staleBoard(staleReason: string, retryAt: number | null) {
  return {
    project: { title: 'Ahrena Console', url: 'https://github.com/orgs/ahrenatechnology/projects/1', primaryRepo: REPO },
    fetchedAt: Date.now() - 31 * MIN,
    stale: true,
    staleReason,
    retryAt,
    total: 1,
    levels: undefined,
    options: {},
    queue: null,
    doneWindowDays: 14,
    columns: WORK_BOARD_COLUMNS.map(({ id, label, criterion }) => {
      const cards = id === 'planning' ? [card] : [];
      return { id, label, criterion, count: cards.length, cards };
    }),
  };
}

const mounted: (() => void)[] = [];
afterEach(() => mounted.splice(0).forEach((leave) => leave()));

async function open(staleReason: string, retryAt: number | null) {
  const area = new ElementoFalso('main');
  const navigated: { route: string; state: unknown }[] = [];
  const leave = new AbortController();
  const ctx = {
    params: {},
    signal: leave.signal,
    read: async () => staleBoard(staleReason, retryAt),
    write: () => Promise.reject(new Error('the work board writes nothing')),
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: (route: string, state: unknown) => navigated.push({ route, state }),
  };
  const cleanup = await mount(area, ctx);
  mounted.push(() => (leave.abort(), typeof cleanup === 'function' && cleanup()));
  const band = area.querySelector('.wb-stale-band');
  assert.ok(band, `the stale band is on screen for ${staleReason}`);
  const button = band.querySelector('button');
  return { area, band, text: texto(band), button, navigated };
}

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('#614/AC-2 rate-limited: the band says GitHub limited the calls and when it comes back', () => {
  test('#614/AC-2 a pause still running: amber with a clock, "Volta às HH:MM (em N min).", no button', async () => {
    const retryAt = Date.now() + 4 * MIN;
    const { band, text, button } = await open('rate-limited', retryAt);
    assert.ok(band.classList.contains('wb-stale-warn'), 'amber');
    assert.equal(band.getAttribute('data-stale-code'), 'rate-limited');
    assert.match(text, /O GitHub limitou as chamadas\./);
    assert.ok(text.includes(`Volta às ${clock(retryAt)} (em 4 min).`), text);
    assert.ok(text.includes(SINCE) && text.includes('(há 31 min).'), text);
    assert.ok(text.includes(LIVE));
    assert.equal(button, null, 'the core does not call GitHub before the hour: no button');
    assert.doesNotMatch(text, /Motivo:/);
    assert.doesNotMatch(text, /GitHub indisponível/);
  });

  for (const [label, retryAt] of [['null', null], ['past', Date.now() - 2 * MIN]] as const) {
    test(`#614/AC-2 a pause that ended (retryAt ${label}): amber, "O limite já passou; relemos na próxima sincronização.", Tentar agora`, async () => {
      const { band, text, button } = await open('rate-limited', retryAt);
      assert.ok(band.classList.contains('wb-stale-warn'), 'amber');
      assert.match(text, /O GitHub limitou as chamadas\./);
      assert.ok(text.includes('O limite já passou; relemos na próxima sincronização.'), text);
      assert.doesNotMatch(text, /Volta às/);
      assert.ok(button, 'Tentar agora is offered');
      assert.equal(button.getAttribute('data-action'), 'retry');
      assert.equal(texto(button), 'Tentar agora');
    });
  }
});

describe('#614/AC-3 credential refused: the band says so and offers Reconectar', () => {
  test('#614/AC-3 credential-refused: red with a key, "O GitHub recusou a credencial do console.", filled Reconectar starts the device flow', async () => {
    const { band, text, button, navigated } = await open('credential-refused', null);
    assert.ok(band.classList.contains('wb-stale-error'), 'red');
    assert.equal(band.getAttribute('data-stale-code'), 'credential-refused');
    assert.match(text, /O GitHub recusou a credencial do console\./);
    assert.ok(text.includes(SINCE) && text.includes(LIVE));
    assert.doesNotMatch(text, /Motivo:/);
    assert.doesNotMatch(text, /GitHub indisponível/);
    assert.ok(button, 'Reconectar is offered');
    assert.equal(button.getAttribute('data-action'), 'reconnect');
    assert.equal(texto(button), 'Reconectar');
    assert.ok(button.classList.contains('filled'), 'the one filled button of the band');
    button.click();
    assert.deepEqual(navigated, [{ route: CONNECT_UI, state: CONNECT_STATE }]);
  });

  test('#614/AC-3 no-scope (live read): red, "A credencial do GitHub não tem a permissão necessária.", Reconectar', async () => {
    const { band, text, button, navigated } = await open('no-scope', null);
    assert.ok(band.classList.contains('wb-stale-error'));
    assert.equal(band.getAttribute('data-stale-code'), 'no-scope');
    assert.match(text, /A credencial do GitHub não tem a permissão necessária\./);
    assert.doesNotMatch(text, /Motivo:/);
    assert.doesNotMatch(text, /GitHub indisponível/);
    assert.equal(button?.getAttribute('data-action'), 'reconnect');
    assert.equal(texto(button), 'Reconectar');
    button.click();
    assert.deepEqual(navigated, [{ route: CONNECT_UI, state: CONNECT_STATE }]);
  });
});

describe('#614/AC-4 "GitHub indisponível." only appears when GitHub did not answer', () => {
  for (const code of ['github-unavailable', 'network']) {
    test(`#614/AC-4 ${code}: red, cloud-off, "GitHub indisponível.", "O GitHub não respondeu. Tentamos de novo em N min.", Tentar agora`, async () => {
      const { band, text, button } = await open(code, Date.now() + 2 * MIN);
      assert.ok(band.classList.contains('wb-stale-error'));
      assert.equal(band.getAttribute('data-stale-code'), code);
      assert.match(text, /GitHub indisponível\./);
      assert.ok(text.includes('O GitHub não respondeu. Tentamos de novo em 2 min.'), text);
      assert.ok(text.includes(SINCE) && text.includes(LIVE));
      assert.doesNotMatch(text, /Motivo:/);
      assert.equal(button?.getAttribute('data-action'), 'retry');
      assert.equal(texto(button), 'Tentar agora');
    });
  }

  test('#614/AC-4 github-error (live read): red, cloud-off, "O GitHub respondeu com erro.", Tentar agora, not "GitHub indisponível."', async () => {
    const { band, text, button } = await open('github-error', null);
    assert.ok(band.classList.contains('wb-stale-error'));
    assert.equal(band.getAttribute('data-stale-code'), 'github-error');
    assert.match(text, /O GitHub respondeu com erro\./);
    assert.doesNotMatch(text, /GitHub indisponível/);
    assert.doesNotMatch(text, /Motivo:/);
    assert.equal(button?.getAttribute('data-action'), 'retry');
  });

  test('#614/AC-4 sync-pending: neutral, "O quadro ainda não foi relido.", Atualizar agora, not "GitHub indisponível."', async () => {
    const { band, text, button } = await open('sync-pending', null);
    assert.ok(band.classList.contains('wb-stale-neutral'), 'neutral');
    assert.equal(band.getAttribute('data-stale-code'), 'sync-pending');
    assert.match(text, /O quadro ainda não foi relido\./);
    assert.ok(text.includes(SINCE) && text.includes(LIVE));
    assert.doesNotMatch(text, /GitHub indisponível/);
    assert.doesNotMatch(text, /Motivo:/);
    assert.equal(button?.getAttribute('data-action'), 'retry');
    assert.equal(texto(button), 'Atualizar agora');
  });

  test('#614/AC-4 the issue panel uses the same band: "Mostrando a issue de …", the same title for the same code, no "Motivo:"', () => {
    const fetchedAt = Date.now() - 31 * MIN;
    const text = texto(staleBand({ fetchedAt, now: Date.now(), reason: 'credential-refused', subject: 'issue' }));
    assert.match(text, /O GitHub recusou a credencial do console\./);
    assert.ok(text.includes('Mostrando a issue de '), text);
    assert.doesNotMatch(text, /Motivo:|GitHub indisponível/);
  });
});
