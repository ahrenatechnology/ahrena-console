import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LIMITES_PADRAO, transicionar, vigiar } from '../../src/estados/index.ts';
import { at } from '../fixtures.ts';
import { estado, ev, principal, sub } from './helpers.ts';

const minuto = (m: number) => new Date(at(m));
const segundos = (s: number) => new Date(Date.parse(at(0)) + s * 1000);
const VIVO = new Set(['/repo/app']);

describe('turno morto (120 s)', () => {
  test('principal working, sem ferramenta, 120 s sem sinal → Interrupted', () => {
    const v = vigiar(estado(), segundos(120), VIVO);
    assert.equal(v?.regra, 'turno_morto');
    assert.equal(v?.evento.type, 'Interrupted');
    assert.equal(v?.evento.createdAt, segundos(120).toISOString());
    const depois = transicionar(estado(), v!.evento);
    assert.equal(depois.session.awaitingReason, 'interrupted');
  });

  test('119 s ainda não', () => {
    assert.equal(vigiar(estado(), segundos(119), VIVO), null);
  });

  test('com ferramenta rodando não é turno morto', () => {
    assert.equal(vigiar(estado({}, [principal({ currentTool: 'Bash' })]), minuto(30), VIVO), null);
  });

  test('delegando não é turno morto', () => {
    assert.equal(vigiar(estado({}, [principal(), sub('agent-7', { updatedAt: at(0) })]), minuto(30), VIVO), null);
    const delegando = transicionar(estado(), ev('PreToolUse', 0, { toolName: 'Agent', data: { tool_use_id: 'tu' } }));
    const semFerramenta = { ...delegando, agentes: delegando.agentes.map((a) => ({ ...a, currentTool: null })) };
    assert.equal(vigiar(semFerramenta, minuto(30), VIVO), null);
  });

  test('já esperando não dispara de novo', () => {
    assert.equal(vigiar(estado({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [principal({ status: 'waiting' })]), minuto(30), VIVO), null);
  });

  test('atividade recente de subagente adia a contagem', () => {
    const e = estado({}, [principal(), sub('agent-7', { status: 'completed', updatedAt: at(1) })]);
    assert.equal(vigiar(e, segundos(150), VIVO), null);
    assert.equal(vigiar(e, segundos(180), VIVO)?.regra, 'turno_morto');
  });

  test('o limite é configurável', () => {
    assert.equal(vigiar(estado(), segundos(10), VIVO, { ...LIMITES_PADRAO, turnoMortoMs: 10_000 })?.regra, 'turno_morto');
  });
});

describe('abandono (180 min)', () => {
  test('active parada há 180 min → Abandoned', () => {
    const e = estado({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [principal({ status: 'waiting' })]);
    assert.equal(vigiar(e, minuto(179), VIVO), null);
    const v = vigiar(e, minuto(180), VIVO);
    assert.equal(v?.regra, 'abandono');
    const depois = transicionar(e, v!.evento);
    assert.equal(depois.session.status, 'abandoned');
    assert.equal(depois.session.awaitingInputSince, null);
  });

  test('error não vira abandoned', () => {
    assert.equal(vigiar(estado({ status: 'error' }), minuto(500), VIVO), null);
  });
});

describe('sonda de processo', () => {
  test('sem processo no cwd → SessionEnd sintético', () => {
    const v = vigiar(estado({}, [principal({ currentTool: 'Bash' })]), minuto(1), new Set(['/outro']));
    assert.equal(v?.regra, 'sonda');
    assert.equal(v?.evento.type, 'SessionEnd');
    assert.deepEqual(v?.evento.data, { sintetico: true, reason: 'processo_encerrado' });
    assert.match(v!.evento.id, /^estado:[0-9a-f]{32}$/);
    assert.equal(transicionar(estado(), v!.evento).session.status, 'completed');
  });

  test('vale para sessão em error também, que continua error ao encerrar', () => {
    const v = vigiar(estado({ status: 'error' }), minuto(1), new Set());
    assert.equal(v?.regra, 'sonda');
    const depois = transicionar(estado({ status: 'error' }), v!.evento);
    assert.equal(depois.session.status, 'error');
    assert.equal(depois.session.endedAt, at(1));
  });

  test('respeita a carência de 30 s', () => {
    assert.equal(vigiar(estado({}, [principal({ currentTool: 'Bash' })]), segundos(29), new Set()), null);
  });

  test('sonda desligada (null) não encerra nada', () => {
    assert.equal(vigiar(estado({}, [principal({ currentTool: 'Bash' })]), minuto(60), null), null);
  });

  test('sessão sem cwd não é sondada', () => {
    assert.equal(vigiar(estado({ cwd: null }, [principal({ currentTool: 'Bash' })]), minuto(60), new Set()), null);
  });

  test('barra no fim do cwd não atrapalha', () => {
    assert.equal(vigiar(estado({ cwd: '/repo/app/' }, [principal({ currentTool: 'Bash' })]), minuto(60), VIVO), null);
  });

  test('a sonda vem antes do abandono', () => {
    assert.equal(vigiar(estado(), minuto(400), new Set())?.regra, 'sonda');
  });
});

test('sessão encerrada não é vigiada', () => {
  assert.equal(vigiar(estado({ status: 'completed', endedAt: at(0) }), minuto(500), new Set()), null);
  assert.equal(vigiar(estado({ status: 'abandoned', endedAt: at(0) }), minuto(500), new Set()), null);
});
