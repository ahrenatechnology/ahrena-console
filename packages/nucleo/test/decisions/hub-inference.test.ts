// CA6: only metadata goes to the hub, unless the person releases the text.
// CA2: a decision inferred by a small model comes in to confirm and only counts after it is confirmed.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { HUB_METADATA_FIELDS, decisionForHub } from '../../src/decisions/hub.ts';
import { captureSuggestions, noInference, type DecisionInferrer, type InferenceInput } from '../../src/decisions/inference.ts';
import { confirmDecision, currentDecisionsFor, registerDecision, releaseDecisionText } from '../../src/decisions/registry.ts';
import { at, draft, openCtx, type Ctx } from './helpers.ts';

describe('decisions: hub and inference', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await openCtx();
  });
  afterEach(async () => {
    await ctx.storage.close();
  });

  test('CA6: without release, the hub gets only metadata: no conversation text and no local path', async () => {
    const { decision } = await registerDecision(
      ctx.decisions,
      draft({ message: { uuid: 'u1', toolUseId: 't1', transcriptPath: '/home/dev/.claude/projects/-repo-app/s1.jsonl' } }),
      at(2),
    );
    const out = decisionForHub(decision);
    assert.deepEqual(Object.keys(out).sort(), [...HUB_METADATA_FIELDS].sort());
    const json = JSON.stringify(out);
    for (const secret of [decision.choice, decision.context!, ...decision.alternatives, decision.topic!, '/repo/app', '/home/dev']) {
      assert.ok(!json.includes(secret), `leaked ${secret}`);
    }
    assert.deepEqual(out.message, { uuid: 'u1', toolUseId: 't1' });
    assert.equal(out.alternativesCount, 1);
  });

  test('CA6: once released, the text goes along (and the local path stays out)', async () => {
    const { decision } = await registerDecision(ctx.decisions, draft({}), at(2));
    const released = await releaseDecisionText(ctx.decisions, decision.id, at(3));
    const out = decisionForHub(released);
    assert.equal(out.textReleased, true);
    assert.deepEqual(out.text, { topic: decision.topic, context: decision.context, choice: decision.choice, alternatives: decision.alternatives });
    assert.ok(!JSON.stringify(out).includes('/repo/app'));
    assert.equal((await ctx.decisions.getDecision(decision.id))?.textReleased, true);
  });

  test('CA2: the default inferrer infers nothing', async () => {
    const input: InferenceInput = { sessionId: 's1', agentId: null, repo: null, branch: null, transcriptPath: null, excerpts: [] };
    assert.deepEqual(await captureSuggestions(ctx.decisions, noInference, input, at(1)), []);
  });

  test('CA2: a small model\'s suggestion comes in to confirm and only counts after it is confirmed', async () => {
    const seen: InferenceInput[] = [];
    const fake: DecisionInferrer = {
      infer: async (input) => {
        seen.push(input);
        return [
          { uuid: 'u7', at: at(5), subject: 'Cards por coluna', context: 'quantos cards por coluna', choice: '10 cards por coluna, com "mostrar mais"', alternatives: ['20 por coluna', 'rolagem infinita'] },
          { uuid: '', at: at(5), subject: null, context: null, choice: 'sem linha: ignorada', alternatives: [] },
          { uuid: 'u8', at: at(5), subject: null, context: null, choice: '   ', alternatives: [] },
        ];
      },
    };
    const input: InferenceInput = {
      sessionId: 's1',
      agentId: 's1:main',
      repo: '/repo/app',
      branch: 'feat/42-kanban',
      transcriptPath: '/t/s1.jsonl',
      excerpts: [{ role: 'agent', text: 'Sugiro 10 cards por coluna.', uuid: 'u7', at: at(5) }],
    };
    const [s] = await captureSuggestions(ctx.decisions, fake, input, at(6));
    assert.equal(seen.length, 1);
    assert.equal(s.origin, 'suggested');
    assert.equal(s.decidedBy, 'agent');
    assert.equal(s.inferred, true);
    assert.equal(s.state, 'to_confirm');
    assert.deepEqual(s.alternatives, ['20 por coluna', 'rolagem infinita']);
    assert.deepEqual(s.message, { uuid: 'u7', toolUseId: null, transcriptPath: '/t/s1.jsonl' });
    assert.equal((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'family')).length, 0);

    await confirmDecision(ctx.decisions, s.id, at(7));
    assert.deepEqual((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'family')).map((d) => d.id), [s.id]);
    // Repeating the inference does not duplicate.
    assert.deepEqual(await captureSuggestions(ctx.decisions, fake, input, at(8)), []);
  });

  test('CA2: not even a direct registration can make a suggestion count without confirming', async () => {
    const { decision } = await registerDecision(ctx.decisions, draft({ origin: 'suggested', decidedBy: 'user', inferred: false, state: 'current' }), at(1));
    assert.equal(decision.state, 'to_confirm');
    assert.equal(decision.decidedBy, 'agent');
    assert.equal(decision.inferred, true);
  });
});
