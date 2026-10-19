import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InvalidModelError, displayStatus, isUrgent, validateSession } from '../src/model.ts';
import { at, session } from './fixtures.ts';

describe('status exibido', () => {
  test('sem espera, mostra o status persistido', () => {
    for (const status of ['active', 'completed', 'error', 'abandoned'] as const) {
      assert.equal(displayStatus(session({ status })), status);
    }
  });

  test('com awaitingInputSince, mostra waiting seja qual for o status persistido', () => {
    assert.equal(displayStatus(session({ awaitingInputSince: at(1), awaitingReason: 'stop' })), 'waiting');
    assert.equal(
      displayStatus(session({ status: 'error', awaitingInputSince: at(1), awaitingReason: 'interrupted' })),
      'waiting',
    );
  });

  test('notification e interrupted são urgentes; stop e session_start não', () => {
    const waiting = (awaitingReason: 'notification' | 'interrupted' | 'stop' | 'session_start') =>
      session({ awaitingInputSince: at(1), awaitingReason });
    assert.equal(isUrgent(waiting('notification')), true);
    assert.equal(isUrgent(waiting('interrupted')), true);
    assert.equal(isUrgent(waiting('stop')), false);
    assert.equal(isUrgent(waiting('session_start')), false);
    assert.equal(isUrgent(session()), false);
  });
});

describe('validação da sessão', () => {
  test('aceita uma sessão válida', () => {
    validateSession(session());
  });

  test('motivo sem espera, ou espera sem motivo, é inválido', () => {
    assert.throws(() => validateSession(session({ awaitingReason: 'stop' })), InvalidModelError);
    assert.throws(() => validateSession(session({ awaitingInputSince: at(1) })), InvalidModelError);
  });

  test('motivo fora da lista é inválido', () => {
    assert.throws(
      () => validateSession(session({ awaitingInputSince: at(1), awaitingReason: 'cafe' as never })),
      InvalidModelError,
    );
  });

  test('datas precisam ser ISO 8601 em UTC', () => {
    assert.throws(() => validateSession(session({ startedAt: '2026-11-02 12:00' })), InvalidModelError);
    assert.throws(() => validateSession(session({ updatedAt: '2026-11-02T12:00:00-03:00' })), InvalidModelError);
  });

  test('id vazio é inválido', () => {
    assert.throws(() => validateSession(session({ id: '' })), InvalidModelError);
  });
});
