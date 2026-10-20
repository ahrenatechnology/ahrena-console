// O extrator dos registros de decisão (#174), portado do spike spikes/adr-extractor/extract.mjs: lê o
// Markdown de uma ADR ou PDR e devolve o que a tela estrutura (número, título, status, data, seções,
// alternativas e ligações). Sem dependências e sem rede: só texto entra, só dados saem.
//
// Formatos: MADR 2, 3 e 4, Nygard (e o adr-tools), Y-statement e os livres em pt-BR, como
// docs/decisoes deste repositório. Quando nenhum é reconhecido, o registro fica como livre: o título,
// as seções pelos sinônimos e o resto em "Outras seções". O que falta vai em `missing`, para a tela
// dizer "não está no texto" em vez de esconder a seção.
//
// Ligações só em lugares previsíveis: metadados, a seção Status e as seções de links. "Substitui" é
// verbo comum em português, e ler o corpo ligaria registros que só citam uma troca qualquer.

import type { DecisionField, DecisionFormat, DecisionKind, DecisionLink, DecisionOption, DecisionSection, DecisionStatus, KindReason, LinkKind, ParsedDecision } from './model.ts';

/** A versão do extrator: entra na chave do cache (`adrs:parsed:<oid>:<versão>`). Mude quando a saída mudar. */
export const EXTRACTOR_VERSION = 1;

/** Pastas onde as ferramentas e os times costumam guardar ADRs, na ordem de busca. */
export const ADR_DIRS = [
  'docs/adr',
  'docs/adrs',
  'docs/decisions',
  'docs/decisoes',
  'docs/architecture/decisions',
  'docs/architecture/adr',
  'docs/arch/adr',
  'doc/adr',
  'doc/architecture/decisions',
  'doc/decisions',
  'adr',
  'adrs',
  'decisions',
  'architecture/decisions',
] as const;

/** Pastas de decisões de produto (PDR). Uma pasta mista, como docs/decisoes, decide pelo campo de tipo. */
export const PDR_DIRS = ['docs/pdr', 'docs/pdrs', 'docs/product-decisions', 'docs/product/decisions', 'docs/decisoes-de-produto', 'doc/pdr', 'pdr', 'pdrs', 'product-decisions'] as const;

/** As 23 pastas da descoberta comum (src/github/repo-files-source.ts), ADR antes de PDR. */
export const DECISION_DIRS: readonly string[] = [...ADR_DIRS, ...PDR_DIRS];

const PDR_FOLDER = /(^|\/)(pdrs?|product-decisions|product\/decisions|decisoes-de-produto)(\/|$)/i;
const ADR_FOLDER = /(^|\/)(adrs?|architecture\/decisions|architecture\/adr|arch\/adr)(\/|$)/i;
const PRODUCT = /^(pdr|produto|product|product decision|decisão de produto)$/i;
const ARCHITECTURE = /^(adr|arquitetura|architecture|architectural|técnica|technical|architecture decision|decisão de arquitetura)$/i;

const NOT_DECISION = /^(readme|index|template|adr-template|pdr-template|_template|toc)\.md$/i;

/** Um arquivo da pasta é registro se é Markdown e não é índice nem modelo. */
export const isDecisionFile = (name: string): boolean => /\.md$/i.test(name) && !NOT_DECISION.test(name);

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export const stripMd = (s: string): string =>
  s
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();

