// Instalar o Ahrena Framework num repositório, por PR (C34 a C37, issue 184), dentro da aba Instruções.
// A aba (agent-instructions.js) lê o plano e mostra o card do topo (`installCard`); "Instalar" troca o
// conteúdo da aba pelo fluxo em três passos (`mountInstallFlow`), sem trocar de tela.
//
// - `GET /api/framework-install/<owner>/<repo>/plan?platforms=&plugins=`: o que achamos, as escolhas e
//   o plano com o diff (src/api/framework-install.ts). Mudar a escolha relê o plano por essa rota.
// - `POST /api/framework-install/<owner>/<repo>` abre o PR. O 409 `plan-changed` avisa e recarrega a
//   prévia; o 422 `invalid-issue` volta ao campo da issue.
// - `GET …/pull-request`: o estado do PR, relido a cada mudança ao vivo
//   `{ type: 'framework-install', key: '<owner>/<repo>' }`.
// - O texto do repositório (o diff, os nomes) entra por `textContent`, nunca como HTML.

import { el, icon } from '../dom.js';
import { loading } from '../states.js';
import { ago } from '../repos-format.js';

const REREAD_MS = 5000;
const OTHERS_SHOWN = 4;

export function loadInstallStyle() {
  if (!document.querySelector('link[data-screen="framework-install"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/framework-install.css', 'data-screen': 'framework-install' }));
}

export const installBase = (owner, name) => `/api/framework-install/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

/** A rota do plano para uma escolha; sem escolha, o padrão do núcleo. */
export function planRoute(owner, name, choice = null, { refresh = false } = {}) {
  const q = [];
  if (choice) q.push(`platforms=${choice.platforms.map(encodeURIComponent).join(',')}`, `plugins=${choice.plugins.map(encodeURIComponent).join(',')}`);
  if (refresh) q.push('refresh=1');
  return `${installBase(owner, name)}/plan${q.length ? `?${q.join('&')}` : ''}`;
}

/** A mudança ao vivo diz respeito a este repositório. */
export const installChangeMatters = (changes, key) => (changes ?? []).some((c) => c?.type === 'framework-install' && String(c.key).toLowerCase() === key.toLowerCase());

/** O campo da issue: vazio é nenhuma; senão, só o número (aceita `#` na frente). */
export function parseIssueField(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, value: null };
  const t = raw.replace(/^#/, '');
  if (!/^[1-9]\d{0,9}$/.test(t)) return { ok: false, value: null };
  return { ok: true, value: Number(t) };
}

/** O nome do plugin sem o prefixo do marketplace, como o wireframe mostra. */
export const pluginLabel = (name) => String(name).replace(/^ahrena-/, '');

const ACTION_LABEL = { create: 'criar', merge: 'mesclar', unchanged: 'sem mudança', refused: 'recusado' };

/**
 * As linhas do diff unificado para a tela: `[{ kind: ' ' | '+' | '-' | '@', n, text }]`. `n` é o
 * número da linha antes da mudança (nas de contexto e nas que saem); nas que entram, vazio.
 */
export function diffLines(text) {
  const out = [];
  let old = 0;
  for (const line of String(text ?? '').replace(/\n$/, '').split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      out.push({ kind: '@', n: '', text: line });
      continue;
    }
    if (line === '' && !out.length) continue;
    const kind = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
    const body = line.slice(1);
    if (kind === '+') out.push({ kind, n: '', text: body });
    else out.push({ kind, n: String(old++ || ''), text: body });
  }
  return out;
}

/** Os totais da prévia: arquivos que mudam, linhas que entram e saem. */
export function planTotals(plan) {
  const files = (plan?.files ?? []).filter((f) => f.action === 'create' || f.action === 'merge');
  return { files: files.length, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0) };
}

