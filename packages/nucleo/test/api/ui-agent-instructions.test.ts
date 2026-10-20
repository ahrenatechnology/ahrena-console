// A aba Instruções de um repositório (C32 e C33, #183) montada no DOM falso, com um `ctx.read` falso
// que devolve respostas no formato de src/agent-instructions/model.ts (dados inventados), e o
// renderizador de Markdown (ui/screens/agent-instructions-markdown.js) contra texto hostil.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { AgentInstructions, ImportNodeWithText, InstructionFileView } from '../../src/agent-instructions/model.ts';
import { ElementoFalso, instalarDomFalso, texto, type NoFalso } from './dom-falso.ts';

instalarDomFalso();

const local = { pathname: '/ui/repos/exemplo-labs/vitrine-demo/instructions', search: '' };
Object.assign(globalThis, { location: local, history: { state: null, replaceState: () => {} }, getSelection: () => ({ toString: () => '' }) });

// @ts-expect-error: módulo do navegador, em JavaScript puro
const { mount: mountRepo } = await import('../../ui/screens/repo.js');
// @ts-expect-error: idem
const { renderMarkdown, safeHref } = await import('../../ui/screens/agent-instructions-markdown.js');
// @ts-expect-error: idem
const { instructionsChangeMatters } = await import('../../ui/screens/agent-instructions.js');

const REPO = 'exemplo-labs/vitrine-demo';
const COMMIT = 'abc123';
const AGORA = new Date().toISOString();

// ---------- respostas de exemplo ----------

function overview(extra: Partial<AgentInstructions> = {}): AgentInstructions {
  return {
    state: 'ready',
    error: null,
    repo: REPO,
    commit: COMMIT,
    readAt: AGORA,
    truncated: false,
    empty: false,
    files: [
      { path: 'packages/api/AGENTS.md', kind: 'agents-nested', folder: 'packages/api', importedBy: ['packages/api/CLAUDE.md'], tree: { path: 'packages/api/AGENTS.md', status: 'ok', imports: [] } },
      { path: 'AGENTS.md', kind: 'agents-root', folder: '', importedBy: ['CLAUDE.md'], tree: { path: 'AGENTS.md', status: 'ok', imports: [] } },
      {
        path: 'CLAUDE.md',
        kind: 'claude-root',
        folder: '',
        importedBy: [],
        tree: {
          path: 'CLAUDE.md',
          status: 'ok',
          imports: [
            { ref: 'AGENTS.md', path: 'AGENTS.md', status: 'ok', imports: [] },
            { ref: 'docs/style.md', path: 'docs/style.md', status: 'ok', imports: [] },
            { ref: '~/.claude/mine.md', path: null, status: 'outside-repo', imports: [] },
          ],
        },
      },
      { path: 'packages/api/CLAUDE.md', kind: 'claude-nested', folder: 'packages/api', importedBy: [], tree: { path: 'packages/api/CLAUDE.md', status: 'ok', imports: [{ ref: 'AGENTS.md', path: 'packages/api/AGENTS.md', status: 'ok', imports: [] }] } },
    ],
    rules: [
      { path: '.claude/rules/tests.md', name: 'tests', paths: ['test/**'] },
      { path: '.claude/rules/style.md', name: 'style', paths: [] },
    ],
    skills: [{ path: '.claude/skills/release/SKILL.md', name: 'release', description: 'Publica uma versão' }],
    agents: [{ path: '.claude/agents/reviewer.md', name: 'reviewer', description: 'Revisa o diff' }],
    commands: [{ path: '.claude/commands/pr/open.md', name: '/pr:open' }],
    hooks: [
      { event: 'PostToolUse', count: 1, matchers: ['Edit|Write'] },
      { event: 'Stop', count: 2, matchers: [] },
    ],
    plugins: [{ name: 'review-kit', marketplace: 'team-tools' }],
    marketplaces: ['team-tools'],
    mcp: ['tracker', 'docs'],
    settings: 'ok',
    warnings: [],
    ...extra,
  };
}

