// Instalar o Ahrena Framework pela aba Instruções (C34 a C37, #184), montada no DOM falso com um
// `ctx.read` e um `ctx.write` falsos que respondem no formato de src/api/framework-install.ts (dados
// inventados): o card do topo, o botão no vazio, os três passos, a base travada, o Cursor desabilitado,
// a issue, os bloqueios (JSON inválido e sem escrita), o PR ao vivo e o 409 que recarrega a prévia.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { AgentInstructions } from '../../src/agent-instructions/model.ts';
import type { FrameworkInstallPlan } from '../../src/api/framework-install.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const local = { pathname: '/ui/repos/exemplo-labs/painel-ficticio/instructions', search: '' };
Object.assign(globalThis, { location: local, history: { state: null, replaceState: () => {} }, getSelection: () => ({ toString: () => '' }) });

// @ts-expect-error: módulo do navegador, em JavaScript puro
const { mount: mountRepo } = await import('../../ui/screens/repo.js');
// @ts-expect-error: idem
const { diffLines, parseIssueField, planRoute } = await import('../../ui/screens/framework-install.js');

const REPO = 'exemplo-labs/painel-ficticio';
const AGORA = new Date().toISOString();
const PLAN_BASE = '/api/framework-install/exemplo-labs/painel-ficticio';

// ---------- respostas de exemplo ----------

function instructions(extra: Partial<AgentInstructions> = {}): AgentInstructions {
  return {
    state: 'ready',
    error: null,
    repo: REPO,
    commit: 'c0ffee',
    readAt: AGORA,
    truncated: false,
    empty: false,
    files: [{ path: 'CLAUDE.md', kind: 'claude-root', folder: '', importedBy: [], tree: { path: 'CLAUDE.md', status: 'ok', imports: [] } }],
    rules: [],
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    plugins: [],
    marketplaces: [],
    mcp: [],
    settings: 'ok',
    warnings: [],
    ...extra,
  };
}

const EMPTY: AgentInstructions = instructions({ empty: true, files: [], settings: 'none' });

const SETTINGS_DIFF = [
  '--- a/.claude/settings.json',
  '+++ b/.claude/settings.json',
  '@@ -1,4 +1,8 @@',
  ' {',
  '   "permissions": {',
  '     "allow": ["Bash(pytest)"]',
  '+  },',
  '+  "enabledPlugins": {',
  '+    "ahrena-foundation@ahrena": true,',
  '+    "ahrena-engineering-python@ahrena": true',
  '   }',
  ' }',
  '',
].join('\n');

type Plan = FrameworkInstallPlan;

function plan(extra: Partial<Plan> = {}): Plan {
  return {
    state: 'ready',
    error: null,
    readAt: AGORA,
    repo: REPO,
    frameworkRepo: 'exemplo-org/framework-ficticio',
    catalogCommit: 'abc1234',
    canWrite: true,
    writeBlockedReason: null,
    installed: false,
    found: { languages: ['Python'], frameworks: ['FastAPI'], tests: 'tests/', ci: 'GitHub Actions', files: { 'CLAUDE.md': true, 'AGENTS.md': false, '.claude/settings.json': true } },
    platforms: [
      { id: 'claude', label: 'Claude Code', detail: 'plugins no settings.json', available: true, checked: true, note: null },
      { id: 'codex', label: 'Codex', detail: 'só o AGENTS.md', available: true, checked: true, note: null },
      { id: 'cursor', label: 'Cursor', detail: 'uma regra .mdc por regra', available: false, checked: false, note: 'a confirmar' },
    ],
    plugins: [
      { name: 'ahrena-foundation', description: 'o núcleo', group: 'base', why: 'base: sempre instalado', checked: true, locked: true },
      { name: 'ahrena-contributing', description: 'issue e PR', group: 'base', why: 'base: sempre instalado', checked: true, locked: true },
      { name: 'ahrena-engineering-python', description: 'Python', group: 'suggested', why: 'achamos pyproject.toml', checked: true, locked: false },
      ...['go', 'rust', 'data', 'frontend', 'delivery'].map((n) => ({ name: `ahrena-engineering-${n}`, description: n, group: 'other' as const, why: null, checked: false, locked: false })),
    ],
    choice: { platforms: ['claude', 'codex'], plugins: ['ahrena-foundation', 'ahrena-contributing', 'ahrena-engineering-python'] },
    files: [
      { path: 'AGENTS.md', action: 'create', why: 'índice das regras', add: 21, del: 0, diff: '--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1,2 @@\n+## Ahrena Framework\n+- regra\n' },
      { path: 'CLAUDE.md', action: 'merge', why: 'importa o AGENTS.md', add: 4, del: 0, diff: '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,1 +1,2 @@\n # painel\n+@AGENTS.md\n' },
      { path: '.claude/settings.json', action: 'merge', why: 'a permissão que já existia fica', add: 15, del: 0, diff: SETTINGS_DIFF },
    ],
    blocked: null,
    branch: 'chore/install-ahrena-framework',
    title: 'chore: install the Ahrena Framework',
    planHash: 'hash-1',
    pullRequest: null,
    ...extra,
  };
}

