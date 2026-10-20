// Os níveis de atenção (#140): o que precisa de você de fato, a sua vez no bate-bola e os PRs que
// aguardam aprovação. Eventos sintéticos e os cenários do simulador.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { atencaoDe } from '../../src/api/atencao.ts';
import { Contas, MontadorDoPainel, TrabalhoPorBranch } from '../../src/api/index.ts';
import { aplicarEvento, resumoVazio } from '../../src/api/resumo.ts';
import { FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { T0, at, event } from '../fixtures.ts';

const S = 'sess-atencao';
const ev = (minuto: number, type: string, toolName: string | null, data: Record<string, unknown> = {}) =>
  event({ sessionId: S, agentId: null, type, toolName, createdAt: at(minuto), data });
const resumoDe = (...eventos: ReturnType<typeof ev>[]) => {
  const r = resumoVazio();
  for (const e of eventos) aplicarEvento(r, e);
  return r;
};
const esperando = (motivo: 'stop' | 'notification' | 'interrupted' | 'session_start') => ({ status: 'waiting' as const, estado: 'waiting' as const, motivo });

describe('#140 CA1 e CA2: precisa de você × sua vez', () => {
  test('permissão, pergunta com opções e plano para aprovar precisam de você', () => {
    assert.deepEqual(atencaoDe(esperando('notification'), resumoDe(ev(1, 'Notification', null, { notification_type: 'permission_prompt' }))), { nivel: 'precisa', porque: 'permissao' });
    assert.deepEqual(atencaoDe(esperando('notification'), resumoDe(ev(1, 'Notification', null, { notification_type: 'elicitation_dialog' }))), { nivel: 'precisa', porque: 'pergunta' });
    const pergunta = resumoDe(ev(1, 'PreToolUse', 'AskUserQuestion', { tool_use_id: 't1', tool_input: { questions: [{ question: 'Qual?', options: [{ label: 'a' }, { label: 'b' }] }] } }));
    assert.deepEqual(atencaoDe(esperando('stop'), pergunta), { nivel: 'precisa', porque: 'pergunta' });
    const plano = resumoDe(ev(1, 'ToolUse', 'ExitPlanMode', { toolUseId: 't2', tool_input: { plan: '# Plano' } }));
    assert.deepEqual(atencaoDe(esperando('stop'), plano), { nivel: 'precisa', porque: 'plano' });
  });

  test('a pergunta respondida sai: volta a ser a sua vez', () => {
    const r = resumoDe(
      ev(1, 'PreToolUse', 'AskUserQuestion', { tool_use_id: 't1', tool_input: { questions: [] } }),
      ev(2, 'PostToolUse', 'AskUserQuestion', { tool_use_id: 't1' }),
    );
    assert.deepEqual(atencaoDe(esperando('stop'), r), { nivel: 'sua-vez', porque: 'sua-vez' });
  });

  test('o fechamento do turno que pede uma decisão (ask ou blocked) precisa de você; sem pedido, é a sua vez', () => {
    const pede = resumoDe(ev(1, 'PreToolUse', 'mcp__ccd_turn__wrap_up', { tool_use_id: 'w1', tool_input: { recap: 'feito', ask: 'Faço o merge?' } }));
    assert.deepEqual(atencaoDe(esperando('stop'), pede), { nivel: 'precisa', porque: 'decisao' });
    const trava = resumoDe(ev(1, 'PreToolUse', 'mcp__ccd_turn__wrap_up', { tool_use_id: 'w1', tool_input: { recap: 'feito', blocked: true } }));
    assert.deepEqual(atencaoDe(esperando('stop'), trava).nivel, 'precisa');
    const so = resumoDe(ev(1, 'PreToolUse', 'mcp__ccd_turn__wrap_up', { tool_use_id: 'w1', tool_input: { recap: 'feito' } }));
    assert.deepEqual(atencaoDe(esperando('stop'), so), { nivel: 'sua-vez', porque: 'sua-vez' });
    // A pessoa respondeu: o pedido do fechamento sai.
    aplicarEvento(pede, ev(2, 'UserPromptSubmit', null));
    assert.deepEqual(atencaoDe(esperando('stop'), pede).nivel, 'sua-vez');
  });

  test('o turno que acabou, o Esc e a sessão no prompt são a sua vez; um texto terminado em "?" também', () => {
    const r = resumoDe(ev(1, 'AssistantMessage', null, {}));
    r.ultimaMensagem = 'Rodo os testes?';
    assert.deepEqual(atencaoDe(esperando('stop'), r), { nivel: 'sua-vez', porque: 'sua-vez' });
    assert.deepEqual(atencaoDe(esperando('interrupted'), r), { nivel: 'sua-vez', porque: 'interrompida' });
    assert.deepEqual(atencaoDe(esperando('session_start'), r), { nivel: 'sua-vez', porque: 'no-prompt' });
  });

  test('erro precisa de você', () => {
    assert.deepEqual(atencaoDe({ status: 'error', estado: 'error', motivo: null }, null), { nivel: 'precisa', porque: 'erro' });
  });
});

describe('#140 CA3: PRs aguardando aprovação', () => {
  test('o PR aberto do branch de uma sessão, com o review pendente, entra; o rascunho não', async () => {
    const montar = async (nome: 'p1' | 'p3') => {
      const storage = openSqliteStorage({ path: ':memory:' });
      const agora = Date.parse(T0);
      await semearCenariosDoPainel(storage, nome, agora);
      const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => agora });
      const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, agora: () => agora, apelido: () => SESSAO_DO_PAINEL });
      await montador.montar({ sessionId: 'qualquer' });
      await trabalho.esperar();
      const p = await montador.montar({ sessionId: 'qualquer' });
      await storage.close();
      return p;
    };
    // P3: o PR #91 está aberto e espera review.
    const p3 = await montar('p3');
    assert.equal(p3.prs.total, 1);
    assert.equal(p3.prs.items[0]?.number, 91);
    assert.match(p3.prs.items[0]!.url, /^https:\/\/github\.com\/.+\/pull\/91$/);
    assert.equal(p3.prs.items[0]?.session.id, SESSAO_DO_PAINEL);
    // P1: o PR #78 é rascunho: não aguarda aprovação.
    assert.equal((await montar('p1')).prs.total, 0);
  });
});
