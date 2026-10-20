// O extrator dos registros de decisão (#174), portado do spike spikes/adr-extractor: os testes do spike
// (os formatos, as ligações, a classificação ADR e PDR e as datas) e as ADRs de docs/decisoes deste
// repositório. Só texto: nenhuma chamada ao GitHub.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chainOf, chains, classify, isDecisionFile, linkAll, normalizeDate, normalizeStatus, parseDecision, uniqueIds, DECISION_DIRS, ADR_DIRS, PDR_DIRS, type ParsedDecision } from '../../src/adrs/index.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Lê uma pasta como a leitura do GitHub faria: `repoPath` é a pasta como o repositório a chama. */
function readDir(dir: string, repoPath: string): ParsedDecision[] {
  const names = readdirSync(dir).filter(isDecisionFile).sort();
  return linkAll(uniqueIds(names.map((n) => parseDecision(readFileSync(`${dir}/${n}`, 'utf8'), `${repoPath}/${n}`))));
}
const byId = (list: ParsedDecision[]) => Object.fromEntries(list.map((a) => [a.id.slice(0, 4), a]));
const fixture = (name: string, repoPath = `docs/adr`) => readDir(here(`fixtures/${name}`), repoPath);

describe('#174 extractor: the formats', () => {
  test('MADR 4: front matter, chosen option, consequences good and bad, confirmation and supersedes', () => {
    const d = byId(fixture('madr4'));
    const a = d['0003'];
    assert.equal(a.format, 'madr4');
    assert.deepEqual(a.deciders, ['dev-sintetico', 'colega-a']);
    assert.deepEqual(a.consulted, ['colega-b']);
    assert.deepEqual(a.informed, ['time']);
    assert.equal(a.chosen, 'SQLite in memory');
    assert.equal(a.chosenReason, 'it is the only option under one minute.');
    assert.deepEqual(a.options.map((o) => o.name), ['SQLite in memory', 'Postgres in Docker', 'Mocked repository layer']);
    assert.deepEqual(a.options.map((o) => o.chosen), [true, false, false]);
    assert.deepEqual(a.drivers, ['Test time under one minute', 'Same SQL dialect as production for the queries we use']);
    assert.match(a.consequences!, /40 s/);
    assert.deepEqual(a.consequencesGood, ['The suite runs in 40 s.']);
    assert.deepEqual(a.consequencesBad, ['JSON operators differ and need a shim.']);
    assert.equal(a.confirmation, 'The CI job fails if the suite takes more than 60 s.');
    assert.doesNotMatch(a.decision!, /Consequences|Confirmation/, 'the decision text stops before its subsections');
    assert.deepEqual(a.other.map((s) => s.heading), ['More Information']);
    assert.ok(a.links.some((l) => l.kind === 'supersedes' && l.target === '0002-use-postgres-in-docker-for-tests' && l.via === 'text'));
    assert.equal(d['0002'].status, 'superseded');
    assert.ok(d['0002'].links.some((l) => l.kind === 'superseded-by' && l.target === '0003-use-sqlite-in-tests'));
  });

  test('MADR 3: status and date in the front matter, without decision-makers', () => {
    const [a] = fixture('madr3');
    assert.equal(a.format, 'madr3');
    assert.equal(a.status, 'proposed');
    assert.equal(a.date, '2025-11-20');
    assert.match(a.consequences!, /same pull request/);
    assert.deepEqual(a.consequencesGood, ['Reviews see the decision in the same pull request.']);
  });

  test('Nygard (adr-tools): status in a section, Date:, Supersedes and Superseded by', () => {
    const d = byId(fixture('nygard'));
    assert.equal(d['0001'].format, 'adr-tools');
    assert.equal(d['0001'].number, 1);
    assert.equal(d['0001'].title, 'Record architecture decisions');
    assert.equal(d['0002'].status, 'superseded');
    assert.equal(d['0003'].status, 'accepted'); // "Accepted" + "Supersedes …" no mesmo bloco
    assert.ok(d['0003'].links.some((l) => l.kind === 'supersedes' && l.target === '0002-use-a-message-queue'));
    assert.deepEqual(d['0001'].missing, ['options']);
    assert.deepEqual(chainOf(fixture('nygard'), '0002-use-a-message-queue').map((n) => n.number), [2, 3]);
  });

  test('Y-statement: the sentence becomes context, decision, options and consequences', () => {
    const [a] = fixture('y-statement');
    assert.equal(a.format, 'y-statement');
    assert.match(a.context!, /dashboard.*secondary rate limit/);
    assert.match(a.decision!, /^a shallow query with a local cache/);
    assert.deepEqual(a.options.map((o) => o.name), ['a shallow query with a local cache', 'nested queries', 'webhooks']);
    assert.match(a.consequences!, /two minutes late/);
    assert.deepEqual(a.missing, []);
  });

  test('free pt-BR: supersedes and superseded by, with the inverse, and "Substitui: nada" is not a link', () => {
    const d = byId(fixture('free-pt', 'docs/decisoes'));
    assert.equal(d['0002'].status, 'superseded');
    assert.ok(d['0003'].links.some((l) => l.kind === 'supersedes' && l.target === '0002-event-queue'));
    assert.ok(d['0002'].links.some((l) => l.kind === 'superseded-by' && l.target === '0003-event-log'));
    assert.ok(!d['0001'].links.some((l) => l.kind === 'supersedes'));
    assert.deepEqual(d['0001'].options.map((o) => o.name), ['Postgres no Docker', 'Repositório falso']);
    assert.equal(d['0001'].language, 'pt');
    assert.deepEqual(d['0002'].missing, ['options', 'consequences']);
    assert.deepEqual(chains(fixture('free-pt', 'docs/decisoes')).map((c) => c.map((n) => n.number)), [[2, 3]]);
  });

  test('an unknown format stays free: title, the sections by synonym and the rest in other sections', () => {
    const a = parseDecision('# Logs\n\nSome intro.\n\n## Background\n\nWhy.\n\n## Notes from the meeting\n\nText.\n\n## Risks\n\nMany.\n', 'notes/logs.md');
    assert.equal(a.format, 'free');
    assert.equal(a.title, 'Logs');
    assert.equal(a.number, null);
    assert.equal(a.context, 'Why.');
    assert.deepEqual(a.other.map((s) => s.heading), ['Notes from the meeting', 'Risks']);
    assert.deepEqual(a.missing, ['status', 'date', 'decision', 'options', 'consequences']);
  });

  test('MADR pros and cons: each option keeps its pros and cons', () => {
    const text = [
      '---',
      'status: accepted',
      'decision-makers: dev-sintetico',
      '---',
      '# Rules in a versioned decision table',
      '',
      '## Context and Problem Statement',
      '',
      'Rules change weekly.',
      '',
      '## Considered Options',
      '',
      '* Decision table',
      '* In-process engine',
      '',
      '## Decision Outcome',
      '',
      'Chosen option: "Decision table", because it can be reviewed in a pull request.',
      '',
      '## Pros and Cons of the Options',
      '',
      '### Decision table',
      '',
      '* Good, because it is versioned',
      '* Good, because it needs no deploy',
      '* Bad, because loops do not fit',
      '',
      '### In-process engine',
      '',
      '* Bad, because each change is a deploy',
    ].join('\n');
    const a = parseDecision(text, 'docs/adr/0008-rules.md');
    assert.equal(a.number, 8);
    assert.deepEqual(a.options, [
      { name: 'Decision table', chosen: true, pros: ['It is versioned', 'It needs no deploy'], cons: ['Loops do not fit'] },
      { name: 'In-process engine', chosen: false, pros: [], cons: ['Each change is a deploy'] },
    ]);
    assert.equal(a.chosenReason, 'it can be reviewed in a pull request.');
    assert.deepEqual(a.other, [], 'pros and cons are structured, not an other section');
  });

  test('a fenced block with a ## line does not split the sections', () => {
    const a = parseDecision('# 1. X\n\n## Context\n\n```md\n## Decision\n```\n\nMore.\n', 'docs/adr/0001-x.md');
    assert.match(a.context!, /More\./);
    assert.equal(a.decision, null);
  });
});