const PR = { number: 12, url: 'https://github.example/exemplo-labs/painel-ficticio/pull/12', title: 'chore: install the Ahrena Framework', branch: 'chore/install-ahrena-framework', base: 'main', state: 'open' as const, checks: 'pending' as const, review: 'review_required' as const, updatedAt: AGORA };

class WriteFailure extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'WriteError';
    this.status = status;
    this.body = body;
  }
}

// ---------- montar ----------

const METRICS = {
  state: 'ready',
  updatedAt: AGORA,
  error: null,
  computing: [],
  period: '90d',
  repo: { fullName: REPO, url: `https://github.com/${REPO}`, visibility: 'public', ci: 'ok', defaultBranch: 'main', stars: 1, forks: 0, watchers: 1, release: null, license: null },
  tabs: { issues: 1, prs: 1, sessions: 1 },
  lines: null,
  commits: null,
  frequency: null,
  issues: null,
  prs: null,
  ci: null,
  languages: null,
  contributors: null,
  releases: null,
  releasesTotal: null,
  community: null,
  canWrite: true,
};

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  writes: { route: string; body: Record<string, unknown> }[];
  change: (changes: unknown[]) => void;
  leave: () => void;
}
const opened: Mounted[] = [];
afterEach(() => {
  for (const m of opened.splice(0)) m.leave();
});

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let k = 0; k < 8; k++) await tick();
};

interface Answers {
  instructions?: AgentInstructions;
  plan?: (route: string) => Plan;
  write?: (body: Record<string, unknown>) => unknown;
  pullRequest?: () => unknown;
}

