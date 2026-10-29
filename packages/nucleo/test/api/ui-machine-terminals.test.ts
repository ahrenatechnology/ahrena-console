// The "Sessões de terminal" card on the machine screens (issue 350, C90 to C93): the pure parts, and
// the card with its confirmations on the fake DOM. The write is a double; nothing leaves the test.
import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { buildTerminals, parseTerminalsPs } from '../../src/telemetry/terminals.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

// @ts-expect-error: browser module, plain JavaScript
import { ICON_NAMES } from '../../ui/dom.js';
// @ts-expect-error: idem
import * as fmt from '../../ui/screens/machine-terminals-format.js';
// @ts-expect-error: idem
import { normalizeReading } from '../../ui/screens/machine-format.js';
// @ts-expect-error: idem
import { machineTerminals } from '../../ui/screens/machine-terminals.js';

const SCRATCH = '/tmp/claude-85401147/p/fe694084-bac4-42f8-a4c6-d8a3accf3a16/scratchpad/destrava-pedro.sh';
const PS = `
 2210   812  2210      -1 ?        Ss      5400  1000 seguim   sshd: seguim@pts/0,pts/1
 2231  2210  2231   41233 pts/0    Ss      5400  1000 seguim   -bash
41233  2231 41233   41233 pts/0    S+      1560  1000 seguim   bash ${SCRATCH}
 2260  2210  2260    2260 pts/1    Ss+     5400  1000 seguim   -bash
 4000   812  4000      -1 ?        Ss      3000     0 root     sshd: root@pts/5
 4010  4000  4010    4020 pts/5    Ss      3000     0 root     bash
 4020  4010  4020    4020 pts/5    S+       999     0 root     apt-get upgrade
`;
const build = (over = {}) => JSON.parse(JSON.stringify(buildTerminals(parseTerminalsPs(PS), { nowMs: Date.parse('2026-10-29T12:00:00Z'), uid: 1000, selfPid: 999_999, ...over })));
const reading = (over = {}) => normalizeReading({ takenAt: 'x', host: {}, cpu: null, memory: null, disk: { volumes: [] }, terminals: build(over) }).terminals;

describe('#350 the pure parts', () => {
  test('a reading of the remote keeps the terminals only when they have the shape', () => {
    assert.equal(reading().sessions.length, 3);
    assert.equal(normalizeReading({ takenAt: 'x', host: {}, terminals: { sessions: 'no' } }).terminals, null);
    assert.equal(normalizeReading({ takenAt: 'x', host: {} }).terminals, null);
    const t = normalizeReading({ takenAt: 'x', host: {}, terminals: { sessions: [{ id: '../x', tty: 'pts/0', state: 'idle', connection: {}, end: {} }] } }).terminals;
    assert.deepEqual(t.sessions, []);
  });

  test('wording: age, short command, connection, state pill', () => {
    assert.equal(fmt.ageText(45), '45 s');
    assert.equal(fmt.ageText(1560), '26 min');
    assert.equal(fmt.ageText(11100), '3 h 05');
    assert.equal(fmt.shortCommand(`bash ${SCRATCH}`), 'bash …/destrava-pedro.sh');
    const [p0] = reading().sessions;
    assert.equal(fmt.connectionCell(p0)[0], 'sshd 2210');
    assert.deepEqual(fmt.stateOf(p0), ['b-error', 'Presa']);
    assert.deepEqual(fmt.stateOf(reading().sessions[1]), ['b-idle', 'Ocioso']);
  });

  test('the actions are on only when they can run, and say why not', () => {
    const [p0, p1, other] = reading({ tunnelSshd: new Set([2210]) }).sessions;
    assert.equal(fmt.interruptState(p0).on, true);
    assert.equal(fmt.interruptState(p1).on, false);
    assert.match(fmt.interruptState(p1).why, /Só o prompt/);
    assert.equal(fmt.endState(p0).on, false);
    assert.match(fmt.endState(p0).why, /leva o túnel do console/);
    assert.match(fmt.interruptState(other).why, /outro usuário/);
    assert.equal(fmt.endState(reading().sessions[0]).on, true);
  });

  test('the confirmation shows the process, the signal and how many terminals the connection holds', () => {
    const [p0] = reading().sessions;
    const i = fmt.confirmation(p0, 'interrupt', { machineLabel: 'Workstation', local: false });
    assert.equal(i.title, 'Interromper o comando em pts/0');
    assert.deepEqual(i.lines, ['SIGINT no grupo 41233', 'o mesmo que Ctrl-C na aba']);
    assert.ok(i.rows.some(([k, v]: string[]) => k === 'Processo' && v.includes('pid 41233')));
    assert.ok(i.rows.some(([k, v]: string[]) => k === 'Onde' && v === 'Na Workstation · terminal pts/0'));
    const e = fmt.confirmation(p0, 'hangup', { machineLabel: 'Workstation', local: true });
    assert.deepEqual(e.lines, ['SIGHUP no sshd 2210']);
    assert.ok(e.rows.some(([k, v]: string[]) => k === 'Esta conexão segura' && v === '2 terminais: pts/0 e pts/1. As duas abas fecham.'));
    const k = fmt.confirmation(p0, 'kill', { machineLabel: 'x', local: true });
    assert.equal(k.danger, true);
    assert.equal(k.title, 'Matar à força · segunda confirmação');
  });

  test('the ladder: SIGINT, SIGTERM, SIGKILL; SIGHUP, SIGTERM; and the command to copy', () => {
    assert.deepEqual(['interrupt', 'terminate', 'kill'].map((s) => fmt.nextStep(s)), ['terminate', 'kill', null]);
    assert.deepEqual(['hangup', 'end'].map((s) => fmt.nextStep(s)), ['end', null]);
    const [p0] = reading().sessions;
    assert.equal(fmt.copyCommand(p0, 'command'), 'kill -INT -- -41233');
    assert.equal(fmt.copyCommand(p0, 'session'), 'kill -HUP 2210');
  });

  test('refusals in the person\'s words', () => {
    const w = { local: false, machineLabel: 'Workstation' };
    assert.match(fmt.actionProblem({ body: { reason: 'changed' } }, w), /Nada foi enviado\. O processo não é mais o mesmo/);
    assert.match(fmt.actionProblem({ status: 403, body: { error: 'origem não permitida' } }, w), /Workstation não aceita ações vindas deste Mac/);
    assert.match(fmt.actionProblem({ status: 502 }, w), /não respondeu/);
    assert.match(fmt.actionProblem({ body: { reason: 'tunnel' } }, w), /leva o túnel/);
  });

  test('every icon the card uses exists', () => {
    for (const n of ['square-terminal', 'square', 'power', 'zap', 'copy', 'bot', 'x', 'alert', 'shield-check', 'info']) assert.ok(ICON_NAMES.includes(n), n);
  });
});