describe('#174 extractor: normalization', () => {
  test('dates, statuses and files that are not records', () => {
    assert.equal(normalizeDate('18/10/2026'), '2026-10-18');
    assert.equal(normalizeDate('2026-10-18T10:00:00Z'), '2026-10-18');
    assert.equal(normalizeDate('20200924'), '2020-09-24');
    assert.equal(normalizeDate('outubro'), null);
    assert.equal(normalizeDate('2026-13-40'), null);
    assert.equal(normalizeStatus('Superseded by ADR-0007'), 'superseded');
    assert.equal(normalizeStatus('Accepted\n\nSupersedes [1. Foo](0001-foo.md)'), 'accepted');
    assert.equal(normalizeStatus('rejeitada'), 'rejected');
    assert.equal(normalizeStatus('obsoleta'), 'deprecated');
    assert.equal(normalizeStatus('em discussão'), 'proposed');
    assert.equal(normalizeStatus('talvez'), 'unknown');
    assert.equal(isDecisionFile('README.md'), false);
    assert.equal(isDecisionFile('adr-template.md'), false);
    assert.equal(isDecisionFile('0001-x.md'), true);
    assert.equal(isDecisionFile('0001-x.txt'), false);
  });

  test('the log4brains date prefix is a date, not a number', () => {
    const a = parseDecision('# Use Markdown\n\n- Status: accepted\n', 'docs/adr/20200924-use-markdown.md');
    assert.equal(a.number, null);
    assert.equal(a.date, '2020-09-24');
    assert.equal(a.title, 'Use Markdown');
  });

  test('the 14 ADR folders and the 9 PDR folders, in the search order', () => {
    assert.equal(ADR_DIRS.length, 14);
    assert.equal(PDR_DIRS.length, 9);
    assert.deepEqual(DECISION_DIRS.slice(0, 4), ['docs/adr', 'docs/adrs', 'docs/decisions', 'docs/decisoes']);
  });

  test('two records with the same file name in two folders get distinct ids', () => {
    const ids = uniqueIds([parseDecision('# A', 'docs/adr/0001-a.md'), parseDecision('# A', 'docs/pdr/0001-a.md')]).map((r) => r.id);
    assert.deepEqual(ids, ['0001-a', '0001-a--2']);
  });
});

