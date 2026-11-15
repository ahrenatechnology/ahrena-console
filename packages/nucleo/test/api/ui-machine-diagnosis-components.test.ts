// The components of the diagnosis next to a saturation alert (#566, layer 2 of 4), rendered from fixed data in the
// shape of docs/contracts/diagnosis.md (#565): no read, no core, no screen state. One group per component and per
// state the wireframe drew (566-3 to 566-9), the pure format and the probable-cause rule with no DOM, and the
// accessibility each component owes (aria-busy, roles, real buttons with names, tables with headers).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

// @ts-expect-error: browser module, plain JavaScript
const format = await import('../../ui/screens/machine-diagnosis-format.js');
// @ts-expect-error: browser module, plain JavaScript
const view = await import('../../ui/screens/machine-diagnosis.js');

const GB = 1024 ** 3;
const DEC_GB = 1e9;
const NOW = Date.parse('2026-11-14T12:00:12.000Z');
const TAKEN = '2026-11-14T12:00:00.000Z';

const proc = (pid: number, name: string, rssGb: number, cpuPct: number) => ({ pid, name, rssBytes: rssGb * GB, cpuPct, startedAt: '2026-11-14T08:00:00.000Z' });
const ok = (id: string, items: unknown[], extra: Record<string, unknown> = {}) => ({ id, status: 'ok', items, ...extra });
const down = (id: string, status: 'unavailable' | 'timeout', reason?: string) => ({ id, status, items: [], ...(reason ? { reason } : {}) });

const RSS = [proc(4182, 'qemu-system-aarch64', 9.8, 102), proc(7731, 'next-server', 3.2, 56), proc(1204, 'Google Chrome Helper', 2.1, 7.4), proc(9120, 'claude', 1.4, 11.2), proc(811, 'WindowServer', 1.1, 4), proc(2210, 'node', 0.9, 6.1), proc(55, 'mds', 0.5, 1)];
const CPU = [proc(4182, 'qemu-system-aarch64', 9.8, 102), proc(7731, 'next-server', 3.2, 56), proc(9120, 'claude', 1.4, 11.2)];
const SWAP = { usedBytes: 19 * GB, totalBytes: 20.4 * GB };

const diagnosis = (kind: string, sections: unknown[], alertId = kind) => ({ machine: 'local', alertId, kind, takenAt: TAKEN, sections });
const memoryDiagnosis = (kind = 'swap-high') => diagnosis(kind, [ok('processes-by-rss', RSS), ok('processes-by-cpu', CPU), ok('swap', [SWAP])]);
const loadDiagnosis = () => diagnosis('load-high', [ok('processes-by-cpu', [proc(20311, 'node', 1.8, 312), proc(20480, 'java', 2.6, 288), proc(31877, 'python3', 0.9, 164), proc(902, 'containerd-shim', 0.1, 41)])]);
const FOLDERS = ['/home/ubuntu/.cache', '/var/lib/docker', '/home/ubuntu/Workspace', '/var/log', '/tmp', '/opt', '/srv'].map((path, i) => ({ path, bytes: (31.4 - i * 4) * DEC_GB }));
const DOCKER = [
  { type: 'Images', usedBytes: 25.2 * DEC_GB, reclaimableBytes: 8.7 * DEC_GB },
  { type: 'Build Cache', usedBytes: 2.3 * DEC_GB, reclaimableBytes: 9.4 * DEC_GB },
];
const CACHES = [
  { id: 'npm', path: '~/.npm', bytes: 3.8 * DEC_GB, actionId: 'npm-cache' },
  { id: 'pip', path: '~/.cache/pip', bytes: 1.1 * DEC_GB, actionId: 'pip-cache' },
  { id: 'worktree', path: '~/Workspace/a', bytes: 7 * DEC_GB, lastUsedAt: '2026-10-01T00:00:00.000Z', hasUncommitted: false, hasUnpushed: false, actionId: null },
  { id: 'worktree', path: '~/Workspace/b', bytes: 7.2 * DEC_GB, lastUsedAt: '2026-10-02T00:00:00.000Z', hasUncommitted: false, hasUnpushed: false, actionId: null },
];
const diskDiagnosis = (extra: unknown[] = []) =>
  diagnosis(
    'volume-full',
    [ok('largest-folders', FOLDERS), ok('docker-df', DOCKER), ok('known-caches', CACHES), ok('journal', [{ bytes: 4 * DEC_GB }]), ...extra],
    'volume-full:/',
  );

const alertOf = (kind: string, level = 'error', message = 'Swap quase cheio') => ({ id: kind, kind, level, message });
const render = (state: string, extra: Record<string, unknown> = {}, handlers: Record<string, unknown> = {}) =>
  view.diagnosisPanel({ state, alert: alertOf('swap-high'), now: NOW, expanded: new Set(), ...extra }, handlers) as ElementoFalso;
const sec = (root: ElementoFalso, id: string) => root.querySelector(`[data-section="${id}"]`);
const buttons = (root: ElementoFalso) => root.querySelectorAll('button');
const action = (root: ElementoFalso, name: string) => root.querySelector(`[data-dg-action="${name}"]`);
const rows = (root: ElementoFalso) => root.querySelectorAll('tbody tr');