/** Os selos do PR: estado, CI e review, `{ text, tone }`. */
export function pullRequestBadges(pr) {
  const out = [];
  out.push(pr.state === 'merged' ? { text: 'Mesclado', tone: 'ok' } : pr.state === 'closed' ? { text: 'Fechado', tone: 'muted' } : { text: 'Aberto', tone: 'ok' });
  if (pr.checks === 'pending') out.push({ text: 'CI …', tone: 'wait' });
  else if (pr.checks === 'success') out.push({ text: 'CI ok', tone: 'ok' });
  else if (pr.checks === 'failure') out.push({ text: 'CI falhou', tone: 'err' });
  return out;
}

export const reviewLabel = (review) => (review === 'approved' ? 'aprovado' : review === 'changes_requested' ? 'mudanças pedidas' : 'esperando');

/** O PR conta como instalação em andamento: aberto, ou mesclado e a leitura ainda sem o framework. */
export const activePullRequest = (plan) => (plan?.pullRequest && plan.pullRequest.state !== 'closed' ? plan.pullRequest : null);

/** Dá para instalar: plano pronto, sem o framework, sem PR em andamento e com escrita. */
export const canInstall = (plan) => !!plan && plan.state === 'ready' && !plan.installed && !activePullRequest(plan) && plan.canWrite;

const pill = (b) => el('span', { class: `fwi-pill fwi-pill-${b.tone}` }, b.text);

const githubLink = (url, label = 'Abrir no GitHub') => (url ? el('a', { class: 'btn outline', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), label) : null);

// ---------- o card do topo da aba (C34) ----------

/**
 * O card do topo da aba: sem o framework, "Instalar" (C34); com o PR de instalação em andamento, o PR;
 * sem escrita, o aviso sem botão (C37). Com o framework instalado (ou sem plano), nada: `null`.
 * `{ inEmpty }`: no vazio (C33) o botão fica no próprio card do vazio, e este só aparece com PR ou sem escrita.
 */
export function installCard(plan, { onInstall, onFollow, inEmpty = false }) {
  if (!plan || plan.state !== 'ready' || plan.installed) return null;
  const pr = activePullRequest(plan);
  if (pr) {
    return el(
      'section',
      { class: 'card fwi-top', 'data-install': 'pull-request', 'aria-label': 'Instalação do Ahrena Framework' },
      el('span', { class: 'fwi-top-ico fwi-ok' }, icon('git-pull-request')),
      el(
        'div',
        { class: 'fwi-top-text' },
        el('b', {}, pr.state === 'merged' ? 'Ahrena Framework instalado pelo PR' : 'Instalação do Ahrena Framework em andamento'),
        el('span', { class: 'fwi-top-sub' }, el('span', { class: 'mono' }, `PR ${pr.number}`), ` · ${pr.title}`, ...pullRequestBadges(pr).map(pill)),
      ),
      el('span', { class: 'fwi-top-actions' }, el('button', { type: 'button', class: 'btn outline', onClick: onFollow }, 'Acompanhar'), githubLink(pr.url)),
    );
  }
  if (!plan.canWrite) {
    return el(
      'section',
      { class: 'card fwi-top', 'data-install': 'no-write', 'aria-label': 'Instalação do Ahrena Framework' },
      el('span', { class: 'fwi-top-ico' }, icon('package-plus')),
      el(
        'div',
        { class: 'fwi-top-text' },
        el('b', {}, 'Sem Ahrena Framework'),
        el('span', { class: 'fwi-top-sub fwi-wait' }, icon('lock'), el('span', {}, el('b', {}, 'Sem permissão de escrita.'), ` ${plan.writeBlockedReason ?? 'Instalar abre um PR; sua conta só lê este repositório.'}`)),
      ),
    );
  }
  if (inEmpty) return null;
  const has = plan.found?.files ?? {};
  const what = has['CLAUDE.md'] ? 'o CLAUDE.md abaixo' : has['AGENTS.md'] ? 'o AGENTS.md abaixo' : 'as instruções abaixo';
  return el(
    'section',
    { class: 'card fwi-top', 'data-install': 'start', 'aria-label': 'Instalação do Ahrena Framework' },
    el('span', { class: 'fwi-top-ico' }, icon('package-plus')),
    el('div', { class: 'fwi-top-text' }, el('b', {}, 'Sem Ahrena Framework'), el('span', { class: 'fwi-top-sub' }, `Os agentes daqui só levam ${what}. Instalar abre um PR com as regras, as skills e os agentes do framework para o Claude Code e o Codex.`)),
    el('span', { class: 'fwi-top-actions' }, el('button', { type: 'button', class: 'btn filled', 'data-action': 'install', onClick: onInstall }, icon('package-plus'), 'Instalar')),
  );
}

