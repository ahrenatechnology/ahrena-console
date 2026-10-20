// node --test spikes/adr-extractor: o extrator contra as ADRs deste repositório e as amostras.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readDir, normalizeDate, normalizeStatus, isAdrFile } from './extract.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const byId = (adrs) => Object.fromEntries(adrs.map((a) => [a.id.slice(0, 4), a]));

test('docs/decisoes deste repositório: status, data e seções de todas', async () => {
  const adrs = await readDir(here('../../docs/decisoes'));
  assert.ok(adrs.length >= 7);
  for (const a of adrs) {
    assert.equal(a.format, 'free', a.id);
    assert.equal(a.language, 'pt', a.id);
    assert.match(a.status, /^(accepted|proposed)$/, a.id);
    assert.match(a.date, /^2026-\d\d-\d\d$/, a.id);
    assert.ok(a.context && a.decision && a.consequences, a.id);
  }
  const d = byId(adrs);
  assert.equal(d['0001'].date, '2026-10-18'); // escrita como 18/10/2026
  assert.equal(d['0001'].number, 1);
  assert.equal(d['0001'].title, 'Consulta ao GitHub: enxuta, com cache e busca sob demanda');
  assert.deepEqual(d['0001'].options.slice(0, 2), ['Manter a consulta aninhada, com cache maior', 'Consulta enxuta + filhas ao expandir + delta']);
  assert.equal(d['0005'].status, 'accepted');
  assert.match(d['0005'].statusRaw, /revista no mesmo dia/);
  assert.equal(d['0007'].status, 'proposed');
  assert.deepEqual(d['0004'].missing, ['options']);
  // "Parte de: [0004]" e "Mexe em: [0002], [0004], [0005]" viram ligações soltas, e a volta aparece.
  assert.ok(d['0005'].links.some((l) => l.kind === 'related' && l.target === '0004-painel-da-sessao' && l.via === 'parte de'));
  assert.ok(d['0002'].links.some((l) => l.kind === 'related' && l.target === '0006-multiplas-contas' && l.via === 'inverse'));
  // O backlog é citado, mas não é ADR.
  assert.ok(adrs.every((a) => a.links.every((l) => l.target)));
});

test('MADR 4: front matter, opção escolhida, consequências e substituição', async () => {
  const d = byId(await readDir(here('fixtures/madr4')));
  assert.equal(d['0003'].format, 'madr4');
  assert.deepEqual(d['0003'].deciders, ['dev-sintetico', 'colega-a']);
  assert.equal(d['0003'].chosen, 'SQLite in memory');
  assert.deepEqual(d['0003'].options, ['SQLite in memory', 'Postgres in Docker', 'Mocked repository layer']);
  assert.match(d['0003'].consequences, /40 s/);
  assert.ok(d['0003'].links.some((l) => l.kind === 'supersedes' && l.target === '0002-use-postgres-in-docker-for-tests' && l.via === 'text'));
  assert.equal(d['0002'].status, 'superseded');
  assert.ok(d['0002'].links.some((l) => l.kind === 'superseded-by' && l.target === '0003-use-sqlite-in-tests'));
});

test('MADR 3: status e data no front matter, sem decision-makers', async () => {
  const [a] = await readDir(here('fixtures/madr3'));
  assert.equal(a.format, 'madr3');
  assert.equal(a.status, 'proposed');
  assert.match(a.consequences, /same pull request/);
});

test('Nygard (adr-tools): status em seção, Date:, Supersedes e Superseded by', async () => {
  const d = byId(await readDir(here('fixtures/nygard')));
  assert.equal(d['0001'].format, 'adr-tools');
  assert.equal(d['0001'].number, 1);
  assert.equal(d['0001'].title, 'Record architecture decisions');
  assert.equal(d['0002'].status, 'superseded');
  assert.equal(d['0003'].status, 'accepted'); // "Accepted" + "Supersedes …" no mesmo bloco
  assert.ok(d['0003'].links.some((l) => l.kind === 'supersedes' && l.target === '0002-use-a-message-queue'));
  assert.deepEqual(d['0001'].missing, ['options']);
});