async function mountTab(a: Answers = {}): Promise<Mounted> {
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const writes: Mounted['writes'] = [];
  const listeners = new Set<(c: unknown[]) => void>();
  const signal = new AbortController();
  const ctx = {
    params: { owner: 'exemplo-labs', repo: 'painel-ficticio', tab: 'instructions' },
    signal: signal.signal,
    read: async (route: string) => {
      reads.push(route);
      if (route.startsWith('/api/repos/')) return METRICS;
      if (route.startsWith(`${PLAN_BASE}/plan`)) return (a.plan ?? (() => plan()))(route);
      if (route === `${PLAN_BASE}/pull-request`) return a.pullRequest?.() ?? { state: 'ready', error: null, pullRequest: PR };
      if (route.includes('/file?path=')) return { state: 'ready', error: null, repo: REPO, readAt: AGORA, path: 'CLAUDE.md', kind: 'claude-root', text: '# painel\n', tree: { path: 'CLAUDE.md', status: 'ok', text: '# painel\n', imports: [] } };
      return a.instructions ?? instructions();
    },
    write: async (route: string, body: Record<string, unknown>) => {
      writes.push({ route, body });
      const r = (a.write ?? (() => ({ status: 'opened', pullRequest: PR })))(body);
      if (r instanceof Error) throw r;
      return r;
    },
    onChange: (f: (c: unknown[]) => void) => listeners.add(f),
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const cleanup = await mountRepo(area, ctx);
  await settle();
  const m = { area, reads, writes, change: (c: unknown[]) => listeners.forEach((f) => f(c)), leave: () => (signal.abort(), cleanup?.()) };
  opened.push(m);
  return m;
}

const click = async (node: ElementoFalso | null) => {
  assert.ok(node, 'o elemento existe');
  node.click();
  await settle();
};
const type = async (input: ElementoFalso | null, value: string) => {
  assert.ok(input);
  input.value = value;
  input.dispatchEvent({ type: 'input' });
  await settle();
};
const action = (area: ElementoFalso, name: string) => area.querySelector(`[data-action="${name}"]`);

async function toPreview(a: Answers = {}) {
  const m = await mountTab(a);
  await click(action(m.area, 'install'));
  await click(action(m.area, 'preview'));
  return m;
}

// ---------- o card do topo e o vazio ----------

describe('Install (C34): the card on the Instructions tab', () => {
  test('a repository without the framework shows "Sem Ahrena Framework" with Instalar on top, and the instructions below', async () => {
    const { area, reads } = await mountTab();
    assert.ok(reads.includes(`${PLAN_BASE}/plan`), 'lê o plano padrão');
    const card = area.querySelector('[data-install="start"]')!;
    assert.match(texto(card), /^Sem Ahrena Framework Os agentes daqui só levam o CLAUDE\.md abaixo\./);
    assert.equal(texto(card.querySelector('[data-action="install"]')), 'Instalar');
    const body = area.querySelector('.ins-body')!;
    assert.equal(body.children[0], card, 'o card fica no topo');
    assert.ok(body.querySelector('.ins-grid'), 'o que existe continua embaixo');
  });

  test('while the default plan is being read, the card is already there, with Instalar off and the notice', async () => {
    const { area } = await mountTab({ plan: () => ({ state: 'loading', error: null }) as unknown as Plan });
    const card = area.querySelector('[data-install="loading"]')!;
    assert.ok(card, 'o card aparece já durante a leitura');
    assert.equal(card.getAttribute('aria-busy'), 'true');
    assert.match(texto(card), /Lendo o repositório para preparar a instalação…/);
    assert.ok(card.querySelector('[data-action="install"]')!.hasAttribute('disabled'));
  });

  test('with the framework installed, there is no card', async () => {
    const { area } = await mountTab({ plan: () => plan({ installed: true }) });
    assert.equal(area.querySelector('.fwi-top'), null);
    assert.equal(action(area, 'install'), null);
  });

  test('without write permission: no Instalar, and the notice', async () => {
    const reason = 'Sua conta não tem permissão de escrita neste repositório: peça a quem administra para instalar.';
    const { area } = await mountTab({ plan: () => plan({ canWrite: false, writeBlockedReason: reason, blocked: { kind: 'no-write', message: reason, path: null } }) });
    const card = area.querySelector('[data-install="no-write"]')!;
    assert.match(texto(card), /Sem permissão de escrita\. Sua conta não tem permissão de escrita/);
    assert.equal(action(area, 'install'), null);
  });

  test('with the install PR already open, the card shows the PR', async () => {
    const { area } = await mountTab({ plan: () => plan({ pullRequest: PR }) });
    const card = area.querySelector('[data-install="pull-request"]')!;
    assert.match(texto(card), /Instalação do Ahrena Framework em andamento PR 12 · chore: install the Ahrena Framework Aberto CI …/);
    assert.equal(card.querySelector('a')!.getAttribute('href'), PR.url);
    assert.equal(action(area, 'install'), null);
  });

  test('branch-exists: the card offers no Instalar and shows the notice with the link to the branch', async () => {
    const url = 'https://github.example/exemplo-labs/painel-ficticio/tree/chore/install-ahrena-framework';
    const blocked = { kind: 'branch-exists', message: 'O branch de instalação já existe sem PR aberto.', path: null, url } as Plan['blocked'];
    const { area } = await mountTab({ plan: () => plan({ blocked }) });
    const card = area.querySelector('[data-install="branch-exists"]')!;
    assert.match(texto(card), /Sem Ahrena Framework Não dá para abrir o PR\. O branch de instalação já existe sem PR aberto\. Abrir o branch no GitHub/);
    assert.equal(card.querySelector('a')!.getAttribute('href'), url);
    assert.equal(card.querySelector('a')!.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(action(area, 'install'), null);
    const empty = await mountTab({ instructions: EMPTY, plan: () => plan({ blocked }) });
    assert.equal(action(empty.area, 'install'), null, 'nem no vazio');
    assert.ok(empty.area.querySelector('[data-install="branch-exists"]'));
  });

  test('the plan route failing does not break the tab: no card, instructions shown', async () => {
    const { area } = await mountTab({
      plan: () => {
        throw new Error('404');
      },
    });
    assert.equal(area.querySelector('.fwi-top'), null);
    assert.ok(area.querySelector('.ins-grid'));
  });

  test('the empty tab (C33) offers "Instalar o Ahrena Framework" next to the CLAUDE.md how-to', async () => {
    const { area } = await mountTab({ instructions: EMPTY });
    const empty = area.querySelector('.ins-empty')!;
    assert.equal(texto(empty.querySelector('[data-action="install"]')), 'Instalar o Ahrena Framework');
    assert.match(texto(empty), /Como escrever um CLAUDE\.md/);
    assert.equal(area.querySelector('[data-install="start"]'), null, 'no vazio, o botão fica no próprio card');
    await click(action(area, 'install'));
    assert.ok(area.querySelector('.fwi-flow'), 'abre o fluxo na própria aba');
  });

  test('the empty tab without write permission has no Instalar', async () => {
    const { area } = await mountTab({ instructions: EMPTY, plan: () => plan({ canWrite: false, writeBlockedReason: 'só leitura' }) });
    assert.equal(action(area, 'install'), null);
    assert.ok(area.querySelector('[data-install="no-write"]'));
  });
});

// ---------- passo 1 ----------

describe('Install (C35): step 1, platforms and plugins', () => {
  test('Instalar opens the three-step flow in the tab, with what we found', async () => {
    const { area } = await mountTab();
    await click(action(area, 'install'));
    assert.equal(area.querySelector('.ins-grid'), null, 'o fluxo toma o lugar do conteúdo da aba');
    assert.ok(area.querySelector('nav.repo-tabs'), 'sem trocar de tela');
    assert.equal(texto(area.querySelector('.fwi-steps')), '1 Plataformas e plugins 2 Prévia do diff 3 Pull request');
    assert.equal(texto(area.querySelector('[aria-current="step"]')), '1 Plataformas e plugins');
    assert.equal(texto(area.querySelector('.fwi-found')), 'No repositório: Python FastAPI testes em tests/ CI no GitHub Actions CLAUDE.md e .claude/settings.json já existem');
  });

  test('platforms: Claude Code and Codex checked, Cursor disabled with "a confirmar"', async () => {
    const { area } = await mountTab();
    await click(action(area, 'install'));
    const p = (id: string) => area.querySelector(`[data-platform="${id}"]`)!;
    assert.equal(p('claude').getAttribute('aria-checked'), 'true');
    assert.equal(p('codex').getAttribute('aria-checked'), 'true');
    assert.equal(p('cursor').getAttribute('aria-checked'), 'false');
    assert.ok(p('cursor').hasAttribute('disabled'));
    assert.match(texto(p('cursor')), /a confirmar/);
  });

  test('cursor never goes to the route; unchecking Codex recalculates the plan', async () => {
    const m = await mountTab();
    await click(action(m.area, 'install'));
    const before = m.reads.length;
    await click(m.area.querySelector('[data-platform="cursor"]'));
    assert.equal(m.reads.length, before, 'o Cursor desabilitado não relê');
    await click(m.area.querySelector('[data-platform="codex"]'));
    const last = m.reads.at(-1)!;
    assert.equal(last, `${PLAN_BASE}/plan?platforms=claude&plugins=ahrena-foundation,ahrena-contributing,ahrena-engineering-python`);
    assert.ok(!m.reads.some((r) => r.includes('cursor')));
  });

  test('base plugins are locked: clicking does not uncheck them nor reread', async () => {
    const m = await mountTab();
    await click(action(m.area, 'install'));
    const base = m.area.querySelector('[data-plugin="ahrena-foundation"]')!;
    assert.equal(base.getAttribute('aria-disabled'), 'true');
    const before = m.reads.length;
    await click(base);
    assert.equal(m.reads.length, before);
    assert.equal(m.area.querySelector('[data-plugin="ahrena-foundation"]')!.getAttribute('aria-checked'), 'true');
  });

  test('suggested checked with the reason, others unchecked; checking one sends the whole list', async () => {
    const m = await mountTab();
    await click(action(m.area, 'install'));
    const py = m.area.querySelector('[data-plugin="ahrena-engineering-python"]')!;
    assert.equal(texto(py), '✓ engineering-python achamos pyproject.toml');
    assert.equal(m.area.querySelector('[data-plugin="ahrena-engineering-go"]')!.getAttribute('aria-checked'), 'false');
    assert.equal(m.area.querySelector('[data-plugin="ahrena-engineering-delivery"]'), null, 'só 4 dos outros, até "mostrar os 5"');
    await click(action(m.area, 'more'));
    assert.ok(m.area.querySelector('[data-plugin="ahrena-engineering-delivery"]'));
    await click(m.area.querySelector('[data-plugin="ahrena-engineering-go"]'));
    assert.equal(m.reads.at(-1), `${PLAN_BASE}/plan?platforms=claude,codex&plugins=ahrena-foundation,ahrena-contributing,ahrena-engineering-python,ahrena-engineering-go`);
  });

  test('changing the choice shows "Recalculando o plano…" and holds Ver a prévia until the new plan arrives', async () => {
    let release: (() => void) | null = null;
    let first = true;
    const m = await mountTab({
      plan: () => {
        if (first) return plan();
        return new Promise<Plan>((resolve) => (release = () => resolve(plan())));
      },
    });
    await click(action(m.area, 'install'));
    first = false;
    await click(m.area.querySelector('[data-plugin="ahrena-engineering-python"]'));
    assert.match(texto(m.area.querySelector('.fwi-band-wait')), /Recalculando o plano…/);
    const preview = action(m.area, 'preview')!;
    assert.ok(preview.hasAttribute('disabled'));
    assert.equal(texto(preview), 'Calculando…');
    release!();
    await settle();
    assert.equal(m.area.querySelector('.fwi-band-wait'), null);
    assert.equal(texto(action(m.area, 'preview')), 'Ver a prévia');
  });

  test('unchecking every suggested plugin still sends the base, not an empty list (which would mean the default)', async () => {
    const m = await mountTab();
    await click(action(m.area, 'install'));
    await click(m.area.querySelector('[data-plugin="ahrena-engineering-python"]'));
    assert.equal(m.reads.at(-1), `${PLAN_BASE}/plan?platforms=claude,codex&plugins=ahrena-foundation,ahrena-contributing`);
  });

  test('Cancelar goes back to the instructions', async () => {
    const { area } = await mountTab();
    await click(action(area, 'install'));
    await click(action(area, 'cancel'));
    assert.equal(area.querySelector('.fwi-flow'), null);
    assert.ok(area.querySelector('.ins-grid'));
    assert.ok(area.querySelector('[data-install="start"]'));
  });
});

// ---------- passo 2 ----------

describe('Install (C36): step 2, the diff preview', () => {
  test('each file with its action and the unified diff, the branch, the title and "Nada foi escrito ainda."', async () => {
    const { area } = await toPreview();
    assert.equal(texto(area.querySelector('[aria-current="step"]')), '2 Prévia do diff');
    assert.equal(
      area
        .querySelectorAll('.fwi-file')
        .map((f) => texto(f))
        .join(' | '),
      'AGENTS.md criar +21 | CLAUDE.md mesclar +4 | .claude/settings.json mesclar +15',
    );
    assert.match(texto(area.querySelector('.fwi-files')), /^3 arquivos · \+40 −0/);
    assert.match(texto(area.querySelector('.fwi-pr-form')), /chore\/install-ahrena-framework/);
    assert.equal(area.querySelector('[data-field="title"]')!.value, 'chore: install the Ahrena Framework');
    assert.match(texto(area.querySelector('.fwi-pr-form')), /Nada foi escrito ainda\./);
    assert.ok(action(area, 'open-pr'));
    // O seletor do DOM falso leria `.claude` como classe: procura pelo atributo.
    await click(area.querySelectorAll('.fwi-file').find((f) => f.getAttribute('data-path') === '.claude/settings.json') ?? null);
    const lines = area.querySelectorAll('.fwi-diff .fwi-line');
    assert.equal(lines.filter((l) => l.getAttribute('data-kind') === 'add').length, 4);
    assert.equal(texto(lines.find((l) => l.getAttribute('data-kind') === 'add')!), '+ },');
    assert.equal(texto(lines[1]!), '1 {', 'o contexto leva o número da linha');
  });

  test('Abrir PR posts the choice, the plan hash, the title and the issue number, and step 3 shows the PR', async () => {
    const m = await toPreview();
    await type(m.area.querySelector('[data-field="title"]'), 'chore: framework');
    await type(m.area.querySelector('[data-field="issue"]'), '#184');
    await click(action(m.area, 'open-pr'));
    assert.deepEqual(m.writes, [{ route: PLAN_BASE, body: { platforms: ['claude', 'codex'], plugins: ['ahrena-foundation', 'ahrena-contributing', 'ahrena-engineering-python'], planHash: 'hash-1', title: 'chore: framework', issue: 184 } }]);
    assert.equal(texto(m.area.querySelector('[aria-current="step"]')), '3 Pull request');
    const card = m.area.querySelector('.fwi-pr')!;
    assert.match(texto(card), /PR 12 · chore: install the Ahrena Framework Aberto CI …/);
    assert.match(texto(card), /Branch chore\/install-ahrena-framework → main Arquivos 3 Linhas \+40 −0 Plugins 3 Review esperando/);
    assert.equal(m.area.querySelector('.fwi-head a')!.getAttribute('href'), PR.url);
  });

  test('an empty issue sends no issue', async () => {
    const m = await toPreview();
    await click(action(m.area, 'open-pr'));
    assert.equal(m.writes[0]!.body.issue, undefined);
  });

  test('an invalid issue warns before sending', async () => {
    const m = await toPreview();
    await type(m.area.querySelector('[data-field="issue"]'), 'abc');
    assert.equal(texto(m.area.querySelector('[data-hint="issue"]')), 'Só o número da issue, como 42.');
    assert.equal(m.area.querySelector('[data-field="issue"]')!.getAttribute('aria-invalid'), 'true');
    await click(action(m.area, 'open-pr'));
    assert.deepEqual(m.writes, [], 'não envia');
    assert.match(texto(m.area.querySelector('.fwi-band')), /Confira a issue\./);
  });

  test('409 plan-changed warns and reloads the preview from GitHub', async () => {
    let n = 0;
    const m = await toPreview({
      plan: (route) => (route.includes('refresh=1') ? plan({ planHash: 'hash-2', files: plan().files.slice(0, 2) }) : plan()),
      write: () => (n++ === 0 ? new WriteFailure('o plano mudou desde a prévia', 409, { error: 'o plano mudou desde a prévia', code: 'plan-changed', planHash: 'hash-2' }) : { status: 'opened', pullRequest: PR }),
    });
    await click(action(m.area, 'open-pr'));
    assert.ok(m.reads.at(-1)!.includes('refresh=1'), 'relê a prévia sem cache');
    assert.match(texto(m.area.querySelector('.fwi-band')), /O repositório mudou desde a prévia\./);
    assert.equal(texto(m.area.querySelector('[aria-current="step"]')), '2 Prévia do diff', 'fica na prévia');
    assert.equal(m.area.querySelectorAll('.fwi-file').length, 2, 'com o plano novo');
    await click(action(m.area, 'open-pr'));
    assert.equal(m.writes[1]!.body.planHash, 'hash-2');
  });

  test('another write error shows the reason and stays on the preview', async () => {
    const m = await toPreview({ write: () => new WriteFailure('o GitHub respondeu 500', 502, { error: 'o GitHub respondeu 500', code: 'github-error' }) });
    await click(action(m.area, 'open-pr'));
    assert.match(texto(m.area.querySelector('.fwi-band')), /Não abrimos o PR\. o GitHub respondeu 500\. Nada foi escrito\./);
    assert.equal(texto(m.area.querySelector('[aria-current="step"]')), '2 Prévia do diff');
  });

  test('invalid JSON blocks: the reason and the file, no Abrir PR', async () => {
    const blocked = plan({
      blocked: { kind: 'invalid-json', message: '.claude/settings.json: JSON inválido', path: '.claude/settings.json' },
      files: [...plan().files.slice(0, 2), { path: '.claude/settings.json', action: 'refused', why: 'JSON inválido: corrija o arquivo antes de instalar', add: 0, del: 0, diff: '' }],
    });
    const { area } = await toPreview({ plan: () => blocked });
    const band = area.querySelector('[data-blocked="invalid-json"]')!;
    assert.equal(texto(band), 'Não dá para abrir o PR. .claude/settings.json: JSON inválido Arquivo: .claude/settings.json . Nada foi escrito.', 'the message of the plan, not a fixed text: the refusal can be other than invalid JSON');
    assert.equal(action(area, 'open-pr'), null);
    assert.match(texto(area.querySelector('.fwi-diff')), /recusado .*Este arquivo não entra no PR: JSON inválido/);
  });

  test('without write permission inside the flow (the plan changed live): notice, no Abrir PR', async () => {
    let current = plan();
    const m = await mountTab({ plan: () => current });
    await click(action(m.area, 'install'));
    current = plan({ canWrite: false, writeBlockedReason: 'só leitura', blocked: { kind: 'no-write', message: 'só leitura', path: null } });
    m.change([{ type: 'framework-install', key: 'Exemplo-Labs/Painel-Ficticio' }]);
    await settle();
    await click(action(m.area, 'preview'));
    assert.equal(texto(m.area.querySelector('[data-blocked="no-write"]')), 'Sem permissão de escrita. só leitura');
    assert.equal(action(m.area, 'open-pr'), null);
  });

  for (const kind of ['unpaired-markers', 'unreadable'] as const) {
    test(`${kind} blocks like invalid JSON: the error band with the reason and the file, no Abrir PR`, async () => {
      const message = kind === 'unpaired-markers' ? 'CLAUDE.md: os marcadores do framework estão desemparelhados; corrija antes de instalar.' : 'AGENTS.md: o arquivo não pôde ser lido do GitHub.';
      const path = kind === 'unpaired-markers' ? 'CLAUDE.md' : 'AGENTS.md';
      const { area } = await toPreview({ plan: () => plan({ blocked: { kind, message, path, url: null } as Plan['blocked'] }) });
      const band = area.querySelector(`[data-blocked="${kind}"]`)!;
      assert.equal(texto(band), `Não dá para abrir o PR. ${message} Arquivo: ${path} . Nada foi escrito.`);
      assert.ok(band.classList.contains('fwi-band-err'));
      assert.equal(action(area, 'open-pr'), null);
    });
  }

  test('branch-exists blocks: the error band with the link to the branch, no Abrir PR', async () => {
    const url = 'https://github.example/exemplo-labs/painel-ficticio/tree/chore/install-ahrena-framework';
    const blocked = { kind: 'branch-exists', message: 'O branch chore/install-ahrena-framework já existe sem PR aberto: apague-o ou mescle-o.', path: null, url };
    // O card não oferece Instalar com o branch sobrando: o branch aparece depois de abrir o fluxo (ao vivo).
    let current = plan();
    const m = await mountTab({ plan: () => current });
    await click(action(m.area, 'install'));
    current = plan({ blocked: blocked as Plan['blocked'] });
    m.change([{ type: 'framework-install', key: 'exemplo-labs/painel-ficticio' }]);
    await settle();
    await click(action(m.area, 'preview'));
    const area = m.area;
    const band = area.querySelector('[data-blocked="branch-exists"]')!;
    assert.match(texto(band), /^Não dá para abrir o PR\. O branch chore\/install-ahrena-framework já existe sem PR aberto/);
    const link = band.querySelector('a')!;
    assert.equal(texto(link), 'Abrir o branch no GitHub');
    assert.equal(link.getAttribute('href'), url);
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(action(area, 'open-pr'), null);
  });

  for (const [code, status, kind] of [
    ['unpaired-markers', 422, 'unpaired-markers'],
    ['unreadable', 422, 'unreadable'],
    ['branch-exists', 409, 'branch-exists'],
  ] as const) {
    test(`the POST answering ${status} ${code} reloads the preview, which shows the band`, async () => {
      let refreshed = false;
      const blocked = { kind, message: `motivo de ${kind}`, path: kind === 'branch-exists' ? null : 'CLAUDE.md', url: kind === 'branch-exists' ? 'https://github.example/b' : null };
      const m = await toPreview({
        plan: (route) => {
          if (route.includes('refresh=1')) refreshed = true;
          return refreshed ? plan({ blocked: blocked as Plan['blocked'] }) : plan();
        },
        write: () => new WriteFailure(`motivo de ${kind}`, status, { error: `motivo de ${kind}`, code }),
      });
      await click(action(m.area, 'open-pr'));
      assert.ok(m.reads.at(-1)!.includes('refresh=1'));
      assert.match(texto(m.area.querySelector(`[data-blocked="${kind}"]`)), new RegExp(`^Não dá para abrir o PR\\. motivo de ${kind}`));
      assert.equal(action(m.area, 'open-pr'), null);
      assert.equal(texto(m.area.querySelector('[aria-current="step"]')), '2 Prévia do diff');
    });
  }

  test('Voltar returns to step 1 with the choice kept', async () => {
    const m = await toPreview();
    await click(action(m.area, 'back'));
    assert.equal(texto(m.area.querySelector('[aria-current="step"]')), '1 Plataformas e plugins');
  });
});

// ---------- passo 3 ----------

describe('Install (C37): step 3, the PR live', () => {
  test('the live change rereads the PR: CI success and review approved', async () => {
    let pr: typeof PR | Record<string, unknown> = PR;
    const m = await toPreview({ pullRequest: () => ({ state: 'ready', error: null, pullRequest: pr }) });
    await click(action(m.area, 'open-pr'));
    pr = { ...PR, checks: 'success', review: 'approved' };
    m.change([{ type: 'framework-install', key: 'exemplo-labs/painel-ficticio' }]);
    await settle();
    assert.ok(m.reads.includes(`${PLAN_BASE}/pull-request`));
    assert.match(texto(m.area.querySelector('.fwi-pr')), /Aberto CI ok/);
    assert.match(texto(m.area.querySelector('.fwi-pr')), /Review aprovado/);
  });

  test('a change for another repository does not reread', async () => {
    const m = await toPreview();
    await click(action(m.area, 'open-pr'));
    const before = m.reads.length;
    m.change([{ type: 'framework-install', key: 'outra/coisa' }]);
    await settle();
    assert.equal(m.reads.length, before);
  });

  test('already-open answers show the existing PR with a notice', async () => {
    const m = await toPreview({ write: () => ({ status: 'already-open', pullRequest: { ...PR, number: 7 } }) });
    await click(action(m.area, 'open-pr'));
    assert.match(texto(m.area.querySelector('.fwi-band')), /O PR já estava aberto\./);
    assert.match(texto(m.area.querySelector('.fwi-pr')), /PR 7/);
  });

  test('Acompanhar on the card opens step 3 with the PR; Fechar returns to the tab', async () => {
    const { area } = await mountTab({ plan: () => plan({ pullRequest: { ...PR, checks: 'failure', review: 'changes_requested' } }) });
    await click(area.querySelector('[data-install="pull-request"] button'));
    assert.equal(texto(area.querySelector('[aria-current="step"]')), '3 Pull request');
    assert.match(texto(area.querySelector('.fwi-pr')), /CI falhou/);
    assert.match(texto(area.querySelector('.fwi-pr')), /Review mudanças pedidas/);
    await click(action(area, 'close'));
    assert.equal(area.querySelector('.fwi-flow'), null);
  });
});

// ---------- as peças puras ----------

describe('Install: helpers', () => {
  test('parseIssueField: empty, a number, # in front, and the invalid ones', () => {
    assert.deepEqual(parseIssueField(''), { ok: true, value: null });
    assert.deepEqual(parseIssueField(' 42 '), { ok: true, value: 42 });
    assert.deepEqual(parseIssueField('#7'), { ok: true, value: 7 });
    for (const bad of ['0', 'abc', '12a', '-3', '#', '1.5']) assert.equal(parseIssueField(bad).ok, false, bad);
  });

  test('planRoute: the default without query, and the choice in the query', () => {
    assert.equal(planRoute('o', 'r'), '/api/framework-install/o/r/plan');
    assert.equal(planRoute('o', 'r', { platforms: ['claude'], plugins: ['a', 'b'] }, { refresh: true }), '/api/framework-install/o/r/plan?platforms=claude&plugins=a,b&refresh=1');
  });

  test('diffLines: headers out, hunk kept, context numbered by the old file, + without number', () => {
    const lines = diffLines('--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@\n a\n+b\n-c\n d\n');
    assert.deepEqual(
      lines.map((l: { kind: string; n: string; text: string }) => [l.kind, l.n, l.text]),
      [
        ['@', '', '@@ -3,2 +3,3 @@'],
        [' ', '3', 'a'],
        ['+', '', 'b'],
        ['-', '4', 'c'],
        [' ', '5', 'd'],
      ],
    );
  });

  test('the diff text of the repository goes in as text, never as HTML', async () => {
    const hostile = plan({ files: [{ path: 'AGENTS.md', action: 'create', why: '<img src=x>', add: 1, del: 0, diff: '@@ -0,0 +1,1 @@\n+<script>alert(1)</script>\n' }] });
    const { area } = await toPreview({ plan: () => hostile });
    assert.match(texto(area.querySelector('.fwi-diff')), /<script>alert\(1\)<\/script>/);
    assert.equal(area.querySelector('.fwi-diff script'), null);
  });
});
