// "Nova sessão" in the /ui: the popover reads the folders, a target's click sends `{ folder, target }`,
// and the answer becomes the state beside the targets. Reader and writer are stubs: nothing here reaches
// a core, a terminal or the Claude Desktop.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
// @ts-expect-error: browser module, plain JavaScript
const { newSessionButton, stateOfAnswer, FOLDERS_ROUTE, NEW_SESSION_ROUTE } = await import('../../ui/new-session.js');

const FOLDERS = { folders: [{ path: '/w/app', name: 'app' }, { path: '/w/other', name: 'other' }], targets: { desktop: true, terminal: true } };
const settle = () => new Promise((ok) => setTimeout(ok, 0));
const writeError = (message: string, body: Record<string, unknown>) => Object.assign(new Error(message), { name: 'WriteError', status: 501, body });

function setup(answer: unknown, folders: unknown = FOLDERS) {
  const reads: string[] = [];
  const writes: { route: string; body: unknown }[] = [];
  const root = newSessionButton({
    read: async (route: string) => (reads.push(route), folders),
    write: async (route: string, body: unknown) => {
      writes.push({ route, body });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    successMs: 5,
  }) as ElementoFalso;
  const pop = root.querySelector('.ns-pop')!;
  return { root, pop, reads, writes, toggle: () => root.querySelector('.ns-button')!.click() };
}

describe('new session button', () => {
  test('closed at first; opening reads the folders and offers both targets', async () => {
    const { pop, reads, toggle } = setup({ ok: true, opened: 'desktop' });
    assert.ok(pop.hasAttribute('hidden'));
    toggle();
    await settle();
    assert.ok(!pop.hasAttribute('hidden'));
    assert.deepEqual(reads, [FOLDERS_ROUTE]);
    assert.deepEqual(pop.querySelectorAll('option').map((o) => o.getAttribute('value')), ['/w/app', '/w/other']);
    assert.deepEqual(pop.querySelectorAll('.ns-target').map((b) => b.getAttribute('data-target')), ['desktop', 'terminal']);
  });

  test('a target sends the chosen folder; the success shows and the popover closes', async () => {
    const { pop, writes, toggle } = setup({ ok: true, opened: 'terminal' });
    toggle();
    await settle();
    pop.querySelector('[data-target="terminal"]')!.click();
    await settle();
    assert.deepEqual(writes, [{ route: NEW_SESSION_ROUTE, body: { folder: '/w/app', target: 'terminal' } }]);
    assert.match(texto(pop.querySelector('.ns-status')), /Aberta no terminal/);
    await new Promise((ok) => setTimeout(ok, 20));
    assert.ok(pop.hasAttribute('hidden'));
  });

  test('an error shows the core text and "Copiar comando"', async () => {
    const { pop, toggle } = setup(writeError('Não há um terminal que o console saiba abrir aqui; copie o comando', { command: "cd '/w/app' && claude" }));
    toggle();
    await settle();
    pop.querySelector('[data-target="terminal"]')!.click();
    await settle();
    assert.match(texto(pop.querySelector('.ns-status')), /copie o comando/);
    assert.ok(pop.querySelector('.ns-copy'));
  });

  test('no folder known: says how one appears, no target', async () => {
    const { pop, toggle } = setup({ ok: true }, { folders: [], targets: {} });
    toggle();
    await settle();
    assert.match(texto(pop), /Nenhuma pasta conhecida/);
    assert.equal(pop.querySelectorAll('.ns-target').length, 0);
  });

  test('stateOfAnswer', () => {
    assert.deepEqual(stateOfAnswer({ ok: true, opened: 'desktop' }), { kind: 'ok', text: 'Aberta no Claude Desktop' });
    assert.deepEqual(stateOfAnswer(null, writeError('x', {})), { kind: 'fail', text: 'x', command: null });
  });
});
