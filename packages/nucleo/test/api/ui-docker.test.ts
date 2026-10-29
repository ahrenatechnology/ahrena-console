// #288 on /ui (wireframes C81 to C85): the pure formats of docker-format.js and the Docker card mounted on the
// fake DOM against answers shaped like the núcleo's: the stacks and containers with their offered buttons, the
// dialogs built from the núcleo's plan (never a command of the screen), the digest the confirmation sends, the
// stale plan (409), the consent for the volumes, Limpar with its five kinds, a running job and its Cancel, the
// Docker that does not answer, and the Workstation with actions off (Copiar comando). No network.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
(documentoFalso as unknown as { body: ElementoFalso }).body = new ElementoFalso('body');
// @ts-expect-error: browser module, plain JavaScript
const format = await import('../../ui/screens/docker-format.js');
// @ts-expect-error: idem
const { dockerActions } = await import('../../ui/screens/docker-actions.js');
// @ts-expect-error: idem
const { ICON_NAMES } = await import('../../ui/dom.js');
// @ts-expect-error: idem
const machineFormat = await import('../../ui/screens/machine-format.js');

type Obj = Record<string, any>;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

const container = (id: string, name: string, o: Obj = {}) => ({ id, name, image: 'postgres:16', running: true, status: 'Up', stack: null, createdAt: new Date(NOW - 2 * 86_400_000).toISOString(), actions: ['container-stop', 'container-restart', 'container-remove'], ...o });
const view = (o: Obj = {}) => ({
  status: 'ok',
  version: 1,
  machine: 'local',
  available: true,
  daemon: { kind: 'rootless', offered: true },
  summary: { running: 2, stopped: 1, stacks: 1 },
  stacks: [{ name: 'tessera306', running: 2, stopped: 0, ports: [3000, 5432], actions: ['stack-stop', 'stack-remove'] }],
  containers: [container('3f9a1c20d4be', 'tessera306-api-1', { stack: 'tessera306' }), container('4d0b6a91e2c8', 'floci-aws-localstack'), container('9d41e0b3a7c2', 'floci-aws-gp-local-ecs-9d41e0', { running: false, actions: ['container-restart', 'container-remove'] })],
  leftovers: [],
  clean: [
    { kind: 'containers-24h', label: 'Limpar os containers parados há mais de 1 dia', count: 1, estimateBytes: 3_100_000_000 },
    { kind: 'images', label: 'Limpar as imagens sem nome', count: 12, estimateBytes: 2_200_000_000 },
  ],
  acceptsRemoteActions: false,
  jobs: { current: null, queue: [], recent: [] },
  ...o,
});
const plan = (o: Obj = {}) => ({ actionId: 'stack-stop', target: 'tessera306', label: 'Parar a stack tessera306', steps: [['docker', 'stop', '3f9a1c20d4be', '8c1e77aa02f9']], timeoutSeconds: 60, admin: false, runnable: true, ids: ['3f9a1c20d4be', '8c1e77aa02f9'], volumes: [], estimateBytes: null, count: null, running: 2, planDigest: '0123456789abcdef', ...o });
const job = (o: Obj = {}) => ({ id: 'abcdefabcdef', toolId: 'docker', actionId: 'stack-stop', label: 'Parar a stack tessera306', machine: 'local', state: 'running', steps: [['docker', 'stop', 'x']], step: 0, phase: 'running', startedAt: new Date(NOW).toISOString(), endedAt: null, exitCode: null, timeoutSeconds: 60, output: ['$ docker stop x'], logFile: '', ...o });

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  documentoFalso.body = new ElementoFalso('body');
});