test('Y-statement: a frase vira contexto, decisão, opções e consequências', async () => {
  const [a] = await readDir(here('fixtures/y-statement'));
  assert.equal(a.format, 'y-statement');
  assert.match(a.context, /dashboard.*secondary rate limit/);
  assert.match(a.decision, /^a shallow query with a local cache/);
  assert.deepEqual(a.options, ['a shallow query with a local cache', 'nested queries', 'webhooks']);
  assert.match(a.consequences, /two minutes late/);
  assert.deepEqual(a.missing, []);
});

test('livre em pt-BR: substitui e substituída por, com a volta', async () => {
  const d = byId(await readDir(here('fixtures/free-pt')));
  assert.equal(d['0002'].status, 'superseded');
  assert.ok(d['0003'].links.some((l) => l.kind === 'supersedes' && l.target === '0002-event-queue'));
  assert.ok(d['0002'].links.some((l) => l.kind === 'superseded-by' && l.target === '0003-event-log'));
  assert.ok(!d['0001'].links.some((l) => l.kind === 'supersedes')); // "Substitui: nada"
  assert.deepEqual(d['0001'].options, ['Postgres no Docker', 'Repositório falso']);
});

test('normalização: datas, status e arquivos que não são ADR', () => {
  assert.equal(normalizeDate('18/10/2026'), '2026-10-18');
  assert.equal(normalizeDate('2026-10-18T10:00:00Z'), '2026-10-18');
  assert.equal(normalizeDate('20200924'), '2020-09-24');
  assert.equal(normalizeDate('outubro'), null);
  assert.equal(normalizeStatus('Superseded by ADR-0007'), 'superseded');
  assert.equal(normalizeStatus('Accepted\n\nSupersedes [1. Foo](0001-foo.md)'), 'accepted');
  assert.equal(normalizeStatus('rejeitada'), 'rejected');
  assert.equal(normalizeStatus('obsoleta'), 'deprecated');
  assert.equal(normalizeStatus('em discussão'), 'proposed');
  assert.equal(normalizeStatus('talvez'), 'unknown');
  assert.equal(isAdrFile('README.md'), false);
  assert.equal(isAdrFile('adr-template.md'), false);
  assert.equal(isAdrFile('0001-x.md'), true);
});

test('ADR ou PDR: campo de tipo numa pasta mista, prefixo, pasta e o padrão', async () => {
  const mista = byId(await readDir(here('fixtures/mixed-pt'), 'docs/decisoes'));
  assert.deepEqual([mista['0001'].kind, mista['0001'].kindWhy], ['adr', 'campo de tipo']);
  assert.deepEqual([mista['0002'].kind, mista['0002'].kindWhy], ['pdr', 'campo de tipo']);
  assert.deepEqual([mista['0003'].kind, mista['0003'].kindWhy], ['adr', 'padrão']);
  assert.deepEqual(mista['0002'].options, ['Teste de 14 dias', 'Um projeto só']);
  assert.deepEqual(mista['0002'].deciders, ['produto-sintetico', 'dev-sintetico']);
  const pdr = await readDir(here('fixtures/pdr'), 'docs/pdr');
  const [a, b] = pdr;
  assert.deepEqual([a.id, a.kind, a.kindWhy, a.number, a.title, a.format], ['0002-pricing-page-in-local-currency', 'pdr', 'pasta', 2, 'Pricing page in local currency', 'adr-tools']);
  assert.deepEqual([b.kind, b.kindWhy, b.number, b.title, b.format, b.chosen], ['pdr', 'prefixo', 1, 'Onboarding in three steps', 'madr4', 'Three steps, the rest deferred']);
  // As ADRs deste repositório não têm campo de tipo e estão numa pasta mista: ficam ADR pelo padrão.
  assert.ok((await readDir(here('../../docs/decisoes'), 'docs/decisoes')).every((x) => x.kind === 'adr' && x.kindWhy === 'padrão'));
  // A mesma PDR numa pasta de ADR, sem campo nem prefixo, vira ADR: a pasta só decide sem sinal melhor.
  assert.equal((await readDir(here('fixtures/pdr'), 'docs/adr'))[0].kind, 'adr');
});
