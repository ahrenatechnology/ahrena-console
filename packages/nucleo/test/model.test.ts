import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ACCOUNT_SOURCES,
  InvalidModelError,
  accountSourceOverrides,
  accountSourceRank,
  applySessionAccount,
  claudeAccountId,
  displayStatus,
  isUrgent,
  validateClaudeAccount,
  validateSession,
} from '../src/model.ts';
import { account, at, session } from './fixtures.ts';

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

describe('conta da sessão', () => {
  test('a ordem das fontes é a da decisão 0006', () => {
    assert.deepEqual([...ACCOUNT_SOURCES], ['env', 'config', 'transcript', 'desktop', 'profile']);
    assert.deepEqual(ACCOUNT_SOURCES.map(accountSourceRank), [1, 2, 3, 4, 5]);
    assert.equal(accountSourceRank(null), Number.POSITIVE_INFINITY);
    assert.throws(() => accountSourceRank('palpite' as never), InvalidModelError);
  });

  test('fonte de ordem menor corrige uma maior, nunca o contrário', () => {
    assert.equal(accountSourceOverrides('env', 'profile'), true);
    assert.equal(accountSourceOverrides('transcript', 'desktop'), true);
    assert.equal(accountSourceOverrides('profile', 'env'), false);
    assert.equal(accountSourceOverrides('desktop', 'transcript'), false);
  });

  test('a mesma ordem não troca a conta gravada', () => {
    for (const s of ACCOUNT_SOURCES) assert.equal(accountSourceOverrides(s, s), false);
  });

  test('qualquer fonte preenche a "Sem conta"; nenhuma fonte não muda nada', () => {
    for (const s of ACCOUNT_SOURCES) assert.equal(accountSourceOverrides(s, null), true);
    assert.equal(accountSourceOverrides(null, null), false);
    assert.equal(accountSourceOverrides(null, 'profile'), false);
  });

  test('applySessionAccount aplica a precedência à sessão', () => {
    const c1 = account({ n: 1 }).id;
    const c2 = account({ n: 2 }).id;
    const inferida = applySessionAccount(session(), c1, 'profile');
    assert.equal(inferida.accountId, c1);
    assert.equal(inferida.accountSource, 'profile');

    // O hook ao vivo corrige a inferência da importação.
    const corrigida = applySessionAccount(inferida, c2, 'env');
    assert.deepEqual([corrigida.accountId, corrigida.accountSource], [c2, 'env']);

    // A importação depois não desfaz o que o hook gravou.
    assert.equal(applySessionAccount(corrigida, c1, 'transcript'), corrigida);
    assert.equal(applySessionAccount(corrigida, c1, 'env'), corrigida);
  });

  test('conta e procedência andam juntas', () => {
    validateSession(session({ accountId: claudeAccountId('u', 'o'), accountSource: 'desktop' }));
    assert.throws(() => validateSession(session({ accountId: 'u/o' })), InvalidModelError);
    assert.throws(() => validateSession(session({ accountSource: 'env' })), InvalidModelError);
    assert.throws(() => validateSession(session({ accountId: '', accountSource: 'env' })), InvalidModelError);
  });
});

describe('validação da conta', () => {
  test('aceita uma conta válida', () => {
    validateClaudeAccount(account());
  });

  test('o id é <accountUuid>/<organizationUuid>', () => {
    assert.equal(claudeAccountId('a', 'b'), 'a/b');
    assert.throws(() => validateClaudeAccount(account({ id: 'x' })), InvalidModelError);
    assert.throws(() => validateClaudeAccount(account({ accountUuid: '', id: '/00000000-0000-4000-8000-0000000000b1' })), InvalidModelError);
  });

  test('datas em UTC e lastSeenAt não antes de firstSeenAt', () => {
    assert.throws(() => validateClaudeAccount(account({ firstSeenAt: 'ontem' })), InvalidModelError);
    assert.throws(() => validateClaudeAccount(account({ firstSeenAt: at(5), lastSeenAt: at(1) })), InvalidModelError);
  });

  test('configDirs é lista de caminhos', () => {
    assert.throws(() => validateClaudeAccount(account({ configDirs: [''] })), InvalidModelError);
    assert.throws(() => validateClaudeAccount(account({ configDirs: 'x' as never })), InvalidModelError);
  });
});