describe('#174 extractor: ADR or PDR', () => {
  test('type field in a mixed folder, prefix, folder and the default', () => {
    const mixed = byId(fixture('mixed-pt', 'docs/decisoes'));
    assert.deepEqual([mixed['0001'].kind, mixed['0001'].kindReason], ['adr', 'type-field']);
    assert.deepEqual([mixed['0002'].kind, mixed['0002'].kindReason], ['pdr', 'type-field']);
    assert.deepEqual([mixed['0003'].kind, mixed['0003'].kindReason], ['adr', 'default']);
    assert.deepEqual(mixed['0002'].options.map((o) => o.name), ['Teste de 14 dias', 'Um projeto só']);
    assert.deepEqual(mixed['0002'].deciders, ['produto-sintetico', 'dev-sintetico']);
    const [a, b] = fixture('pdr', 'docs/pdr');
    assert.deepEqual([a.id, a.kind, a.kindReason, a.number, a.title, a.format], ['0002-pricing-page-in-local-currency', 'pdr', 'folder', 2, 'Pricing page in local currency', 'adr-tools']);
    assert.deepEqual([b.kind, b.kindReason, b.number, b.title, b.format, b.chosen], ['pdr', 'prefix', 1, 'Onboarding in three steps', 'madr4', 'Three steps, the rest deferred']);
    // A mesma PDR numa pasta de ADR, sem campo nem prefixo, vira ADR: a pasta só decide sem sinal melhor.
    assert.equal(fixture('pdr', 'docs/adr')[0].kind, 'adr');
  });

  test('classify reads the front matter type and the ADR prefix', () => {
    assert.deepEqual(classify({ path: 'docs/decisions/x.md', fm: { type: 'product' } }), { kind: 'pdr', why: 'type-field' });
    assert.deepEqual(classify({ path: 'docs/pdr/ADR-0001-x.md' }), { kind: 'adr', why: 'prefix' });
    assert.deepEqual(classify({ path: 'docs/decisions/x.md', title: 'PDR-7: Free plan' }), { kind: 'pdr', why: 'prefix' });
  });
});

describe('#174 extractor: the ADRs of docs/decisoes in this repository', () => {
  const adrs = readDir(here('../../../../docs/decisoes'), 'docs/decisoes');
  const d = byId(adrs);

  test('status, date and sections of all of them, as ADR by default', () => {
    assert.ok(adrs.length >= 7);
    for (const a of adrs) {
      assert.equal(a.format, 'free', a.id);
      assert.equal(a.language, 'pt', a.id);
      assert.match(a.status, /^(accepted|proposed)$/, a.id);
      assert.match(a.date!, /^2026-\d\d-\d\d$/, a.id);
      assert.ok(a.context && a.decision && a.consequences, a.id);
      assert.deepEqual([a.kind, a.kindReason], ['adr', 'default'], a.id);
    }
  });

  test('the first seven, field by field', () => {
    assert.equal(d['0001'].date, '2026-10-18'); // escrita como 18/10/2026
    assert.equal(d['0001'].number, 1);
    assert.equal(d['0001'].title, 'Consulta ao GitHub: enxuta, com cache e busca sob demanda');
    assert.deepEqual(d['0001'].options.slice(0, 2).map((o) => o.name), ['Manter a consulta aninhada, com cache maior', 'Consulta enxuta + filhas ao expandir + delta']);
    assert.equal(d['0005'].status, 'accepted');
    assert.match(d['0005'].statusRaw!, /revista no mesmo dia/);
    assert.equal(d['0007'].status, 'proposed');
    assert.deepEqual(d['0004'].missing, ['options']);
    for (const k of ['0001', '0002', '0003', '0005', '0006', '0007']) assert.deepEqual(d[k].missing, [], k);
  });

  test('the links: "Parte de" and "Mexe em" become related, with the inverse; the backlog is not a record', () => {
    assert.ok(d['0005'].links.some((l) => l.kind === 'related' && l.target === '0004-painel-da-sessao' && l.via === 'parte de'));
    assert.ok(d['0002'].links.some((l) => l.kind === 'related' && l.target === '0006-multiplas-contas' && l.via === 'inverse'));
    assert.ok(adrs.every((a) => a.links.every((l) => l.target)));
  });

  test('0010 supersedes 0005, which still says accepted: the inverse appears and the conflict is flagged', () => {
    if (!d['0010']) return; // a 0010 entrou depois das sete primeiras
    assert.ok(d['0010'].links.some((l) => l.kind === 'supersedes' && l.target === '0005-app-desktop'));
    assert.ok(d['0005'].links.some((l) => l.kind === 'superseded-by' && l.target === '0010-core-per-installation'));
    assert.match(d['0005'].statusConflict ?? '', /superseded-by/);
  });
});