type FrontMatter = Record<string, string | string[]>;
interface Meta {
  key: string;
  value: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * ADR (arquitetura) ou PDR (produto), na ordem: o campo de tipo (front matter `type`, `kind` ou
 * `category`, ou a linha "Tipo:"), o prefixo do arquivo ou do título (`PDR-`, `ADR-`), a pasta e,
 * sem nenhum sinal, ADR. Devolve também o porquê, para a tela e para os testes.
 */
export function classify({ path = '', fm = null, meta = [], title = '' }: { path?: string; fm?: FrontMatter | null; meta?: Meta[]; title?: string }): { kind: DecisionKind; why: KindReason } {
  const field = [fm?.type, fm?.kind, fm?.category, ...meta.filter((m) => /^(tipo|type|kind|categoria|category)$/.test(m.key)).map((m) => m.value)]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => stripMd(v).trim());
  for (const v of field) {
    if (PRODUCT.test(v)) return { kind: 'pdr', why: 'type-field' };
    if (ARCHITECTURE.test(v)) return { kind: 'adr', why: 'type-field' };
  }
  const name = basename(path);
  if (/^PDR[-_ ]/i.test(name) || /^PDR[\s-]?\d/i.test(title)) return { kind: 'pdr', why: 'prefix' };
  if (/^ADR[-_ ]/i.test(name) || /^ADR[\s-]?\d/i.test(title)) return { kind: 'adr', why: 'prefix' };
  const dir = dirname(path);
  if (PDR_FOLDER.test(dir)) return { kind: 'pdr', why: 'folder' };
  if (ADR_FOLDER.test(dir)) return { kind: 'adr', why: 'folder' };
  return { kind: 'adr', why: 'default' };
}

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
} as const;
type SectionKey = keyof typeof SECTIONS;

const STATUS: [DecisionStatus, RegExp][] = [
  ['superseded', /superseded by|replaced by|substitu[íi]d[ao] por|substitu[íi]d[ao]$|^superseded$/i],
  ['deprecated', /deprecated|obsolet|descontinuad|depreciad/i],
  ['rejected', /rejected|declined|rejeitad|recusad/i],
  ['accepted', /accepted|adopted|approved|decided|done|aceit|aprovad|adotad|vigente/i],
  ['proposed', /proposed|draft|open|under review|propost|rascunho|em discuss|em revis/i],
];

/** "aceita; revista no mesmo dia" → accepted. O texto cru fica ao lado, para a tela. */
export function normalizeStatus(raw: string | null | undefined): DecisionStatus {
  if (!raw) return 'unknown';
  const lines = raw
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // No Nygard o bloco Status pode ter "Accepted" e, embaixo, "Superseded by …": vale o mais forte.
  for (const [key, re] of STATUS) if (lines.some((l) => re.test(stripMd(l)))) return key;
  return 'unknown';
}

const validDay = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1970 && y <= 2999;

/** 18/10/2026, 2026-10-18, 2026-10-18T10:00, 20200924 → 2026-10-18. Senão, null. */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = stripMd(String(raw)).trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m && validDay(+m[1], +m[2], +m[3])) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m && validDay(+m[3], +m[2], +m[1])) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m && validDay(+m[1], +m[2], +m[3])) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Front matter YAML simples: `chave: valor` e listas `- item`. Basta para MADR 3 e 4. */
function frontMatter(text: string): { fm: FrontMatter | null; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: null, body: text };
  const fm: FrontMatter = {};
  let key: string | null = null;
  const unquote = (x: string) => x.trim().replace(/^["']|["']$/g, '');
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1].toLowerCase();
      const v = unquote(kv[2]);
      fm[key] = v === '' ? [] : v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(unquote).filter(Boolean) : v;
    } else if (key && /^\s*-\s+/.test(line)) {
      const list = fm[key];
      if (Array.isArray(list)) list.push(unquote(line.replace(/^\s*-\s+/, '')));
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

/** Número e título: "# 1. Record…", "# 0001 · Consulta…", "# ADR-0003: Foo", ou o nome do arquivo. */
function titleAndNumber(heading: string | null, file: string): { number: number | null; title: string } {
  let title = heading ?? '';
  let number: number | null = null;
  const m = title.match(/^(?:[AP]DR[\s-]?)?(\d{1,5})\s*(?:[.:·—–-]\s*)?(.*)$/i);
  if (m && m[2]) {
    number = Number(m[1]);
    title = m[2];
  }
  const f = basename(file).match(/^(?:[AP]DR[-_])?(\d{1,5})[-_ ]/i);
  // Prefixo de 8 dígitos (`20200924-…`, o log4brains) é data, não número: a regex acima nem o pega.
  if (number === null && f) number = Number(f[1]);
  if (!title)
    title = basename(file)
      .replace(/\.md$/i, '')
      .replace(/^(?:[AP]DR[-_])?\d+[-_ ]/i, '')
      .replace(/[-_]/g, ' ');
  return { number, title: stripMd(title) };
}

/** Linhas de metadado: "- **Status:** aceita", "* Status: accepted", "Date: 2016-02-12". */
function metaLines(text: string): Meta[] {
  const meta: Meta[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s+)?(?:\*\*|__)?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ -]{1,30}?)(?::\*\*|:__|\*\*:|__:|:)\s*(.+)$/);
    if (m && !/^https?$/i.test(m[1])) meta.push({ key: m[1].trim().toLowerCase(), value: m[2].trim() });
  }
  return meta;
}

