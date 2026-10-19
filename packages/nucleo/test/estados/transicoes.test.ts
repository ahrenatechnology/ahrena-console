// Tabela de transições: estado de partida + eventos → estado esperado.
// Cada linha é uma regra de docs/benchmark/00-agent-monitor-detalhado.md (seção 3) ou do Podium.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { displayStatus, type AgentStatus, type AwaitingReason, type DisplayStatus, type SessionEvent, type SessionStatus } from '../../src/model.ts';
import { lerInbox, lerMemoria, transicionar, type EstadoDaSessao, type EstadoDoInbox } from '../../src/estados/index.ts';
import { at } from '../fixtures.ts';
import { MAIN, SID, estado, ev, main, principal, sub } from './helpers.ts';

interface Esperado {
  exibido?: DisplayStatus;
  persistido?: SessionStatus;
  motivo?: AwaitingReason | null;
  principal?: AgentStatus;
  ferramenta?: string | null;
  inbox?: EstadoDoInbox;
  precisaDeVoce?: boolean;
  urgente?: boolean;
  confere?: (e: EstadoDaSessao) => void;
}

interface Linha {
  caso: string;
  antes: EstadoDaSessao;
  eventos: SessionEvent[];
  espera: Esperado;
}

const bash = (min: number, extra: Partial<SessionEvent> = {}) => ({ toolName: 'Bash', ...extra, createdAt: at(min) });