describe('the format, with no DOM', () => {
  test('only load-high, memory-high, swap-high and volume-full are saturation kinds', () => {
    for (const k of ['load-high', 'memory-high', 'swap-high', 'volume-full']) assert.equal(format.isSaturationKind(k), true, k);
    for (const k of ['port-exposed', 'tunnel-busy', 'machine-unreachable', 'terminal-stuck', 'stack-orphan', '', undefined]) assert.equal(format.isSaturationKind(k), false, String(k));
  });

  test('each kind lists its sections in the contract order, drops unknown ids, and keeps the absent journal absent', () => {
    const shuffled = diagnosis('swap-high', [ok('swap', [SWAP]), ok('mystery', []), ok('processes-by-cpu', CPU), ok('processes-by-rss', RSS)]);
    assert.deepEqual(format.sectionsFor('swap-high', shuffled).map((s: { id: string }) => s.id), ['processes-by-rss', 'processes-by-cpu', 'swap']);
    assert.deepEqual(format.sectionsFor('memory-high', memoryDiagnosis('memory-high')).map((s: { id: string }) => s.id), ['processes-by-rss', 'processes-by-cpu', 'swap']);
    assert.deepEqual(format.sectionsFor('load-high', loadDiagnosis()).map((s: { id: string }) => s.id), ['processes-by-cpu']);
    const mac = diagnosis('volume-full', [ok('known-caches', CACHES), ok('docker-df', DOCKER), ok('largest-folders', FOLDERS)]);
    assert.deepEqual(format.sectionsFor('volume-full', mac).map((s: { id: string }) => s.id), ['largest-folders', 'docker-df', 'known-caches']);
    assert.deepEqual(format.sectionsFor('volume-full', diskDiagnosis()).map((s: { id: string }) => s.id), ['largest-folders', 'docker-df', 'known-caches', 'journal']);
    assert.deepEqual(format.sectionsFor('port-exposed', diskDiagnosis()), []);
  });

  test('a list shows 5 and offers "Mostrar os 10"; open it shows up to 10; 5 or fewer offer nothing', () => {
    const ten = Array.from({ length: 10 }, (_, i) => i);
    assert.deepEqual(format.visibleItems(ten, false), { items: ten.slice(0, 5), total: 10, canExpand: true });
    assert.equal(format.visibleItems(ten, true).items.length, 10);
    assert.equal(format.visibleItems(ten.slice(0, 5), false).canExpand, false);
    assert.equal(format.visibleItems(Array.from({ length: 12 }, (_, i) => i), true).items.length, 10);
    assert.equal(format.moreLabel('processes-by-rss', 10, false), 'Mostrar os 10');
    assert.equal(format.moreLabel('largest-folders', 10, false), 'Mostrar as 10');
    assert.equal(format.moreLabel('processes-by-rss', 10, true), 'Mostrar menos');
    assert.equal(format.moreLabel('processes-by-rss', 7, false), 'Mostrar os 7');
  });

  test('the read line is "lido às HH:MM · há N s", from takenAt, and empty when takenAt is not a date', () => {
    const d = new Date(TAKEN);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    assert.equal(format.readLine(TAKEN, NOW), `lido às ${hhmm} · há 12 s`);
    assert.equal(format.readLine(TAKEN, NOW + 5 * 60_000), `lido às ${hhmm} · há 5 min`);
    assert.equal(format.readLine('nope', NOW), '');
    assert.equal(format.readLine(null, NOW), '');
  });

  test('the Memória card tone is the worst level of the memory-high and swap-high alerts: warning is warn, error is bad, none is ok', () => {
    const a = (kind: string, level: string) => ({ id: kind, kind, level });
    assert.equal(format.memoryTone([]), 'ok');
    assert.equal(format.memoryTone([a('port-exposed', 'error'), a('load-high', 'error'), a('volume-full', 'error')]), 'ok');
    assert.equal(format.memoryTone([a('memory-high', 'warning')]), 'warn');
    assert.equal(format.memoryTone([a('swap-high', 'error')]), 'bad');
    assert.equal(format.memoryTone([a('memory-high', 'warning'), a('swap-high', 'error')]), 'bad');
    assert.equal(format.memoryTone([a('swap-high', 'error'), a('memory-high', 'warning')]), 'bad');
    assert.equal(format.memoryTone([a('memory-high', 'info')]), 'ok');
  });

  test('numbers: memory in binary GB with one decimal, CPU with a comma and a percent, folders in decimal units', () => {
    assert.equal(format.gbText(9.8 * GB), '9,8 GB');
    assert.equal(format.gbText(19 * GB), '19,0 GB');
    assert.equal(format.gbText(300 * 1024 ** 2), '300 MB');
    assert.equal(format.cpuText(102), '102%');
    assert.equal(format.cpuText(7.4), '7,4%');
    assert.equal(format.cpuText(null), '—');
    assert.equal(format.swapLine({ usedBytes: 19 * GB, totalBytes: 20.4 * GB }), '19,0 de 20,4 GB · 93%');
    assert.equal(format.swapLine({ usedBytes: 0, totalBytes: 0 }), 'sem swap');
    assert.equal(format.swapTone({ usedBytes: 19 * GB, totalBytes: 20.4 * GB }), 'bad');
    assert.equal(format.swapTone({ usedBytes: 17.5 * GB, totalBytes: 20 * GB }), 'warn');
    assert.equal(format.swapTone({ usedBytes: 1 * GB, totalBytes: 20 * GB }), 'ok');
  });

  test('the known caches name their cleanup, and the old worktrees are one row with their number and size', () => {
    const rowsOf = format.cacheRows(CACHES, NOW);
    assert.deepEqual(rowsOf, [
      { title: 'npm', path: '~/.npm', bytes: 3.8 * DEC_GB },
      { title: 'pip', path: '~/.cache/pip', bytes: 1.1 * DEC_GB },
      { title: 'Worktrees antigas', path: '2 sem uso há mais de 43 dias, em ~/Workspace', bytes: 14.2 * DEC_GB },
    ]);
    assert.equal(format.cacheRows([{ id: 'xcode', path: '~/DerivedData', bytes: 1, actionId: 'xcode-derived-data' }])[0].title, 'Xcode DerivedData');
    assert.equal(format.cacheRows([{ id: 'worktree', path: '/w', bytes: 1, lastUsedAt: '2026-11-12T00:00:00.000Z', actionId: null }], NOW)[0].path, '1 sem uso há mais de 2 dias, em /');
    // no readable lastUsedAt: only the number and the folder, never an invented age (#566)
    assert.equal(format.cacheRows([{ id: 'worktree', path: '~/Workspace/x/a', bytes: 1, actionId: null }, { id: 'worktree', path: '~/Workspace/x/b', bytes: 1, lastUsedAt: 'nope', actionId: null }], NOW)[0].path, '2 worktrees, em ~/Workspace/x');
  });

  test('the worktree line takes the age limit and the shared root the core served, and each one falls back alone when it is absent (#566)', () => {
    const trees = [{ id: 'worktree', path: '/home/u/Workspace/a', bytes: 1, lastUsedAt: '2026-11-12T00:00:00.000Z', actionId: null }];
    const line = (served?: unknown) => format.cacheRows(trees, NOW, served)[0].path;
    assert.equal(line({ oldAfterDays: 14, root: '~/Workspace' }), '1 sem uso há mais de 14 dias, em ~/Workspace');
    assert.equal(line({ oldAfterDays: 1, root: '~/Workspace' }), '1 sem uso há mais de 1 dia, em ~/Workspace', 'one day is singular');
    assert.equal(line({ oldAfterDays: 14, root: null }), '1 sem uso há mais de 14 dias', 'no shared root to name: no folder');
    assert.equal(line({ root: '~/Workspace' }), '1 sem uso há mais de 2 dias, em ~/Workspace', 'no age limit: the items give the days');
    assert.equal(line({ oldAfterDays: 14 }), '1 sem uso há mais de 14 dias, em /home/u/Workspace', 'no root field: the items give the folder');
    assert.equal(line({ oldAfterDays: 0, root: 7 }), '1 sem uso há mais de 2 dias, em /home/u/Workspace', 'a field that is not valid counts as absent');
    assert.equal(line(undefined), '1 sem uso há mais de 2 dias, em /home/u/Workspace', 'an old remote serves no worktrees');
  });

  test('the folder section names the mount that the alert id carries', () => {
    assert.equal(format.mountOf('volume-full:/'), '/');
    assert.equal(format.mountOf('volume-full:/Volumes/Data'), '/Volumes/Data');
    assert.equal(format.mountOf('swap-high'), '');
  });

  test('what a failure says: the Workstation answering 502 is not the route failing, and the code line names the status and the route only', () => {
    assert.deepEqual(format.failureText({ status: 500, remote: false }), { reason: 'A rota de diagnóstico não respondeu. O alerta continua aberto: só o diagnóstico não veio.', code: 'GET /api/diagnosis · erro 500' });
    const ws = format.failureText({ status: 502, remote: true });
    assert.match(ws.reason, /^A Workstation não respondeu ao pedido de diagnóstico\./);
    assert.equal(ws.code, 'GET /api/diagnosis · erro 502 do núcleo daqui');
    assert.equal(format.failureText({ status: 502, remote: false }).code, 'GET /api/diagnosis · erro 502');
    const slow = format.failureText({ status: null, timedOut: true, remote: false });
    assert.equal(slow.reason, 'A rota de diagnóstico não respondeu. O alerta continua aberto: só o diagnóstico não veio.');
    assert.equal(slow.code, 'GET /api/diagnosis · sem resposta');
    assert.equal(format.failureText({ status: null, remote: false }).code, 'GET /api/diagnosis · sem resposta');
    assert.equal(format.READ_CEILING_MS, 20_000);
  });
});

