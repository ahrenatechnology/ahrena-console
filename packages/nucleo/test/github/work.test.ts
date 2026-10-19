import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { levelOf, parseWorkKey, stageOf, type LinkedPullRequest } from '../../src/index.ts';

const pr = (over: Partial<LinkedPullRequest> = {}): LinkedPullRequest => ({
  number: 1, url: 'u', state: 'OPEN', isDraft: false, review: null, ci: 'SUCCESS', ...over,
});

describe('nível na hierarquia', () => {
  test('pelo tipo de issue', () => {
    assert.equal(levelOf('Initiative', null), 'initiative');
    assert.equal(levelOf('Epic', 'initiative'), 'epic');
    assert.equal(levelOf('Tech Task', 'epic'), 'item');
    assert.equal(levelOf('User Story', null), 'item');
    assert.equal(levelOf('Plan', 'item'), 'plan');
  });

  test('sem tipo: um abaixo do pai, parando em plano; sem pai, item', () => {
    assert.equal(levelOf(null, 'initiative'), 'epic');
    assert.equal(levelOf(null, 'item'), 'plan');
    assert.equal(levelOf('Desconhecido', 'plan'), 'plan');
    assert.equal(levelOf(null, null), 'item');
  });
});

describe('etapa pelo PR, CI e review', () => {
  test('issue fechada é concluída, mesmo com PR aberto', () => assert.equal(stageOf('CLOSED', [pr()]), 'concluída'));
  test('sem PR é a fazer', () => assert.equal(stageOf('OPEN', []), 'a fazer'));
  test('PR mergeado', () => assert.equal(stageOf('OPEN', [pr({ state: 'MERGED' })]), 'mergeado'));
  test('só PR fechado sem merge é a fazer', () => assert.equal(stageOf('OPEN', [pr({ state: 'CLOSED' })]), 'a fazer'));
  test('rascunho', () => assert.equal(stageOf('OPEN', [pr({ isDraft: true })]), 'em andamento'));
  test('CI falhou', () => {
    assert.equal(stageOf('OPEN', [pr({ ci: 'FAILURE' })]), 'ci falhou');
    assert.equal(stageOf('OPEN', [pr({ ci: 'ERROR' })]), 'ci falhou');
  });
  test('CI rodando', () => {
    assert.equal(stageOf('OPEN', [pr({ ci: 'PENDING' })]), 'ci rodando');
    assert.equal(stageOf('OPEN', [pr({ ci: 'EXPECTED' })]), 'ci rodando');
  });
  test('review pediu ajustes', () => assert.equal(stageOf('OPEN', [pr({ review: 'CHANGES_REQUESTED' })]), 'ajustes pedidos'));
  test('CI verde esperando review', () => {
    assert.equal(stageOf('OPEN', [pr({ review: 'REVIEW_REQUIRED' })]), 'em revisão');
    assert.equal(stageOf('OPEN', [pr({ ci: null, review: 'APPROVED' })]), 'em revisão');
  });
});

test('chave da issue', () => {
  assert.deepEqual(parseWorkKey('dono/repo#12'), { owner: 'dono', name: 'repo', repo: 'dono/repo', number: 12 });
  assert.throws(() => parseWorkKey('repo#12'), /inválida/);
  assert.throws(() => parseWorkKey('dono/repo#x'), /inválida/);
});
