// CA6: para o hub só saem metadados, salvo se a pessoa liberar o texto.
// CA2: a decisão inferida por um modelo pequeno entra a confirmar e só vale depois de confirmada.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { HUB_METADATA_FIELDS, decisionForHub } from '../../src/decisoes/hub.ts';
import { captureSuggestions, noInference, type DecisionInferrer, type InferenceInput } from '../../src/decisoes/inferencia.ts';
import { confirmDecision, currentDecisionsFor, registerDecision, releaseDecisionText } from '../../src/decisoes/registro.ts';
import { at, draft, openCtx, type Ctx } from './helpers.ts';

describe('decisões: hub e inferência', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await openCtx();
  });
  afterEach(async () => {
    await ctx.storage.close();
  });

  test('CA6: sem liberar, o hub recebe só metadados: nenhum texto da conversa nem caminho local', async () => {
    const { decision } = await registerDecision(
      ctx.decisions,
      draft({ message: { uuid: 'u1', toolUseId: 't1', transcriptPath: '/home/dev/.claude/projects/-repo-app/s1.jsonl' } }),
      at(2),
    );
    const out = decisionForHub(decision);
    assert.deepEqual(Object.keys(out).sort(), [...HUB_METADATA_FIELDS].sort());
    const json = JSON.stringify(out);
    for (const secret of [decision.choice, decision.context!, ...decision.alternatives, decision.topic!, '/repo/app', '/home/dev']) {
      assert.ok(!json.includes(secret), `vazou ${secret}`);
    }
    assert.deepEqual(out.message, { uuid: 'u1', toolUseId: 't1' });
    assert.equal(out.alternativesCount, 1);
  });

  test('CA6: liberado, o texto vai junto (e o caminho local continua de fora)', async () => {
    const { decision } = await registerDecision(ctx.decisions, draft({}), at(2));
    const released = await releaseDecisionText(ctx.decisions, decision.id, at(3));
    const out = decisionForHub(released);
    assert.equal(out.textReleased, true);
    assert.deepEqual(out.text, { topic: decision.topic, context: decision.context, choice: decision.choice, alternatives: decision.alternatives });
    assert.ok(!JSON.stringify(out).includes('/repo/app'));
    assert.equal((await ctx.decisions.getDecision(decision.id))?.textReleased, true);
  });

  test('CA2: o inferidor padrão não infere nada', async () => {
    const input: InferenceInput = { sessionId: 's1', agentId: null, repo: null, branch: null, transcriptPath: null, excerpts: [] };
    assert.deepEqual(await captureSuggestions(ctx.decisions, noInference, input, at(1)), []);
  });

  test('CA2: sugestão de um modelo pequeno entra a confirmar e só vale depois de confirmada', async () => {
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
      excerpts: [{ role: 'agente', text: 'Sugiro 10 cards por coluna.', uuid: 'u7', at: at(5) }],
    };
    const [s] = await captureSuggestions(ctx.decisions, fake, input, at(6));
    assert.equal(seen.length, 1);
    assert.equal(s.origin, 'sugerida');
    assert.equal(s.decidedBy, 'agente');
    assert.equal(s.inferred, true);
    assert.equal(s.state, 'a_confirmar');
    assert.deepEqual(s.alternatives, ['20 por coluna', 'rolagem infinita']);
    assert.deepEqual(s.message, { uuid: 'u7', toolUseId: null, transcriptPath: '/t/s1.jsonl' });
    assert.equal((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'familia')).length, 0);

    await confirmDecision(ctx.decisions, s.id, at(7));
    assert.deepEqual((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'familia')).map((d) => d.id), [s.id]);
    // Repetir a inferência não duplica.
    assert.deepEqual(await captureSuggestions(ctx.decisions, fake, input, at(8)), []);
  });

  test('CA2: nem um registro direto consegue fazer sugestão valer sem confirmar', async () => {
    const { decision } = await registerDecision(ctx.decisions, draft({ origin: 'sugerida', decidedBy: 'usuario', inferred: false, state: 'vigente' }), at(1));
    assert.equal(decision.state, 'a_confirmar');
    assert.equal(decision.decidedBy, 'agente');
    assert.equal(decision.inferred, true);
  });
});