describe('the probable cause rule (Q12), with no DOM', () => {
  const text = (c: { parts: { text: string }[] } | null) => (c ? format.causeText(c.parts) : null);

  test('memory: the two biggest by RSS at 40% or more of what is used make the cause obvious, and it says "empurram para o swap" only for swap-high', () => {
    const c = format.probableCause(memoryDiagnosis('swap-high'), { memoryUsedBytes: 30.5 * GB });
    assert.equal(c.obvious, true);
    assert.equal(text(c), 'qemu-system-aarch64 segura 9,8 GB e 102% de CPU, e next-server mais 3,2 GB a 56%. Os dois somam 13,0 dos 30,5 GB em uso e empurram o Mac para o swap.');
    const remote = format.probableCause(memoryDiagnosis('swap-high'), { memoryUsedBytes: 30.5 * GB, machine: 'a Workstation' });
    assert.match(text(remote) as string, /e empurram a Workstation para o swap\.$/);
    assert.equal(c.note, 'Uma leitura dos processos acima, não uma certeza: o console aponta o que mais pesa.');
    assert.doesNotMatch(text(format.probableCause(memoryDiagnosis('memory-high'), { memoryUsedBytes: 30.5 * GB })) as string, /swap/);
    assert.ok(c.parts.some((p: { text: string; mono?: boolean }) => p.text === 'qemu-system-aarch64' && p.mono === true), 'a process name is mono');
  });

  test('memory: exactly 40% is obvious, just under is not, and not obvious says so and the note says the cause is not obvious', () => {
    const at = (usedGb: number) => format.probableCause(memoryDiagnosis(), { memoryUsedBytes: usedGb * GB });
    assert.equal(at(32.5).obvious, true);
    const wide = at(32.6);
    assert.equal(wide.obvious, false);
    assert.match(text(wide) as string, /^não há uma óbvia\./);
    assert.match(text(wide) as string, /somam só 13,0 dos 32,6 GB em uso/);
    assert.equal(wide.note, 'A causa não é óbvia.');
  });

  test('memory and load: the boundaries are the exported shares, not literals', () => {
    assert.equal(format.MEMORY_SHARE, 0.4);
    assert.equal(format.LOAD_SHARE, 0.5);
    const sum = 13 * GB;
    assert.equal(format.probableCause(memoryDiagnosis(), { memoryUsedBytes: sum / format.MEMORY_SHARE }).obvious, true);
    assert.equal(format.probableCause(memoryDiagnosis(), { memoryUsedBytes: (sum / format.MEMORY_SHARE) * 1.001 }).obvious, false);
    const cores = 7.64;
    assert.equal(format.probableCause(loadDiagnosis(), { load: cores / format.LOAD_SHARE }).obvious, true);
    assert.equal(format.probableCause(loadDiagnosis(), { load: (cores / format.LOAD_SHARE) * 1.001 }).obvious, false);
  });

  test('memory: with one process only, the one is the sum; without the RSS section or the used memory, there is no cause to state', () => {
    const one = diagnosis('swap-high', [ok('processes-by-rss', [proc(1, 'solo', 12, 10)])]);
    assert.equal(format.probableCause(one, { memoryUsedBytes: 20 * GB }).obvious, true);
    assert.equal(format.probableCause(diagnosis('swap-high', [down('processes-by-rss', 'timeout')]), { memoryUsedBytes: 20 * GB }), null);
    assert.equal(format.probableCause(memoryDiagnosis(), {}), null);
    assert.equal(format.probableCause(memoryDiagnosis(), { memoryUsedBytes: 0 }), null);
  });

  test('load: the three biggest by CPU explaining half of the load or more is obvious; below, it says the cause is not obvious and Delegar would lead', () => {
    const wsLoad = loadDiagnosis();
    const not = format.probableCause(wsLoad, { load: 24.6 });
    assert.equal(not.obvious, false);
    assert.match(text(not) as string, /^não há uma óbvia\. node \(312%\), java \(288%\) e python3 \(164%\) somam 7,6 núcleos dos 24,6 de carga/);
    assert.equal(not.note, 'A causa não é óbvia.');
    const yes = format.probableCause(wsLoad, { load: 15.28 });
    assert.equal(yes.obvious, true);
    assert.match(text(yes) as string, /somam 7,6 núcleos dos 15,3 de carga/);
    assert.equal(format.probableCause(wsLoad, {}), null);
    assert.equal(format.probableCause(diagnosis('load-high', [down('processes-by-cpu', 'unavailable')]), { load: 5 }), null);
  });

  test('load: 1,6 core is said in the singular', () => {
    const two = diagnosis('load-high', [ok('processes-by-cpu', [proc(1, 'colima', 1, 102), proc(2, 'next-server', 1, 56)])]);
    assert.match(text(format.probableCause(two, { load: 11.8 })) as string, /somam 1,6 núcleo dos 11,8 de carga/);
  });

  test('disk: when the cleanups that remake themselves bring the volume under 85%, the cause is obvious and names the new level', () => {
    const volume = { mount: '/', usedBytes: 146 * DEC_GB, totalBytes: 170 * DEC_GB };
    const sections = [ok('largest-folders', FOLDERS), ok('docker-df', DOCKER), ok('known-caches', [{ id: 'npm', path: '~/.npm', bytes: 14.3 * DEC_GB, actionId: 'npm-cache' }, CACHES[2]])];
    const c = format.probableCause(diagnosis('volume-full', sections, 'volume-full:/'), { volume });
    assert.equal(c.obvious, true);
    assert.equal(text(c), 'o / está em 86% (146 GB de 170 GB). O que se refaz sozinho soma 14,3 GB e leva o volume a cerca de 77%, abaixo dos 85%.');
    assert.equal(c.note, 'Os tamanhos são os do diagnóstico acima; a prévia lê de novo antes de rodar.');
  });

  test('disk: a level that rounds to 85% but is under it is said as 84%, never "cerca de 85%, abaixo dos 85%" (issue 566, review round 1)', () => {
    const volume = { mount: '/', usedBytes: 900 * DEC_GB, totalBytes: 1000 * DEC_GB };
    const caches = [{ id: 'npm', path: '~/.npm', bytes: 53 * DEC_GB, actionId: 'npm-cache' }];
    const c = format.probableCause(diagnosis('volume-full', [ok('known-caches', caches)], 'volume-full:/'), { volume });
    assert.equal(c.obvious, true);
    assert.match(text(c) as string, /leva o volume a cerca de 84%, abaixo dos 85%\./);
  });

  test('disk: when they do not bring it under 85%, it says how much is missing and that the caches are not enough; a Docker that did not come is said', () => {
    const volume = { mount: '/', usedBytes: 556 * DEC_GB, totalBytes: 612 * DEC_GB };
    const caches = [{ id: 'x', path: '~/Library/Developer/Xcode/DerivedData', bytes: 22.1 * DEC_GB, actionId: 'xcode-derived-data' }];
    const c = format.probableCause(diagnosis('volume-full', [down('docker-df', 'unavailable'), ok('known-caches', caches)], 'volume-full:/'), { volume });
    assert.equal(c.obvious, false);
    assert.equal(text(c), 'o / está em 91% (556 GB de 612 GB). Os caches que se refazem somam 22,1 GB. Para sair dos 85% faltam 35,8 GB: só os caches não bastam.');
    assert.equal(c.note, 'O Docker não respondeu: o que ele guarda não entrou na conta.');
  });

  test('disk: worktrees are user data and never count as a cleanup; without the caches section or the volume there is no cause', () => {
    const volume = { mount: '/', usedBytes: 90 * DEC_GB, totalBytes: 100 * DEC_GB };
    const onlyWorktrees = diagnosis('volume-full', [ok('known-caches', [CACHES[2], CACHES[3]])], 'volume-full:/');
    const c = format.probableCause(onlyWorktrees, { volume });
    assert.equal(c.obvious, false);
    assert.match(text(c) as string, /Nenhum cache que se refaz sozinho foi achado\. Para sair dos 85% faltam 5 GB/);
    assert.equal(format.probableCause(diagnosis('volume-full', [down('known-caches', 'timeout')], 'volume-full:/'), { volume }), null);
    assert.equal(format.probableCause(diskDiagnosis(), {}), null);
  });

  test('a kind with no diagnosis has no cause', () => {
    assert.equal(format.probableCause(diagnosis('port-exposed', []), { memoryUsedBytes: GB }), null);
  });
});

