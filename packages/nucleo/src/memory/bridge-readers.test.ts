// What the bridge's handoff list is reprojected to: the listed fields, with cwd, owner_user and accepted_by_user held apart, and the session match (#734) and (#735).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { matchSession, readBridgeHandoffs } from './bridge-readers.ts';
import { MemoryReadError } from './readers.ts';
import { bridgeHandoffFixture, bridgeHandoffsFixture, FAKE_SESSION_ID, FAKE_TOKEN, OTHER_SESSION_ID } from './mocks/fixtures.ts';

const SHAREABLE_KEYS = ['accepted_at', 'accepted_by', 'accepted_by_session', 'created_at', 'from_agent', 'from_session_id', 'id', 'state', 'to_agent'];

describe('readBridgeHandoffs (#734/AC-2)', () => {
  test('#734/AC-2 each handoff carries the listed fields and none of the planted body fields', () => {
    const { handoffs } = readBridgeHandoffs(JSON.stringify({ handoffs: bridgeHandoffsFixture() }));
    assert.equal(handoffs.length, 2);
    for (const handoff of handoffs) assert.deepEqual(Object.keys(handoff).sort(), SHAREABLE_KEYS);
    const text = JSON.stringify(handoffs);
    for (const planted of ['summary', 'open_questions', 'next_steps', 'files_touched', FAKE_TOKEN, 'secret-plan', 'which database', 'run the migration']) {
      assert.equal(text.includes(planted), false, `${planted} must not appear`);
    }
  });

  test('#734/AC-2 anything else in the input is dropped too: workspace and project ids, and a field upstream adds later', () => {
    const { handoffs } = readBridgeHandoffs(JSON.stringify({ handoffs: [bridgeHandoffFixture({ brand_new_field: 'x' })], hint: 'free text' }));
    const text = JSON.stringify(handoffs);
    assert.equal(text.includes('workspace_id'), false);
    assert.equal(text.includes('project_id'), false);
    assert.equal(text.includes('brand_new_field'), false);
  });

  test('#734/AC-2 the accepted fields keep their values and null stays null', () => {
    const accepted = bridgeHandoffFixture({
      id: '8c1f4b2d-3e5a-4b7c-9d0e-1f2a3b4c5d6e',
      from_session_id: OTHER_SESSION_ID,
      from_agent: 'codex',
      to_agent: null,
      owner_user: null,
      state: 'accepted',
      accepted_by: 'claude-code',
      accepted_at: '2026-11-20T11:00:00Z',
      accepted_by_session: FAKE_SESSION_ID,
      accepted_by_user: 'local:someone',
    });
    const { handoffs, local } = readBridgeHandoffs(JSON.stringify({ handoffs: [accepted] }));
    assert.deepEqual(handoffs[0], {
      id: '8c1f4b2d-3e5a-4b7c-9d0e-1f2a3b4c5d6e',
      from_session_id: OTHER_SESSION_ID,
      from_agent: 'codex',
      to_agent: null,
      state: 'accepted',
      created_at: '2026-11-20T10:00:00Z',
      accepted_by: 'claude-code',
      accepted_at: '2026-11-20T11:00:00Z',
      accepted_by_session: FAKE_SESSION_ID,
    });
    assert.deepEqual(local, [{ id: '8c1f4b2d-3e5a-4b7c-9d0e-1f2a3b4c5d6e', cwd: '/Users/someone/work/app', owner_user: null, accepted_by_user: 'local:someone' }]);
  });

  test('#735/D2 owner_user and accepted_by_user are personal data: in the local part, by handoff id, and in no shareable handoff', () => {
    const owned = bridgeHandoffFixture({ owner_user: 'local:someone', accepted_by_user: 'local:another' });
    const { handoffs, local } = readBridgeHandoffs(JSON.stringify({ handoffs: [owned] }));
    assert.equal(local[0]?.owner_user, 'local:someone');
    assert.equal(local[0]?.accepted_by_user, 'local:another');
    const text = JSON.stringify(handoffs);
    for (const name of ['owner_user', 'accepted_by_user', 'local:someone', 'local:another']) assert.equal(text.includes(name), false, name);
  });

  test('#734/AC-2 #719/AC-11 cwd is in a separately typed local part, by handoff id, and in no shareable handoff', () => {
    const { handoffs, local } = readBridgeHandoffs(JSON.stringify({ handoffs: bridgeHandoffsFixture() }));
    assert.deepEqual(local, [
      { id: '7b0e3a1c-2d4f-4a6b-8c9d-0e1f2a3b4c5d', cwd: '/Users/someone/work/app', owner_user: 'local:someone', accepted_by_user: null },
      { id: '9d2a5c3e-4f6b-4c8d-8e1f-2a3b4c5d6e7f', cwd: '/Users/someone/work/other', owner_user: 'local:someone', accepted_by_user: null },
    ]);
    assert.equal(JSON.stringify(handoffs).includes('/Users/'), false);
    assert.equal(JSON.stringify(handoffs).includes('cwd'), false);
  });

  test('#734/AC-2 a result that carries the newer-session hint and a hint text reads the same', () => {
    const { handoffs } = readBridgeHandoffs(JSON.stringify({ handoffs: [bridgeHandoffFixture()], newer_unended_session: { session_id: 'x' }, hint: 'read it' }));
    assert.equal(handoffs.length, 1);
  });

  const MALFORMED: [string, string][] = [
    ['text that is not JSON', `{ nope ${FAKE_TOKEN}`],
    ['no handoffs array', JSON.stringify({ handoffs: 'x' })],
    ['an id that is a number', JSON.stringify({ handoffs: [bridgeHandoffFixture({ id: 1 })] })],
    ['a state that is unknown', JSON.stringify({ handoffs: [bridgeHandoffFixture({ state: 'weird' })] })],
    ['a created_at that is a number', JSON.stringify({ handoffs: [bridgeHandoffFixture({ created_at: 5 })] })],
    ['an accepted_by_session that is a number', JSON.stringify({ handoffs: [bridgeHandoffFixture({ accepted_by_session: 5 })] })],
    ['a cwd that is a number', JSON.stringify({ handoffs: [bridgeHandoffFixture({ cwd: 5 })] })],
    ['an owner_user that is a number', JSON.stringify({ handoffs: [bridgeHandoffFixture({ owner_user: 5 })] })],
  ];
  for (const [name, text] of MALFORMED) {
    test(`#734/AC-2 ${name} is rejected with malformed-bridge, a code and never the input`, () => {
      assert.throws(
        () => readBridgeHandoffs(text),
        (error) => error instanceof MemoryReadError && error.code === 'malformed-bridge' && !String(error.message).includes(FAKE_TOKEN),
      );
    });
  }
});

describe('matchSession (#734)', () => {
  test('#719/AC-8 the handoffs a session opened are matched by from_session_id only', () => {
    const { handoffs } = readBridgeHandoffs(JSON.stringify({ handoffs: bridgeHandoffsFixture() }));
    const view = matchSession(handoffs, FAKE_SESSION_ID);
    assert.deepEqual(view, { opened: handoffs.filter((h) => h.from_session_id === FAKE_SESSION_ID) });
    assert.deepEqual(view.opened.map((h) => h.id), ['7b0e3a1c-2d4f-4a6b-8c9d-0e1f2a3b4c5d']);
  });

  test('#719/AC-8 a session with no handoff has empty lists, and the other session is matched on its own', () => {
    const { handoffs } = readBridgeHandoffs(JSON.stringify({ handoffs: bridgeHandoffsFixture() }));
    assert.deepEqual(matchSession(handoffs, 'unknown-session'), { opened: [] });
    assert.equal(matchSession(handoffs, OTHER_SESSION_ID).opened.length, 1);
  });
});