function card(machineId: string, answers: { view: () => Obj; plan?: (route: string) => unknown; write?: (route: string, body: Obj, options: Obj) => Promise<unknown> }) {
  const reads: string[] = [];
  const writes: { route: string; body: Obj; options: Obj }[] = [];
  const changes: ((c: unknown[]) => void)[] = [];
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const ctx = {
    signal: abort.signal,
    read: async (route: string) => (reads.push(route), route.includes('/plan?') ? answers.plan?.(route) : answers.view()),
    write: async (route: string, body: Obj, options: Obj) => (writes.push({ route, body, options }), (answers.write ?? (async () => ({ job: job() })))(route, body, options)),
    onChange: (f: (c: unknown[]) => void) => changes.push(f),
  };
  const c = dockerActions(ctx, machineId);
  const node = c.node();
  const dialog = () => (documentoFalso.body as unknown as ElementoFalso).querySelector('[role="dialog"]') as ElementoFalso | null;
  return { c, node, reads, writes, change: (x: unknown[]) => changes.forEach((f) => f(x)), dialog };
}
const clickWhere = (root: ElementoFalso, selector: string) => (root.querySelector(selector) as ElementoFalso).click();

describe('#288 the pure formats (docker-format.js)', () => {
  test('the routes carry only ids; only a docker job of the Tools queue is this card\'s', () => {
    assert.equal(format.planRoute('ws-exemplo', 'container-remove', '9d41e0b3a7c2'), '/api/docker/plan?machine=ws-exemplo&action=container-remove&target=9d41e0b3a7c2');
    assert.equal(format.actionRoute('clean'), '/api/docker/actions/clean');
    const v = format.normalizeDocker({ ...view(), jobs: { current: { ...job(), toolId: 'gh' }, queue: [], recent: [job({ state: 'succeeded' })] } }).view;
    assert.equal(v.jobs.current, null);
    assert.equal(v.jobs.recent.length, 1);
  });

  test('what each dialog says, and the command is shortened but the copy has every id', () => {
    assert.match(format.whatHappens(plan({ actionId: 'stack-remove', running: 3, ids: ['a', 'b', 'c', 'd'] })), /^3 containers rodando são parados e 4 containers são removidos\. As imagens, os volumes e as redes ficam\.$/);
    assert.match(format.whatHappens(plan({ actionId: 'stack-remove-volumes', count: 3, estimateBytes: 2_500_000_000 })), /3 volumes são apagados \(2,5 GB\)/);
    const p = format.normalizePlan({ plan: plan({ steps: [['docker', 'stop', ...Array.from({ length: 14 }, (_, i) => `id${i}`)]] }) });
    assert.match(format.commandLines(p)[0], /… e mais 11$/);
    assert.equal(format.commandText(p).split(' ').length, 16);
  });

  test('the freed space comes from a prune\'s last line; filters and counts', () => {
    assert.equal(format.reclaimedFrom(['Deleted Containers:', 'abc', 'Total reclaimed space: 3.1GB']), '3,1 GB');
    assert.equal(format.reclaimedFrom(['nothing']), null);
    const cs = [container('aaaaaaaaaaaa', 'a-1', { stack: 's' }), container('bbbbbbbbbbbb', 'b-1', { running: false })];
    assert.deepEqual(format.filterCounts(cs), { all: 2, running: 1, stopped: 1, loose: 1 });
    assert.deepEqual(format.containerFilter(cs, 'stopped', '').map((c: Obj) => c.name), ['b-1']);
    assert.deepEqual(format.containerFilter(cs, 'all', 'POSTGRES').length, 2);
  });

  test('every icon the card draws exists', () => {
    for (const name of ['container', 'trash', 'play', 'square', 'rotate-cw', 'power', 'copy', 'x', 'lock', 'info', 'shield-check', 'refresh', 'check-circle-2', 'error']) assert.ok(ICON_NAMES.includes(name), name);
    assert.equal(typeof machineFormat.bytes, 'function');
  });
});