describe('the toggle on the alert row (566-4, 1)', () => {
  test('it is a real button with the name "Ver diagnóstico" closed and "Diagnóstico" open, aria-expanded and aria-controls following', () => {
    let clicked = 0;
    const closed = view.diagnosisToggle({ open: false, controls: 'dg-swap-high', onToggle: () => clicked++ }) as ElementoFalso;
    assert.equal(closed.tagName, 'BUTTON');
    assert.equal(closed.getAttribute('type'), 'button');
    assert.equal(closed.getAttribute('aria-expanded'), 'false');
    assert.equal(closed.getAttribute('aria-controls'), 'dg-swap-high');
    assert.equal(texto(closed), 'Ver diagnóstico');
    closed.click();
    assert.equal(clicked, 1);
    const open = view.diagnosisToggle({ open: true, controls: 'dg-swap-high', onToggle: () => {} }) as ElementoFalso;
    assert.equal(open.getAttribute('aria-expanded'), 'true');
    assert.equal(texto(open), 'Diagnóstico');
  });
});

describe('loading (566-3)', () => {
  test('says "Carregando diagnóstico" with role status and aria-busy true, and what is being read for memory, load and disk', () => {
    const memory = render('loading');
    assert.equal(memory.getAttribute('data-part'), 'diagnosis');
    assert.equal(memory.getAttribute('data-dg-state'), 'loading');
    assert.equal(memory.getAttribute('role'), 'status');
    assert.equal(memory.getAttribute('aria-busy'), 'true');
    assert.match(texto(memory), /Carregando diagnóstico/);
    assert.match(texto(memory), /lendo os processos por memória e por CPU e o swap/);
    assert.match(texto(render('loading', { alert: alertOf('load-high') })), /lendo os processos por CPU/);
    assert.match(texto(render('loading', { alert: alertOf('volume-full') })), /lendo as pastas, o Docker, os caches e o journal/);
  });

  test('the skeleton has the shape of the ready panel: two lists and the swap for memory, one list for load, four blocks for disk; it is hidden from readers', () => {
    const count = (kind: string) => render('loading', { alert: alertOf(kind) }).querySelectorAll('.tm-dg-skel').length;
    assert.equal(count('swap-high'), 3);
    assert.equal(count('memory-high'), 3);
    assert.equal(count('load-high'), 1);
    assert.equal(count('volume-full'), 4);
    for (const s of render('loading').querySelectorAll('.tm-dg-skel')) assert.equal(s.getAttribute('aria-hidden'), 'true');
  });

  test('it offers no button: nothing to retry while it reads', () => {
    assert.equal(buttons(render('loading')).length, 0);
  });
});

