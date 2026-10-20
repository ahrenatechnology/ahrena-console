// issue 245: the shared attention vocabulary of the /ui (ui/attention.js) and how the Sessões and
// Detail screens use it: "Precisa de você" (blocked) and "Ociosa" (idle), never the old waiting label.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
// @ts-expect-error: browser modules, plain JavaScript
import * as attention from '../../ui/attention.js';
// @ts-expect-error: idem
import { PILLS, badgeEl, pillCount, stateFromQuery } from '../../ui/screens/sessions.js';
// @ts-expect-error: idem
import { bandTitle, idleNote } from '../../ui/screens/session-detail.js';

instalarDomFalso();

const classes = (n: ElementoFalso) => (n.getAttribute('class') ?? '').split(/\s+/);

describe('attention vocabulary (issue 245)', () => {
  test('labels, plurals and every reason of the core with its pt-BR label', () => {
    assert.deepEqual(attention.ATTENTION_LABEL, { blocked: 'Precisa de você', idle: 'Ociosa' });
    assert.deepEqual(attention.ATTENTION_PLURAL, { blocked: 'Precisam de você', idle: 'Ociosas' });
    const labels = Object.fromEntries(Object.entries(attention.ATTENTION_REASONS as Record<string, { label: string; level: string }>).map(([k, v]) => [k, [v.level, v.label]]));
    assert.deepEqual(labels, {
      permission: ['blocked', 'Pede permissão'],
      question: ['blocked', 'Pergunta'],
      plan: ['blocked', 'Plano para aprovar'],
      decision: ['blocked', 'Decisão pedida'],
      error: ['blocked', 'Com erro'],
      turn_ended: ['idle', 'Sua vez'],
      interrupted: ['idle', 'Interrompida'],
      first_prompt: ['idle', 'No prompt'],
    });
  });

  test('attentionOf keeps only the known levels; tone and text: error keeps "Com erro"', () => {
    assert.equal(attention.attentionOf(null), null);
    assert.equal(attention.attentionOf({ level: 'waiting', reason: 'x' }), null);
    assert.deepEqual(attention.attentionOf({ level: 'idle', reason: 7 }), { level: 'idle', reason: null });
    assert.equal(attention.attentionTone({ level: 'blocked', reason: 'error' }), 'error');
    assert.equal(attention.attentionText({ level: 'blocked', reason: 'question' }), 'Precisa de você');
    assert.equal(attention.attentionText({ level: 'idle', reason: 'turn_ended' }), 'Ociosa');
    assert.equal(attention.attentionText({ level: 'blocked', reason: 'error' }), 'Com erro');
    assert.equal(attention.reasonLabel({ level: 'blocked', reason: 'something-new' }), null, 'never a raw value on screen');
  });

  test('pill and chip: blocked strong and yellow, idle light and neutral, error red and without a chip', () => {
    const blocked = attention.attentionPill({ level: 'blocked', reason: 'plan' }) as ElementoFalso;
    assert.ok(classes(blocked).includes('attention-pill-blocked'));
    assert.equal(texto(blocked), 'Precisa de você');
    const idle = attention.attentionPill({ level: 'idle', reason: 'interrupted' }) as ElementoFalso;
    assert.ok(classes(idle).includes('attention-pill-idle'));
    const chip = attention.reasonChip({ level: 'idle', reason: 'interrupted' }) as ElementoFalso;
    assert.ok(classes(chip).includes('attention-chip-light'));
    assert.equal(texto(chip), 'Interrompida');
    assert.equal(attention.reasonChip({ level: 'blocked', reason: 'error' }), null);
    assert.ok(classes(attention.reasonChip({ level: 'blocked', reason: 'error' }, { withError: true })).includes('attention-chip-error'));
    assert.equal(attention.attentionPill(null), null);
    assert.deepEqual(attention.attentionBadges({ level: 'blocked', reason: 'decision' }).map((n: ElementoFalso) => texto(n)), ['Precisa de você', 'Decisão pedida']);
  });

  test('statusWithoutAttention: waiting without attention is active, the rest unchanged', () => {
    assert.equal(attention.statusWithoutAttention('waiting'), 'active');
    assert.equal(attention.statusWithoutAttention('error'), 'error');
    assert.equal(attention.statusWithoutAttention('completed'), 'completed');
  });

  test('an /api/attention item from an older core: level needs is blocked, your-turn is idle', () => {
    assert.deepEqual(attention.attentionOfItem({ attention: { level: 'idle', reason: 'first_prompt' }, level: 'your-turn' }), { level: 'idle', reason: 'first_prompt' });
    assert.deepEqual(attention.attentionOfItem({ level: 'needs', reason: 'question' }), { level: 'blocked', reason: 'question' });
    assert.deepEqual(attention.attentionOfItem({ level: 'needs', reason: 'your-turn' }), { level: 'blocked', reason: null });
    assert.deepEqual(attention.attentionOfItem({ level: 'needs', reason: 'error' }), { level: 'blocked', reason: 'error' });
    assert.deepEqual(attention.attentionOfItem({ level: 'your-turn', reason: 'your-turn' }), { level: 'idle', reason: null });
    assert.equal(attention.attentionOfItem({}), null);
  });
});

