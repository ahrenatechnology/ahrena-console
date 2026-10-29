// The text of a Conversa message, drawn like a chat: markdown for what the person and the assistant
// wrote, and a readable card for what the harness wraps in tags (<system-reminder>, <task-notification>,
// a slash command and its output, pasted text).
//
// The text is untrusted: every piece goes in through `el()` as a text node or an element, never as HTML.
// A link only becomes `<a>` for http(s) and mailto; anything else stays text.

import { el, icon } from '../dom.js';

// ---------- Inline ----------

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
// One pass over the inline marks, in order of precedence: code, link, bare URL, bold, italic.
const INLINE = /(`[^`\n]+`)|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\n]+)\*(?!\w)|(?<![\w_])_([^_\n]+)_(?!\w)/g;

function link(text, href) {
  // A file path or any other scheme is not a page to open here: its text, with the target in the tooltip.
  return SAFE_URL.test(href) ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'sd-link' }, text) : el('code', { class: 'sd-code', title: href }, text);
}

/** One line of inline markdown, as nodes. */
export function inline(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(el('code', { class: 'sd-code' }, m[1].slice(1, -1)));
    else if (m[2]) out.push(link(m[2], m[3]));
    else if (m[4]) out.push(link(m[4], m[4]));
    else if (m[5] || m[6]) out.push(el('strong', {}, ...inline(m[5] ?? m[6])));
    else out.push(el('em', {}, ...inline(m[7] ?? m[8])));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines joined by `<br>`, each with its inline marks. */
function lines(list) {
  return list.flatMap((l, i) => (i ? [el('br'), ...inline(l)] : inline(l)));
}

// ---------- Blocks ----------

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Markdown blocks: paragraphs, headings, lists, quotes, code, tables and rules. */
export function markdown(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < src.length) {
    const line = src[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < src.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(src[i])) body.push(src[i++]);
      i++;
      out.push(codeBlock(body.join('\n'), fence[2]));
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push(el(`h${Math.min(h[1].length + 2, 6)}`, { class: 'sd-md-h' }, ...inline(h[2])));
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push(el('hr')); i++; continue; }
    if (line.includes('|') && TABLE_SEP.test(src[i + 1] ?? '')) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < src.length && src[i].includes('|') && src[i].trim()) rows.push(cells(src[i++]));
      out.push(el('div', { class: 'sd-md-table' }, el('table', {},
        el('thead', {}, el('tr', {}, ...head.map((c) => el('th', {}, ...inline(c))))),
        el('tbody', {}, ...rows.map((r) => el('tr', {}, ...head.map((_, k) => el('td', {}, ...inline(r[k] ?? '')))))))));
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < src.length && QUOTE.test(src[i])) body.push(QUOTE.exec(src[i++])[1]);
      out.push(el('blockquote', {}, ...markdown(body.join('\n'))));
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const [node, next] = list(src, i);
      out.push(node);
      i = next;
      continue;
    }
    const para = [];
    while (i < src.length && src[i].trim() && !FENCE.test(src[i]) && !HEADING.test(src[i]) && !BULLET.test(src[i]) && !ORDERED.test(src[i]) && !QUOTE.test(src[i])) para.push(src[i++]);
    out.push(el('p', {}, ...lines(para)));
  }
  return out;
}

/** A list from line `i`, with its nested items (by indentation); returns the node and the next line. */
function list(src, i) {
  const first = BULLET.exec(src[i]) ?? ORDERED.exec(src[i]);
  const indent = first[1].length;
  const ordered = !BULLET.test(src[i]);
  const items = [];
  while (i < src.length) {
    const m = (ordered ? ORDERED : BULLET).exec(src[i]);
    if (!m || m[1].length !== indent) break;
    const body = [ordered ? m[3] : m[2]];
    i++;
    const children = [];
    while (i < src.length && src[i].trim()) {
      const sub = BULLET.exec(src[i]) ?? ORDERED.exec(src[i]);
      if (sub && sub[1].length > indent) {
        const [node, next] = list(src, i);
        children.push(node);
        i = next;
      } else if (!sub && /^\s+/.test(src[i])) body.push(src[i++].trim());
      else break;
    }
    items.push(el('li', {}, ...lines(body), ...children));
    if (i < src.length && !src[i].trim() && ((ordered ? ORDERED : BULLET).exec(src[i + 1] ?? '')?.[1].length === indent)) i++;
  }
  return [el(ordered ? 'ol' : 'ul', ordered && first[2] !== '1' ? { start: first[2] } : {}, ...items), i];
}

function codeBlock(code, lang) {
  const copy = el('button', { type: 'button', class: 'sd-md-copy', title: 'Copiar', 'aria-label': 'Copiar o código' }, icon('copy'));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.classList.add('sd-copied');
      setTimeout(() => copy.classList.remove('sd-copied'), 1200);
    } catch {}
  });
  return el('div', { class: 'sd-md-pre' }, el('div', { class: 'sd-md-pre-head' }, el('span', { class: 'mono' }, lang || 'código'), copy), el('pre', { class: 'mono' }, el('code', {}, code)));
}

// ---------- Harness tags ----------

const BLOCK_TAG = /<([a-z][\w-]*)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
const child = (body, name) => new RegExp(`<${name}>([\\s\\S]*?)(</${name}>|$)`, 'i').exec(body)?.[1]?.trim() || null;

/**
 * Splits a message into the harness's tagged pieces and the person's own text, in order:
 * `[{ tag, attrs, body } | { text }]`. Only the known top-level tags split; anything else is text.
 */
export function pieces(text) {
  const out = [];
  let last = 0;
  for (const m of String(text ?? '').matchAll(BLOCK_TAG)) {
    if (!TAGS[m[1].toLowerCase()]) continue;
    const before = text.slice(last, m.index);
    if (before.trim()) out.push({ text: before.trim() });
    out.push({ tag: m[1].toLowerCase(), attrs: m[2] ?? '', body: m[3] });
    last = m.index + m[0].length;
  }
  const rest = String(text ?? '').slice(last);
  // A text cut before its closing tag (older summaries end in "…") still reads as its card.
  const open = /^\s*<([a-z][\w-]*)(\s[^>]*)?>/i.exec(rest);
  if (open && TAGS[open[1].toLowerCase()]) out.push({ tag: open[1].toLowerCase(), attrs: open[2] ?? '', body: rest.slice(open[0].length).replace(/…\s*$/, '') });
  else if (rest.trim()) out.push({ text: rest.trim() });
  return out;
}

/** A collapsed notice: icon, title, one-line preview; the click shows the body. */
function notice({ iconName, title, preview, body, tone = '' }) {
  const detail = el('div', { class: 'sd-note-body', hidden: true }, ...(Array.isArray(body) ? body : [body]));
  const head = el('button', { type: 'button', class: 'sd-note-head', 'aria-expanded': 'false' },
    icon('chevron-right'), icon(iconName), el('b', {}, title), preview ? el('span', { class: 'sd-note-preview' }, preview) : null);
  head.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
    head.firstChild.replaceWith(icon(open ? 'chevron-down' : 'chevron-right'));
  });
  return el('div', { class: `sd-note ${tone}` }, head, detail);
}

const oneLine = (s, max = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const STATUS = { completed: 'concluída', failed: 'falhou', killed: 'interrompida', running: 'rodando' };

const TAGS = {
  'system-reminder': (p) => notice({ iconName: 'info', title: 'Lembrete do sistema', preview: oneLine(p.body), body: el('div', { class: 'sd-md' }, ...markdown(p.body.trim())), tone: 'sd-note-quiet' }),
  'task-notification': (p) => {
    const status = child(p.body, 'status');
    const summary = child(p.body, 'summary');
    const facts = [['Tarefa', child(p.body, 'task-id')], ['Ferramenta', child(p.body, 'tool-use-id')], ['Saída', child(p.body, 'output-file')]].filter(([, v]) => v);
    const result = child(p.body, 'result');
    return notice({
      iconName: status === 'failed' ? 'error' : 'check-circle-2',
      title: `Tarefa em segundo plano${status ? ` ${STATUS[status] ?? status}` : ''}`,
      preview: oneLine(summary ?? ''),
      tone: status === 'failed' ? 'sd-note-fail' : 'sd-note-ok',
      body: [
        el('dl', { class: 'sd-note-facts' }, ...facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: 'mono' }, v)])),
        result ? el('div', { class: 'sd-md' }, ...markdown(result)) : null,
      ],
    });
  },
  'command-name': (p) => el('span', { class: 'sd-cmd-chip mono' }, icon('square-terminal'), p.body.trim()),
  'command-message': () => null,
  'command-args': (p) => (p.body.trim() ? el('span', { class: 'sd-cmd-args mono' }, p.body.trim()) : null),
  'local-command-stdout': (p) => (p.body.trim() ? el('div', { class: 'sd-cmd-out mono' }, p.body.trim()) : null),
  'local-command-stderr': (p) => (p.body.trim() ? el('div', { class: 'sd-cmd-out sd-cmd-err mono' }, p.body.trim()) : null),
  'local-command-caveat': () => null,
  pasted_content: (p) => {
    const body = p.body.trim();
    const n = body.split('\n').length;
    return notice({ iconName: 'file-text', title: 'Texto colado', preview: `${n} linha${n === 1 ? '' : 's'} · ${oneLine(body, 90)}`, body: el('div', { class: 'sd-md' }, ...markdown(body)) });
  },
  'side-sessions-event': (p) => notice({ iconName: 'robot', title: 'Aviso de outra sessão', preview: oneLine(p.body), body: el('div', { class: 'sd-md' }, ...markdown(p.body.trim())), tone: 'sd-note-quiet' }),
  'ci-monitor-event': (p) => notice({ iconName: 'git-pull-request', title: 'Aviso do CI', preview: oneLine(p.body), body: el('div', { class: 'sd-md' }, ...markdown(p.body.trim())), tone: 'sd-note-quiet' }),
};

/**
 * A message's body: the person's text as markdown and each harness tag as its card.
 * `system` is true when nothing in it was written by a person (only tags): the row then reads as a notice.
 */
export function messageBody(text) {
  const parts = pieces(text);
  const nodes = [];
  let commandRow = null;
  for (const p of parts) {
    if (p.text) {
      commandRow = null;
      nodes.push(el('div', { class: 'sd-md' }, ...markdown(p.text)));
      continue;
    }
    const node = TAGS[p.tag](p);
    if (!node) continue;
    // The slash command's name and args read as one line.
    if (p.tag === 'command-name' || p.tag === 'command-args') {
      if (!commandRow) nodes.push((commandRow = el('div', { class: 'sd-cmd-row' })));
      commandRow.append(node);
    } else {
      commandRow = null;
      nodes.push(node);
    }
  }
  return { nodes, system: parts.length > 0 && parts.every((p) => !p.text) };
}