describe('ready, memory and swap (566-4)', () => {
  const ready = (extra: Record<string, unknown> = {}, handlers: Record<string, unknown> = {}) =>
    render('ready', { diagnosis: memoryDiagnosis(), context: { memoryUsedBytes: 30.5 * GB }, ...extra }, handlers);

  test('it is a labelled region with the alert in its name, and no aria-busy', () => {
    const p = ready();
    assert.equal(p.getAttribute('data-part'), 'diagnosis');
    assert.equal(p.getAttribute('data-dg-state'), 'ready');
    assert.equal(p.getAttribute('role'), 'region');
    assert.equal(p.getAttribute('aria-label'), 'Diagnóstico do alerta Swap quase cheio');
    assert.equal(p.getAttribute('aria-busy'), null);
  });

  test('the header says Diagnóstico, when it was read and how long ago, and has "Ler de novo" as a real button that calls onReread', () => {
    let again = 0;
    const p = ready({}, { onReread: () => again++ });
    const head = p.querySelector('.tm-dg-head') as ElementoFalso;
    assert.match(texto(head), /^Diagnóstico lido às \d\d:\d\d · há 12 s Ler de novo$/);
    const b = action(p, 'reread') as ElementoFalso;
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.getAttribute('type'), 'button');
    assert.equal(texto(b), 'Ler de novo');
    b.click();
    assert.equal(again, 1);
  });

  test('the sections come in order: processes by memory, processes by CPU, swap', () => {
    const p = ready();
    assert.deepEqual(p.querySelectorAll('[data-section]').map((s) => s.getAttribute('data-section')), ['processes-by-rss', 'processes-by-cpu', 'swap']);
    assert.match(texto(sec(p, 'processes-by-rss')), /^Processos por memória 5 de 7/);
    assert.match(texto(sec(p, 'processes-by-cpu')), /^Processos por CPU 3 de 3/);
  });

  test('each process table has headers pid, Processo, RSS and CPU, five rows, and the column that orders the list is marked', () => {
    const rss = sec(ready(), 'processes-by-rss') as ElementoFalso;
    assert.deepEqual(rss.querySelectorAll('thead th').map((h) => texto(h)), ['pid', 'Processo', 'RSS', 'CPU']);
    for (const h of rss.querySelectorAll('thead th')) assert.equal(h.getAttribute('scope'), 'col');
    assert.equal(rows(rss).length, 5);
    assert.equal(texto(rows(rss)[0]!), '4182 qemu-system-aarch64 9,8 GB 102%');
    assert.equal(texto(rows(rss)[2]!), '1204 Google Chrome Helper 2,1 GB 7,4%');
    assert.equal(rss.querySelectorAll('td.tm-dg-by').length, 5, 'the RSS cells carry the mark');
    const cpu = sec(ready(), 'processes-by-cpu') as ElementoFalso;
    assert.equal(cpu.querySelectorAll('td.tm-dg-by').map((c) => texto(c))[0], '102%');
  });

  test('"Mostrar os 7" opens the rest through onMore with the section id, and then says "Mostrar menos"; a list of 5 or fewer has no such button', () => {
    const calls: string[] = [];
    const closed = ready({}, { onMore: (id: string) => calls.push(id) });
    const more = sec(closed, 'processes-by-rss')!.querySelector('[data-dg-action="more"]') as ElementoFalso;
    assert.equal(more.tagName, 'BUTTON');
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    assert.equal(texto(more), 'Mostrar os 7');
    more.click();
    assert.deepEqual(calls, ['processes-by-rss']);
    assert.equal(sec(closed, 'processes-by-cpu')!.querySelector('[data-dg-action="more"]'), null);
    const open = ready({ expanded: new Set(['processes-by-rss']) });
    assert.equal(rows(sec(open, 'processes-by-rss')!).length, 7);
    const less = sec(open, 'processes-by-rss')!.querySelector('[data-dg-action="more"]') as ElementoFalso;
    assert.equal(texto(less), 'Mostrar menos');
    assert.equal(less.getAttribute('aria-expanded'), 'true');
  });

  test('the swap shows used and total with the percentage, and a meter named for readers that goes red at 93%', () => {
    const swap = sec(ready(), 'swap') as ElementoFalso;
    assert.match(texto(swap), /^Swap swap 19,0 de 20,4 GB · 93%$/);
    const bar = swap.querySelector('progress') as ElementoFalso;
    assert.equal(bar.getAttribute('value'), '93');
    assert.equal(bar.getAttribute('max'), '100');
    assert.ok(bar.classList.contains('tm-bar-bad'));
    assert.equal(bar.getAttribute('aria-label'), 'Swap: 19,0 de 20,4 GB · 93%');
  });

  test('the Resolver has only its header and the probable cause: no button, no group, nothing that calls an API that does not exist yet', () => {
    const p = ready();
    const rs = p.querySelector('[data-part="resolver"]') as ElementoFalso;
    assert.equal(rs.getAttribute('role'), 'group');
    assert.equal(rs.getAttribute('aria-label'), 'Resolver');
    assert.match(texto(rs.querySelector('.tm-rs-head')), /^Resolver$/);
    assert.match(texto(rs.querySelector('.tm-rs-cause')), /^Causa provável: qemu-system-aarch64 segura 9,8 GB/);
    assert.match(texto(rs), /Uma leitura dos processos acima, não uma certeza/);
    assert.equal(rs.querySelectorAll('button').length, 0);
    assert.doesNotMatch(texto(p), /Delegar|Revisar e limpar|Limpezas seguras|Propostas/);
    assert.ok(rs.querySelector('[data-slot="resolver-actions"]'), 'an empty slot waits for the next stories');
    assert.equal(rs.querySelector('[data-slot="resolver-actions"]')!.children.length, 0);
  });

  test('the cause names its processes in mono and its figures in bold, as parts of text and never as HTML', () => {
    const cause = ready().querySelector('.tm-rs-cause') as ElementoFalso;
    assert.ok(cause.querySelectorAll('.mono').some((n) => texto(n) === 'qemu-system-aarch64'));
    assert.ok(cause.querySelectorAll('b').some((n) => texto(n) === '9,8 GB'));
  });

  test('a diagnosis with no cause to state (no used memory) shows no Resolver at all', () => {
    assert.equal(ready({ context: {} }).querySelector('[data-part="resolver"]'), null);
  });

  test('text that comes from the machine goes in as text: a process called "<img onerror>" is a name, not a node', () => {
    const evil = diagnosis('swap-high', [ok('processes-by-rss', [proc(1, '<img src=x onerror=alert(1)>', 1, 1)])]);
    const p = ready({ diagnosis: evil });
    assert.match(texto(p), /<img src=x onerror=alert\(1\)>/);
    assert.equal(p.querySelectorAll('img').length, 0);
  });
});

