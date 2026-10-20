// #146: o grafo da sessão com os subagentes. O painel manda, de cada subagente, quem o disparou
// (`pai`) e a onda (o turno da sessão em que ele foi disparado), montados dos eventos gravados.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, MontadorDoPainel, aplicarEvento, iniciosDosTurnos, resumoVazio, subagentesDe } from '../../src/api/index.ts';
import { SESSAO_DO_PAINEL, semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { T0, agent, at, event, session } from '../fixtures.ts';

const principal = agent({ id: 's1:main', type: 'main' });
const sub = (id: string, inicio: number, extra: Parameters<typeof agent>[0] = {}) =>
  agent({ id: `s1:${id}`, type: 'subagent', subagentType: 'Explore', name: id, parentAgentId: 's1:main', startedAt: at(inicio), ...extra });

describe('início dos turnos no resumo', () => {
  test('guarda quando cada prompt chegou, pelos hooks e pelo transcript; vale a lista mais longa', () => {
    const r = resumoVazio();
    aplicarEvento(r, event({ type: 'UserPromptSubmit', createdAt: at(1) }));
    aplicarEvento(r, event({ type: 'UserPrompt', agentId: 's1:main', createdAt: at(1) }));
    aplicarEvento(r, event({ type: 'UserPromptSubmit', createdAt: at(10) }));
    // O prompt de um subagente não é um turno da sessão.
    aplicarEvento(r, event({ type: 'UserPrompt', agentId: 's1:a9', createdAt: at(11) }));
    assert.deepEqual(r.iniciosHook, [at(1), at(10)]);
    assert.deepEqual(r.iniciosTranscript, [at(1)]);
    assert.deepEqual(iniciosDosTurnos(r), [at(1), at(10)]);
  });
});

describe('subagentesDe: pai e onda', () => {
  test('o pai é o subagente que disparou; a sessão principal não conta como pai', () => {
    const { items: itens } = subagentesDe([principal, sub('a', 2), sub('b', 3, { parentAgentId: 's1:a' }), sub('c', 4, { parentAgentId: 's1:b' })], [at(1)]);
    const de = (id: string) => itens.find((i) => i.id === `s1:${id}`)!;
    assert.equal(de('a').parent, null);
    assert.equal(de('b').parent, 's1:a');
    assert.equal(de('c').parent, 's1:b');
  });

  test('a onda é o turno em que o subagente de cima começou; o aninhado herda a dele', () => {
    const turnos = [at(0), at(10), at(20)];
    const { items: itens } = subagentesDe(
      [principal, sub('a', 2), sub('b', 3), sub('c', 12), sub('d', 25, { parentAgentId: 's1:c' }), sub('e', 21)],
      turnos,
    );
    const onda = Object.fromEntries(itens.map((i) => [i.id.slice(3), i.wave]));
    assert.deepEqual(onda, { a: 1, b: 1, c: 2, d: 2, e: 3 });
  });

  test('sem os prompts da sessão, a onda fica nula (o painel agrupa pela sobreposição no tempo)', () => {
    const { items: itens } = subagentesDe([principal, sub('a', 2)], []);
    assert.equal(itens[0]!.wave, null);
  });

  test('um pai que não está entre os subagentes (outra sessão, dado velho) vira a sessão', () => {
    const { items: itens } = subagentesDe([principal, sub('a', 2, { parentAgentId: 's1:sumiu' })], [at(0)]);
    assert.equal(itens[0]!.parent, null);
    assert.equal(itens[0]!.wave, 1);
  });

  test('um ciclo nos dados não trava a conta da onda', () => {
    const { items: itens } = subagentesDe([principal, sub('a', 2, { parentAgentId: 's1:b' }), sub('b', 3, { parentAgentId: 's1:a' })], [at(0)]);
    assert.equal(itens.length, 2);
  });
});

describe('painel: o grafo montado dos eventos gravados', () => {
  test('agentes e prompts gravados viram pai e onda na resposta do painel', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ startedAt: T0, updatedAt: at(30) }));
    await storage.putAgent(principal);
    await storage.putAgent(sub('plan', 2, { subagentType: 'Plan', status: 'completed', endedAt: at(4) }));
    await storage.putAgent(sub('gp', 12, { subagentType: 'general-purpose' }));
    await storage.putAgent(sub('explore', 13, { parentAgentId: 's1:gp', status: 'completed', endedAt: at(15) }));
    for (const [i, m] of [0, 10].entries()) await storage.appendEvent(event({ id: `p${i}`, type: 'UserPromptSubmit', agentId: null, toolName: null, createdAt: at(m) }));
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null, agora: () => Date.parse(at(30)) });
    const p = await montador.montar({ sessionId: 's1' });
    const de = (id: string) => p.subagents.items.find((i) => i.id === `s1:${id}`)!;
    assert.deepEqual([de('plan').parent, de('plan').wave], [null, 1]);
    assert.deepEqual([de('gp').parent, de('gp').wave], [null, 2]);
    assert.deepEqual([de('explore').parent, de('explore').wave], ['s1:gp', 2]);
    await storage.close();
  });

  test('P13: 25 subagentes em 5 ondas, 4 ativos, 1 com erro e aninhados em dois níveis', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const agora = Date.parse(T0);
    await semearCenariosDoPainel(storage, 'p13', agora);
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null, agora: () => agora, apelido: () => SESSAO_DO_PAINEL });
    const p = await montador.montar({ sessionId: 'qualquer' });
    const itens = p.subagents.items;
    assert.equal(itens.length, 25);
    assert.equal(p.subagents.active, 4);
    assert.equal(itens.filter((i) => i.status === 'error').length, 1);
    const porOnda = itens.reduce<Record<number, number>>((a, i) => ((a[i.wave!] = (a[i.wave!] ?? 0) + 1), a), {});
    assert.deepEqual(porOnda, { 1: 6, 2: 6, 3: 1, 4: 10, 5: 2 });
    const gp = itens.find((i) => i.task === 'migrar a cobrança')!;
    const contratos = itens.find((i) => i.task === 'contratos')!;
    assert.equal(contratos.parent, gp.id);
    assert.equal(itens.find((i) => i.task === 'esquemas')!.parent, contratos.id);
    await storage.close();
  });
});
