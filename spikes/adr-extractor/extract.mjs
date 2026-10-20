// Spike #174: lê um registro de decisão (ADR) em Markdown e devolve a estrutura que a tela
// mostra: número, título, status, data, seções, opções e ligações. Sem dependências.
// Formatos: MADR 2, 3 e 4, Nygard (e o adr-tools), Y-statement e os livres em pt-BR, como
// docs/decisoes deste repositório. Descartável: o código do produto vai para o núcleo.

import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

/** Pastas onde as ferramentas e os times costumam guardar ADRs, na ordem de busca. */
export const ADR_DIRS = [
  'docs/adr', 'docs/adrs', 'docs/decisions', 'docs/decisoes',
  'docs/architecture/decisions', 'docs/architecture/adr', 'docs/arch/adr',
  'doc/adr', 'doc/architecture/decisions', 'doc/decisions',
  'adr', 'adrs', 'decisions', 'architecture/decisions',
];

const NOT_ADR = /^(readme|index|template|adr-template|_template|toc)\.md$/i;

/** Um arquivo da pasta é ADR se é Markdown e não é índice nem modelo. */
export const isAdrFile = (name) => /\.md$/i.test(name) && !NOT_ADR.test(name);

// Cada seção canônica e os títulos que a anunciam (inglês e pt-BR).
const SECTIONS = {
  status: /^(status|estado|situação)$/i,
  context: /^(context|context and problem statement|problem statement|background|contexto|contexto e problema|problema)$/i,
  drivers: /^(decision drivers|forces|drivers|motivadores|forças|critérios)$/i,
  options: /^(considered options|options|alternatives|alternatives considered|opções|opções consideradas|alternativas|alternativas consideradas)$/i,
  decision: /^(decision|decision outcome|outcome|decisão|resultado)$/i,
  consequences: /^(consequences|consequências|implicações)$/i,
  prosCons: /^(pros and cons of the options|prós e contras( das opções)?)$/i,
  confirmation: /^(confirmation|confirmação)$/i,
  links: /^(links|related|related decisions|more information|notes|ligações|relacionadas|mais informações|notas)$/i,
};

const STATUS = [
  ['superseded', /superseded by|replaced by|substitu[íi]d[ao] por|substitu[íi]d[ao]$|^superseded$/i],
  ['deprecated', /deprecated|obsolet|descontinuad|depreciad/i],
  ['rejected', /rejected|declined|rejeitad|recusad/i],
  ['accepted', /accepted|adopted|approved|decided|done|aceit|aprovad|adotad|vigente/i],
  ['proposed', /proposed|draft|open|under review|propost|rascunho|em discuss|em revis/i],
];

/** "aceita; revista no mesmo dia" → accepted. O texto cru fica ao lado, para a tela. */
export function normalizeStatus(raw) {
  if (!raw) return 'unknown';
  const first = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  // No Nygard o bloco Status pode ter "Accepted" e, embaixo, "Superseded by …": vale o mais forte.
  for (const [key, re] of STATUS) if (first.some((l) => re.test(stripMd(l)))) return key;
  return 'unknown';
}

/** 18/10/2026, 2026-10-18, 2026-10-18T10:00, 20200924 → 2026-10-18. Senão, null. */
export function normalizeDate(raw) {
  if (!raw) return null;
  const s = stripMd(String(raw)).trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const stripMd = (s) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

/** Front matter YAML simples: `chave: valor` e listas `- item`. Basta para MADR 3 e 4. */
function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: null, body: text };
  const fm = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1].toLowerCase();
      const v = kv[2].trim().replace(/^["']|["']$/g, '');
      fm[key] = v === '' ? [] : v.startsWith('[') ? v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : v;
    } else if (key && /^\s*-\s+/.test(line) && Array.isArray(fm[key])) {
      fm[key].push(line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

/** Número e título: "# 1. Record…", "# 0001 · Consulta…", "# ADR-0003: Foo", ou o nome do arquivo. */
function titleAndNumber(heading, file) {
  let title = heading ?? '';
  let number = null;
  const m = title.match(/^(?:ADR[\s-]?)?(\d{1,5})\s*(?:[.:·—–-]\s*)?(.*)$/i);
  if (m && m[2]) { number = Number(m[1]); title = m[2]; }
  const f = basename(file).match(/^(\d{1,5})[-_ ]/);
  if (number === null && f && f[1].length < 8) number = Number(f[1]);
  if (!title) title = basename(file, '.md').replace(/^\d+[-_ ]/, '').replace(/[-_]/g, ' ');
  return { number, title: stripMd(title) };
}

/** Linhas de metadado: "- **Status:** aceita", "* Status: accepted", "Date: 2016-02-12". */
function metaLines(text) {
  const meta = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s+)?(?:\*\*|__)?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ -]{1,30}?)(?::\*\*|:__|\*\*:|__:|:)\s*(.+)$/);
    if (m && !/^https?$/i.test(m[1])) meta.push({ key: m[1].trim().toLowerCase(), value: m[2].trim() });
  }
  return meta;
}