describe('ready, load (566-5)', () => {
  test('the load alert shows one list by CPU, with the CPU column marked, and the cause not obvious when the biggest do not explain the load', () => {
    const p = render('ready', { alert: alertOf('load-high'), diagnosis: loadDiagnosis(), context: { load: 24.6 } });
    assert.deepEqual(p.querySelectorAll('[data-section]').map((s) => s.getAttribute('data-section')), ['processes-by-cpu']);
    assert.equal(rows(p.querySelector('table')!).length, 4);
    assert.ok(p.querySelector('.tm-dg-cols')!.classList.contains('tm-dg-one'));
    assert.match(texto(p.querySelector('.tm-rs-cause')), /^Causa provável: não há uma óbvia\./);
    assert.equal(p.querySelector('[data-part="resolver"]')!.getAttribute('data-obvious'), 'false');
  });
});

describe('ready, disk (566-6)', () => {
  const volume = { mount: '/', usedBytes: 146 * DEC_GB, totalBytes: 170 * DEC_GB };
  const disk = (d = diskDiagnosis(), extra: Record<string, unknown> = {}) =>
    render('ready', { alert: alertOf('volume-full', 'warning', 'O volume / passou de 85%'), diagnosis: d, context: { volume }, ...extra });

  test('four sections come in two columns in order: folders of the mount, Docker, known caches, journal', () => {
    const p = disk();
    assert.deepEqual(p.querySelectorAll('[data-section]').map((s) => s.getAttribute('data-section')), ['largest-folders', 'docker-df', 'known-caches', 'journal']);
    assert.match(texto(sec(p, 'largest-folders')), /^Maiores pastas de \/ 5 de 7/);
    assert.match(texto(sec(p, 'docker-df')), /^Docker docker system df/);
    assert.match(texto(sec(p, 'journal')), /^Journal do systemd journalctl --disk-usage/);
  });

  test('the folders table has headers, five rows and "Mostrar as 7"; Docker rows come in Portuguese with used and reclaimable', () => {
    const p = disk();
    const folders = sec(p, 'largest-folders') as ElementoFalso;
    assert.deepEqual(folders.querySelectorAll('thead th').map((h) => texto(h)), ['Pasta', 'Tamanho']);
    assert.equal(rows(folders).length, 5);
    assert.equal(texto(rows(folders)[0]!), '/home/ubuntu/.cache 31,4 GB');
    assert.equal(texto(folders.querySelector('[data-dg-action="more"]')), 'Mostrar as 7');
    const docker = sec(p, 'docker-df') as ElementoFalso;
    assert.deepEqual(docker.querySelectorAll('thead th').map((h) => texto(h)), ['Tipo', 'Em uso', 'Recuperável']);
    assert.deepEqual(rows(docker).map((r) => texto(r)), ['Imagens 25,2 GB 8,7 GB', 'Build cache 2,3 GB 9,4 GB']);
  });

  test('the known caches show the path under the name and the size, with the worktrees as one row; the journal is one row of what the journals use', () => {
    const p = disk();
    const caches = sec(p, 'known-caches') as ElementoFalso;
    assert.deepEqual(caches.querySelectorAll('thead th').map((h) => texto(h)), ['Cache', 'Tamanho']);
    assert.deepEqual(rows(caches).map((r) => texto(r)), ['npm ~/.npm 3,8 GB', 'pip ~/.cache/pip 1,1 GB', 'Worktrees antigas 2 sem uso há mais de 43 dias, em ~/Workspace 14,2 GB']);
    assert.equal(texto(rows(sec(p, 'journal')!)[0]!), 'Em uso pelos journals 4 GB');
  });

  test('a section that timed out or is unavailable keeps its place with a badge and one line, the others stay, and there is no retry per section (Q9)', () => {
    const d = diagnosis(
      'volume-full',
      [down('largest-folders', 'timeout', 'du measured no folder'), down('docker-df', 'unavailable', 'docker: command not found'), ok('known-caches', CACHES)],
      'volume-full:/',
    );
    const p = disk(d);
    assert.deepEqual(p.querySelectorAll('[data-section]').map((s) => s.getAttribute('data-section')), ['largest-folders', 'docker-df', 'known-caches']);
    const timeout = sec(p, 'largest-folders') as ElementoFalso;
    assert.equal(timeout.getAttribute('data-status'), 'timeout');
    assert.match(texto(timeout), /Tempo esgotado/);
    assert.match(texto(timeout), /A leitura passou de 10 s e foi cortada\. As outras seções chegaram\./);
    assert.equal(texto(timeout.querySelector('.tm-dg-code')), 'du measured no folder');
    assert.ok(timeout.querySelector('.b-waiting'));
    const gone = sec(p, 'docker-df') as ElementoFalso;
    assert.equal(gone.getAttribute('data-status'), 'unavailable');
    assert.match(texto(gone), /Indisponível/);
    assert.equal(texto(gone.querySelector('.tm-dg-line')), 'O Docker não respondeu.');
    assert.equal(texto(gone.querySelector('.tm-dg-code')), 'docker: command not found');
    assert.ok(gone.querySelector('.tm-dg-code')!.classList.contains('mono'));
    assert.doesNotMatch(texto(timeout.querySelector('.tm-dg-line')), /du measured/);
    assert.ok(gone.querySelector('.b-abandoned'));
    assert.equal(gone.querySelectorAll('table').length, 0);
    assert.equal(timeout.querySelectorAll('button').length, 0);
    assert.equal(gone.querySelectorAll('button').length, 0);
    assert.equal(sec(p, 'journal'), null, 'no journal on this machine: the section does not exist, not "unavailable"');
    assert.equal(texto(timeout.querySelector('[role="status"]') ?? timeout).length > 0, true);
  });

  test('with an odd number of sections the last one takes the whole width', () => {
    const d = diagnosis('volume-full', [down('largest-folders', 'timeout'), down('docker-df', 'unavailable'), ok('known-caches', CACHES)], 'volume-full:/');
    assert.ok(sec(disk(d), 'known-caches')!.classList.contains('tm-dg-wide'));
    assert.equal(sec(disk(), 'known-caches')!.classList.contains('tm-dg-wide'), false);
  });

  test('a section that came ok but only in part says so', () => {
    const d = diagnosis('volume-full', [ok('largest-folders', FOLDERS, { partial: { reason: 'one folder was not readable' } })], 'volume-full:/');
    const text = texto(sec(disk(d), 'largest-folders'));
    assert.match(text, /Só parte desta seção foi lida\./);
    assert.equal(texto(sec(disk(d), 'largest-folders')!.querySelector('.tm-dg-partial .tm-dg-code')), 'one folder was not readable');
  });

  test('a section down with no reason from the núcleo falls back to the drawn lines only (566-6)', () => {
    const d = diagnosis('volume-full', [down('largest-folders', 'timeout'), down('docker-df', 'unavailable'), ok('known-caches', CACHES)], 'volume-full:/');
    const p = disk(d);
    assert.match(texto(sec(p, 'largest-folders')), /A leitura passou de 10 s e foi cortada\. As outras seções chegaram\./);
    assert.match(texto(sec(p, 'docker-df')), /O Docker não respondeu\./);
    assert.equal(sec(p, 'docker-df')!.querySelector('.tm-dg-code'), null, 'no reason from the núcleo, no code line');
    const swapGone = diagnosis('swap-high', [down('swap', 'unavailable', 'swap not reported by /proc/meminfo')]);
    const q = render('ready', { diagnosis: swapGone });
    assert.match(texto(sec(q, 'swap')), /As outras seções chegaram\./);
    assert.doesNotMatch(texto(sec(q, 'swap')!.querySelector('.tm-dg-line')), /swap not reported/);
    assert.doesNotMatch(texto(sec(p, 'docker-df')), /não está disponível agora/);
  });

  test('the Resolver says the caches are not enough when they are not (566-6, Mac)', () => {
    const mac = diagnosis('volume-full', [down('docker-df', 'unavailable'), ok('known-caches', [{ id: 'x', path: '~/DerivedData', bytes: 22.1 * DEC_GB, actionId: 'xcode-derived-data' }])], 'volume-full:/');
    const p = disk(mac, { context: { volume: { mount: '/', usedBytes: 556 * DEC_GB, totalBytes: 612 * DEC_GB } } });
    assert.match(texto(p.querySelector('.tm-rs-cause')), /só os caches não bastam\./);
    assert.match(texto(p.querySelector('[data-part="resolver"]')), /O Docker não respondeu: o que ele guarda não entrou na conta\./);
  });
});