describe('#350 the card and its confirmations', () => {
  afterEach(() => mock.timers.reset());

  function setup({ local = true, terminals = reading(), fail = null as null | { status?: number; body?: unknown; message?: string } } = {}) {
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const writes: { route: string; body: unknown }[] = [];
    const ctl = new AbortController();
    const repaints = { n: 0 };
    let rereads = 0;
    const ctx = {
      signal: ctl.signal,
      write: async (route: string, body: unknown) => {
        writes.push({ route, body });
        if (fail) throw Object.assign(new Error(fail.message ?? 'falhou'), { status: fail.status, body: fail.body });
        return { result: 'sent' };
      },
    };
    const t = machineTerminals(ctx, { id: 'ws-exemplo', local, label: () => 'Workstation', repaint: () => void repaints.n++, reread: () => void rereads++ });
    const box = () => {
      const area = new ElementoFalso('div');
      const c = t.card(terminals, []);
      if (c) area.append(c);
      for (const n of [t.dialogNode(), t.bandNode()]) if (n) area.append(n);
      return area;
    };
    return { t, writes, repaints, rereads: () => rereads, box, terminals };
  }
  const click = (area: ElementoFalso, sel: string) => area.querySelector(sel)!.click();

  test('one row per terminal, the stuck one marked, with its Claude session', () => {
    const { box } = setup();
    const area = box();
    assert.equal(area.querySelectorAll('tbody tr').length, 3);
    const stuck = area.querySelector('tr.tm-term-stuck')!;
    assert.match(texto(stuck), /pts\/0/);
    assert.match(texto(stuck), /bash …\/destrava-pedro\.sh/);
    assert.match(texto(stuck), /sessão do Claude: fe694084/);
    assert.match(texto(stuck), /Presa/);
    assert.match(texto(stuck), /26 min/);
  });

  test('Interromper o comando opens the confirmation; Confirmar sends the ids only and keeps the ladder manual', async () => {
    const { t, writes, repaints, box, rereads } = setup();
    click(box(), 'tr[data-terminal="pts/0"] [data-action="command"]');
    assert.equal(repaints.n, 1);
    assert.equal(t.isOpen(), true);
    const dlg = box().querySelector('[data-part="terminal-dialog"]')!;
    assert.match(texto(dlg), /SIGINT no grupo 41233/);
    assert.match(texto(dlg), /confere de novo que o pid ainda é este processo/);
    await box().querySelector('[data-action="dialog-confirm"]')!.click();
    await Promise.resolve();
    assert.deepEqual(writes, [{ route: '/api/terminals/pts-0/actions/interrupt', body: { pid: 41233 } }]);
    assert.equal(t.isOpen(), false);
    assert.match(texto(box().querySelector('[data-part="terminal-band"]')), /SIGINT enviado/);
    mock.timers.tick(1500);
    assert.equal(rereads(), 1);
    // The next reading still has the process: the next signal is offered, never sent by itself.
    t.take(reading(), []);
    const band = box().querySelector('[data-part="terminal-band"]')!;
    assert.match(texto(band), /SIGINT enviado e o processo continua vivo/);
    assert.equal(writes.length, 1);
    click(box(), '[data-action="next-step"]');
    assert.match(texto(box().querySelector('[data-part="terminal-dialog"]')), /SIGTERM no grupo 41233/);
  });

  test('SIGKILL is the second confirmation and sends confirm', async () => {
    const { t, writes, box } = setup();
    click(box(), 'tr[data-terminal="pts/0"] [data-action="command"]');
    await box().querySelector('[data-action="dialog-confirm"]')!.click();
    await Promise.resolve();
    mock.timers.tick(1500);
    t.take(reading(), []);
    click(box(), '[data-action="next-step"]'); // terminate
    await box().querySelector('[data-action="dialog-confirm"]')!.click();
    await Promise.resolve();
    mock.timers.tick(1500);
    t.take(reading(), []);
    click(box(), '[data-action="next-step"]'); // kill
    const dlg = box().querySelector('[data-part="terminal-dialog"]')!;
    assert.equal(dlg.getAttribute('data-step'), 'kill');
    assert.match(texto(dlg), /Matar à força · segunda confirmação/);
    await box().querySelector('[data-action="dialog-confirm"]')!.click();
    await Promise.resolve();
    assert.deepEqual(writes.map((w) => w.route.split('/').pop()), ['interrupt', 'terminate', 'kill']);
    assert.deepEqual(writes[2]!.body, { pid: 41233, confirm: true });
  });

  test('when the process is gone the band says the terminal is back to the prompt', async () => {
    const { t, box } = setup();
    click(box(), 'tr[data-terminal="pts/0"] [data-action="command"]');
    await box().querySelector('[data-action="dialog-confirm"]')!.click();
    await Promise.resolve();
    mock.timers.tick(1500);
    const idle = JSON.parse(JSON.stringify(reading()));
    idle.sessions[0] = { ...idle.sessions[0], foreground: null, state: 'idle', stuck: false };
    t.take(idle, []);
    assert.match(texto(box().querySelector('[data-part="terminal-band"]')), /pts\/0 voltou ao prompt/);
    assert.equal(box().querySelector('[data-action="next-step"]'), null);
  });

  test('Encerrar a sessão warns about the second terminal on the same connection', () => {
    const { box } = setup();
    click(box(), 'tr[data-terminal="pts/0"] [data-action="session"]');
    const dlg = box().querySelector('[data-part="terminal-dialog"]')!;
    assert.match(texto(dlg), /2 terminais: pts\/0 e pts\/1\. As duas abas fecham\./);
    assert.match(texto(dlg), /SIGHUP no sshd 2210/);
  });

  test('a refusal closes the confirmation and says nothing was sent', async () => {
    const { t, box, rereads } = setup({ fail: { status: 409, body: { reason: 'changed' } } });
    click(box(), 'tr[data-terminal="pts/0"] [data-action="command"]');
    await box().querySelector('[data-action="dialog-confirm"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(t.isOpen(), false);
    assert.match(texto(box().querySelector('[data-part="terminal-band"]')), /Nada foi enviado\. O processo não é mais o mesmo/);
    assert.equal(rereads(), 1);
  });

  test('disabled actions explain themselves, and the other user\'s row has none on', () => {
    const { box } = setup({ terminals: reading({ tunnelSshd: new Set([2210]) }) });
    const area = box();
    const idle = area.querySelector('tr[data-terminal="pts/1"]')!;
    assert.equal(idle.querySelector('[data-action="command"]')!.hasAttribute('disabled'), true);
    assert.match(texto(idle), /Só o prompt: não há comando para interromper/);
    assert.match(texto(area.querySelector('tr[data-terminal="pts/0"]')), /leva o túnel do console/);
    const other = area.querySelector('tr[data-terminal="pts/5"]')!;
    assert.equal(other.querySelectorAll('button').every((b) => b.hasAttribute('disabled')), true);
  });

  test('on a remote that does not accept actions the buttons copy the command, with the read-only note', () => {
    const { box } = setup({ local: false });
    const area = box();
    assert.match(texto(area.querySelector('.tm-only-shows')), /Só leitura\./);
    assert.match(texto(area.querySelector('tr[data-terminal="pts/0"]')), /Copiar: kill -INT -- -41233/);
    assert.match(texto(area.querySelector('tr[data-terminal="pts/0"]')), /Copiar: kill -HUP 2210/);
    assert.equal(area.querySelector('tr[data-terminal="pts/0"] [data-action="command"]'), null);
  });

  test('on a remote that accepts them the write carries the machine', async () => {
    const { writes, box } = setup({ local: false, terminals: reading({ remoteActions: true }) });
    click(box(), 'tr[data-terminal="pts/0"] [data-action="command"]');
    assert.match(texto(box().querySelector('[data-part="terminal-dialog"]')), /Na Workstation · terminal pts\/0/);
    await box().querySelector('[data-action="dialog-confirm"]')!.click();
    await Promise.resolve();
    assert.deepEqual(writes, [{ route: '/api/terminals/pts-0/actions/interrupt', body: { pid: 41233, machine: 'ws-exemplo' } }]);
  });

  test('no terminals reading: no card; no terminals open: an empty line', () => {
    assert.equal(setup({ terminals: null as never }).box().querySelector('[data-part="terminals"]'), null);
    assert.match(texto(setup({ terminals: { sessions: [], stuckAfterSec: 900, remoteActions: false } as never }).box()), /Nenhum terminal aberto/);
  });
});