/** O botão do vazio (C33): "Instalar o Ahrena Framework". */
export function installEmptyButton(onInstall) {
  return el('button', { type: 'button', class: 'btn filled', 'data-action': 'install', onClick: onInstall }, icon('package-plus'), 'Instalar o Ahrena Framework');
}

// ---------- o fluxo em três passos (C35, C36, C37) ----------

const STEPS = ['Plataformas e plugins', 'Prévia do diff', 'Pull request'];

function stepper(on) {
  const parts = [];
  STEPS.forEach((t, i) => {
    parts.push(
      el(
        'span',
        { class: 'fwi-step', 'data-state': i < on ? 'done' : i === on ? 'current' : 'next', 'aria-current': i === on ? 'step' : null },
        el('span', { class: 'fwi-step-n', 'aria-hidden': 'true' }, i < on ? '✓' : String(i + 1)),
        t,
      ),
    );
    if (i < STEPS.length - 1) parts.push(el('span', { class: 'fwi-step-sep', 'aria-hidden': 'true' }, icon('chevron-right')));
  });
  return el('ol', { class: 'fwi-steps', 'aria-label': 'Passos da instalação' }, ...parts.map((p) => (p.classList.contains('fwi-step') ? el('li', {}, p) : el('li', { class: 'fwi-step-li-sep' }, p))));
}

function box(checked, locked) {
  return el('span', { class: 'fwi-box', 'data-checked': String(!!checked), 'data-locked': locked ? 'true' : null, 'aria-hidden': 'true' }, checked ? '✓' : '');
}

/**
 * Monta o fluxo em `area` (o conteúdo da aba). `plan` é o plano já lido (o padrão); `step` 0, 1 ou 2.
 * Devolve `{ live(), leave() }`: a aba repassa a mudança ao vivo e desmonta ao sair.
 */