describe('Sessões: the blocked and idle pills (issue 245)', () => {
  test('the status pills: Precisam de você and Ociosas side by side, with the counts of the core', () => {
    assert.deepEqual(
      PILLS.map(([v, label]: [string, string]) => `${v}:${label}`),
      ['all:Todas', 'active:Ativas', 'blocked:Precisam de você', 'idle:Ociosas', 'completed:Concluídas', 'error:Erro', 'abandoned:Abandonadas'],
    );
    assert.equal(pillCount({ blocked: 5, idle: 3 }, 'blocked'), '5');
    assert.equal(pillCount({ blocked: 5 }, 'idle'), null);
    assert.equal(pillCount(null, 'all'), null);
  });

  test('an old bookmark with status=waiting opens the ones that need you', () => {
    assert.equal(stateFromQuery('?status=waiting').status, 'blocked');
    assert.equal(stateFromQuery('?status=idle').status, 'idle');
    assert.equal(stateFromQuery('?status=nonsense').status, 'all');
  });

  test('the status cell: the attention pill and its reason; an error keeps only "Com erro"; no raw status', () => {
    const cell = (status: string, a: unknown) => (badgeEl(status, a) as ElementoFalso[]).map((n) => texto(n));
    assert.deepEqual(cell('waiting', { level: 'blocked', reason: 'permission' }), ['Precisa de você', 'Pede permissão']);
    assert.deepEqual(cell('waiting', { level: 'idle', reason: 'turn_ended' }), ['Ociosa', 'Sua vez']);
    assert.deepEqual(cell('error', { level: 'blocked', reason: 'error' }), ['Com erro']);
    assert.deepEqual(cell('active', null), ['Ativa']);
    assert.deepEqual(cell('waiting', null), ['Ativa'], 'waiting without attention (delegating) is not waiting on you');
    assert.deepEqual(cell('nonsense', null), [], 'nothing raw on screen');
  });
});

describe('Detalhe: the band only when blocked, a muted line when idle (issue 245)', () => {
  test('band title by reason; error is "Com erro."', () => {
    assert.equal(bandTitle({ banner: { type: 'permission' }, attention: { level: 'blocked', reason: 'permission' } }), 'Precisa de você · Pede permissão.');
    assert.equal(bandTitle({ banner: { type: 'question' }, attention: { level: 'blocked', reason: 'question' } }), 'Precisa de você · Pergunta.');
    assert.equal(bandTitle({ banner: { type: 'error' }, attention: { level: 'blocked', reason: 'error' } }), 'Com erro.');
  });

  test('the idle line says what happened and since when, and that nothing blocks', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    assert.equal(idleNote({ level: 'idle', reason: 'turn_ended' }, '2026-10-20T11:59:00Z', now), 'Ociosa · o turno terminou há 1 min e a vez é sua. Nada trava a sessão.');
    assert.match(idleNote({ level: 'idle', reason: 'interrupted' }, '2026-10-20T11:54:00Z', now), /^Ociosa · interrompida há 6 min/);
    assert.match(idleNote({ level: 'idle', reason: 'first_prompt' }, null, now), /^Ociosa · aberta no prompt, sem o primeiro pedido\. Nada trava a sessão\.$/);
  });
});
