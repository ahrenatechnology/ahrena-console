// Ferramentas on /ui (issue 280, decision 0014, wireframes C72 to C76): the pure parts of
// tools-format.js and the screen mounted on the fake DOM with the demo fixtures (src/simulator/tools.ts),
// one per state of the wireframes. No network, no process: the reads come from the fixtures and the
// writes are recorded (route, method, body) and answered here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { toolsFixture, type ToolsDemoScenario } from '../../src/simulator/tools.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
const here = { pathname: '/ui/tools', search: '', port: '4720' };
const replaced: string[] = [];
Object.assign(globalThis, { location: here, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) } });

// @ts-expect-error: browser module, plain JavaScript
import { WriteError } from '../../ui/api.js';
// @ts-expect-error: idem
import * as format from '../../ui/screens/tools-format.js';
// @ts-expect-error: idem
import { ICON_NAMES } from '../../ui/dom.js';
const screen = await import(
  // @ts-expect-error: idem
  '../../ui/screens/tools.js'
);

const NOW = Date.now();
type Body = Record<string, any>;
const fixture = (scenario: ToolsDemoScenario, machine = 'local'): Body => JSON.parse(JSON.stringify(toolsFixture(scenario, machine, NOW)));
const MACHINES = [
  { id: 'local', label: 'Esta máquina', state: 'connected' },
  { id: 'workstation', label: 'Workstation', state: 'connected' },
];

interface Write {
  route: string;
  method: string;
  body: any;
}
type Answer = (w: Write) => Promise<unknown>;

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  writes: Write[];
  bodies: Map<string, Body>;
  leave: () => void;
  ready: Promise<unknown>;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

const accepted: Answer = async (w) => ({ job: { id: 'job-1', toolId: w.route.split('/')[3], state: 'queued' } });