const META = {
  status: /^(status|estado|situação)$/,
  date: /^(date|data|last updated|atualizad[ao])$/,
  deciders: /^(deciders|decision-makers|decision makers|decisores|decidiram|quem decidiu|autores?|authors?)$/,
  consulted: /^(consulted|consultados?)$/,
  informed: /^(informed|informados?)$/,
};

interface RawSection {
  heading: string | null;
  text: string;
}

/** Divide o corpo pelos `## `; os `### ` ficam dentro da seção. Código cercado não divide. */
function splitSections(body: string): RawSection[] {
  const out: { heading: string | null; lines: string[] }[] = [];
  let cur: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    const h = fence === null ? line.match(/^##\s+(.+?)\s*#*\s*$/) : null;
    if (h) {
      out.push(cur);
      cur = { heading: stripMd(h[1]), lines: [] };
    } else cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() }));
}

const canonical = (heading: string): SectionKey | null => {
  const h = heading.replace(/^\d+[.)]\s*/, '').trim();
  for (const [key, re] of Object.entries(SECTIONS)) if (re.test(h)) return key as SectionKey;
  return null;
};

/** O nome curto de um item: o negrito do começo; senão, até o travessão, os dois-pontos ou o fim da frase. */
function shortName(item: string): string {
  const bold = item.match(/^\*\*(.+?)\*\*/)?.[1];
  return stripMd(bold ?? item.split(/\s+[–—]\s+|\s+--\s+|:\s|\.\s/)[0])
    .replace(/[.;:]$/, '')
    .trim();
}

/** Itens de primeiro nível de uma lista, ou os `### ` da seção, como nomes curtos. */
export function listItems(text: string | null | undefined): string[] {
  if (!text) return [];
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (m) items.push(shortName(m[1]));
  }
  if (items.length) return items;
  return [...text.matchAll(/^###\s+(.+)$/gm)].map((x) => stripMd(x[1]));
}

/** Os itens de uma lista como estão (sem o marcador), para consequências e prós e contras. */
function bullets(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((l) => l.match(/^\s{0,1}(?:[-*+]|\d+[.)])\s+(.+)$/)?.[1])
    .filter((x): x is string => Boolean(x))
    .map((x) => stripMd(x));
}

const GOOD = /^(good|positive|pro|bom|boa|positiv[ao]|pró)\s*[,:]\s*(?:because\s+|porque\s+)?/i;
const BAD = /^(bad|negative|con|ruim|negativ[ao]|contra)\s*[,:]\s*(?:because\s+|porque\s+)?/i;

