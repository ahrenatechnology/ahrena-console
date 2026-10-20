// O renderizador de Markdown da aba Instruções (C32, issue 183): um CLAUDE.md ou AGENTS.md vira títulos,
// listas, código, ênfase, links e tabelas, com os `@imports` abertos no lugar.
//
// O texto é DADO do repositório (estudo, "Segurança"):
// - nada vira HTML: cada pedaço entra com `createElement` e `textContent` (via `el`), e uma tag
//   escrita no Markdown (`<script>`, `<img onerror>`) aparece como texto;
// - link só `http(s)` ou relativo; o relativo aponta para o arquivo no GitHub do repositório, no
//   commit lido. `javascript:`, `data:`, `file:` e qualquer outro esquema ficam como texto;
// - imagem nunca carrega: vira um link para ela (ou texto, se o endereço não serve);
// - o `@` só vira bloco de import quando a árvore do núcleo traz aquele `@ref` (`tree.imports`), e
//   nunca dentro de código: blocos e trechos de código não são varridos.

import { el, icon } from '../dom.js';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const INSTRUCTION_FILE = /(^|\/)(CLAUDE|AGENTS)\.md$/;

/** A pasta de um caminho do repositório (`''` na raiz). */
const dirname = (path) => (path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Junta e normaliza dentro do repositório; `null` quando sobe acima da raiz. */
function resolvePath(base, rel) {
  const out = [];
  for (const part of `${base ? `${base}/` : ''}${rel}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/** O endereço do arquivo no GitHub, no commit lido (`HEAD` sem commit). */
export function blobUrl(repo, commit, path, hash = '') {
  if (!repo || !path) return null;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}/blob/${encodeURIComponent(commit || 'HEAD')}/${encoded}${hash ? `#${encodeURIComponent(hash)}` : ''}`;
}

/**
 * O `href` seguro de um link do Markdown, ou `null` (o link vira texto).
 * - `http(s)://…`: como está;
 * - relativo (`docs/x.md`, `../README.md`, `/docs/x.md`, `#secao`): o arquivo no GitHub do repositório;
 * - qualquer outro esquema (`javascript:`, `data:`, `mailto:`…), `//host` ou relativo acima da raiz: `null`.
 */
export function safeHref(raw, { repo = null, commit = null, from = '' } = {}) {
  const url = String(raw ?? '').trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  }
  if (SCHEME.test(url) || url.startsWith('//') || url.startsWith('\\') || /[\u0000-\u001f]/.test(url)) return null;
  if (!repo) return null;
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt + 1) : '';
  const pathPart = (hashAt >= 0 ? url.slice(0, hashAt) : url).split('?')[0];
  let target;
  try {
    target = pathPart ? resolvePath(pathPart.startsWith('/') ? '' : dirname(from), decodeURIComponent(pathPart)) : from;
  } catch {
    return null;
  }
  if (!target) return null;
  return blobUrl(repo, commit, target, hash);
}

// ---------- os imports ----------

/** O texto de cada estado de import, em pt-BR. */
export const IMPORT_STATUS = {
  ok: 'achado',
  'outside-repo': 'fora do repositório: vem da máquina de quem roda o agente',
  missing: 'não existe no repositório',
  cycle: 'ciclo: este arquivo já foi importado acima, o Claude Code não o abre de novo',
  'too-deep': 'fundo demais: passa dos 5 saltos que o Claude Code segue',
};

export const IMPORT_ICON = { ok: 'file-text', 'outside-repo': 'monitor', missing: 'error', cycle: 'repeat', 'too-deep': 'layers' };

/** A configuração cujo texto o núcleo nunca devolve (src/agent-instructions/read.ts, `CONFIG_PATHS`). */
const CONFIG_PATHS = new Set(['.claude/settings.json', '.mcp.json']);

const lineCount = (text) => String(text ?? '').replace(/\n$/, '').split('\n').length;

/** O import abre sozinho quando é um arquivo de instrução do primeiro salto (o `@AGENTS.md` do CLAUDE.md, C32). */
const opensByDefault = (node, depth) => depth === 0 && Boolean(node.path) && INSTRUCTION_FILE.test(node.path);