function mount(bodies: Record<string, Body>, { answer = accepted, search = '', machines = MACHINES }: { answer?: Answer; search?: string; machines?: unknown[] } = {}): Mounted {
  here.search = search;
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const writes: Write[] = [];
  const map = new Map(Object.entries(bodies));
  const signal = new AbortController();
  let cleanup: (() => void) | null = null;
  const ctx = {
    params: {},
    signal: signal.signal,
    read: async (route: string) => {
      reads.push(route);
      if (route === '/api/machines') return machines;
      const url = new URL(route, 'http://127.0.0.1');
      const body = map.get(url.searchParams.get('machine') ?? 'local');
      if (url.pathname !== '/api/tools' || !body) throw new Error(`unexpected route ${route}`);
      return JSON.parse(JSON.stringify(body));
    },
    write: (route: string, body: unknown, options?: { method?: string }) => {
      const w = { route, method: options?.method ?? 'POST', body };
      writes.push(w);
      return answer(w);
    },
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const ready = screen.mount(area, ctx).then((f: () => void) => (cleanup = f));
  const m: Mounted = { area, reads, writes, bodies: map, ready, leave: () => (signal.abort(), cleanup?.()) };
  open.push(m);
  return m;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const buttonByText = (node: ElementoFalso, text: string) => node.querySelectorAll('button').find((b) => texto(b) === text) ?? null;
const row = (area: ElementoFalso, id: string) => area.querySelector(`[data-tool="${id}"]`)!;
const dialog = (area: ElementoFalso) => area.querySelector('.tl-dialog');
const band = (area: ElementoFalso, kind: string) => area.querySelector(`[data-band="${kind}"]`);

// ---------- the pure parts ----------

describe('issue 280 tools-format: reading GET /api/tools and what the screen shows', () => {
  test('routes, the machine of the URL and the argv line', () => {
    assert.equal(format.toolsRoute('local'), '/api/tools?machine=local');
    assert.equal(format.actionRoute('gh', 'update'), '/api/tools/gh/actions/update');
    assert.equal(format.actionRoute('container-colima', 'stop'), '/api/tools/container-colima/actions/stop');
    assert.throws(() => format.actionRoute('../x', 'update'));
    assert.throws(() => format.actionRoute('gh', 'rm'));
    assert.equal(format.jobRoute('job-7'), '/api/tools/jobs/job-7');
    assert.throws(() => format.jobRoute('a/b'));
    assert.equal(format.machineFromSearch('?machine=workstation'), 'workstation');
    assert.equal(format.machineFromSearch('?machine=../x'), 'local');
    assert.equal(format.screenUrl('local'), '/ui/tools');
    assert.equal(format.screenUrl('workstation'), '/ui/tools?machine=workstation');
    assert.equal(format.argvLine(['npm', 'install', '-g', 'wrangler@4.47.2']), 'npm install -g wrangler@4.47.2');
  });

  test('normalizeOverview keeps the contract fields and nothing else; MCP env and header values have no field to land in', () => {
    assert.equal(format.normalizeOverview(null), null);
    assert.equal(format.normalizeOverview({ items: [] }), null);
    const body = fixture('default');
    body.mcp.servers[4].env = { PGPASSWORD: 'segredo-de-mentira' };
    body.mcp.servers[1].headers = { Authorization: 'Bearer segredo-de-mentira' };
    const o = format.normalizeOverview(body);
    assert.equal(o.items.length, 16);
    assert.ok(!JSON.stringify(o).includes('segredo-de-mentira'));
    assert.deepEqual(o.mcp.servers[4].envNames, ['PGHOST', 'PGUSER', 'PGPASSWORD']);
    // An action marked admin is never runnable, whatever the body says.
    const aws = o.items.find((i: Body) => i.id === 'aws');
    assert.deepEqual([aws.actions[0].admin, aws.actions[0].runnable, aws.actions[0].blockedReason], [true, false, 'admin']);
    const forged = format.normalizeAction({ id: 'update', runnable: true, admin: true, steps: [['sudo', 'x']] });
    assert.equal(forged.runnable, false);
    assert.equal(format.normalizeAction({ id: 'rm', steps: [] }), null);
  });

  test('C72: six stats, "Atualizar 5" in screen order (CLIs and runtimes, without sudo, not MCP)', () => {
    const o = format.normalizeOverview(fixture('default'));
    const stats = format.statCards(o).map((c: Body) => [c.id, c.value, c.sub]);
    assert.deepEqual(stats, [
      ['cli', '11', '6 em dia · 1 instalada à mão'],
      ['outdated', '5', '3 CLIs · 2 plataformas · todas sem sudo'],
      ['missing', '1', 'gcloud · o catálogo instala'],
      ['mcp', '5', '1 falhou · 1 precisa de login'],
      ['runtime', '5', 'Node.js, TypeScript, Python, Rust, Go'],
      ['containers', 'Colima', 'rodando · 3 containers no ar'],
    ]);
    assert.deepEqual(format.updatable(o).map((x: Body) => x.item.id), ['claude', 'gh', 'wrangler', 'node', 'python']);
    const bulk = format.bulkConfirmView(o, format.updatable(o));
    assert.equal(bulk.title, 'Atualizar 5 itens');
    assert.deepEqual(bulk.steps, ['claude update', 'brew upgrade gh', 'npm install -g wrangler@4.47.2', 'fnm install 24.11.0 e depois fnm default 24.11.0', 'uv python install 3.14.0']);
    assert.match(bulk.note, /aws/);
    assert.equal(format.machineBand(o, NOW), null);
  });

  test('C74 1: everything in order gives three stats and "Tudo em dia"', () => {
    const o = format.normalizeOverview(fixture('all-ok'));
    assert.equal(format.statCards(o).length, 3);
    const b = format.machineBand(o, NOW);
    assert.equal(b.kind, 'all-ok');
    assert.match(b.text, /^11 CLIs, 5 servidores MCP, 5 plataformas e o Colima, verificados às \d\d:\d\d\. A próxima verificação é às \d\d:\d\d/);
    assert.deepEqual(format.updatable(o), []);
  });

  test('the confirm says what runs, exactly, where and as whom; the remote one names the remote', () => {
    const o = format.normalizeOverview(fixture('default'));
    const gh = o.items.find((i: Body) => i.id === 'gh');
    const v = format.confirmView(o, gh, gh.actions[0]);
    assert.equal(v.title, 'Atualizar GitHub CLI');
    assert.deepEqual(v.steps, ['brew upgrade gh']);
    assert.deepEqual(v.rows, [
      ['Onde', 'Esta máquina · como o seu usuário'],
      ['De onde', 'Homebrew · 2.81.0 → 2.83.1'],
      ['Tempo limite', '10 min · Cancelar a qualquer momento'],
    ]);
    const r = format.normalizeOverview(fixture('remote-actions', 'workstation'));
    const rust = r.items.find((i: Body) => i.id === 'rust');
    const rv = format.confirmView(r, rust, rust.actions[0]);
    assert.equal(rv.title, 'Atualizar Rust na Workstation');
    assert.equal(rv.rows[0][1], 'Na Workstation · pelo núcleo de lá · como o seu usuário de lá');
    assert.equal(rv.rows[2][1], '15 min · Cancelar a qualquer momento');
    assert.match(rv.note, /Este Mac só manda o id do item e da ação/);
  });

  test('row actions: run, sudo, copy on a read-only remote, off without network, queued and busy with a job', () => {
    const kind = (o: Body, id: string) => format.rowAction(o, o.items.find((i: Body) => i.id === id), NOW).kind;
    const o = format.normalizeOverview(fixture('default'));
    assert.deepEqual(['claude', 'git', 'aws', 'gcloud'].map((id) => kind(o, id)), ['run', 'none', 'sudo', 'run']);
    const ws = format.normalizeOverview(fixture('default', 'workstation'));
    assert.deepEqual(['gh', 'wrangler', 'rust', 'go', 'colima'].map((id) => kind(ws, id)), ['sudo', 'copy', 'copy', 'sudo', 'none']);
    const off = format.normalizeOverview(fixture('offline'));
    assert.equal(kind(off, 'gh'), 'off');
    const busy = fixture('default');
    busy.jobs = { current: job({ toolId: 'gh', state: 'running' }), queue: [job({ id: 'job-2', toolId: 'wrangler', label: 'Cloudflare Wrangler' })], recent: [] };
    const b = format.normalizeOverview(busy);
    assert.deepEqual([kind(b, 'gh'), kind(b, 'wrangler')], ['busy', 'queued']);
    assert.deepEqual(format.updatable(b).map((x: Body) => x.item.id), ['claude', 'node', 'python']);
  });

  test('the job band: done, failed with the last lines and the log, canceled', () => {
    const o = (j: Body) => format.normalizeOverview({ ...fixture('default'), jobs: { current: null, queue: [], recent: [j] } });
    const started = new Date(NOW - 90_000).toISOString();
    const done = format.jobBand(o(job({ state: 'succeeded', exitCode: 0, startedAt: started, endedAt: new Date(NOW - 66_000).toISOString() })), NOW);
    assert.equal(done.title, 'GitHub CLI na 2.83.1.');
    assert.equal(done.text, 'brew upgrade gh saiu com o código 0 em 24 s, e o núcleo conferiu a versão.');
    const failed = format.jobBand(o(job({ state: 'failed', exitCode: 1, startedAt: started, endedAt: new Date(NOW - 28_000).toISOString(), output: ['a', 'b', 'Error: not writable'] })), NOW);
    assert.equal(failed.title, 'Não atualizou GitHub CLI.');
    assert.equal(failed.text, 'brew upgrade gh saiu com o código 1 depois de 1 min 2 s. O gh continua na 2.81.0.');
    assert.deepEqual(failed.lines, ['a', 'b', 'Error: not writable']);
    assert.match(failed.log, /tools\.log/);
    const timed = format.jobBand(o(job({ state: 'timed-out', startedAt: started, endedAt: new Date(NOW - 1000).toISOString() })), NOW);
    assert.match(timed.text, /passou do tempo limite de 10 min/);
    assert.equal(format.jobBand(o(job({ state: 'succeeded', endedAt: new Date(NOW - format.BAND_MS - 1).toISOString() })), NOW), null);
    assert.equal(format.jobBand(o(job({ state: 'canceled', endedAt: new Date(NOW).toISOString() })), NOW).kind, 'canceled');
  });

  test('MCP lines: names and counts, never values; the source and the scope', () => {
    const o = format.normalizeOverview(fixture('default'));
    const [own, github, playwright, docs, pg] = o.mcp.servers;
    assert.equal(format.mcpNote(github), 'cabeçalho Authorization · valor oculto');
    assert.equal(format.mcpNote(pg), '3 variáveis de ambiente · valores ocultos');
    assert.equal(format.mcpNote(playwright), 'sem variáveis de ambiente');
    assert.equal(format.mcpSource(playwright), 'npm @playwright/mcp 0.0.41');
    assert.equal(format.mcpScope(pg), 'projeto · catalogo-exemplo');
    assert.deepEqual([own, playwright, docs, pg].map((s: Body) => format.mcpAction(o, s, NOW).kind), ['none', 'run', 'login', 'config']);
    assert.deepEqual(format.mcpBadge(playwright), ['b-waiting', 'Desatualizada']);
  });

  test('every icon the screen uses exists in dom.js', () => {
    const js = readFileSync(new URL('../../ui/screens/tools.js', import.meta.url), 'utf8');
    const used = new Set([...js.matchAll(/icon\('([\w-]+)'\)/g), ...js.matchAll(/button\([^,]+, '([\w-]+)'/g)].map((m) => m[1]!));
    for (const extra of ['wrench', 'arrow-up-circle', 'package-x', 'square', 'an-download', 'resume', 'ok', 'offline', 'eye', 'server', 'monitor']) used.add(extra);
    for (const name of used) assert.ok(ICON_NAMES.includes(name), `missing icon ${name}`);
  });
});

function job(over: Body = {}): Body {
  return {
    id: 'job-1',
    toolId: 'gh',
    actionId: 'update',
    label: 'GitHub CLI',
    machine: 'local',
    state: 'queued',
    steps: [['brew', 'upgrade', 'gh']],
    step: 0,
    phase: 'running',
    startedAt: new Date(NOW - 18_000).toISOString(),
    endedAt: null,
    exitCode: null,
    timeoutSeconds: 600,
    targetVersion: '2.83.1',
    output: ['==> Upgrading 1 outdated package:', 'gh 2.81.0 -> 2.83.1'],
    logFile: '/Users/exemplo/.ahrena-console/tools.log',
    ...over,
  };
}

// ---------- the screen ----------

describe('issue 280 the Ferramentas screen on the fake DOM', () => {
  test('C72: header with the machine selector, Verificar agora and Atualizar 5; the four cards; the stylesheet', async () => {
    const m = mount({ local: fixture('default') });
    await m.ready;
    const head = texto(m.area.querySelector('.cc-head'));
    assert.match(head, /Ferramentas/);
    assert.match(head, /Esta máquina Workstation Verificar agora Atualizar 5/);
    assert.match(head, /macOS 26 · arm64 · verificado às/);
    assert.deepEqual(m.area.querySelectorAll('.tl-card .tl-title').map((t) => texto(t).split(' ')[0]), ['CLIs', 'Plataformas', 'Containers', 'Como', 'Servidores']);
    assert.equal(texto(row(m.area, 'gh').querySelector('.badge')), 'Desatualizada');
    assert.equal(texto(row(m.area, 'aws').querySelector('button')), 'Precisa de sudo');
    assert.equal(texto(row(m.area, 'gcloud').querySelector('button')), 'Instalar');
    assert.ok(document.head.querySelector('link[data-screen="tools"]'));
    assert.deepEqual(m.reads.sort(), ['/api/machines', '/api/tools?machine=local']);
    m.leave();
    assert.equal(document.head.querySelector('link[data-screen="tools"]'), null);
  });

  test('without a remote in /api/machines, no machine selector', async () => {
    const m = mount({ local: fixture('default') }, { machines: [MACHINES[0]] });
    await m.ready;
    assert.equal(m.area.querySelector('.tl-seg[aria-label="Máquina"]'), null);
  });

  test('the CLI filter: Pedem ação shows only what asks for something', async () => {
    const m = mount({ local: fixture('default') });
    await m.ready;
    buttonByText(m.area, 'Pedem ação 5')!.click();
    const ids = m.area.querySelectorAll('.tl-cols-cli [data-tool]').map((r) => r.getAttribute('data-tool'));
    assert.deepEqual(ids, ['claude', 'gh', 'aws', 'wrangler', 'gcloud']);
  });

  test('C73 1: Atualizar opens the confirm with the exact command; Confirmar POSTs the ids and the digest, nothing else', async () => {
    const body = fixture('default');
    const m = mount({ local: body });
    await m.ready;
    row(m.area, 'gh').querySelector('button')!.click();
    const d = dialog(m.area)!;
    assert.match(texto(d), /Atualizar GitHub CLI/);
    assert.match(texto(d), /Vai rodar, exatamente brew upgrade gh/);
    assert.match(texto(d), /Nada digitado na tela vira comando/);
    assert.equal(m.writes.length, 0, 'opening the dialog writes nothing');
    buttonByText(d, 'Confirmar e rodar')!.click();
    await until(() => m.writes.length === 1);
    const digest = body.items.find((i: Body) => i.id === 'gh').actions[0].planDigest;
    assert.deepEqual(m.writes[0], { route: '/api/tools/gh/actions/update', method: 'POST', body: { planDigest: digest, machine: 'local' } });
    await until(() => !dialog(m.area));
  });

  test('Cancelar in the confirm closes it and writes nothing', async () => {
    const m = mount({ local: fixture('default') });
    await m.ready;
    row(m.area, 'claude').querySelector('button')!.click();
    buttonByText(dialog(m.area)!, 'Cancelar')!.click();
    assert.equal(dialog(m.area), null);
    assert.equal(m.writes.length, 0);
  });

  test('C73: on 409 the dialog shows the new plan from the answer and asks again; the second POST carries the new digest', async () => {
    const plan = { steps: [['npm', 'install', '-g', 'wrangler@4.47.3']], sourceId: 'npm', targetVersion: '4.47.3', timeoutSeconds: 600, admin: false, planDigest: 'feedfacecafe0001' };
    const answer: Answer = async (w) => {
      if (w.body.planDigest !== plan.planDigest) throw new WriteError('o plano mudou', { status: 409, route: w.route, body: { error: 'o plano mudou', plan } });
      return { job: { id: 'job-9' } };
    };
    const m = mount({ local: fixture('default') }, { answer });
    await m.ready;
    row(m.area, 'wrangler').querySelector('button')!.click();
    buttonByText(dialog(m.area)!, 'Confirmar e rodar')!.click();
    await until(() => !!dialog(m.area) && /O plano mudou/.test(texto(dialog(m.area))));
    assert.match(texto(dialog(m.area)), /npm install -g wrangler@4\.47\.3/);
    assert.match(texto(dialog(m.area)), /4\.45\.0 → 4\.47\.3/);
    assert.equal(m.writes.length, 1);
    buttonByText(dialog(m.area)!, 'Confirmar e rodar')!.click();
    await until(() => m.writes.length === 2);
    assert.deepEqual(m.writes[1], { route: '/api/tools/wrangler/actions/update', method: 'POST', body: { planDigest: 'feedfacecafe0001', machine: 'local' } });
  });

  test('C73 1b: Atualizar 5 lists every command once, then POSTs one per item, in order', async () => {
    const m = mount({ local: fixture('default') });
    await m.ready;
    buttonByText(m.area, 'Atualizar 5')!.click();
    const d = dialog(m.area)!;
    assert.match(texto(d), /Atualizar 5 itens/);
    for (const cmd of ['claude update', 'brew upgrade gh', 'npm install -g wrangler@4.47.2', 'fnm install 24.11.0 e depois fnm default 24.11.0', 'uv python install 3.14.0']) assert.ok(texto(d).includes(cmd), cmd);
    buttonByText(d, 'Confirmar os 5')!.click();
    await until(() => m.writes.length === 5);
    assert.deepEqual(m.writes.map((w) => w.route), ['claude', 'gh', 'wrangler', 'node', 'python'].map((id) => `/api/tools/${id}/actions/update`));
    assert.ok(m.writes.every((w) => w.body.machine === 'local' && /^[0-9a-f]{16}$/.test(w.body.planDigest)));
  });

  test('C73 2: the running job shows on its row with the output, the steps and the queue; Cancelar DELETEs the job', async () => {
    const body = fixture('default');
    body.jobs = { current: job({ state: 'running' }), queue: [job({ id: 'job-2', toolId: 'wrangler', label: 'Cloudflare Wrangler' })], recent: [] };
    const m = mount({ local: body }, { answer: async () => ({ job: { id: 'job-1', state: 'canceled' } }) });
    await m.ready;
    assert.equal(texto(row(m.area, 'gh').querySelector('button')), 'Atualizando…');
    assert.equal(texto(row(m.area, 'wrangler').querySelector('button')), 'Na fila');
    const box = m.area.querySelector('[data-job="job-1"]')!;
    assert.match(texto(box), /brew upgrade gh conferindo a versão/);
    assert.match(texto(box), /gh 2\.81\.0 -> 2\.83\.1/);
    assert.match(texto(box), /0:1\d de 10:00/);
    assert.match(texto(box), /Na fila: Cloudflare Wrangler/);
    assert.match(texto(m.area.querySelector('.cc-head')), /Atualizando · 2 na fila/);
    box.querySelector('[data-action="cancel"]')!.click();
    await until(() => m.writes.length === 1);
    assert.deepEqual(m.writes[0], { route: '/api/tools/jobs/job-1', method: 'DELETE', body: undefined });
  });

  test('C73 3 and 4: done band; failed band with the exit code, the last lines, the log, Copiar a saída and Tentar de novo', async () => {
    const done = fixture('default');
    done.jobs.recent = [job({ toolId: 'claude', label: 'Claude Code', steps: [['claude', 'update']], targetVersion: '2.1.312', state: 'succeeded', exitCode: 0, endedAt: new Date(NOW - 5000).toISOString() })];
    const a = mount({ local: done });
    await a.ready;
    assert.match(texto(band(a.area, 'job-done')), /Claude Code na 2\.1\.312\. claude update saiu com o código 0 em 13 s/);
    a.leave();

    const failed = fixture('default');
    failed.jobs.recent = [job({ state: 'failed', exitCode: 1, startedAt: new Date(NOW - 70_000).toISOString(), endedAt: new Date(NOW - 8000).toISOString(), output: ['Error: The following directories are not writable by your user:', '/opt/homebrew/share/zsh/site-functions'] })];
    const m = mount({ local: failed });
    await m.ready;
    const b = band(m.area, 'job-failed')!;
    assert.match(texto(b), /Não atualizou GitHub CLI\. brew upgrade gh saiu com o código 1 depois de 1 min 2 s\. O gh continua na 2\.81\.0\./);
    assert.match(texto(b), /not writable by your user/);
    assert.match(texto(b), /\/Users\/exemplo\/\.ahrena-console\/tools\.log/);
    assert.ok(buttonByText(b, 'Copiar a saída'));
    assert.equal(texto(row(m.area, 'gh').querySelector('.badge')), 'Falhou');
    b.querySelector('[data-action="retry"]')!.click();
    assert.match(texto(dialog(m.area)), /Vai rodar, exatamente brew upgrade gh/);
  });

  test('C74 5: Precisa de sudo opens the row with the command to copy; "Rodei, verificar de novo" POSTs the check', async () => {
    const m = mount({ local: fixture('default') });
    await m.ready;
    row(m.area, 'aws').querySelector('button')!.click();
    const box = m.area.querySelector('[data-sudo="aws"]')!;
    assert.match(texto(box), /O console não roda este\./);
    assert.match(texto(box), /sudo installer -pkg AWSCLIV2\.pkg -target \//);
    assert.ok(buttonByText(box, 'Copiar'));
    box.querySelector('[data-action="recheck"]')!.click();
    await until(() => m.writes.length === 1);
    assert.deepEqual(m.writes[0], { route: '/api/tools/checks', method: 'POST', body: { machine: 'local' } });
  });

  test('Verificar agora and Verificar conexões', async () => {
    const m = mount({ local: fixture('default') }, { answer: async () => ({ ok: true }) });
    await m.ready;
    m.area.querySelector('[data-action="check"]')!.click();
    await until(() => m.writes.length === 1);
    m.area.querySelector('[data-action="mcp-check"]')!.click();
    await until(() => m.writes.length === 2);
    assert.deepEqual(m.writes.map((w) => [w.route, w.body]), [
      ['/api/tools/checks', { machine: 'local' }],
      ['/api/tools/mcp/checks', { machine: 'local' }],
    ]);
  });

  test('C74 1 to 4 and 6: all in order, first check (never "Em dia"), offline, macOS without Homebrew, Windows without winget', async () => {
    const ok = mount({ local: fixture('all-ok') });
    await ok.ready;
    assert.match(texto(band(ok.area, 'all-ok')), /^Tudo em dia\./);
    assert.equal(ok.area.querySelectorAll('.tl-stat').length, 3);
    ok.leave();

    const first = mount({ local: fixture('first-check') });
    await first.ready;
    const cli = first.area.querySelector('.tl-cols-cli')!;
    assert.ok(!texto(cli).includes('Em dia'));
    assert.match(texto(cli), /Verificando/);
    assert.ok(cli.querySelectorAll('.tl-skel').length > 0);
    assert.match(texto(first.area), /lendo as versões · 2 de 11/);
    assert.match(texto(first.area), /a coluna fica vazia, nunca "em dia"/);
    first.leave();

    const off = mount({ local: fixture('offline') });
    await off.ready;
    assert.match(texto(band(off.area, 'offline')), /^Sem rede\. .*Instalar e atualizar ficam desligados/);
    const ghBtn = row(off.area, 'gh').querySelector('button')!;
    assert.equal(ghBtn.getAttribute('disabled'), '');
    assert.equal(buttonByText(off.area, 'Atualizar 5'), null);
    off.leave();

    const brew = mount({ local: fixture('no-homebrew') });
    await brew.ready;
    const b = band(brew.area, 'no-homebrew')!;
    assert.match(texto(b), /Sem Homebrew, o console só lê\./);
    assert.match(texto(b), /raw\.githubusercontent\.com\/Homebrew\/install/);
    assert.ok(buttonByText(b, 'Rodei, verificar de novo'));
    brew.leave();

    const win = mount({ local: fixture('windows-no-winget') });
    await win.ready;
    assert.match(texto(band(win.area, 'no-winget')), /Sem o winget, o console só lê\./);
  });

  test('C75 1: the Workstation read-only: every action is Copiar comando, no Atualizar N, the band says how to turn it on', async () => {
    const m = mount({ local: fixture('default'), workstation: fixture('default', 'workstation') }, { search: '?machine=workstation' });
    await m.ready;
    assert.ok(m.reads.includes('/api/tools?machine=workstation'));
    assert.match(texto(band(m.area, 'read-only')), /Só leitura\..*acceptRemoteActions/);
    assert.match(texto(m.area.querySelector('.cc-head')), /ws-exemplo · Ubuntu 24\.04 · lido do núcleo de lá/);
    assert.equal(buttonByText(m.area, 'Atualizar 2 lá'), null);
    assert.equal(texto(row(m.area, 'wrangler').querySelector('button')), 'Copiar comando');
    assert.equal(texto(row(m.area, 'rust').querySelector('button')), 'Copiar comando');
    assert.equal(texto(row(m.area, 'gh').querySelector('button')), 'Precisa de sudo');
    assert.ok(!m.area.querySelectorAll('button').some((b) => /^Atualizar/.test(texto(b))));
    row(m.area, 'wrangler').querySelector('button')!.click();
    assert.equal(m.writes.length, 0, 'copying writes nothing');
  });

  test('C75 2: actions on there: "Atualizar lá", "Atualizar 2 lá", and the confirm says it runs on the Workstation', async () => {
    const m = mount({ local: fixture('default'), workstation: fixture('remote-actions', 'workstation') }, { search: '?machine=workstation' });
    await m.ready;
    assert.match(texto(band(m.area, 'remote-actions')), /Ações ligadas na Workstation\./);
    assert.ok(buttonByText(m.area, 'Atualizar 2 lá'));
    assert.equal(texto(row(m.area, 'rust').querySelector('button')), 'Atualizar lá');
    row(m.area, 'rust').querySelector('button')!.click();
    assert.match(texto(dialog(m.area)), /Atualizar Rust na Workstation.*Na Workstation · pelo núcleo de lá/);
    buttonByText(dialog(m.area)!, 'Confirmar e rodar')!.click();
    await until(() => m.writes.length === 1);
    assert.equal(m.writes[0]!.route, '/api/tools/rust/actions/update');
    assert.equal(m.writes[0]!.body.machine, 'workstation');
  });

  test('C75 3: the Workstation out: the last reading faded, nothing to click in the rows, a link to the machine', async () => {
    const m = mount({ local: fixture('default'), workstation: fixture('remote-stale', 'workstation') }, { search: '?machine=workstation' });
    await m.ready;
    assert.match(texto(band(m.area, 'stale')), /Sem conexão com a Workstation\./);
    assert.ok(m.area.querySelector('.tl-faded'));
    assert.equal(m.area.querySelector('.tl-faded')!.querySelectorAll('.tl-table button').length, 0);
    assert.match(texto(m.area.querySelector('.cc-head')), /última leitura às \d\d:\d\d, há 14 min/);
    assert.equal(buttonByText(m.area, 'Verificar agora'), null);
    assert.equal(band(m.area, 'stale')!.querySelector('a')!.getAttribute('href'), '/ui/machines/workstation');
  });

  test('the machine selector switches with ?machine= and re-reads', async () => {
    replaced.length = 0;
    const m = mount({ local: fixture('default'), workstation: fixture('default', 'workstation') });
    await m.ready;
    buttonByText(m.area, 'Workstation')!.click();
    await until(() => m.reads.includes('/api/tools?machine=workstation') && !!band(m.area, 'read-only'));
    assert.deepEqual(replaced, ['/ui/tools?machine=workstation']);
  });

  test('C76: the containers card in each variant', async () => {
    const card = async (scenario: ToolsDemoScenario, machine = 'local') => {
      const m = mount({ [machine]: fixture(scenario, machine) }, { search: machine === 'local' ? '' : `?machine=${machine}` });
      await m.ready;
      const node = m.area.querySelector('.tl-containers')!;
      return { m, node, text: texto(node) };
    };
    const running = await card('default');
    assert.match(running.text, /Colima Rodando Parar/);
    assert.match(running.text, /Colima 0\.9\.1 · Docker CLI 28\.5\.1 · perfil default/);
    assert.match(running.text, /Parar roda: colima stop · sem senha/);
    assert.ok(running.node.querySelector('progress.tl-bar'));
    running.node.querySelector('[data-action="stop"]')!.click();
    assert.match(texto(dialog(running.m.area)), /Parar Colima.*colima stop/);
    buttonByText(dialog(running.m.area)!, 'Confirmar e rodar')!.click();
    await until(() => running.m.writes.length === 1);
    assert.equal(running.m.writes[0]!.route, '/api/tools/container-colima/actions/stop');

    assert.match((await card('colima-stopped')).text, /Colima Parado Iniciar.*parada.*Iniciar roda: colima start/);
    assert.match((await card('colima-starting')).text, /Colima Iniciando Iniciando…/);
    const none = await card('no-runtime');
    assert.match(none.text, /Sem runtime Faltando Instalar o Colima/);
    assert.match(none.text, /Instalar roda: brew install colima docker/);
    const engine = await card('linux-engine-stopped', 'workstation');
    assert.match(engine.text, /Docker Engine Parado Precisa de sudo/);
    assert.match(engine.text, /sudo systemctl start docker/);
    const win = await card('windows-no-winget');
    assert.match(win.text, /Podman Desktop Faltando/);
    assert.match(win.text, /Achamos Docker Desktop 4\.48 · rodando · o console só lê/);
  });

  test('MCP: Verificar conexões, the login and Agent Config actions, and no value of env or headers on screen', async () => {
    const body = fixture('default');
    body.mcp.servers[4].env = { PGPASSWORD: 'segredo-de-mentira' };
    const m = mount({ local: body });
    await m.ready;
    const mcp = m.area.querySelector('.tl-mcp')!;
    assert.match(texto(mcp), /postgres-local 3 variáveis de ambiente · valores ocultos/);
    assert.match(texto(mcp), /Entrar pelo \/mcp/);
    assert.equal(mcp.querySelector('a')!.getAttribute('href'), '/ui/agent-config?tab=mcp');
    assert.ok(!texto(m.area).includes('segredo-de-mentira'));
  });

  test('a read that fails before anything is on screen shows the error state', async () => {
    const m = mount({});
    await m.ready;
    assert.match(texto(m.area), /Não deu para ler as ferramentas/);
  });
});

describe('issue 280 tools.css', () => {
  test('three stats and two columns under 1300 px, six and three from 1300; fixed tables', () => {
    const css = readFileSync(new URL('../../ui/screens/tools.css', import.meta.url), 'utf8');
    assert.match(css, /\.tl-stats \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.tl-grid \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /@media \(min-width: 1300px\) \{\s*\.tl-stats \{ grid-template-columns: repeat\(6/);
    assert.match(css, /\.tl-table \{[^}]*table-layout: fixed/);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