/** "Good, because X" e "Bad, because Y" de uma lista: os dois lados, sem o prefixo. */
function goodAndBad(items: string[]): { good: string[]; bad: string[] } {
  const good: string[] = [];
  const bad: string[] = [];
  for (const it of items) {
    if (GOOD.test(it)) good.push(capitalize(it.replace(GOOD, '')));
    else if (BAD.test(it)) bad.push(capitalize(it.replace(BAD, '')));
  }
  return { good, bad };
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** As subseções `### ` de um texto: título → corpo. */
function subsections(text: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^###\s+(.+?)\s*#*\s*$/);
    if (h) {
      if (cur) out.push({ heading: cur.heading, text: cur.lines.join('\n').trim() });
      cur = { heading: stripMd(h[1]), lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) out.push({ heading: cur.heading, text: cur.lines.join('\n').trim() });
  return out;
}

// "Supersedes [1. Foo](0001-foo.md)", "Substitui a 0003", "Superseded by ADR-0007".
const LINK_KINDS: [LinkKind, RegExp][] = [
  ['superseded-by', /\b(superseded by|replaced by|substitu[íi]d[ao] por)(?![\p{L}])/iu],
  ['supersedes', /\b(supersedes|replaces|substitui)(?![\p{L}])/iu],
  ['amended-by', /\b(amended by|emendad[ao] por)(?![\p{L}])/iu],
  ['amends', /\b(amends|emenda)(?![\p{L}])/iu],
  ['clarified-by', /\b(clarified by)(?![\p{L}])/iu],
  ['clarifies', /\b(clarifies|esclarece)(?![\p{L}])/iu],
];

type Target = { file?: string; number?: number; label?: string };

/** Alvos de uma linha: links para outro .md, "ADR-12" ou um número de 4 dígitos. */
function targets(line: string): Target[] {
  const out: Target[] = [];
  for (const m of line.matchAll(/\[([^\]]*)\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) out.push({ file: basename(m[2]), label: stripMd(m[1]) });
  if (out.length) return out;
  for (const m of line.matchAll(/\b[AP]DR[\s-]?0*(\d{1,5})\b|\b(\d{4})\b/gi)) out.push({ number: Number(m[1] ?? m[2]) });
  return out;
}

function findLinks(lines: string[], meta: Meta[]): DecisionLink[] {
  const links: DecisionLink[] = [];
  const seen = new Set<string>();
  const add = (kind: LinkKind, t: Target, via: string) => {
    const k = `${kind}:${t.file ?? t.number}`;
    if (!seen.has(k)) {
      seen.add(k);
      links.push({ kind, target: null, via, ...t });
    }
  };
  for (const line of lines) {
    for (const [kind, re] of LINK_KINDS) {
      const m = line.match(re);
      if (!m || m.index === undefined) continue;
      for (const t of targets(line.slice(m.index + m[0].length))) add(kind, t, 'text');
      break;
    }
  }
  // Metadado com link para outro registro e sem verbo conhecido ("Mexe em", "Parte de", "Related").
  for (const { key, value } of meta) {
    if (META.status.test(key) || LINK_KINDS.some(([, re]) => re.test(value) || re.test(key))) continue;
    for (const t of targets(value)) if (t.file) add('related', t, key);
  }
  return links;
}

const Y = /in the context of\s+([\s\S]+?),\s*facing\s+([\s\S]+?),\s*we decided (?:for|to)\s+([\s\S]+?)(?:,?\s*and neglected\s+([\s\S]+?))?,\s*to achieve\s+([\s\S]+?),\s*accepting(?: that)?\s+([\s\S]+?)[.\n]/i;
const Y_PT = /no contexto d[eoa]s?\s+([\s\S]+?),\s*diante d[eoa]s?\s+([\s\S]+?),\s*decidimos (?:por|usar)?\s*([\s\S]+?)(?:,?\s*e descartamos\s+([\s\S]+?))?,\s*para (?:atingir|alcançar|conseguir)\s+([\s\S]+?),\s*aceitando(?: que)?\s+([\s\S]+?)[.\n]/i;

const asList = (v: string | string[] | null | undefined): string[] => (v ? (Array.isArray(v) ? v : v.split(/,\s*/)).map(stripMd).filter(Boolean) : []);

/**
 * Lê o texto de um registro. `path` é o caminho no repositório: o nome dá o número quando o título
 * não dá, e a pasta entra na classificação ADR ou PDR.
 */
export function parseDecision(text: string, path = 'adr.md'): ParsedDecision {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const { fm, body } = frontMatter(src);
  const h1 = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  const heading = str(fm?.title) ?? h1?.[1] ?? null;
  const { number, title } = titleAndNumber(heading, path);
  const afterTitle = h1 && h1.index !== undefined ? body.slice(h1.index + h1[0].length) : body;
  const sections = splitSections(afterTitle);
  const preamble = sections[0].heading === null ? sections.shift()!.text : '';
  const meta = metaLines(preamble);
  const metaOf = (re: RegExp) => meta.find((m) => re.test(m.key))?.value ?? null;

  const byKey: Partial<Record<SectionKey, string>> = {};
  const other: DecisionSection[] = [];
  for (const s of sections) {
    if (!s.heading) continue;
    const k = canonical(s.heading);
    if (k && byKey[k] === undefined) byKey[k] = s.text;
    else other.push({ heading: s.heading, text: s.text });
  }
  // As seções de links também são texto do autor: a tela as mostra em "Outras seções".
  const linksSection = sections.find((s) => s.heading && canonical(s.heading) === 'links');
  if (linksSection?.heading) other.unshift({ heading: linksSection.heading, text: linksSection.text });

  const kind = classify({ path, fm, meta, title: heading ?? '' });
  const fmStatus = str(fm?.status);
  const statusRaw = fmStatus ?? metaOf(META.status) ?? byKey.status?.split(/\n\s*\n/)[0] ?? null;
  let status = normalizeStatus(byKey.status && !fmStatus && !metaOf(META.status) ? byKey.status : statusRaw);
  const nygardDate = afterTitle.match(/^Date:\s*(.+)$/m)?.[1] ?? null;
  const fileDate = basename(path).match(/^(\d{8})[-_]/)?.[1] ?? null;
  const dateRaw = str(fm?.date) ?? metaOf(META.date) ?? nygardDate ?? fileDate ?? null;

  let context = byKey.context ?? null;
  const drivers = listItems(byKey.drivers);
  let optionNames = listItems(byKey.options);
  const prosCons = byKey.prosCons ? subsections(byKey.prosCons) : [];
  if (!optionNames.length && prosCons.length) optionNames = prosCons.map((s) => s.heading);

  // A decisão do MADR: o texto sem as subseções de consequências e confirmação, que viram as suas.
  let decision = byKey.decision ?? null;
  let consequences = byKey.consequences ?? null;
  let confirmation = byKey.confirmation ?? null;
  let consequencesGood: string[] = [];
  let consequencesBad: string[] = [];
  if (decision) {
    const subs = subsections(decision);
    const positive = subs.find((s) => /^(positive consequences|consequências positivas)$/i.test(s.heading));
    const negative = subs.find((s) => /^(negative consequences|consequências negativas)$/i.test(s.heading));
    const plain = subs.find((s) => /^(consequences|consequências)$/i.test(s.heading));
    const conf = subs.find((s) => /^(confirmation|confirmação)$/i.test(s.heading));
    if (!consequences && (plain || positive || negative)) consequences = [plain?.text, positive?.text, negative?.text].filter(Boolean).join('\n\n');
    if (positive) consequencesGood = bullets(positive.text);
    if (negative) consequencesBad = bullets(negative.text);
    if (!confirmation && conf) confirmation = conf.text;
    if (plain || positive || negative || conf) {
      const cut = decision.search(/^###\s+(?:positive consequences|negative consequences|consequences|consequências(?: positivas| negativas)?|confirmation|confirmação)\s*$/im);
      if (cut >= 0) decision = decision.slice(0, cut).trim() || null;
    }
  }
  if (consequences && !consequencesGood.length && !consequencesBad.length) {
    const split = goodAndBad(bullets(consequences));
    consequencesGood = split.good;
    consequencesBad = split.bad;
  }

  // Entre aspas vale o texto inteiro, vírgula inclusive; sem aspas, até a vírgula ou o "because".
  const chosenMatch = decision?.match(/(?:chosen option|opção escolhida):\s*\**(?:["“]([^"”\n]+)["”]|([^,*\n]+?))\**(?:,|\s+because|\s+porque|$)/im);
  const chosen = (chosenMatch?.[1] ?? chosenMatch?.[2])?.trim() ?? null;
  const chosenReason = chosenMatch ? (decision!.slice((chosenMatch.index ?? 0) + chosenMatch[0].length).match(/^\s*(?:because|porque)?\s*([^\n]+)/i)?.[1]?.trim() ?? null) : null;

  let format: DecisionFormat = 'free';
  const y = src.match(Y) ?? src.match(Y_PT);
  if (y) {
    format = 'y-statement';
    context ??= `${y[1].trim()}; ${y[2].trim()}`;
    decision ??= y[3].trim();
    if (!optionNames.length && y[4]) optionNames = [y[3].trim(), ...y[4].split(/,\s*|\s+(?:and|e)\s+/).map((s) => s.trim())];
    consequences ??= `${y[5].trim()}; aceitando ${y[6].trim()}`;
  } else if (byKey.decision && /decision outcome/i.test(sections.map((s) => s.heading).join('|'))) {
    // A versão vem do que só ela tem: 4 traz decision-makers/consulted/informed e Confirmation;
    // 3 pôs status e data no front matter; 2 usava "* Status:" no topo. Sem nada disso, só "madr".
    format =
      fm?.['decision-makers'] || fm?.consulted || fm?.informed || byKey.confirmation || /^###\s+Confirmation/im.test(byKey.decision ?? '')
        ? 'madr4'
        : fm?.status || fm?.date || fm?.deciders
          ? 'madr3'
          : metaOf(META.status)
            ? 'madr2'
            : 'madr';
  } else if (byKey.status && byKey.context && byKey.decision) {
    format = nygardDate ? 'adr-tools' : 'nygard';
  }
  const headings = sections.map((s) => s.heading).join('|');
  const language: 'en' | 'pt' = /(contexto|decisão|consequências)/i.test(headings) || (/status|data/i.test(meta.map((m) => m.key).join('|')) && /aceit|propost/i.test(statusRaw ?? '')) ? 'pt' : 'en';

  const linkLines = [...preamble.split('\n'), ...(byKey.status ?? '').split('\n'), ...(byKey.links ?? '').split('\n')];
  if (fmStatus) linkLines.push(fmStatus);
  const links = findLinks(linkLines, meta);
  if (status === 'unknown' && links.some((l) => l.kind === 'superseded-by')) status = 'superseded';

  // Os prós e contras de cada alternativa, quando o texto traz (MADR: "### <opção>" em Pros and Cons).
  const options: DecisionOption[] = optionNames.map((name) => {
    const sub = prosCons.find((s) => s.heading.toLowerCase() === name.toLowerCase() || s.heading.toLowerCase().startsWith(name.toLowerCase()));
    const { good, bad } = goodAndBad(bullets(sub?.text));
    return { name, chosen: chosen !== null && (name === chosen || name.toLowerCase().startsWith(chosen.toLowerCase())), pros: good, cons: bad };
  });

  const out: ParsedDecision = {
    path,
    id: basename(path).replace(/\.md$/i, ''),
    number,
    title,
    kind: kind.kind,
    kindReason: kind.why,
    format,
    language,
    status,
    statusRaw: statusRaw ? stripMd(statusRaw) : null,
    date: normalizeDate(dateRaw),
    dateRaw,
    deciders: asList((fm?.['decision-makers'] as string | string[] | undefined) ?? fm?.deciders ?? metaOf(META.deciders)),
    consulted: asList(fm?.consulted ?? metaOf(META.consulted)),
    informed: asList(fm?.informed ?? metaOf(META.informed)),
    context,
    drivers,
    decision,
    chosen,
    chosenReason,
    options,
    consequences,
    consequencesGood,
    consequencesBad,
    confirmation,
    other,
    links,
    missing: [],
    statusConflict: null,
  };
  const fields: DecisionField[] = ['status', 'date', 'context', 'decision', 'options', 'consequences'];
  out.missing = fields.filter((k) => (k === 'status' ? out.status === 'unknown' : k === 'options' ? !out.options.length : !out[k]));
  return out;
}
