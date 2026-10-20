// The readable phrase of an event, which the Dashboard (#27) and the Feed (#94) show. Synthetic fixtures.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { codigoDoErro, duracao, fraseDoEvento } from '../../src/api/event-phrase.ts';

const em = '2026-11-02T12:00:38.200Z';
const ev = (type: string, extra: { toolName?: string | null; summary?: string | null; data?: unknown } = {}) => ({
  type,
  toolName: extra.toolName ?? null,
  summary: extra.summary ?? null,
  data: extra.data ?? null,
  createdAt: em,
});

describe('a frase do evento', () => {
  test('ferramenta e alvo, subagente e plano', () => {
    assert.equal(fraseDoEvento(ev('PreToolUse', { toolName: 'Read', summary: 'src/cobranca/servico.ts' })), 'Read: src/cobranca/servico.ts');
    assert.equal(fraseDoEvento(ev('ToolUse', { toolName: 'Bash', summary: 'Bash' })), 'Bash');
    assert.equal(fraseDoEvento(ev('PreToolUse', { toolName: 'Agent', data: { tool_input: { subagent_type: 'Explore' } } })), 'Subagente Explore iniciado');
    assert.equal(fraseDoEvento(ev('PreToolUse', { toolName: 'Agent', summary: '3 subagentes em paralelo' })), 'Agent: 3 subagentes em paralelo');
    assert.equal(fraseDoEvento(ev('PreToolUse', { toolName: 'Task' })), 'Subagente iniciado');
    assert.equal(fraseDoEvento(ev('PreToolUse', { toolName: 'TodoWrite', summary: 'plano' })), 'Plano atualizado');
    assert.equal(fraseDoEvento(ev('PostToolUse', { toolName: 'Bash', summary: 'erro: npm test' })), 'Bash falhou');
    assert.equal(fraseDoEvento(ev('PostToolUse', { toolName: 'Bash', summary: 'npm test' })), 'Bash concluído');
  });

  test('turno com e sem duração', () => {
    assert.equal(fraseDoEvento(ev('Stop'), { ultimoPrompt: Date.parse('2026-11-02T12:00:00Z') }), 'Turno concluído em 38,2 s');
    assert.equal(fraseDoEvento(ev('Stop')), 'Turno concluído');
    assert.equal(fraseDoEvento(ev('Stop'), { ultimoPrompt: Date.parse('2026-10-01T00:00:00Z') }), 'Turno concluído', 'mais de um dia não é um turno');
    assert.equal(fraseDoEvento(ev('TurnDuration', { data: { durationMs: 125_000 } })), 'Turno concluído em 2 min');
  });

  test('pedidos, avisos, erros e ciclo de vida', () => {
    const notif = (tipo: string) => ev('Notification', { summary: 'mensagem', data: { notification_type: tipo } });
    assert.equal(fraseDoEvento(notif('permission_prompt'), { ultimaFerramenta: { nome: 'Bash', resumo: 'npm run build' } }), 'Pede permissão: Bash npm run build');
    assert.equal(fraseDoEvento(notif('permission_prompt')), 'Pede permissão');
    assert.equal(fraseDoEvento(notif('elicitation_dialog')), 'Fez uma pergunta');
    assert.equal(fraseDoEvento(notif('idle_prompt')), 'Sua vez');
    assert.equal(fraseDoEvento(notif('outro')), 'Aviso: mensagem');
    assert.equal(fraseDoEvento(ev('PermissionRequest', { toolName: 'Write', summary: 'a.ts' })), 'Pede permissão: Write a.ts');
    assert.equal(fraseDoEvento(ev('Interrupted')), 'Interrompida (Esc)');
    assert.equal(fraseDoEvento(ev('APIError', { summary: 'API Error: 529 overloaded_error — detalhes secretos' })), 'Erro de API 529 · overloaded_error');
    assert.equal(fraseDoEvento(ev('StopFailure')), 'Erro de API');
    assert.equal(fraseDoEvento(ev('SessionStart', { summary: 'resume' })), 'Sessão retomada');
    assert.equal(fraseDoEvento(ev('SessionEnd', { summary: 'logout' })), 'Sessão encerrada');
    assert.equal(fraseDoEvento(ev('SubagentStop', { summary: 'Explore' })), 'Subagente Explore terminou');
    assert.equal(fraseDoEvento(ev('UserPromptSubmit', { summary: 'rode os testes' })), 'Prompt: "rode os testes"');
    assert.equal(fraseDoEvento(ev('AssistantMessage', { summary: 'Pronto.' })), 'Resposta: "Pronto."');
    assert.equal(fraseDoEvento(ev('AssistantMessage')), 'Resposta do modelo');
    assert.equal(fraseDoEvento(ev('Desconhecido')), null);
  });

  test('do erro sai só o código, e a duração no jeito do console', () => {
    assert.equal(codigoDoErro('falhou com 500 e api_error: texto'), '500 · api_error');
    assert.equal(codigoDoErro('sem código'), null);
    assert.equal(duracao(9.04), '9,0 s');
    assert.equal(duracao(3900), '1 h 5 min');
  });
});