const META = {
  status: /^(status|estado|situação)$/,
  date: /^(date|data|last updated|atualizad[ao])$/,
  deciders: /^(deciders|decision-makers|decision makers|decisores|quem decidiu|autores?|authors?)$/,
};

/** Divide o corpo pelos `## `; os `### ` ficam dentro da seção. */
function splitSections(body) {
  const out = [];
  let cur = { heading: null, lines: [] };
  for (const line of body.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h) { out.push(cur); cur = { heading: stripMd(h[1]), lines: [] }; } else cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() }));
}

const canonical = (heading) => {
  const h = heading.replace(/^\d+[.)]\s*/, '').trim();
  for (const [key, re] of Object.entries(SECTIONS)) if (re.test(h)) return key;
  return null;
};

/** Itens de primeiro nível de uma lista, ou os `### ` da seção, como opções. */
export function listItems(text) {
  if (!text) return [];
  const items = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (!m) continue;
    // "**Nome.** detalhe" → o negrito; senão, até o travessão, os dois-pontos ou o fim da frase.
    const bold = m[1].match(/^\*\*(.+?)\*\*/)?.[1];
    items.push(stripMd(bold ?? m[1].split(/\s+[–—]\s+|:\s|\.\s/)[0]).replace(/[.;:]$/, '').trim());
  }
  if (items.length) return items;
  return [...text.matchAll(/^###\s+(.+)$/gm)].map((m) => stripMd(m[1]));
}

// "Supersedes [1. Foo](0001-foo.md)", "Substitui a 0003", "Superseded by ADR-0007".
const LINK_KINDS = [
  ['superseded-by', /\b(superseded by|replaced by|substitu[íi]d[ao] por)\b/i],
  ['supersedes', /\b(supersedes|replaces|substitui)\b/i],
  ['amended-by', /\b(amended by|emendad[ao] por)\b/i],
  ['amends', /\b(amends|emenda)\b/i],
  ['clarified-by', /\b(clarified by)\b/i],
  ['clarifies', /\b(clarifies|esclarece)\b/i],
];

/** Alvos de uma linha: links para outro .md, "ADR-12" ou um número de 4 dígitos. */
function targets(line) {
  const out = [];
  for (const m of line.matchAll(/\[([^\]]*)\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) out.push({ file: basename(m[2]), label: stripMd(m[1]) });
  if (out.length) return out;
  for (const m of line.matchAll(/\bADR[\s-]?0*(\d{1,5})\b|\b(\d{4})\b/gi)) out.push({ number: Number(m[1] ?? m[2]) });
  return out;
}

function findLinks(lines, meta) {
  const links = [];
  const seen = new Set();
  const add = (kind, t, via) => {
    const k = `${kind}:${t.file ?? t.number}`;
    if (!seen.has(k)) { seen.add(k); links.push({ kind, ...t, via }); }
  };
  for (const line of lines) {
    for (const [kind, re] of LINK_KINDS) {
      const m = line.match(re);
      if (!m) continue;
      for (const t of targets(line.slice(m.index + m[0].length))) add(kind, t, 'text');
      break;
    }
  }
  // Metadado com link para outra ADR e sem verbo conhecido ("Mexe em", "Parte de", "Related").
  for (const { key, value } of meta) {
    if (META.status.test(key) || LINK_KINDS.some(([, re]) => re.test(value) || re.test(key))) continue;
    for (const t of targets(value)) if (t.file) add('related', { ...t, label: t.label }, key);
  }
  return links;
}

const Y = /in the context of\s+([\s\S]+?),\s*facing\s+([\s\S]+?),\s*we decided (?:for|to)\s+([\s\S]+?)(?:,?\s*and neglected\s+([\s\S]+?))?,\s*to achieve\s+([\s\S]+?),\s*accepting(?: that)?\s+([\s\S]+?)[.\n]/i;
const Y_PT = /no contexto d[eoa]s?\s+([\s\S]+?),\s*diante d[eoa]s?\s+([\s\S]+?),\s*decidimos (?:por|usar)?\s*([\s\S]+?)(?:,?\s*e descartamos\s+([\s\S]+?))?,\s*para (?:atingir|alcançar|conseguir)\s+([\s\S]+?),\s*aceitando(?: que)?\s+([\s\S]+?)[.\n]/i;

/**
 * Lê o texto de uma ADR. `file` é o caminho (o nome dá o número quando o título não dá).
 * Devolve só o que achou; o que falta vai em `missing`, para a tela dizer "sem consequências".
 */
export function parseAdr(text, file = 'adr.md') {
  const src = text.replace(/\r\n?/g, '\n');
  const { fm, body } = frontMatter(src);
  const h1 = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  const { number, title } = titleAndNumber(fm?.title ?? h1?.[1], file);
  const afterTitle = h1 ? body.slice(h1.index + h1[0].length) : body;
  const sections = splitSections(afterTitle);
  const preamble = sections[0].heading === null ? sections.shift().text : '';
  const meta = metaLines(preamble);
  const metaOf = (re) => meta.find((m) => re.test(m.key))?.value ?? null;

  const out = { file: basename(file), id: basename(file).replace(/\.md$/i, ''), number, title, format: 'free', language: 'en' };
  const byKey = {};
  const other = [];
  for (const s of sections) {
    const k = canonical(s.heading);
    if (k && !byKey[k]) byKey[k] = s.text; else other.push(s);
  }

  // Status: front matter, linha de metadado ou seção ## Status (Nygard).
  const statusRaw = (typeof fm?.status === 'string' ? fm.status : null) ?? metaOf(META.status) ?? byKey.status?.split(/\n\s*\n/)[0] ?? null;
  out.statusRaw = statusRaw ? stripMd(statusRaw) : null;
  out.status = normalizeStatus(byKey.status && !fm?.status && !metaOf(META.status) ? byKey.status : statusRaw);
  const nygardDate = afterTitle.match(/^Date:\s*(.+)$/m)?.[1];
  const fileDate = basename(file).match(/^(\d{8})[-_]/)?.[1];
  out.dateRaw = (typeof fm?.date === 'string' ? fm.date : null) ?? metaOf(META.date) ?? nygardDate ?? fileDate ?? null;
  out.date = normalizeDate(out.dateRaw);
  const deciders = fm?.['decision-makers'] ?? fm?.deciders ?? metaOf(META.deciders);
  out.deciders = deciders ? (Array.isArray(deciders) ? deciders : deciders.split(/,\s*/)).map(stripMd).filter(Boolean) : [];

  out.context = byKey.context ?? null;
  out.drivers = listItems(byKey.drivers);
  out.options = listItems(byKey.options);
  if (!out.options.length && byKey.prosCons) out.options = listItems(byKey.prosCons);
  out.decision = byKey.decision ?? null;
  out.chosen = out.decision?.match(/chosen option:\s*\**"?([^",*\n]+?)"?\**(?:,|\s+because|$)/im)?.[1]?.trim() ?? null;
  out.consequences = byKey.consequences ?? null;
  // Consequências dentro da Decision Outcome (MADR 3 e 4: "### Consequences").
  if (!out.consequences && out.decision) {
    const sub = out.decision.match(/^###\s+(?:Positive |Negative )?Consequences\s*\n([\s\S]*?)(?=^###\s|(?![\s\S]))/im);
    if (sub) out.consequences = sub[1].trim();
  }
  out.other = other.filter((s) => s.heading).map((s) => s.heading);

  // Y-statement: a frase inteira vira as seções.
  const y = src.match(Y) ?? src.match(Y_PT);
  if (y) {
    out.format = 'y-statement';
    out.context ??= `${y[1].trim()}; ${y[2].trim()}`;
    out.decision ??= y[3].trim();
    if (!out.options.length && y[4]) out.options = [y[3].trim(), ...y[4].split(/,\s*|\s+(?:and|e)\s+/).map((s) => s.trim())];
    out.consequences ??= `${y[5].trim()}; aceitando ${y[6].trim()}`;
  } else if (byKey.decision && /decision outcome/i.test(sections.map((s) => s.heading).join('|'))) {
    // A versão vem do que só ela tem: 4 traz decision-makers/consulted/informed e Confirmation;
    // 3 pôs status e data no front matter; 2 usava "* Status:" no topo. Sem nada disso, só "madr".
    out.format = fm?.['decision-makers'] || fm?.consulted || fm?.informed || byKey.confirmation || /^###\s+Confirmation/im.test(byKey.decision ?? '') ? 'madr4'
      : fm?.status || fm?.date || fm?.deciders ? 'madr3' : metaOf(META.status) ? 'madr2' : 'madr';
  } else if (byKey.status && byKey.context && byKey.decision) {
    out.format = nygardDate ? 'adr-tools' : 'nygard';
  }
  if (/(contexto|decisão|consequências)/i.test(sections.map((s) => s.heading).join('|')) || /status|data/i.test(meta.map((m) => m.key).join('|')) && /aceit|propost/i.test(statusRaw ?? '')) out.language = 'pt';

  const linkLines = [...preamble.split('\n'), ...(byKey.status ?? '').split('\n'), ...(byKey.links ?? '').split('\n')];
  if (fm?.status) linkLines.push(fm.status);
  out.links = findLinks(linkLines, meta);
  if (out.status === 'unknown' && out.links.some((l) => l.kind === 'superseded-by')) out.status = 'superseded';

  out.missing = ['status', 'date', 'context', 'decision', 'options', 'consequences'].filter((k) =>
    k === 'status' ? out.status === 'unknown' : k === 'options' ? !out.options.length : !out[k]);
  return out;
}

/**
 * Resolve os alvos das ligações contra o conjunto (pelo arquivo ou pelo número) e cria a volta:
 * se A substitui B, B é substituída por A, mesmo que B não diga.
 */
export function linkAll(adrs) {
  const byFile = new Map(adrs.map((a) => [a.file, a]));
  const byNumber = new Map(adrs.filter((a) => a.number !== null).map((a) => [a.number, a]));
  const inverse = { supersedes: 'superseded-by', 'superseded-by': 'supersedes', amends: 'amended-by', 'amended-by': 'amends', clarifies: 'clarified-by', 'clarified-by': 'clarifies', related: 'related' };
  for (const a of adrs) {
    for (const l of a.links) {
      const t = l.file ? byFile.get(l.file) : byNumber.get(l.number);
      l.target = t?.id ?? null;
    }
    // "Mexe em: [backlog](../backlog.md)" não é ADR: só fica a ligação solta que tem verbo.
    a.links = a.links.filter((l) => l.target || l.kind !== 'related');
  }
  for (const a of adrs) {
    for (const l of a.links) {
      if (!l.target) continue;
      const t = adrs.find((x) => x.id === l.target);
      const kind = inverse[l.kind];
      if (!t.links.some((x) => x.kind === kind && x.target === a.id)) t.links.push({ kind, target: a.id, via: 'inverse' });
    }
  }
  for (const a of adrs) if (a.links.some((l) => l.kind === 'superseded-by') && a.status !== 'superseded') a.statusConflict = 'superseded-by link, status says ' + a.status;
  return adrs;
}

/** Lê uma pasta inteira, como a tela faria com o conteúdo vindo do GitHub. */
export async function readDir(dir) {
  const names = (await readdir(dir)).filter(isAdrFile).sort();
  const adrs = [];
  for (const n of names) adrs.push(parseAdr(await readFile(join(dir, n), 'utf8'), n));
  return linkAll(adrs);
}

// node spikes/adr-extractor/extract.mjs <pasta> [--json]
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? 'docs/decisoes';
  const adrs = await readDir(dir);
  if (process.argv.includes('--json')) console.log(JSON.stringify(adrs, null, 2));
  else {
    for (const a of adrs) {
      const links = a.links.map((l) => `${l.kind}→${l.target ?? l.file ?? l.number}`).join(' ');
      console.log([a.id.slice(0, 44).padEnd(44), a.format.padEnd(11), a.status.padEnd(10), (a.date ?? '—').padEnd(10), `opções ${a.options.length}`, a.missing.length ? `falta: ${a.missing.join(',')}` : 'completa', links].join('  '));
    }
  }
}