describe('failed (566-8)', () => {
  const failed = (failure: Record<string, unknown>, extra: Record<string, unknown> = {}, handlers: Record<string, unknown> = {}) => render('failed', { failure, ...extra }, handlers);

  test('the route failing says "Não deu para diagnosticar" with the status line and a role alert, so it is announced', () => {
    const p = failed({ status: 500, remote: false });
    assert.equal(p.getAttribute('data-dg-state'), 'failed');
    assert.equal(p.getAttribute('role'), 'alert');
    assert.equal(p.getAttribute('aria-busy'), null);
    assert.match(texto(p), /Não deu para diagnosticar/);
    assert.match(texto(p), /A rota de diagnóstico não respondeu\. O alerta continua aberto: só o diagnóstico não veio\./);
    assert.match(texto(p), /GET \/api\/diagnosis · erro 500/);
  });

  test('"Tentar de novo" is the one button, a real button that calls onRetry; there is no Delegar here', () => {
    let retried = 0;
    const p = failed({ status: 500, remote: false }, {}, { onRetry: () => retried++ });
    assert.equal(buttons(p).length, 1);
    const b = action(p, 'retry') as ElementoFalso;
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.getAttribute('type'), 'button');
    assert.equal(texto(b), 'Tentar de novo');
    b.click();
    assert.equal(retried, 1);
    assert.doesNotMatch(texto(p), /Delegar/);
  });

  test('the Workstation not answering (502) keeps the same title and the same button, and changes only the sentence', () => {
    const p = failed({ status: 502, remote: true });
    assert.match(texto(p), /Não deu para diagnosticar/);
    assert.match(texto(p), /A Workstation não respondeu ao pedido de diagnóstico\. O túnel ou o núcleo de lá pode ter caído; o alerta e os números são da última leitura\./);
    assert.match(texto(p), /GET \/api\/diagnosis · erro 502 do núcleo daqui/);
    assert.equal(texto(action(p, 'retry')), 'Tentar de novo');
  });

  test('the 20 s ceiling reads as a failure with the same retry', () => {
    const p = failed({ status: null, timedOut: true, remote: false });
    assert.match(texto(p), /Não deu para diagnosticar/);
    assert.match(texto(p), /GET \/api\/diagnosis · sem resposta/);
    assert.ok(action(p, 'retry'));
  });

  test('the failure never prints a response body: only the status and the route', () => {
    const p = failed({ status: 500, remote: false, body: 'stack trace: secret' });
    assert.doesNotMatch(texto(p), /secret|stack trace/);
  });
});