const CLAUDE_TEXT = '# vitrine-demo\n\nLeia antes.\n\n@AGENTS.md\n@docs/style.md\n@~/.claude/mine.md\n\n## Testes\n\n- Rode `npm test`.\n';

function fileView(path: string): InstructionFileView {
  const node = (n: ImportNodeWithText) => n;
  if (path === 'CLAUDE.md') {
    return {
      state: 'ready',
      error: null,
      repo: REPO,
      readAt: AGORA,
      path,
      kind: 'claude-root',
      text: CLAUDE_TEXT,
      tree: node({
        path,
        status: 'ok',
        text: CLAUDE_TEXT,
        imports: [
          { ref: 'AGENTS.md', path: 'AGENTS.md', status: 'ok', text: '# Convenções\n\n- Bastidores em inglês.\n', imports: [] },
          { ref: 'docs/style.md', path: 'docs/style.md', status: 'ok', text: '# Estilo\n\n- Funções pequenas.\n- Nomes claros.\n', imports: [] },
          { ref: '~/.claude/mine.md', path: null, status: 'outside-repo', imports: [] },
        ],
      }),
    };
  }
  const text = `# ${path}\n\nTexto de ${path}.\n`;
  return { state: 'ready', error: null, repo: REPO, readAt: AGORA, path, kind: 'agents-root', text, tree: { path, status: 'ok', text, imports: [] } };
}

const METRICS = {
  state: 'ready',
  updatedAt: AGORA,
  error: null,
  computing: [],
  period: '90d',
  repo: { fullName: REPO, url: `https://github.com/${REPO}`, visibility: 'public', ci: 'ok', defaultBranch: 'main', stars: 1, forks: 0, watchers: 1, release: null, license: null },
  tabs: { issues: 12, prs: 3, sessions: 5 },
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
  canWrite: false,
};

// ---------- montar ----------

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  change: (changes: unknown[]) => void;
  leave: () => void;
}
const opened: Mounted[] = [];
afterEach(() => {
  for (const m of opened.splice(0)) m.leave();
});

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let k = 0; k < 6; k++) await tick();
};