function importBlock(node, opts) {
  const depth = opts.depth ?? 0;
  const status = IMPORT_STATUS[node.status] ? node.status : 'missing';
  const ref = `@${node.ref ?? node.path ?? ''}`;
  const readable = status === 'ok' && typeof node.text === 'string';
  const box = el('div', { class: 'ins-import', 'data-status': status, 'data-ref': node.ref ?? '' });
  if (!readable) {
    box.append(
      el(
        'div',
        { class: 'ins-import-head' },
        icon(status === 'ok' ? 'file-text' : IMPORT_ICON[status]),
        el('span', { class: 'mono ins-import-ref' }, ref),
        el('span', { class: 'ins-import-why' }, status !== 'ok' ? IMPORT_STATUS[status] : CONFIG_PATHS.has(node.path) ? 'conteúdo não exibido: da configuração só sai o resumo, nos cards de .claude/' : 'achado, sem o texto lido'),
      ),
    );
    return box;
  }
  const n = lineCount(node.text);
  const chevron = el('span', { class: 'ins-import-chev' });
  const summary = el('span', { class: 'ins-import-sum' }, `${n} ${n === 1 ? 'linha' : 'linhas'} · clique para abrir`);
  const head = el('button', { type: 'button', class: 'ins-import-head', 'aria-expanded': 'false' }, chevron, el('span', { class: 'mono ins-import-ref' }, ref));
  const body = el('div', { class: 'ins-import-body', hidden: true });
  let drawn = false;
  const setOpen = (open) => {
    if (open && !drawn) {
      drawn = true;
      body.append(renderMarkdown(node.text, { ...opts, from: node.path, imports: node.imports ?? [], depth: depth + 1 }));
    }
    head.setAttribute('aria-expanded', String(open));
    chevron.replaceChildren(icon(open ? 'chevron-down' : 'chevron-right'));
    if (open) {
      body.removeAttribute('hidden');
      summary.remove();
    } else {
      body.setAttribute('hidden', '');
      box.insertBefore(summary, body);
    }
  };
  head.addEventListener('click', () => setOpen(head.getAttribute('aria-expanded') !== 'true'));
  box.append(head, body);
  setOpen(opensByDefault(node, depth));
  box.open = setOpen;
  return box;
}

// ---------- as linhas em linha (inline) ----------

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const IMPORT_AT = /^@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+)/;
const BARE_URL = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/i;