describe('the alert already closed (566-8, 404)', () => {
  test('it is calm: role status, no red, no button, and says the list updates on the next read', () => {
    const p = render('closed');
    assert.equal(p.getAttribute('data-dg-state'), 'closed');
    assert.equal(p.getAttribute('role'), 'status');
    assert.ok(p.classList.contains('tm-dg-calm'));
    assert.equal(p.classList.contains('tm-dg-fail'), false);
    assert.match(texto(p), /Este alerta já fechou/);
    assert.match(texto(p), /O alerta fechou enquanto o diagnóstico era lido\. A lista se atualiza na próxima leitura, em até 30 s\./);
    assert.equal(buttons(p).length, 0);
  });
});

describe('the old core (566-9, 501)', () => {
  test('the Workstation says its núcleo does not diagnose yet and where to update; it is calm, has no retry and no failure look', () => {
    const p = render('unsupported', { remote: true });
    assert.equal(p.getAttribute('data-dg-state'), 'unsupported');
    assert.equal(p.getAttribute('role'), 'status');
    assert.ok(p.classList.contains('tm-dg-calm'));
    assert.equal(p.classList.contains('tm-dg-fail'), false);
    assert.match(texto(p), /O núcleo da Workstation ainda não faz diagnóstico/);
    assert.match(texto(p), /O alerta continua valendo\./);
    assert.match(texto(p), /Atualize o núcleo de lá pelo aviso da linha Versão do card Conexão/);
    assert.equal(buttons(p).length, 0);
    assert.doesNotMatch(texto(p), /Tentar de novo|Não deu para diagnosticar|Delegar/);
  });

  test('a remote machine is named by its label, as the Workstation is', () => {
    assert.match(texto(render('unsupported', { remote: true, label: 'Estação' })), /O núcleo da Estação ainda não faz diagnóstico/);
  });

  test('this machine whose core cannot diagnose says so without sending the person to a Workstation', () => {
    const p = render('unsupported', { remote: false });
    assert.match(texto(p), /O núcleo desta máquina ainda não faz diagnóstico/);
    assert.match(texto(p), /O alerta continua valendo\./);
    assert.doesNotMatch(texto(p), /Workstation|de lá|O núcleo daqui/);
    assert.equal(buttons(p).length, 0);
  });
});

describe('the panel entry point', () => {
  test('every panel carries the id the toggle controls, and an unknown state draws nothing', () => {
    assert.equal(render('loading').getAttribute('id'), 'dg-swap-high');
    assert.equal(render('ready', { diagnosis: memoryDiagnosis(), context: {} }).getAttribute('id'), 'dg-swap-high');
    assert.equal(view.diagnosisPanelId('volume-full:/'), 'dg-volume-full:/');
    assert.equal(view.diagnosisPanel({ state: 'nonsense', alert: alertOf('swap-high') }, {}), null);
  });

  test('a ready panel without a diagnosis draws nothing instead of throwing', () => {
    assert.equal(view.diagnosisPanel({ state: 'ready', alert: alertOf('swap-high'), now: NOW }, {}), null);
  });

  test('a panel for a kind without diagnosis (port-exposed) is never drawn', () => {
    assert.equal(view.diagnosisPanel({ state: 'loading', alert: alertOf('port-exposed', 'warning') }, {}), null);
  });
});