describe('#288 the Docker card', () => {
  test('a núcleo without the route hides the card; nothing is read before the first paint', async () => {
    const reads: string[] = [];
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    const c = dockerActions({ signal: abort.signal, read: async (r: string) => (reads.push(r), Promise.reject(Object.assign(new Error('x'), { status: 404 }))), write: async () => ({}), onChange: () => {} }, 'local');
    assert.deepEqual(reads, []);
    const node = c.node();
    await until(() => reads.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(node.hasAttribute('hidden'));
    assert.equal(c.available(), false);
  });

  test('stacks and containers with the buttons the núcleo offers on each', async () => {
    const t = card('local', { view: () => view() });
    await until(() => !t.node.hasAttribute('hidden'));
    assert.deepEqual(t.node.querySelectorAll('[data-stack] button').map((b: ElementoFalso) => texto(b)), ['Parar', 'Remover…']);
    const loose = t.node.querySelector('[data-container="9d41e0b3a7c2"]') as ElementoFalso;
    assert.deepEqual(loose.querySelectorAll('button').map((b: ElementoFalso) => texto(b)), ['Reiniciar', 'Remover…'], 'a stopped container has no Parar');
    assert.match(texto(t.node), /2 rodando · 1 parados · 1 stack/);
    assert.equal(t.c.available(), true);
    assert.deepEqual(t.node.querySelectorAll('[data-dk-filter]').map((b: ElementoFalso) => texto(b)), ['Todos 3', 'Rodando 2', 'Parados 1', 'Sem stack 2']);
  });

  test('a click asks for the plan and the dialog shows the núcleo\'s command; Confirmar sends the ids and the digest', async () => {
    const t = card('local', { view: () => view(), plan: () => ({ plan: plan() }) });
    await until(() => !t.node.hasAttribute('hidden'));
    clickWhere(t.node, '[data-stack="tessera306"] [data-dk-action="stack-stop"]');
    await until(() => t.dialog() !== null);
    assert.equal(t.reads.at(-1), '/api/docker/plan?machine=local&action=stack-stop&target=tessera306');
    const text = texto(t.dialog());
    assert.match(text, /Parar a stack tessera306/);
    assert.match(text, /Esta máquina · como o seu usuário/);
    assert.match(text, /docker stop 3f9a1c20d4be 8c1e77aa02f9/);
    assert.match(text, /14 containers|2 containers rodando são parados/);
    clickWhere(t.dialog()!, '[data-dk-confirm]');
    await until(() => t.writes.length === 1);
    assert.deepEqual(t.writes[0], { route: '/api/docker/actions/stack-stop', body: { machine: 'local', target: 'tessera306', planDigest: '0123456789abcdef' }, options: undefined });
    await until(() => t.dialog() === null);
  });

  test('a stale plan (409) shows the new plan in the same dialog and nothing was run', async () => {
    const fresh = plan({ planDigest: 'fedcba9876543210', steps: [['docker', 'stop', '3f9a1c20d4be']], ids: ['3f9a1c20d4be'], running: 1 });
    const t = card('local', { view: () => view(), plan: () => ({ plan: plan() }), write: async () => Promise.reject(Object.assign(new Error('o plano mudou'), { status: 409, body: { plan: fresh } })) });
    await until(() => !t.node.hasAttribute('hidden'));
    clickWhere(t.node, '[data-dk-action="stack-stop"]');
    await until(() => t.dialog() !== null);
    clickWhere(t.dialog()!, '[data-dk-confirm]');
    await until(() => /O plano mudou desde que você abriu/.test(texto(t.dialog())));
    assert.match(texto(t.dialog()), /docker stop 3f9a1c20d4be(?! 8c)/);
    clickWhere(t.dialog()!, '[data-dk-confirm]');
    await until(() => t.writes.length === 2);
    assert.equal(t.writes[1]!.body.planDigest, 'fedcba9876543210');
  });

  test('the volumes of a removed stack: the consent comes first, and the volume still in use stays', async () => {
    const volumes = plan({ actionId: 'stack-remove-volumes', target: 'old', label: 'Remover os volumes da stack old', steps: [['docker', 'volume', 'rm', 'old_data']], volumes: [{ name: 'old_data', sizeBytes: 5_000_000, keptBy: null }, { name: 'old_cache', sizeBytes: 7_000_000, keptBy: 'cache-user' }], count: 1, estimateBytes: 5_000_000, running: 0, ids: [] });
    const t = card('local', { view: () => view({ leftovers: [{ name: 'old', volumes: 2, actions: ['stack-remove-volumes'] }] }), plan: () => ({ plan: volumes }) });
    await until(() => !t.node.hasAttribute('hidden'));
    clickWhere(t.node, '[data-leftover="old"] button');
    await until(() => t.dialog() !== null);
    const text = texto(t.dialog());
    assert.match(text, /old_data 5 MB só a stack removida/);
    assert.match(text, /old_cache 7 MB fica: usado por cache-user/);
    assert.match(text, /docker volume rm old_data/);
    const go = t.dialog()!.querySelector('[data-dk-confirm]') as ElementoFalso;
    assert.ok(go.hasAttribute('disabled'), 'disabled until the consent');
    const box = t.dialog()!.querySelector('[data-dk-consent]') as ElementoFalso;
    (box as unknown as { checked: boolean }).checked = true;
    box.dispatchEvent({ type: 'change', target: box });
    await until(() => !(t.dialog()!.querySelector('[data-dk-confirm]') as ElementoFalso).hasAttribute('disabled'));
  });

  test('Limpar: the five kinds are explained, the first is marked, and a single one runs its own plan', async () => {
    const images = plan({ actionId: 'clean', target: 'images', label: 'Limpar as imagens sem nome', steps: [['docker', 'image', 'prune', '--force']], ids: [], estimateBytes: 2_200_000_000, count: 12, running: 0, planDigest: 'aaaaaaaaaaaaaaaa' });
    const t = card('local', { view: () => view(), plan: () => ({ plan: images }) });
    await until(() => !t.node.hasAttribute('hidden'));
    clickWhere(t.node, '[data-dk-action="clean"]');
    await until(() => t.dialog() !== null);
    const text = texto(t.dialog());
    assert.match(text, /até 3,1 GB/);
    assert.match(text, /docker container prune --force --filter until=24h/);
    assert.match(text, /Não está aqui: docker system prune, --all e volume prune/);
    assert.match(text, /1 selecionado · roda um comando/);
    // switch to the images only
    const images2 = t.dialog()!.querySelector('[data-dk-clean="images"] input') as ElementoFalso;
    (images2 as unknown as { checked: boolean }).checked = true;
    images2.dispatchEvent({ type: 'change', target: images2 });
    const first = t.dialog()!.querySelector('[data-dk-clean="containers-24h"] input') as ElementoFalso;
    (first as unknown as { checked: boolean }).checked = false;
    first.dispatchEvent({ type: 'change', target: first });
    clickWhere(t.dialog()!, '[data-dk-clean-go]');
    await until(() => /Limpar as imagens sem nome/.test(texto(t.dialog())) && t.dialog()!.querySelector('[data-dk-confirm]') !== null);
    clickWhere(t.dialog()!, '[data-dk-confirm]');
    await until(() => t.writes.length === 1);
    assert.deepEqual(t.writes[0]!.body, { machine: 'local', target: 'images', planDigest: 'aaaaaaaaaaaaaaaa' });
  });

  test('a running job: the band with the step and the tail, Cancelar deletes it; the next one shows what was freed', async () => {
    let current = view({ jobs: { current: job({ steps: [['docker', 'stop', 'x'], ['docker', 'rm', 'x']], step: 1, output: ['$ docker rm x', 'x'] }), queue: [], recent: [] } });
    const t = card('local', { view: () => current, write: async () => ({ job: job({ state: 'canceled' }) }) });
    await until(() => t.node.querySelector('[data-part="docker-job"]') !== null);
    assert.match(texto(t.node.querySelector('[data-part="docker-job"]')), /Parar a stack tessera306\. Passo 2 de 2/);
    assert.match(texto(t.node.querySelector('[data-part="docker-job"]')), /\$ docker rm x/);
    clickWhere(t.node, '[data-dk-cancel]');
    await until(() => t.writes.length === 1);
    assert.deepEqual(t.writes[0], { route: '/api/docker/jobs/abcdefabcdef', body: { machine: 'local' }, options: { method: 'DELETE' } });
    current = view({ jobs: { current: null, queue: [], recent: [job({ state: 'succeeded', actionId: 'clean', label: 'Limpar as imagens sem nome', steps: [['docker', 'image', 'prune', '--force']], exitCode: 0, output: ['Total reclaimed space: 2.2GB'] })] } });
    t.change([{ type: 'tools', key: 'local' }]);
    await until(() => /Liberou 2,2 GB/.test(texto(t.node)));
  });

  test('the Docker does not answer: only Reiniciar o Docker is offered, with the plan from the núcleo', async () => {
    const t = card('local', { view: () => view({ available: false, stacks: [], containers: [], clean: [], summary: { running: 0, stopped: 0, stacks: 0 } }), plan: () => ({ plan: plan({ actionId: 'daemon-restart', target: 'rootless', label: 'Reiniciar o Docker', steps: [['systemctl', '--user', 'restart', 'docker']], ids: [], running: 0 }) }) });
    await until(() => !t.node.hasAttribute('hidden'));
    assert.match(texto(t.node), /O Docker não respondeu/);
    assert.equal(t.c.available(), false, 'machine.js keeps its read-only stacks card');
    clickWhere(t.node, '[data-part="docker-down"] [data-dk-action="daemon-restart"]');
    await until(() => t.dialog() !== null);
    assert.match(texto(t.dialog()), /systemctl --user restart docker/);
  });

  test('the Docker of the system: the dialog has Copiar comando and no Confirmar', async () => {
    const sys = plan({ actionId: 'daemon-restart', target: 'system', label: 'Reiniciar o Docker', steps: [['sudo', 'systemctl', 'restart', 'docker']], admin: true, runnable: false, ids: [], running: 0 });
    const t = card('local', { view: () => view({ daemon: { kind: 'system', offered: true } }), plan: () => ({ plan: sys }) });
    await until(() => !t.node.hasAttribute('hidden'));
    clickWhere(t.node, '[data-dk-action="daemon-restart"]');
    await until(() => t.dialog() !== null);
    assert.equal(t.dialog()!.querySelector('[data-dk-confirm]'), null);
    assert.match(texto(t.dialog()), /sudo systemctl restart docker/);
    assert.match(texto(t.dialog()), /o console não roda sudo/);
    assert.match(texto(t.dialog()), /Copiar comando/);
  });

  test('the Workstation with actions off (the default): a band says why, the buttons copy, and Confirmar never appears', async () => {
    const t = card('ws-exemplo', { view: () => view({ machine: 'ws-exemplo', acceptsRemoteActions: false }), plan: () => ({ plan: plan() }) });
    await until(() => !t.node.hasAttribute('hidden'));
    assert.match(texto(t.node), /As ações na Workstation estão desligadas/);
    clickWhere(t.node, '[data-stack] [data-dk-action="stack-stop"]');
    await until(() => t.dialog() !== null);
    assert.equal(t.dialog()!.querySelector('[data-dk-confirm]'), null);
    assert.match(texto(t.dialog()), /Workstation · como o usuário de lá/);
    assert.equal(t.reads.at(-1), '/api/docker/plan?machine=ws-exemplo&action=stack-stop&target=tessera306');
  });

  test('a refusal over there (403 remote-actions-disabled) turns the dialog into the copy mode', async () => {
    const t = card('ws-exemplo', { view: () => view({ machine: 'ws-exemplo', acceptsRemoteActions: true }), plan: () => ({ plan: plan() }), write: async () => Promise.reject(Object.assign(new Error('x'), { status: 403, body: { reason: 'remote-actions-disabled', error: 'x' } })) });
    await until(() => !t.node.hasAttribute('hidden'));
    clickWhere(t.node, '[data-stack] [data-dk-action="stack-stop"]');
    await until(() => t.dialog() !== null);
    clickWhere(t.dialog()!, '[data-dk-confirm]');
    await until(() => /não aceita ações pelo túnel/.test(texto(t.dialog())));
  });
});