/** O fecho de `[texto]`, pulando trechos de código e colchetes aninhados; -1 sem fecho. */
function closingBracket(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

/** `[texto](destino "título")` a partir de `start` (o `[`): `{ label, dest, end }` ou `null`. */
function parseLink(src, start) {
  const close = closingBracket(src, start);
  if (close < 0 || src[close + 1] !== '(') return null;
  let depth = 0;
  let end = -1;
  for (let i = close + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const inside = src.slice(close + 2, end).trim();
  const m = /^(<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(inside);
  if (!m && inside !== '') return null;
  const dest = m ? m[1].replace(/^<|>$/g, '') : '';
  return { label: src.slice(start + 1, close), dest, end: end + 1 };
}

const isWord = (c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c) => c === undefined || /\s/.test(c);

/** O fecho de um delimitador de ênfase (`**`, `*`, `__`, `_`, `~~`); -1 sem fecho válido. */
function closingDelimiter(src, from, delim) {
  let j = from;
  for (;;) {
    j = src.indexOf(delim, j);
    if (j < 0) return -1;
    const before = src[j - 1];
    const after = src[j + delim.length];
    const sameAfter = after === delim[0] && delim.length === 1;
    if (j > from && !isSpace(before) && before !== '\\' && !sameAfter && !(delim[0] === '_' && isWord(after))) return j;
    j += delim.length;
  }
}

function inline(src, r) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(document.createTextNode(buf));
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const prev = src[i - 1];
    if (c === '\\' && src[i + 1] === '\n') {
      flush();
      out.push(el('br'));
      i += 2;
      continue;
    }
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '\n') {
      if (buf.endsWith('  ')) {
        buf = buf.replace(/ +$/, '');
        flush();
        out.push(el('br'));
      } else buf += ' ';
      i++;
      continue;
    }
    if (c === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let j = src.indexOf(fence, i + run);
      while (j >= 0 && src[j + run] === '`') j = src.indexOf(fence, j + run + 1);
      if (j >= 0) {
        flush();
        let code = src.slice(i + run, j).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out.push(el('code', { class: 'ins-md-code' }, code));
        i = j + run;
      } else {
        buf += fence;
        i += run;
      }
      continue;
    }
    // Dentro do rótulo de um link, nada vira outro link (`<a>` dentro de `<a>`): fica texto.
    if (!r.noLinks && (c === '[' || (c === '!' && src[i + 1] === '['))) {
      const image = c === '!';
      const link = parseLink(src, image ? i + 1 : i);
      if (link) {
        flush();
        const href = safeHref(link.dest, r);
        const original = src.slice(i, link.end);
        if (!href) out.push(el('span', { class: 'ins-md-unsafe', title: 'Link fora de http(s) e do repositório: mostrado como texto' }, original));
        else if (image) out.push(el('a', { class: 'ins-md-link', href, target: '_blank', rel: 'noopener noreferrer' }, `imagem: ${link.label || link.dest}`));
        else out.push(el('a', { class: 'ins-md-link', href, target: '_blank', rel: 'noopener noreferrer', title: href }, ...inline(link.label, { ...r, noLinks: true })));
        i = link.end;
        continue;
      }
    }
    if (c === '<' && !r.noLinks) {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i));
      const href = m ? safeHref(m[1], r) : null;
      if (href) {
        flush();
        out.push(el('a', { class: 'ins-md-link', href, target: '_blank', rel: 'noopener noreferrer' }, m[1]));
        i += m[0].length;
        continue;
      }
    }
    if (c === 'h' && !r.noLinks && (i === 0 || /[\s(]/.test(prev))) {
      const m = BARE_URL.exec(src.slice(i));
      const href = m ? safeHref(m[0], r) : null;
      if (href) {
        flush();
        out.push(el('a', { class: 'ins-md-link', href, target: '_blank', rel: 'noopener noreferrer' }, m[0]));
        i += m[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_' || (c === '~' && src[i + 1] === '~')) {
      let run = 0;
      while (src[i + run] === c) run++;
      const delim = c === '~' ? '~~' : c.repeat(Math.min(run, 2));
      const opens = !isSpace(src[i + delim.length]) && !(c === '_' && isWord(prev));
      const j = opens ? closingDelimiter(src, i + delim.length, delim) : -1;
      if (j >= 0) {
        flush();
        const tag = c === '~' ? 'del' : delim.length === 2 ? 'strong' : 'em';
        out.push(el(tag, {}, ...inline(src.slice(i + delim.length, j), r)));
        i = j + delim.length;
      } else {
        buf += c.repeat(run);
        i += run;
      }
      continue;
    }
    if (c === '@' && r.queue && (i === 0 || isSpace(prev))) {
      const m = IMPORT_AT.exec(src.slice(i));
      const ref = m ? m[1].replace(/[.,;:)]+$/, '') : '';
      if (ref && (ref.includes('/') || /\.\w+$/.test(ref))) {
        const at = r.queue.findIndex((n) => n.ref === ref);
        if (at >= 0) {
          const [node] = r.queue.splice(at, 1);
          flush();
          out.push(el('span', { class: 'mono ins-md-import-ref' }, `@${ref}`));
          r.found.push(node);
          i += 1 + ref.length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Só `@imports` e espaço: o parágrafo some e ficam só os blocos. */
const onlyImports = (nodes) =>
  nodes.length > 0 && nodes.some((n) => n instanceof Element && n.getAttribute('class') === 'mono ins-md-import-ref') && nodes.every((n) => (n instanceof Element ? n.getAttribute('class') === 'mono ins-md-import-ref' || n.tagName === 'BR' : !n.textContent.trim()));

// ---------- os blocos ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const blank = (line) => !line.trim();
const indentOf = (line) => /^ */.exec(line.replace(/\t/g, '    '))[0].length;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      code = !code;
      cur += ch;
    } else if (ch === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const startsBlock = (line, next) => FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) || (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-'));

function blocks(lines, r) {
  const out = [];
  // Os blocos dos imports achados no bloco anterior entram logo depois dele.
  const push = (node) => {
    if (node) out.push(node);
    for (const imp of r.found.splice(0)) out.push(importBlock(imp, r));
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = fence[2].trim().split(/\s+/)[0];
      push(el('pre', { class: 'ins-md-pre', 'data-lang': lang || null }, el('code', {}, body.join('\n'))));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      push(el(`h${Math.min(level + 1, 6)}`, { class: `ins-md-h ins-md-h${level}` }, ...inline((heading[2] ?? '').replace(/\s+#+$/, ''), r)));
      i++;
      continue;
    }
    if (HR.test(line)) {
      push(el('hr', { class: 'ins-md-hr' }));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) inner.push(lines[i++].replace(QUOTE, ''));
      const found = r.found.splice(0);
      push(el('blockquote', { class: 'ins-md-quote' }, ...blocks(inner, r)));
      r.found.push(...found);
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      const base = list[1].length;
      const ordered = /\d/.test(list[2]);
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = LIST.exec(cur);
        if (m && m[1].length === base && /\d/.test(m[2]) === ordered) {
          const content = base + m[2].length + 1;
          items.push({ lines: [m[3] ?? ''], content });
          i++;
          continue;
        }
        const item = items.at(-1);
        if (blank(cur)) {
          let k = i + 1;
          while (k < lines.length && blank(lines[k])) k++;
          if (k < lines.length && indentOf(lines[k]) > base && !(LIST.exec(lines[k]) && indentOf(lines[k]) === base)) {
            for (; i < k; i++) item.lines.push('');
            continue;
          }
          break;
        }
        if (indentOf(cur) > base) {
          item.lines.push(cur.replace(/\t/g, '    ').slice(Math.min(item.content, indentOf(cur))));
          i++;
          continue;
        }
        if (!blank(item.lines.at(-1)) && !startsBlock(cur, lines[i + 1])) {
          item.lines.push(cur.trim());
          i++;
          continue;
        }
        break;
      }
      const start = ordered ? Number.parseInt(list[2], 10) : null;
      const found = r.found.splice(0);
      const node = el(
        ordered ? 'ol' : 'ul',
        { class: 'ins-md-list', start: ordered && start !== 1 ? start : null },
        ...items.map((it) => {
          const task = /^\[([ xX])\]\s+/.exec(it.lines[0]);
          if (task) it.lines[0] = it.lines[0].slice(task[0].length);
          return el('li', { class: task ? 'ins-md-task' : null }, task ? el('span', { class: 'ins-md-check', 'aria-label': task[1] === ' ' ? 'a fazer' : 'feito' }, task[1] === ' ' ? '☐' : '☑') : null, ...blocks(it.lines, r));
        }),
      );
      r.found.push(...found);
      push(node);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((a) => (/^:-+:$/.test(a) ? 'center' : /-:$/.test(a) ? 'right' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const cell = (tag, text, k) => el(tag, { class: align[k] ? `ins-md-${align[k]}` : null, scope: tag === 'th' ? 'col' : null }, ...inline(text ?? '', r));
      push(
        el(
          'div',
          { class: 'ins-md-table-wrap' },
          el(
            'table',
            { class: 'ins-md-table' },
            el('thead', {}, el('tr', {}, ...head.map((h, k) => cell('th', h, k)))),
            el('tbody', {}, ...rows.map((row) => el('tr', {}, ...head.map((_, k) => cell('td', row[k], k))))),
          ),
        ),
      );
      continue;
    }
    // O parágrafo: até a linha em branco ou o começo de outro bloco. HTML escrito no Markdown cai aqui, como texto.
    const para = [line];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
    const nodes = inline(para.join('\n'), r);
    push(onlyImports(nodes) ? null : el('p', { class: 'ins-md-p' }, ...nodes));
  }
  return out;
}

/**
 * O Markdown de um arquivo de instrução, renderizado.
 * - `repo` (`dono/nome`), `commit` e `from` (o caminho do arquivo): para os links relativos;
 * - `imports`: os nós da árvore de imports do arquivo (`tree.imports`), cada `ok` com `text`;
 * - `depth`: o salto do import (0 no arquivo aberto).
 */
export function renderMarkdown(text, { repo = null, commit = null, from = '', imports = [], depth = 0 } = {}) {
  const r = { repo, commit, from, depth, queue: [...(imports ?? [])], found: [] };
  let lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  // O front matter (`---` … `---` no topo) sai como está, em bloco de código.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) {
      out.push(el('pre', { class: 'ins-md-pre ins-md-front' }, el('code', {}, lines.slice(0, end + 1).join('\n'))));
      lines = lines.slice(end + 1);
    }
  }
  out.push(...blocks(lines, r));
  // Um import que a árvore traz e o texto não mostrou (escrito de um jeito que esta leitura não pega): no fim, para não sumir.
  if (r.queue.length) out.push(el('div', { class: 'ins-md-rest' }, 'Outros imports deste arquivo'), ...r.queue.map((n) => importBlock(n, r)));
  return el('div', { class: 'ins-md' }, ...out);
}