export function mountInstallFlow(area, ctx, { owner, name, plan: first, step: firstStep = 0, onClose }) {
  loadInstallStyle();
  const base = installBase(owner, name);
  let plan = first;
  let step = firstStep;
  let choice = first?.choice ? { platforms: [...first.choice.platforms], plugins: [...first.choice.plugins] } : null;
  let busy = false;
  let sending = false;
  let notice = null; // { tone: 'err' | 'wait', title, text }
  let issueText = '';
  let issueError = null;
  let title = first?.title ?? '';
  let titleTouched = false;
  let openFile = null;
  let showOthers = false;
  let pr = firstStep === 2 ? first?.pullRequest ?? null : null;
  let submitted = null; // { files, add, del, plugins } do plano que abriu o PR
  let request = 0;
  let timer = null;
  let alive = true;

  const root = el('div', { class: 'fwi-flow' });
  area.replaceChildren(root);

  async function reread({ refresh = false } = {}) {
    clearTimeout(timer);
    timer = null;
    const n = ++request;
    busy = true;
    draw();
    try {
      const d = await ctx.read(planRoute(owner, name, choice, { refresh }));
      if (!alive || n !== request) return;
      plan = d;
      if (d.choice) choice = { platforms: [...d.choice.platforms], plugins: [...d.choice.plugins] };
      if (!titleTouched && d.title) title = d.title;
      if (d.state === 'loading') timer = setTimeout(() => reread(), REREAD_MS);
    } catch (e) {
      if (e?.name === 'AbortError' || !alive || n !== request) return;
      notice = { tone: 'err', title: 'Não recalculamos o plano.', text: `${e?.message ?? e}. A escolha anterior continua valendo.` };
    }
    busy = false;
    draw();
  }

  async function rereadPullRequest() {
    try {
      const r = await ctx.read(`${base}/pull-request`);
      if (!alive) return;
      if (r?.pullRequest) pr = r.pullRequest;
      draw();
    } catch {
      // A leitura do PR falhar não apaga o que já está na tela; a próxima mudança relê.
    }
  }

  function close() {
    leave();
    onClose?.();
  }

  function leave() {
    alive = false;
    clearTimeout(timer);
    timer = null;
    request++;
  }

  // ---------- desenho ----------
  function draw() {
    if (!alive) return;
    const head = el(
      'section',
      { class: 'card fwi-head', 'aria-label': 'Instalar o Ahrena Framework' },
      el('div', { class: 'fwi-head-l1' }, el('span', { class: 'fwi-accent fwi-head-ico' }, icon('package-plus')), el('h2', { class: 'fwi-head-title' }, 'Instalar o Ahrena Framework'), el('span', { class: 'fwi-head-actions' }, ...headActions())),
      stepper(step),
    );
    const parts = [head];
    if (notice) parts.push(band(notice));
    if (!plan || plan.state === 'loading') parts.push(loading({ label: 'Lendo o repositório…' }));
    else if (plan.state !== 'ready') parts.push(band({ tone: 'err', title: 'O plano não saiu.', text: plan.error ?? 'O GitHub não respondeu.' }));
    else if (step === 0) parts.push(...stepChoose());
    else if (step === 1) parts.push(...stepPreview());
    else parts.push(...stepPullRequest());
    root.replaceChildren(...parts);
  }

  function headActions() {
    if (step === 0) {
      return [
        el('button', { type: 'button', class: 'btn outline', 'data-action': 'cancel', onClick: close }, 'Cancelar'),
        el('button', { type: 'button', class: 'btn filled', 'data-action': 'preview', disabled: busy || !plan || plan.state !== 'ready' ? true : null, onClick: () => go(1) }, 'Ver a prévia', icon('arrow-right')),
      ];
    }
    if (step === 1) {
      const blocked = !plan || plan.state !== 'ready' || !!plan.blocked || !plan.canWrite;
      return [
        el('button', { type: 'button', class: 'btn outline', 'data-action': 'back', onClick: () => go(0) }, icon('back'), 'Voltar'),
        blocked ? null : el('button', { type: 'button', class: 'btn filled', 'data-action': 'open-pr', disabled: busy || sending ? true : null, onClick: submit }, icon('git-pull-request'), sending ? 'Abrindo…' : 'Abrir PR'),
      ];
    }
    return [githubLink(pr?.url), el('button', { type: 'button', class: 'btn outline', 'data-action': 'close', onClick: close }, 'Fechar')];
  }

  function go(next) {
    if (busy && next === 1) return;
    step = next;
    notice = null;
    draw();
  }

  function band({ tone, title: t, text, iconName }) {
    return el('div', { class: `fwi-band fwi-band-${tone}`, role: tone === 'err' ? 'alert' : 'status' }, icon(iconName ?? (tone === 'err' ? 'error' : 'alert')), el('p', {}, el('b', {}, t), text ? ` ${text}` : null));
  }

  // ---------- passo 1: plataformas e plugins (C35) ----------
  function stepChoose() {
    return [foundCard(), el('div', { class: 'fwi-choose' }, platformsCard(), pluginsCard())];
  }

  function foundCard() {
    const f = plan.found ?? {};
    const chips = [];
    for (const l of f.languages ?? []) chips.push(l);
    for (const fw of f.frameworks ?? []) chips.push(fw);
    if (f.tests) chips.push(`testes em ${f.tests}`);
    if (f.ci) chips.push(`CI no ${f.ci}`);
    const existing = Object.entries(f.files ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (existing.length) chips.push(`${existing.join(' e ').replace(/ e (?=.* e )/g, ', ')} já ${existing.length === 1 ? 'existe' : 'existem'}`);
    return el(
      'section',
      { class: 'card fwi-found', 'aria-label': 'O que achamos no repositório' },
      el('span', { class: 'fwi-muted fwi-found-label' }, icon('search'), 'No repositório:'),
      ...(chips.length ? chips.map((c) => el('span', { class: 'fwi-chip' }, c)) : [el('span', { class: 'fwi-muted' }, 'nenhuma linguagem, teste ou CI que a gente reconheça')]),
    );
  }

  function toggle(list, value) {
    return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
  }

  function platformsCard() {
    const items = (plan.platforms ?? []).map((p) => {
      const on = choice.platforms.includes(p.id);
      const b = el(
        'button',
        { type: 'button', role: 'checkbox', class: 'fwi-plat', 'data-platform': p.id, 'aria-checked': String(on), 'aria-disabled': p.available ? null : 'true', disabled: p.available ? null : true },
        box(on),
        el('span', { class: 'fwi-plat-text' }, el('b', {}, p.label), el('span', { class: 'fwi-plat-detail' }, p.detail), p.note ? el('span', { class: 'fwi-note' }, p.note) : null),
      );
      if (p.available) {
        b.addEventListener('click', () => {
          const next = toggle(choice.platforms, p.id);
          // Ao menos uma plataforma: sem nenhuma não há o que instalar.
          if (!next.length) return;
          choice = { ...choice, platforms: next };
          reread();
        });
      }
      return b;
    });
    return el(
      'section',
      { class: 'card fwi-card', 'aria-label': 'Plataformas' },
      el('h3', { class: 'fwi-ttl' }, icon('monitor'), 'Plataformas'),
      ...items,
      el('span', { class: 'fwi-muted fwi-foot' }, 'O Claude Code vai completo: plugins no settings.json e o índice pelo import no CLAUDE.md. O Codex lê o mesmo AGENTS.md. Plugins no Codex e o Cursor ficam a confirmar.'),
    );
  }

  function pluginRow(p) {
    const on = choice.plugins.includes(p.name);
    const why = p.group === 'suggested' ? p.why ?? p.description : p.description;
    const b = el(
      'button',
      { type: 'button', role: 'checkbox', class: 'fwi-plug', 'data-plugin': p.name, 'aria-checked': String(on), 'aria-disabled': p.locked ? 'true' : null, title: p.locked ? `${p.name}: base, sempre instalado` : p.name },
      box(on, p.locked),
      el('span', { class: 'mono fwi-plug-name' }, pluginLabel(p.name)),
      why ? el('span', { class: 'fwi-plug-why', title: why }, why) : null,
    );
    if (!p.locked) {
      b.addEventListener('click', () => {
        choice = { ...choice, plugins: toggle(choice.plugins, p.name) };
        reread();
      });
    }
    return b;
  }

  function pluginsCard() {
    const all = plan.plugins ?? [];
    const group = (g) => all.filter((p) => p.group === g);
    const others = group('other');
    const shown = showOthers ? others : others.slice(0, OTHERS_SHOWN);
    const more =
      others.length > OTHERS_SHOWN
        ? el(
            'button',
            {
              type: 'button',
              class: 'fwi-link',
              'data-action': 'more',
              'aria-expanded': String(showOthers),
              onClick: () => {
                showOthers = !showOthers;
                draw();
              },
            },
            showOthers ? 'mostrar menos' : `mostrar os ${others.length}`,
          )
        : null;
    return el(
      'section',
      { class: 'card fwi-card', 'aria-label': 'Plugins', 'aria-busy': busy ? 'true' : null },
      el('h3', { class: 'fwi-ttl' }, icon('plug'), 'Plugins', el('span', { class: 'fwi-ttl-r' }, busy ? 'recalculando…' : `${choice.plugins.length} de ${all.length} · ${plan.frameworkRepo}`)),
      el('div', { class: 'eyebrow fwi-eyebrow' }, 'Base, sempre'),
      ...group('base').map(pluginRow),
      group('suggested').length ? el('div', { class: 'eyebrow fwi-eyebrow' }, 'Pelo que o repositório tem') : null,
      ...group('suggested').map(pluginRow),
      others.length ? el('div', { class: 'eyebrow fwi-eyebrow fwi-eyebrow-row' }, el('span', {}, 'Outros'), more) : null,
      others.length ? el('div', { class: 'fwi-others' }, ...shown.map(pluginRow)) : null,
    );
  }

  // ---------- passo 2: a prévia do diff (C36) ----------
  function stepPreview() {
    const parts = [];
    const b = plan.blocked;
    if (b?.kind === 'invalid-json') {
      parts.push(
        el(
          'div',
          { class: 'fwi-band fwi-band-err', role: 'alert', 'data-blocked': 'invalid-json' },
          icon('error'),
          el('p', {}, el('b', {}, 'Não dá para abrir o PR.'), ' O ', el('code', {}, b.path ?? '.claude/settings.json'), ' deste repositório não é um JSON válido; corrija e tente de novo. Nada foi escrito.'),
        ),
      );
    } else if (b?.kind === 'no-write' || !plan.canWrite) {
      parts.push(
        el(
          'div',
          { class: 'fwi-band fwi-band-wait', role: 'status', 'data-blocked': 'no-write' },
          icon('lock'),
          el('p', {}, el('b', {}, 'Sem permissão de escrita.'), ` ${b?.message ?? plan.writeBlockedReason ?? 'Instalar abre um PR; sua conta só lê este repositório.'}`),
        ),
      );
    } else if (b) {
      parts.push(el('div', { class: 'fwi-band fwi-band-wait', role: 'status', 'data-blocked': b.kind }, icon('alert'), el('p', {}, el('b', {}, 'Nada para abrir.'), ` ${b.message}`)));
    }
    const files = plan.files ?? [];
    if (!openFile || !files.some((f) => f.path === openFile)) openFile = (files.find((f) => f.action === 'refused') ?? files.find((f) => f.action !== 'unchanged') ?? files[0])?.path ?? null;
    const t = planTotals(plan);
    const list = el(
      'nav',
      { class: 'card fwi-files', 'aria-label': 'Arquivos do PR' },
      el('div', { class: 'eyebrow fwi-eyebrow' }, `${t.files} ${t.files === 1 ? 'arquivo' : 'arquivos'} · +${t.add} −${t.del}`),
      ...files.map((f) => {
        const item = el(
          'button',
          { type: 'button', class: 'fwi-file', 'data-path': f.path, 'aria-current': f.path === openFile ? 'true' : null, title: f.path },
          el('span', { class: 'mono fwi-trunc' }, f.path),
          el('span', { class: 'fwi-action', 'data-action': f.action }, ACTION_LABEL[f.action] ?? f.action),
          f.action === 'refused' || f.action === 'unchanged' ? null : el('span', { class: 'mono fwi-add' }, `+${f.add}`),
        );
        item.addEventListener('click', () => {
          openFile = f.path;
          draw();
        });
        return item;
      }),
    );
    parts.push(el('div', { class: 'fwi-preview' }, el('div', { class: 'fwi-preview-side' }, list, prCard()), diffCard(files.find((f) => f.path === openFile))));
    return parts;
  }

  function prCard() {
    const titleInput = el('input', { type: 'text', class: 'fwi-input', maxlength: '256', 'aria-label': 'Título do PR', 'data-field': 'title' });
    titleInput.value = title;
    titleInput.addEventListener('input', () => {
      title = titleInput.value;
      titleTouched = true;
    });
    const issueInput = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'número', 'aria-label': 'Issue (opcional)', 'data-field': 'issue', 'aria-invalid': issueError ? 'true' : null });
    issueInput.value = issueText;
    const issueHint = el('span', { class: issueError ? 'fwi-hint fwi-err' : 'fwi-hint', role: issueError ? 'alert' : null, 'data-hint': 'issue' }, issueError ?? 'Com número, o PR leva Refs #N; vazio, nenhuma referência.');
    issueInput.addEventListener('input', () => {
      issueText = issueInput.value;
      const ok = parseIssueField(issueText).ok;
      issueError = ok ? null : 'Só o número da issue, como 42.';
      issueInput.setAttribute('aria-invalid', ok ? 'false' : 'true');
      issueHint.textContent = issueError ?? 'Com número, o PR leva Refs #N; vazio, nenhuma referência.';
      issueHint.setAttribute('class', issueError ? 'fwi-hint fwi-err' : 'fwi-hint');
    });
    return el(
      'section',
      { class: 'card fwi-card fwi-pr-form', 'aria-label': 'O PR' },
      el('h3', { class: 'fwi-ttl' }, icon('branch'), 'O PR'),
      el('span', { class: 'fwi-muted' }, 'Branch novo'),
      el('span', { class: 'mono fwi-branch' }, plan.branch),
      el('span', { class: 'fwi-muted' }, 'a partir do branch padrão, um commit, sem tocar nele.'),
      el('label', { class: 'fwi-label' }, el('span', { class: 'fwi-muted' }, 'Título'), titleInput),
      el('label', { class: 'fwi-label' }, el('span', { class: 'fwi-muted' }, 'Issue (opcional)'), el('span', { class: 'fwi-issue' }, el('span', { class: 'fwi-muted', 'aria-hidden': 'true' }, '#'), issueInput)),
      issueHint,
      el('span', { class: 'fwi-written' }, icon('info'), 'Nada foi escrito ainda.'),
    );
  }

  function diffCard(f) {
    if (!f) return el('section', { class: 'card fwi-diff' }, el('p', { class: 'fwi-muted fwi-diff-empty' }, 'Nenhum arquivo no plano.'));
    const head = el(
      'header',
      { class: 'fwi-diff-head' },
      el('b', { class: 'mono fwi-diff-path' }, f.path),
      el('span', { class: 'fwi-action', 'data-action': f.action }, ACTION_LABEL[f.action] ?? f.action),
      el('span', { class: 'fwi-muted fwi-diff-why' }, f.why),
    );
    let body;
    if (f.action === 'refused') body = el('p', { class: 'fwi-diff-empty fwi-err', role: 'alert' }, `Este arquivo não entra no PR: ${f.why}.`);
    else if (!f.diff) body = el('p', { class: 'fwi-muted fwi-diff-empty' }, 'Sem mudança: o arquivo já tem o que o framework põe.');
    else {
      body = el(
        'div',
        { class: 'fwi-diff-body', role: 'table', 'aria-label': `Diff de ${f.path}` },
        ...diffLines(f.diff).map((l) =>
          el('div', { class: 'fwi-line', 'data-kind': l.kind === '@' ? 'hunk' : l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx', role: 'row' }, el('span', { class: 'fwi-ln' }, l.n), el('span', { class: 'fwi-sign' }, l.kind === '@' ? '' : l.kind), el('span', { class: 'fwi-code' }, l.text)),
        ),
      );
    }
    return el('section', { class: 'card fwi-diff', 'aria-label': `Prévia de ${f.path}` }, head, body);
  }

  async function submit() {
    if (sending || busy) return;
    const issue = parseIssueField(issueText);
    if (!issue.ok) {
      issueError = 'Só o número da issue, como 42.';
      notice = { tone: 'err', title: 'Confira a issue.', text: 'O campo aceita só o número da issue (ou fica vazio).' };
      return draw();
    }
    sending = true;
    notice = null;
    draw();
    const body = { platforms: choice.platforms, plugins: choice.plugins, planHash: plan.planHash, title: title.trim() || undefined, issue: issue.value ?? undefined };
    try {
      const r = await ctx.write(base, body);
      if (!alive) return;
      const t = planTotals(plan);
      submitted = { ...t, plugins: choice.plugins.length };
      pr = r.pullRequest;
      step = 2;
      if (r.status === 'already-open') notice = { tone: 'wait', title: 'O PR já estava aberto.', text: 'Mostrando o PR de instalação que já existe.', iconName: 'info' };
    } catch (e) {
      if (!alive || e?.name === 'AbortError') return;
      const code = e?.body?.code;
      if (code === 'plan-changed') {
        notice = { tone: 'wait', title: 'O repositório mudou desde a prévia.', text: 'Recarregamos a prévia com o que está no GitHub agora; confira e abra o PR de novo.' };
        sending = false;
        return reread({ refresh: true });
      }
      if (code === 'invalid-issue') {
        issueError = 'Só o número da issue, como 42.';
        notice = { tone: 'err', title: 'Confira a issue.', text: e.message };
      } else notice = { tone: 'err', title: 'Não abrimos o PR.', text: `${e?.message ?? e}. Nada foi escrito.` };
    }
    sending = false;
    draw();
  }

  // ---------- passo 3: o PR aberto (C37) ----------
  function stepPullRequest() {
    if (!pr) return [el('section', { class: 'card fwi-card' }, el('p', { class: 'fwi-muted' }, 'Lendo o PR…'))];
    const legend = [
      el('span', {}, 'Branch ', el('b', { class: 'mono' }, pr.branch), ' → ', el('b', { class: 'mono' }, pr.base)),
      submitted ? el('span', {}, 'Arquivos ', el('b', {}, String(submitted.files))) : null,
      submitted ? el('span', {}, 'Linhas ', el('b', {}, `+${submitted.add} −${submitted.del}`)) : null,
      submitted ? el('span', {}, 'Plugins ', el('b', {}, String(submitted.plugins))) : null,
      el('span', { 'data-field': 'review' }, 'Review ', el('b', {}, reviewLabel(pr.review))),
    ];
    const n = submitted?.plugins;
    return [
      el(
        'section',
        { class: 'card fwi-card fwi-pr', 'aria-label': `PR ${pr.number}`, 'data-state': pr.state },
        el('div', { class: 'fwi-pr-l1' }, el('span', { class: 'fwi-ok fwi-pr-ico' }, icon('git-pull-request')), el('b', { class: 'fwi-pr-title' }, `PR ${pr.number} · ${pr.title}`), ...pullRequestBadges(pr).map(pill), el('span', { class: 'fwi-muted fwi-pr-when' }, ago(pr.updatedAt))),
        el('div', { class: 'fwi-legend' }, ...legend),
        el('span', { class: 'fwi-muted' }, `Depois do merge, quem abrir o repositório no Claude Code recebe a oferta de instalar ${n ? `os ${n} plugins` : 'os plugins'}; no Codex, o AGENTS.md já vale.`),
      ),
    ];
  }

  draw();
  if (!plan || plan.state === 'loading') reread();
  else if (step === 2 && !pr) rereadPullRequest();

  return {
    /** A mudança ao vivo deste repositório: relê o PR no passo 3 e o plano nos outros. */
    live() {
      if (!alive) return;
      if (step === 2) rereadPullRequest();
      else if (!busy && !sending) reread();
    },
    leave,
  };
}