const TABELA: Linha[] = [
  // SessionStart
  {
    caso: 'SessionStart abre esperando no prompt vazio',
    antes: estado(),
    eventos: [ev('SessionStart', 1, { data: { source: 'startup' } })],
    espera: { exibido: 'waiting', persistido: 'active', motivo: 'session_start', principal: 'waiting', urgente: false, precisaDeVoce: true },
  },
  {
    caso: 'SessionStart de compactação preserva o estado',
    antes: estado({}, [principal({ currentTool: 'Read' })]),
    eventos: [ev('SessionStart', 1, { data: { source: 'compact' } })],
    espera: { exibido: 'active', motivo: null, principal: 'working', ferramenta: 'Read' },
  },
  {
    caso: 'SessionStart (resume) reabre sessão encerrada',
    antes: estado({ status: 'completed', endedAt: at(0) }, [principal({ status: 'completed', endedAt: at(0) })]),
    eventos: [ev('SessionStart', 5, { data: { source: 'resume' } })],
    espera: { persistido: 'active', motivo: 'session_start', principal: 'waiting', confere: (e) => assert.equal(e.session.endedAt, null) },
  },
  {
    caso: 'SessionStart reabre sessão abandonada',
    antes: estado({ status: 'abandoned', endedAt: at(0) }),
    eventos: [ev('SessionStart', 5, { data: { source: 'resume' } })],
    espera: { persistido: 'active', motivo: 'session_start' },
  },
  {
    caso: 'SessionStart cria o agente principal quando ele não existe',
    antes: estado({}, []),
    eventos: [ev('SessionStart', 1, { data: { source: 'startup' } })],
    espera: { principal: 'waiting', confere: (e) => assert.equal(main(e).id, MAIN) },
  },
  // UserPromptSubmit
  {
    caso: 'UserPromptSubmit limpa a espera e põe o principal para trabalhar',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [principal({ status: 'waiting' })]),
    eventos: [ev('UserPromptSubmit', 1)],
    espera: { exibido: 'active', motivo: null, principal: 'working', inbox: 'active', precisaDeVoce: false },
  },
  {
    caso: 'UserPromptSubmit numa sessão encerrada a reabre',
    antes: estado({ status: 'completed', endedAt: at(0) }),
    eventos: [ev('UserPromptSubmit', 1)],
    espera: { persistido: 'active', principal: 'working' },
  },
  // PreToolUse / PostToolUse
  {
    caso: 'PreToolUse do principal marca a ferramenta e limpa a permissão pendente',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'notification' }),
    eventos: [ev('PreToolUse', 1, bash(1))],
    espera: { exibido: 'active', motivo: null, principal: 'working', ferramenta: 'Bash' },
  },
  {
    caso: 'regra de ator: subagente trabalhando não limpa a permissão do principal',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'notification' }, [principal({ status: 'waiting' })]),
    eventos: [ev('PreToolUse', 1, { ...bash(1), agentId: 'agent-7', data: { agent_id: 'agent-7', agent_type: 'Explore' } })],
    espera: {
      exibido: 'waiting',
      motivo: 'notification',
      urgente: true,
      confere: (e) => {
        const s = e.agentes.find((a) => a.id === `${SID}:agent-7`);
        assert.equal(s?.type, 'subagent');
        assert.equal(s?.status, 'working');
        assert.equal(s?.subagentType, 'Explore');
        assert.equal(s?.parentAgentId, MAIN);
      },
    },
  },
  {
    caso: 'subagente trabalhando desfaz o "turno morto" do vigia',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'interrupted' }, [principal({ status: 'waiting' }), sub('agent-7')]),
    eventos: [ev('PreToolUse', 1, { ...bash(1), agentId: 'agent-7' })],
    espera: { motivo: null },
  },
  {
    caso: 'PreToolUse de Agent registra a delegação (delegando)',
    antes: estado(),
    eventos: [ev('PreToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'tu-a', tool_input: { description: 'mapear o código' } } })],
    espera: {
      exibido: 'active',
      inbox: 'delegating',
      precisaDeVoce: false,
      confere: (e) => assert.deepEqual(lerMemoria(e.session).delegacoes['tu-a'], { desde: at(1), descricao: 'mapear o código' }),
    },
  },
  {
    caso: 'PostToolUse de Agent encerra a delegação',
    antes: estado(),
    eventos: [
      ev('PreToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'tu-a', tool_input: {} } }),
      ev('PostToolUse', 3, { toolName: 'Agent', data: { tool_use_id: 'tu-a' } }),
    ],
    espera: { inbox: 'active', ferramenta: null, confere: (e) => assert.deepEqual(lerMemoria(e.session).delegacoes, {}) },
  },
  {
    caso: 'subagente trabalhando com o principal parado é delegando',
    antes: estado({}, [principal(), sub('agent-7')]),
    eventos: [ev('PostToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'x' } })],
    espera: { inbox: 'delegating' },
  },
  {
    caso: 'principal rodando outra ferramenta não é delegando, mesmo com subagente',
    antes: estado({}, [principal(), sub('agent-7')]),
    eventos: [ev('PreToolUse', 1, bash(1))],
    espera: { inbox: 'active' },
  },
  {
    caso: 'PostToolUse responde a permissão e limpa a ferramenta',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'notification' }, [principal({ status: 'waiting', currentTool: 'Bash' })]),
    eventos: [ev('PostToolUse', 1, bash(1))],
    espera: { exibido: 'active', motivo: null, principal: 'working', ferramenta: null },
  },
  {
    caso: 'PostToolUseFailure não é erro da sessão',
    antes: estado({}, [principal({ currentTool: 'Bash' })]),
    eventos: [ev('PostToolUseFailure', 1, { ...bash(1), data: { error: 'exit 1' } })],
    espera: { persistido: 'active', principal: 'working', ferramenta: null },
  },
  // Notification
  {
    caso: 'Notification de permissão é waiting urgente',
    antes: estado({}, [principal({ currentTool: 'Bash' })]),
    eventos: [ev('Notification', 1, { data: { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' } })],
    espera: { exibido: 'waiting', motivo: 'notification', principal: 'waiting', urgente: true, precisaDeVoce: true, inbox: 'waiting' },
  },
  {
    caso: 'Notification que não bloqueia não muda nada',
    antes: estado(),
    eventos: [ev('Notification', 1, { data: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } })],
    espera: { exibido: 'active', motivo: null, principal: 'working' },
  },
  {
    caso: 'Notification sem tipo decide pelo texto',
    antes: estado(),
    eventos: [ev('Notification', 1, { data: { message: 'Claude needs your permission to use Edit' } })],
    espera: { motivo: 'notification' },
  },
  {
    caso: 'Notification de subagente deixa o subagente esperando',
    antes: estado({}, [principal({ currentTool: 'Agent' }), sub('agent-7')]),
    eventos: [ev('Notification', 1, { agentId: 'agent-7', data: { notification_type: 'permission_prompt' } })],
    espera: {
      motivo: 'notification',
      inbox: 'waiting',
      confere: (e) => assert.equal(e.agentes.find((a) => a.id === `${SID}:agent-7`)?.status, 'waiting'),
    },
  },
  // Stop
  {
    caso: 'Stop: a vez é do usuário e a sessão continua active',
    antes: estado({}, [principal({ currentTool: 'Bash' })]),
    eventos: [ev('Stop', 1)],
    espera: { exibido: 'waiting', persistido: 'active', motivo: 'stop', principal: 'waiting', ferramenta: null, urgente: false, precisaDeVoce: true },
  },
  {
    caso: 'Stop com stop_reason error vai para error',
    antes: estado(),
    eventos: [ev('Stop', 1, { data: { stop_reason: 'error' } })],
    espera: { exibido: 'error', persistido: 'error', principal: 'error', motivo: null, precisaDeVoce: true },
  },
  {
    caso: 'StopFailure vai para error',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'notification' }),
    eventos: [ev('StopFailure', 1)],
    espera: { exibido: 'error', motivo: null },
  },
  {
    caso: 'Stop com subagente em background: delegando, não esperando você',
    antes: estado({}, [principal(), sub('agent-7')]),
    eventos: [ev('Stop', 1)],
    espera: { exibido: 'waiting', motivo: 'stop', inbox: 'delegating', precisaDeVoce: false },
  },
  {
    caso: 'Stop com Bash em background: esperando processo em background',
    antes: estado(),
    eventos: [
      ev('PostToolUse', 1, { toolName: 'Bash', data: { tool_use_id: 'tu-b', tool_input: { command: 'npm run dev', run_in_background: true }, tool_response: { backgroundTaskId: 'bg-1' } } }),
      ev('Stop', 2),
    ],
    espera: {
      exibido: 'waiting',
      motivo: 'stop',
      inbox: 'background',
      precisaDeVoce: false,
      confere: (e) => {
        assert.deepEqual(lerMemoria(e.session).background, { 'bg-1': { desde: at(1), comando: 'npm run dev' } });
        assert.equal(lerInbox(e.session, e.agentes).processosEmBackground, 1);
      },
    },
  },
  {
    caso: 'KillShell tira o processo do background',
    antes: estado(),
    eventos: [
      ev('PostToolUse', 1, { toolName: 'Bash', data: { tool_input: { command: 'npm run dev', run_in_background: true }, tool_response: { shellId: 'bg-1' } } }),
      ev('PostToolUse', 2, { toolName: 'KillShell', data: { tool_input: { shell_id: 'bg-1' } } }),
      ev('Stop', 3),
    ],
    espera: { inbox: 'waiting', precisaDeVoce: true },
  },
  {
    caso: 'BashOutput com o processo terminado tira do background',
    antes: estado(),
    eventos: [
      ev('PostToolUse', 1, { toolName: 'Bash', data: { tool_input: { command: 'npm test', run_in_background: true }, tool_response: { backgroundTaskId: 'bg-2' } } }),
      ev('PostToolUse', 2, { toolName: 'BashOutput', data: { tool_input: { bash_id: 'bg-2' }, tool_response: { status: 'running' } } }),
    ],
    espera: { confere: (e) => assert.ok(lerMemoria(e.session).background['bg-2']) },
  },
  {
    caso: 'BashOutput com status completed encerra o processo',
    antes: estado(),
    eventos: [
      ev('PostToolUse', 1, { toolName: 'Bash', data: { tool_input: { command: 'npm test', run_in_background: true }, tool_response: { backgroundTaskId: 'bg-2' } } }),
      ev('PostToolUse', 2, { toolName: 'BashOutput', data: { tool_input: { bash_id: 'bg-2' }, tool_response: { status: 'completed' } } }),
    ],
    espera: { confere: (e) => assert.deepEqual(lerMemoria(e.session).background, {}) },
  },
  {
    caso: 'Stop encerra delegações em primeiro plano',
    antes: estado(),
    eventos: [ev('PreToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'tu-a' } }), ev('Stop', 2)],
    espera: { inbox: 'waiting', confere: (e) => assert.deepEqual(lerMemoria(e.session).delegacoes, {}) },
  },
  // SubagentStop
  {
    caso: 'SubagentStop encerra o subagente pelo agent_id',
    antes: estado({}, [principal({ currentTool: 'Agent' }), sub('agent-7'), sub('agent-8')]),
    eventos: [ev('SubagentStop', 1, { agentId: 'agent-8', data: { agent_id: 'agent-8' } })],
    espera: {
      confere: (e) => {
        assert.equal(e.agentes.find((a) => a.id === `${SID}:agent-8`)?.status, 'completed');
        assert.equal(e.agentes.find((a) => a.id === `${SID}:agent-8`)?.endedAt, at(1));
        assert.equal(e.agentes.find((a) => a.id === `${SID}:agent-7`)?.status, 'working');
      },
    },
  },
  {
    caso: 'SubagentStop sem id encerra o subagente trabalhando mais antigo',
    antes: estado({}, [principal(), sub('novo', { startedAt: at(2) }), sub('velho', { startedAt: at(1) })]),
    eventos: [ev('SubagentStop', 3)],
    espera: { confere: (e) => assert.equal(e.agentes.find((a) => a.id === `${SID}:velho`)?.status, 'completed') },
  },
  {
    caso: 'último subagente encerrado após o Stop: volta a ser a sua vez',
    antes: estado({}, [principal(), sub('agent-7')]),
    eventos: [ev('Stop', 1), ev('SubagentStop', 2, { data: { agent_id: 'agent-7' } })],
    espera: { inbox: 'waiting', precisaDeVoce: true },
  },
  // SessionEnd
  {
    caso: 'SessionEnd encerra sessão e agentes',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [principal({ status: 'waiting' }), sub('agent-7')]),
    eventos: [ev('SessionEnd', 1, { data: { reason: 'prompt_input_exit' } })],
    espera: {
      exibido: 'completed',
      motivo: null,
      principal: 'completed',
      precisaDeVoce: false,
      confere: (e) => {
        assert.equal(e.session.endedAt, at(1));
        assert.ok(e.agentes.every((a) => a.status === 'completed' && a.endedAt === at(1)));
      },
    },
  },
  {
    caso: 'SessionEnd com erro não superado fica em error',
    antes: estado(),
    eventos: [ev('APIError', 1), ev('SessionEnd', 2)],
    espera: { exibido: 'error', persistido: 'error', confere: (e) => assert.equal(e.session.endedAt, at(2)) },
  },
  // Erro e cura
  {
    caso: 'APIError do transcript vai para error',
    antes: estado(),
    eventos: [ev('APIError', 1, { id: 'jsonl:u1' })],
    espera: { exibido: 'error', principal: 'error', confere: (e) => assert.equal(lerMemoria(e.session).erroEm, at(1)) },
  },
  {
    caso: 'cura de erro: progresso depois do erro volta para active',
    antes: estado(),
    eventos: [ev('APIError', 1, { id: 'jsonl:u1' }), ev('AssistantMessage', 2, { id: 'jsonl:u2' })],
    espera: { exibido: 'active', persistido: 'active', principal: 'working', confere: (e) => assert.equal(lerMemoria(e.session).erroEm, null) },
  },
  {
    caso: 'cura de erro: novo prompt também cura',
    antes: estado(),
    eventos: [ev('Stop', 1, { data: { stop_reason: 'error' } }), ev('UserPromptSubmit', 4)],
    espera: { persistido: 'active', principal: 'working' },
  },
  {
    caso: 'Stop depois do erro não cura (não é progresso)',
    antes: estado(),
    eventos: [ev('StopFailure', 1), ev('Stop', 2)],
    espera: { persistido: 'error' },
  },
  // Interrupção
  {
    caso: 'Interrupted é waiting urgente',
    antes: estado({}, [principal({ currentTool: 'Bash' })]),
    eventos: [ev('Interrupted', 1)],
    espera: { exibido: 'waiting', motivo: 'interrupted', urgente: true, principal: 'waiting', ferramenta: null },
  },
  {
    caso: 'Esc no transcript ([Request interrupted by user]) é interrupted',
    antes: estado(),
    eventos: [ev('UserPrompt', 1, { id: 'jsonl:u9', summary: '[Request interrupted by user]' })],
    espera: { motivo: 'interrupted' },
  },
  {
    caso: 'transcript andou depois do "turno morto": volta a trabalhar',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'interrupted' }, [principal({ status: 'waiting' })]),
    eventos: [ev('AssistantMessage', 1, { id: 'jsonl:u3' })],
    espera: { exibido: 'active', motivo: null, principal: 'working' },
  },
  {
    caso: 'AssistantMessage não tira a vez do usuário',
    antes: estado({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [principal({ status: 'waiting' })]),
    eventos: [ev('AssistantMessage', 1, { id: 'jsonl:u3' })],
    espera: { motivo: 'stop' },
  },
  {
    caso: 'TurnDuration do transcript fecha o turno',
    antes: estado(),
    eventos: [ev('TurnDuration', 1, { id: 'jsonl:u4' })],
    espera: { motivo: 'stop', principal: 'waiting' },
  },
  // Histórico não reabre
  {
    caso: 'evento do histórico não reabre sessão encerrada',
    antes: estado({ status: 'completed', endedAt: at(0) }, [principal({ status: 'completed' })]),
    eventos: [ev('UserPrompt', 1, { id: 'jsonl:u5' }), ev('ToolUse', 2, { id: 'jsonl:u6', toolName: 'Read' })],
    espera: { persistido: 'completed' },
  },
  // Abandono (aplicado pelo vigia)
  {
    caso: 'Abandoned encerra como abandoned',
    antes: estado({}, [principal({ currentTool: 'Bash' })]),
    eventos: [ev('Abandoned', 200, { data: { sintetico: true } })],
    espera: {
      exibido: 'abandoned',
      principal: 'completed',
      confere: (e) => {
        assert.equal(e.session.endedAt, at(200));
        // Evento sintético não conta como atividade.
        assert.equal(e.session.updatedAt, at(0));
        assert.equal(main(e).updatedAt, at(0));
      },
    },
  },
  // Ordem e duplicata
  {
    caso: 'evento atrasado (anterior ao último aplicado) é ignorado',
    antes: estado(),
    eventos: [ev('UserPromptSubmit', 5), ev('Stop', 3)],
    espera: { exibido: 'active', principal: 'working' },
  },
  {
    caso: 'evento desconhecido só conta como atividade',
    antes: estado(),
    eventos: [ev('PreCompact', 4)],
    espera: { exibido: 'active', confere: (e) => assert.equal(main(e).updatedAt, at(4)) },
  },
];

describe('tabela de transições', () => {
  for (const linha of TABELA) {
    test(linha.caso, () => {
      const depois = linha.eventos.reduce(transicionar, linha.antes);
      const esp = linha.espera;
      const inbox = lerInbox(depois.session, depois.agentes);
      if (esp.exibido !== undefined) assert.equal(displayStatus(depois.session), esp.exibido, 'status exibido');
      if (esp.persistido !== undefined) assert.equal(depois.session.status, esp.persistido, 'status persistido');
      if (esp.motivo !== undefined) assert.equal(depois.session.awaitingReason, esp.motivo, 'motivo');
      if (esp.principal !== undefined) assert.equal(main(depois).status, esp.principal, 'status do principal');
      if (esp.ferramenta !== undefined) assert.equal(main(depois).currentTool, esp.ferramenta, 'ferramenta do principal');
      if (esp.inbox !== undefined) assert.equal(inbox.estado, esp.inbox, 'estado do inbox');
      if (esp.precisaDeVoce !== undefined) assert.equal(inbox.precisaDeVoce, esp.precisaDeVoce, 'precisa de você');
      if (esp.urgente !== undefined) assert.equal(inbox.urgente, esp.urgente, 'urgente');
      esp.confere?.(depois);
    });
  }
});

describe('propriedades da transição', () => {
  test('não altera o estado de entrada', () => {
    const antes = estado();
    const copia = structuredClone(antes);
    transicionar(antes, ev('Stop', 1));
    assert.deepEqual(antes, copia);
  });

  test('o mesmo evento duas vezes não muda nada na segunda', () => {
    const e = ev('PreToolUse', 1, { toolName: 'Agent', data: { tool_use_id: 'tu' } });
    const uma = transicionar(estado(), e);
    assert.equal(transicionar(uma, e), uma);
  });

  test('dois eventos no mesmo instante são aplicados', () => {
    const pre = ev('PreToolUse', 1, { toolName: 'Read' });
    const post = ev('PostToolUse', 1, { toolName: 'Read' });
    const depois = [pre, post].reduce(transicionar, estado());
    assert.equal(main(depois).currentTool, null);
    assert.deepEqual(lerMemoria(depois.session).idsNoUltimoInstante, [pre.id, post.id]);
  });

  test('a espera guarda desde quando, e repetir o motivo não reinicia a contagem', () => {
    const depois = [
      ev('Notification', 1, { data: { notification_type: 'permission_prompt' } }),
      ev('Notification', 2, { data: { notification_type: 'permission_prompt' } }),
    ].reduce(transicionar, estado());
    assert.equal(depois.session.awaitingInputSince, at(1));
  });

  test('evento de outra sessão é ignorado', () => {
    const antes = estado();
    assert.equal(transicionar(antes, ev('Stop', 1, { sessionId: 'outra' })), antes);
  });

  test('preserva o metadata que não é da máquina', () => {
    const depois = transicionar(estado({ metadata: { importacao: { bytes: 10 }, transcriptPath: '/x' } }), ev('Stop', 1));
    assert.deepEqual(depois.session.metadata.importacao, { bytes: 10 });
    assert.equal(depois.session.metadata.transcriptPath, '/x');
  });
});