async function mountTab(answer: (route: string) => unknown, params: Record<string, string> = { owner: 'exemplo-labs', repo: 'vitrine-demo', tab: 'instructions' }): Promise<Mounted> {
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const listeners = new Set<(c: unknown[]) => void>();
  const signal = new AbortController();
  const ctx = {
    params,
    signal: signal.signal,
    read: async (route: string) => {
      reads.push(route);
      if (route.startsWith('/api/repos/')) return METRICS;
      const r = answer(route);
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
  const m = { area, reads, change: (c: unknown[]) => listeners.forEach((f) => f(c)), leave: () => (signal.abort(), cleanup?.()) };
  opened.push(m);
  return m;
}

const standard = (data: AgentInstructions = overview()) => (route: string) => {
  if (route.includes('/file?path=')) return fileView(decodeURIComponent(route.split('path=')[1]!));
  return data;
};

/** Todo elemento com `innerHTML` posto: só os ícones (SVG do próprio console) podem ter. */
function innerHtmlOutsideIcons(no: NoFalso): string[] {
  const out: string[] = [];
  const visit = (n: NoFalso) => {
    if (!(n instanceof ElementoFalso)) return;
    if (n.innerHTMLFalso && n.tagName !== 'SVG') out.push(n.tagName);
    n.childNodes.forEach(visit);
  };
  visit(no);
  return out;
}

const md = (text: string, opts: Record<string, unknown> = {}) => {
  const root = new ElementoFalso('div');
  root.append(renderMarkdown(text, { repo: REPO, commit: COMMIT, from: 'CLAUDE.md', ...opts }));
  return root;
};

// ---------- a aba e a fila de abas ----------

describe('Instruções (C32): a aba na tela do repositório', () => {
  test('a fila de abas tem Instruções depois de Decisões, aberta, e Métricas vira link', async () => {
    const { area, reads } = await mountTab(standard());
    const tabs = area.querySelector('nav.repo-tabs')!.children.map((t) => texto(t));
    assert.deepEqual(tabs, ['Métricas', 'Issues (12)', 'PRs (3)', 'CI', 'Sessões (5)', 'Decisões', 'Instruções']);
    assert.equal(texto(area.querySelector('nav.repo-tabs [aria-current="page"]')), 'Instruções');
    const metrics = area.querySelectorAll('nav.repo-tabs a').find((a) => texto(a) === 'Métricas')!;
    assert.equal(metrics.getAttribute('href'), '/ui/repos/exemplo-labs/vitrine-demo');
    assert.equal(area.querySelector('.repo-seg'), null, 'o período é das métricas');
    assert.ok(reads.includes('/api/agent-instructions/exemplo-labs/vitrine-demo'));
  });

  test('na aba Métricas, Instruções é o link para /instructions', async () => {
    const { area } = await mountTab(standard(), { owner: 'exemplo-labs', repo: 'vitrine-demo' });
    const link = area.querySelectorAll('nav.repo-tabs a').find((a) => texto(a) === 'Instruções')!;
    assert.equal(link.getAttribute('href'), '/ui/repos/exemplo-labs/vitrine-demo/instructions');
    assert.equal(texto(area.querySelector('nav.repo-tabs [aria-current="page"]')), 'Métricas');
  });

  test('uma aba que não existe mostra "Aba não encontrada"', async () => {
    const { area, reads } = await mountTab(standard(), { owner: 'exemplo-labs', repo: 'vitrine-demo', tab: 'nada' });
    assert.match(texto(area), /Aba não encontrada/);
    assert.deepEqual(reads, []);
  });
});

describe('Instruções (C32): a lista e os cards', () => {
  test('a lista põe a raiz primeiro, com os imports do CLAUDE.md embaixo, e as subpastas agrupadas por pasta', async () => {
    const { area } = await mountTab(standard());
    const nav = area.querySelector('nav.ins-nav')!;
    const items = nav.querySelectorAll('button').map((b) => texto(b));
    assert.deepEqual(items.slice(0, 7), ['CLAUDE.md raiz', '↳ @AGENTS.md', '↳ @docs/style.md', `↳ @~/.claude/mine.md fora do repositório: vem da máquina de quem roda o agente`, 'AGENTS.md raiz', 'CLAUDE.md', '↳ @AGENTS.md']);
    assert.deepEqual(nav.querySelectorAll('.ins-folder').map((f) => texto(f)), ['packages/api/']);
    assert.equal(texto(nav.querySelector('[aria-current="true"]')), 'CLAUDE.md raiz');
  });

  test('o AGENTS.md diz que é importado pelo CLAUDE.md', async () => {
    const { area } = await mountTab(standard());
    area.querySelectorAll('nav.ins-nav button').find((b) => texto(b) === 'AGENTS.md raiz')!.click();
    await settle();
    assert.equal(texto(area.querySelector('.ins-viewer-role')), 'raiz · importado pelo CLAUDE.md');
    assert.match(texto(area.querySelector('.ins-viewer-body')), /Texto de AGENTS\.md/);
  });

  test('os cards de .claude/: regras com paths, skills, agentes, comandos, hooks sem o comando, plugins com marketplace e MCP', async () => {
    const { area } = await mountTab(standard());
    const card = (id: string) => texto(area.querySelector(`[data-card="${id}"]`));
    assert.equal(card('rules'), 'Regras 2 tests só em test/** style todo o repositório');
    assert.equal(card('skills'), 'Skills 1 release Publica uma versão');
    assert.equal(card('agents'), 'Agentes 1 reviewer Revisa o diff');
    assert.equal(card('commands'), 'Comandos 1 /pr:open');
    assert.equal(card('hooks'), 'Hooks 2 eventos PostToolUse Edit|Write · 1 comando Stop 2 comandos');
    assert.equal(card('plugins'), 'Plugins habilitados 1 review-kit @team-tools');
    assert.equal(card('mcp'), 'MCP 2 tracker .mcp.json docs .mcp.json');
  });

  test('o arquivo abre renderizado, com o @AGENTS.md aberto no lugar e o @docs/style.md fechado', async () => {
    const { area, reads } = await mountTab(standard());
    assert.ok(reads.includes('/api/agent-instructions/exemplo-labs/vitrine-demo/file?path=CLAUDE.md'));
    const body = area.querySelector('.ins-viewer-body')!;
    assert.equal(texto(body.querySelector('h2')), 'vitrine-demo');
    const blocks = body.querySelectorAll('.ins-import');
    assert.deepEqual(blocks.map((b) => b.getAttribute('data-ref')), ['AGENTS.md', 'docs/style.md', '~/.claude/mine.md']);
    assert.equal(blocks[0]!.querySelector('button')!.getAttribute('aria-expanded'), 'true');
    assert.match(texto(blocks[0]!.querySelector('.ins-import-body')), /Bastidores em inglês/);
    assert.equal(blocks[1]!.querySelector('button')!.getAttribute('aria-expanded'), 'false');
    assert.equal(texto(blocks[1]!.querySelector('.ins-import-sum')), '4 linhas · clique para abrir');
    blocks[1]!.querySelector('button')!.click();
    assert.match(texto(blocks[1]!.querySelector('.ins-import-body')), /Funções pequenas/);
    // Nenhum parágrafo "@AGENTS.md @docs/style.md" sobra: a linha só de imports vira só os blocos.
    assert.equal(body.querySelectorAll('p').filter((p) => /@AGENTS/.test(texto(p))).length, 0);
  });

  test('Markdown mostra o texto como está, sem renderizar', async () => {
    const { area } = await mountTab(standard());
    area.querySelectorAll('.ins-seg button').find((b) => texto(b) === 'Markdown')!.click();
    assert.equal(area.querySelector('.ins-viewer-body pre')!.textContent, CLAUDE_TEXT);
    assert.equal(area.querySelector('.ins-viewer-body .ins-import'), null);
  });

  test('o botão do GitHub aponta para o arquivo no commit lido', async () => {
    const { area } = await mountTab(standard());
    assert.equal(area.querySelector('.ins-viewer-head a')!.getAttribute('href'), `https://github.com/${REPO}/blob/${COMMIT}/CLAUDE.md`);
  });

  test('a busca acha nos arquivos e nos imports, sem acento e sem caixa', async () => {
    const { area } = await mountTab(standard());
    const input = area.querySelector('input[type="search"]')!;
    input.value = 'INGLES';
    input.dispatchEvent({ type: 'input' });
    await new Promise((r) => setTimeout(r, 250));
    await settle();
    const hits = area.querySelectorAll('.ins-hit').map((h) => texto(h));
    assert.ok(hits.includes('@AGENTS.md · 3 - Bastidores em inglês .'), hits.join(' | '));
    assert.ok(area.querySelector('.ins-hit mark'));
  });
});

// ---------- os estados (C33) ----------

describe('Instruções (C33): vazio, avisos e estados', () => {
  test('repositório sem nada: o vazio com só "Como escrever um CLAUDE.md", sem Instalar', async () => {
    const empty = overview({ empty: true, files: [], rules: [], skills: [], agents: [], commands: [], hooks: [], plugins: [], marketplaces: [], mcp: [], settings: 'none' });
    const { area } = await mountTab(standard(empty));
    const t = texto(area);
    assert.match(t, /Nenhuma instrução para agentes neste repositório/);
    assert.doesNotMatch(t, /Instalar/);
    const links = area.querySelectorAll('.ins-empty a');
    assert.equal(links.length, 1);
    assert.equal(texto(links[0]!), 'Como escrever um CLAUDE.md');
    assert.equal(links[0]!.getAttribute('href'), 'https://docs.claude.com/en/docs/claude-code/memory');
    assert.equal(links[0]!.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(area.querySelector('.ins-empty button'), null);
  });

  test('os quatro avisos: árvore cortada na faixa, AGENTS.md sem import, import inexistente e settings.json inválido', async () => {
    const data = overview({
      truncated: true,
      settings: 'invalid',
      hooks: [],
      plugins: [],
      warnings: [{ kind: 'truncated' }, { kind: 'invalid-settings', path: '.claude/settings.json' }, { kind: 'agents-not-imported', path: 'AGENTS.md' }, { kind: 'missing-import', path: 'CLAUDE.md', ref: 'docs/gone.md' }],
    });
    const { area } = await mountTab(standard(data));
    assert.match(texto(area.querySelector('.ins-band')), /Árvore grande demais\. O GitHub cortou a lista de arquivos/);
    const warns = area.querySelectorAll('.ins-warn').map((w) => [w.getAttribute('data-kind'), texto(w)]);
    assert.deepEqual(warns, [
      ['invalid-settings', '.claude/settings.json JSON inválido: hooks e plugins não foram lidos'],
      ['agents-not-imported', 'AGENTS.md nenhum CLAUDE.md importa este AGENTS.md'],
      ['missing-import', '@docs/gone.md não existe no repositório (importado por CLAUDE.md)'],
    ]);
    assert.match(texto(area.querySelector('[data-card="hooks"]')), /settings\.json inválido: os hooks não foram lidos/);
  });

  test('"Tentar agora" da faixa relê com ?refresh=1', async () => {
    const { area, reads } = await mountTab(standard(overview({ truncated: true, warnings: [{ kind: 'truncated' }] })));
    area.querySelector('.ins-band button')!.click();
    await settle();
    assert.equal(reads.at(-1), '/api/agent-instructions/exemplo-labs/vitrine-demo?refresh=1');
  });

  test('sem avisos, nenhum card de avisos', async () => {
    const { area } = await mountTab(standard());
    assert.equal(area.querySelector('.ins-warnings'), null);
    assert.equal(area.querySelector('.ins-band'), null);
  });

  test('carregando: "Lendo o GitHub…" até a mudança ao vivo do repositório, que faz reler', async () => {
    let data: AgentInstructions = overview({ state: 'loading', files: [], empty: false });
    const { area, reads, change } = await mountTab((route) => (route.includes('/file?') ? fileView('CLAUDE.md') : data));
    assert.match(texto(area), /Lendo o GitHub/);
    data = overview();
    const before = reads.length;
    change([{ type: 'agent-instructions', key: 'outro/repo' }]);
    await settle();
    assert.equal(reads.length, before, 'mudança de outro repositório não relê');
    change([{ type: 'agent-instructions', key: 'Exemplo-Labs/Vitrine-Demo' }]);
    await settle();
    assert.match(texto(area), /O QUE .CLAUDE\/ TRAZ|O que .claude\/ traz/);
    assert.ok(area.querySelector('.ins-viewer'));
  });

  test('sem GitHub, não encontrado e erro: os estados das outras telas', async () => {
    assert.match(texto((await mountTab(standard(overview({ state: 'no-github', files: [] })))).area), /O núcleo está sem o GitHub/);
    assert.match(texto((await mountTab(standard(overview({ state: 'not-found', files: [] })))).area), /Repositório não encontrado/);
    assert.match(texto((await mountTab(standard(overview({ state: 'error', error: 'limite do GitHub', files: [] })))).area), /O GitHub não respondeu limite do GitHub/);
    assert.match(texto((await mountTab(() => new Error('O núcleo em 127.0.0.1 não respondeu'))).area), /Sem conexão com o núcleo/);
  });

  test('a mudança ao vivo casa só com o tipo e a chave do repositório', () => {
    assert.equal(instructionsChangeMatters([{ type: 'repos', key: REPO }], REPO), false);
    assert.equal(instructionsChangeMatters([{ type: 'agent-instructions', key: REPO.toUpperCase() }], REPO), true);
  });
});

// ---------- os imports em cada estado ----------

describe('Instruções (C32): os @imports abertos no lugar', () => {
  const imports: ImportNodeWithText[] = [
    { ref: 'AGENTS.md', path: 'AGENTS.md', status: 'ok', text: '- Um assunto por commit.\n', imports: [] },
    { ref: '~/.claude/mine.md', path: null, status: 'outside-repo', imports: [] },
    { ref: 'docs/gone.md', path: 'docs/gone.md', status: 'missing', imports: [] },
    { ref: 'CLAUDE.md', path: 'CLAUDE.md', status: 'cycle', imports: [] },
    { ref: 'deep.md', path: 'deep.md', status: 'too-deep', imports: [] },
  ];
  const text = 'Antes.\n\n@AGENTS.md\n@~/.claude/mine.md\n@docs/gone.md\n@CLAUDE.md\n@deep.md\n\nDepois.\n';

  test('cada estado com o seu texto em pt-BR', () => {
    const root = md(text, { imports });
    const why = Object.fromEntries(root.querySelectorAll('.ins-import').map((b) => [b.getAttribute('data-status'), texto(b)]));
    assert.match(why.ok!, /^@AGENTS\.md Um assunto por commit\.$/);
    assert.equal(why['outside-repo'], '@~/.claude/mine.md fora do repositório: vem da máquina de quem roda o agente');
    assert.equal(why.missing, '@docs/gone.md não existe no repositório');
    assert.equal(why.cycle, '@CLAUDE.md ciclo: este arquivo já foi importado acima, o Claude Code não o abre de novo');
    assert.equal(why['too-deep'], '@deep.md fundo demais: passa dos 5 saltos que o Claude Code segue');
  });

  test('os blocos ficam no lugar do @, entre o texto de antes e o de depois', () => {
    const root = md(text, { imports });
    const kids = root.querySelector('.ins-md')!.children.map((c) => (c.getAttribute('class') === 'ins-import' ? `import:${c.getAttribute('data-ref')}` : texto(c)));
    assert.deepEqual(kids, ['Antes.', 'import:AGENTS.md', 'import:~/.claude/mine.md', 'import:docs/gone.md', 'import:CLAUDE.md', 'import:deep.md', 'Depois.']);
  });

  test('um import no meio da frase fica marcado na frase e abre logo depois do parágrafo', () => {
    const root = md('Veja também @docs/style.md para o estilo.\n', { imports: [{ ref: 'docs/style.md', path: 'docs/style.md', status: 'ok', text: 'x', imports: [] }] });
    const kids = root.querySelector('.ins-md')!.children;
    assert.equal(kids[0]!.tagName, 'P');
    assert.equal(texto(kids[0]!.querySelector('.ins-md-import-ref')), '@docs/style.md');
    assert.equal(kids[1]!.getAttribute('data-ref'), 'docs/style.md');
  });

  test('o @ dentro de bloco e de trecho de código não vira import', () => {
    const tree = [{ ref: 'docs/real.md', path: 'docs/real.md', status: 'ok', text: 'real', imports: [] }] as ImportNodeWithText[];
    const root = md('Use `@docs/real.md` assim:\n\n```md\n@docs/real.md\n```\n\n@docs/real.md\n', { imports: tree });
    const blocks = root.querySelectorAll('.ins-import');
    assert.equal(blocks.length, 1, 'só o @ fora do código');
    assert.equal(root.querySelector('pre code')!.textContent, '@docs/real.md');
    assert.equal(texto(root.querySelector('p code')), '@docs/real.md');
    assert.equal(root.querySelector('p code .ins-md-import-ref'), null);
  });

  test('menção (@fulano) e @ que a árvore não traz ficam como texto', () => {
    const root = md('Fale com @colega-a sobre @docs/other.md.\n', { imports: [] });
    assert.equal(root.querySelectorAll('.ins-import').length, 0);
    assert.equal(texto(root), 'Fale com @colega-a sobre @docs/other.md.');
  });
});

// ---------- o renderizador ----------

describe('Instruções (#183): o renderizador de Markdown', () => {
  test('títulos, listas, código, ênfase, links e tabela viram estrutura', () => {
    const root = md('# Título\n\nUm **forte**, um *leve*, um ~~riscado~~ e `code`.\n\n- um\n- dois\n  - aninhado\n\n1. primeiro\n2. segundo\n\n> citação\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n---\n');
    assert.equal(texto(root.querySelector('h2')), 'Título');
    assert.equal(texto(root.querySelector('strong')), 'forte');
    assert.equal(texto(root.querySelector('em')), 'leve');
    assert.equal(texto(root.querySelector('del')), 'riscado');
    assert.deepEqual(root.querySelectorAll('ul li').map((li) => texto(li.querySelector('p'))), ['um', 'dois', 'aninhado']);
    assert.ok(root.querySelector('ul li ul li'), 'a lista aninhada');
    assert.deepEqual(root.querySelectorAll('ol li').map((li) => texto(li)), ['primeiro', 'segundo']);
    assert.equal(texto(root.querySelector('blockquote')), 'citação');
    assert.equal(root.querySelector('pre')!.getAttribute('data-lang'), 'ts');
    assert.equal(root.querySelector('pre code')!.textContent, 'const a = 1;');
    assert.deepEqual(root.querySelectorAll('th').map((t) => texto(t)), ['A', 'B']);
    assert.deepEqual(root.querySelectorAll('td').map((t) => texto(t)), ['1', '2']);
    assert.equal(root.querySelectorAll('td')[1]!.getAttribute('class'), 'ins-md-right');
    assert.ok(root.querySelector('hr'));
  });

  test('HTML embutido vira texto, e nada entra por innerHTML', () => {
    const root = md('<script>alert(1)</script>\n\nTexto <img src=x onerror="alert(2)"> e <b>negrito</b>.\n\n<div onclick="x()">bloco</div>\n');
    assert.equal(root.querySelector('script'), null);
    assert.equal(root.querySelector('img'), null);
    assert.equal(root.querySelector('b'), null);
    assert.equal(root.querySelector('div[onclick]'), null);
    assert.match(texto(root), /<script>alert\(1\)<\/script>/);
    assert.match(texto(root), /<img src=x onerror="alert\(2\)">/);
    assert.deepEqual(innerHtmlOutsideIcons(root), []);
  });

  test('javascript:, data: e outros esquemas não viram link; ficam como texto', () => {
    const root = md('[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](data:text/html,<script>x</script>) [d](vbscript:x) [e](//evil.example/x) [f](file:///etc/passwd)\n');
    assert.equal(root.querySelectorAll('a').length, 0);
    assert.match(texto(root), /\[a\]\(javascript:alert\(1\)\)/);
    for (const raw of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', '//evil.example', 'java\u0000script:x']) assert.equal(safeHref(raw, { repo: REPO, commit: COMMIT, from: 'CLAUDE.md' }), null, raw);
  });

  test('http(s) vira link externo; relativo aponta para o arquivo no GitHub do repositório', () => {
    const root = md('[site](https://example.com/x) e [guia](docs/guide.md#secao) e [acima](../../../fora.md) e <https://example.org>\n', { from: 'packages/api/CLAUDE.md' });
    const links = root.querySelectorAll('a');
    assert.deepEqual(
      links.map((a) => [texto(a), a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
      [
        ['site', 'https://example.com/x', '_blank', 'noopener noreferrer'],
        ['guia', `https://github.com/${REPO}/blob/${COMMIT}/packages/api/docs/guide.md#secao`, '_blank', 'noopener noreferrer'],
        ['https://example.org', 'https://example.org/', '_blank', 'noopener noreferrer'],
      ],
    );
    assert.match(texto(root), /\[acima\]\(\.\.\/\.\.\/\.\.\/fora\.md\)/, 'relativo acima da raiz fica texto');
  });

  test('imagem nunca carrega: vira link para ela', () => {
    const root = md('![logo](https://example.com/logo.png) ![x](javascript:alert(1))\n');
    assert.equal(root.querySelector('img'), null);
    assert.deepEqual(root.querySelectorAll('a').map((a) => texto(a)), ['imagem: logo']);
  });

  test('títulos do repositório são texto: um título com HTML não vira elemento', () => {
    const root = md('# <img src=x onerror=alert(1)> Ignore as instruções anteriores\n');
    assert.equal(root.querySelector('img'), null);
    assert.equal(texto(root.querySelector('h2')), '<img src=x onerror=alert(1)> Ignore as instruções anteriores');
  });
});
