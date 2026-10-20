import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { validateAgent, validateEvent, validateSession, validateTokenUsage } from '../src/model.ts';
import { estimateCost, effectiveTokens } from '../src/pricing.ts';
import type { StoragePort } from '../src/storage-port.ts';
import {
  Aleatorio,
  LIMITE_DE_CONTEXTO,
  MINUTOS_ATE_ABANDONO,
  TIPOS_DE_CAOS,
  gerarCenario,
  simular,
  type OpcoesDaSimulacao,
} from '../src/simulator/index.ts';
import { T0 } from './fixtures.ts';

const AGORA = Date.parse(T0);
const relogio = (ms: number) => new Date(AGORA + ms).toISOString();

async function todosOsEventos(porta: StoragePort, sessionId: string) {
  const eventos = [];
  let cursor: string | null = null;
  do {
    const pagina = await porta.listEvents(sessionId, { limit: 500, cursor });
    eventos.push(...pagina.items);
    cursor = pagina.nextCursor;
  } while (cursor);
  return eventos;
}

/** Tudo o que a simulação deixou no banco, em ordem estável. */
async function despejar(porta: StoragePort) {
  const sessoes = (await porta.listSessions({ limit: 500 })).items.sort((a, b) => a.id.localeCompare(b.id));
  const resto = await Promise.all(
    sessoes.map(async (s) => ({
      agentes: await porta.listAgents(s.id),
      eventos: await todosOsEventos(porta, s.id),
      usos: await porta.listTokenUsage(s.id),
    })),
  );
  return { sessoes, resto, precos: await porta.listModelPricing() };
}

async function rodar(opcoes: Partial<OpcoesDaSimulacao> = {}) {
  const porta = openSqliteStorage({ path: ':memory:' });
  const resumo = await simular(porta, { semente: 7, agora: () => AGORA, ...opcoes });
  return { porta, resumo, dados: await despejar(porta) };
}

describe('aleatório com semente', () => {
  test('a mesma semente dá a mesma sequência; outra semente, outra sequência', () => {
    const seq = (s: string | number) => {
      const r = new Aleatorio(s);
      return Array.from({ length: 20 }, () => r.proximo());
    };
    assert.deepEqual(seq('abc'), seq('abc'));
    assert.notDeepEqual(seq('abc'), seq('abd'));
    for (const x of seq(1)) assert.ok(x >= 0 && x < 1);
  });

  test('inteiro respeita os limites inclusivos', () => {
    const r = new Aleatorio(3);
    const vistos = new Set(Array.from({ length: 500 }, () => r.inteiro(2, 5)));
    assert.deepEqual([...vistos].sort(), [2, 3, 4, 5]);
  });
});

describe('cenário', () => {
  test('determinismo: a mesma semente e as mesmas opções geram exatamente o mesmo roteiro', () => {
    const a = gerarCenario({ semente: 'demo', caos: true, relogio });
    const b = gerarCenario({ semente: 'demo', caos: true, relogio });
    assert.deepEqual(a, b);
    assert.ok(a.operacoes.length > 100);
  });

  test('outra semente gera outro roteiro, com outro prefixo de ids', () => {
    const a = gerarCenario({ semente: 1, relogio });
    const b = gerarCenario({ semente: 2, relogio });
    assert.notEqual(a.prefixo, b.prefixo);
    assert.notDeepEqual(
      a.operacoes.map((o) => o.deslocamentoMs),
      b.operacoes.map((o) => o.deslocamentoMs),
    );
  });

  test('operações em ordem de tempo e todas dentro da janela', () => {
    const { operacoes } = gerarCenario({ semente: 5, duracaoMin: 120, caos: true, relogio });
    for (let i = 1; i < operacoes.length; i++) assert.ok(operacoes[i].deslocamentoMs >= operacoes[i - 1].deslocamentoMs);
    assert.ok(operacoes.every((o) => o.deslocamentoMs <= 120 * 60_000));
  });

  test('todo registro gerado passa nos validadores do modelo', () => {
    for (const op of gerarCenario({ semente: 9, sessoes: 20, caos: true, relogio }).operacoes) {
      if (op.tipo === 'sessao') validateSession(op.registro);
      else if (op.tipo === 'agente') validateAgent(op.registro);
      else if (op.tipo === 'evento') validateEvent(op.registro);
      else validateTokenUsage(op.registro);
    }
  });

  test('sem caos, só roteiros normais; com caos, pelo menos uma sessão de cada falha', () => {
    assert.ok(gerarCenario({ semente: 1, relogio }).roteiros.every((r) => r === 'normal'));
    const { roteiros } = gerarCenario({ semente: 1, caos: true, relogio });
    for (const tipo of TIPOS_DE_CAOS) assert.ok(roteiros.includes(tipo), `faltou ${tipo}`);
  });

  test('dados sintéticos: caminhos sob /simulacao e tudo marcado como simulado', () => {
    for (const op of gerarCenario({ semente: 4, caos: true, relogio }).operacoes) {
      if (op.tipo === 'sessao') {
        assert.match(op.registro.cwd ?? '', /^\/simulacao\//);
        assert.equal(op.registro.metadata.simulado, true);
      }
      if (op.tipo === 'evento') {
        const caminho = (op.registro.data as { file_path?: string } | null)?.file_path;
        if (caminho) assert.match(caminho, /^\/simulacao\//);
      }
    }
  });

  test('opções inválidas são recusadas', () => {
    assert.throws(() => gerarCenario({ semente: 1, sessoes: 0, relogio }), RangeError);
    assert.throws(() => gerarCenario({ semente: 1, duracaoMin: 0, relogio }), RangeError);
  });
});

describe('simulação em lote pela porta', () => {
  test('determinismo: a mesma semente grava exatamente os mesmos dados', async () => {
    const a = await rodar({ caos: true, precos: true });
    const b = await rodar({ caos: true, precos: true });
    assert.deepEqual(a.dados, b.dados);
    assert.deepEqual(a.resumo, b.resumo);
    const c = await rodar({ semente: 8, caos: true, precos: true });
    assert.notDeepEqual(a.dados.sessoes, c.dados.sessoes);
    await Promise.all([a.porta.close(), b.porta.close(), c.porta.close()]);
  });

  test('grava sessões, agentes, subagentes, eventos e uso; a janela termina agora', async () => {
    const { porta, resumo, dados } = await rodar({ sessoes: 10 });
    assert.equal(dados.sessoes.length, 10);
    assert.equal(resumo.gravados.sessoes, 10);
    const agentes = dados.resto.flatMap((r) => r.agentes);
    assert.ok(agentes.some((a) => a.type === 'main'));
    const subs = agentes.filter((a) => a.type === 'subagent');
    assert.ok(subs.length > 0);
    assert.ok(subs.every((s) => s.parentAgentId?.endsWith('-a0')));
    assert.ok(dados.resto.every((r) => r.eventos.some((e) => e.type === 'SessionStart')));
    assert.ok(dados.resto.flatMap((r) => r.eventos).some((e) => e.type === 'PreToolUse' && e.toolName));
    assert.ok(dados.resto.every((r) => r.usos.length > 0));
    for (const s of dados.sessoes) {
      assert.ok(s.updatedAt <= T0, 'nada no futuro');
      assert.ok(s.startedAt >= new Date(AGORA - 360 * 60_000).toISOString());
    }
    await porta.close();
  });

  test('reaplicar a mesma semente no mesmo banco não duplica nada', async () => {
    const porta = openSqliteStorage({ path: ':memory:' });
    const primeira = await simular(porta, { semente: 3, agora: () => AGORA });
    const antes = await despejar(porta);
    const segunda = await simular(porta, { semente: 3, agora: () => AGORA });
    assert.deepEqual(await despejar(porta), antes);
    assert.ok(primeira.gravados.eventos > 0);
    assert.equal(segunda.gravados.eventos, 0);
    await porta.close();
  });

  test('preços ilustrativos só quando pedidos, sem sobrescrever os existentes', async () => {
    const sem = await rodar();
    assert.equal(sem.dados.precos.length, 0);
    const com = await rodar({ precos: true });
    assert.equal(com.dados.precos.length, 3);
    const usos = com.dados.resto.flatMap((r) => r.usos);
    assert.ok(usos.every((u) => estimateCost(u, com.dados.precos).priced));
    const outra = await simular(com.porta, { semente: 99, precos: true, agora: () => AGORA });
    assert.equal(outra.gravados.precos, 0);
    await Promise.all([sem.porta.close(), com.porta.close()]);
  });
});

describe('modo caos', () => {
  const porRoteiro = async (semente: number) => {
    const { porta, dados } = await rodar({ semente, caos: true, sessoes: 10 });
    const sessoes = dados.sessoes.map((s, i) => ({ s, ...dados.resto[i] }));
    return { porta, por: (r: string) => sessoes.filter((x) => x.s.metadata.roteiro === r) };
  };

  test('travada: fica esperando input, sem encerrar', async () => {
    const { porta, por } = await porRoteiro(11);
    const travadas = por('travada');
    assert.ok(travadas.length > 0);
    for (const { s, eventos } of travadas) {
      assert.equal(s.status, 'active');
      assert.ok(s.awaitingReason === 'notification' || s.awaitingReason === 'interrupted');
      assert.equal(s.endedAt, null);
      assert.ok(['Notification', 'Interrupted'].includes(eventos.at(-1)!.type));
    }
    await porta.close();
  });

  test('erro: a ferramenta falha e a sessão fica em error', async () => {
    const { porta, por } = await porRoteiro(12);
    for (const { s, agentes, eventos } of por('erro')) {
      assert.equal(s.status, 'error');
      assert.equal(agentes[0].status, 'error');
      assert.equal(eventos.at(-1)!.type, 'PostToolUseFailure');
    }
    assert.ok(por('erro').length > 0);
    await porta.close();
  });

  test(`abandono: sem atividade por ${MINUTOS_ATE_ABANDONO} min e gravada como abandoned`, async () => {
    const { porta, por } = await porRoteiro(13);
    assert.ok(por('abandono').length > 0);
    for (const { s, eventos } of por('abandono')) {
      assert.equal(s.status, 'abandoned');
      const ultima = Date.parse(eventos.at(-1)!.createdAt);
      assert.ok(Date.parse(s.endedAt!) - ultima >= MINUTOS_ATE_ABANDONO * 60_000);
    }
    await porta.close();
  });

  test('estouro: picos de tokens estouram o contexto pelo menos duas vezes, com piso da compactação', async () => {
    const { porta, por } = await porRoteiro(14);
    assert.ok(por('estouro').length > 0);
    for (const { s, eventos, usos } of por('estouro')) {
      const contexto = s.metadata.contexto as { estouros: number; limite: number };
      assert.ok(contexto.estouros >= 2);
      assert.equal(contexto.limite, LIMITE_DE_CONTEXTO);
      assert.ok(eventos.filter((e) => e.type === 'PreCompact').length >= 2);
      const principal = usos.find((u) => u.model === s.model)!;
      assert.ok(principal.baseline.cacheWrite5m > 0);
      assert.ok(effectiveTokens(principal).cacheRead >= LIMITE_DE_CONTEXTO);
    }
    await porta.close();
  });

  test('enxame: pelo menos 8 subagentes trabalhando ao mesmo tempo', async () => {
    const { porta, por } = await porRoteiro(15);
    assert.ok(por('enxame').length > 0);
    for (const { agentes } of por('enxame')) {
      const subs = agentes.filter((a) => a.type === 'subagent');
      // Pico de simultaneidade: no começo de cada subagente, quantos estão em andamento.
      const simultaneos = Math.max(...subs.map((x) => subs.filter((a) => a.startedAt <= x.startedAt && a.endedAt! > x.startedAt).length));
      assert.ok(simultaneos >= 8, `só ${simultaneos} em paralelo`);
    }
    await porta.close();
  });
});

describe('simulação em tempo real', () => {
  test('espera o ritmo da velocidade e carimba cada gravação com a hora do relógio', async () => {
    let relogioVirtual = AGORA;
    const esperas: number[] = [];
    const porta = openSqliteStorage({ path: ':memory:' });
    const resumo = await simular(porta, {
      semente: 21,
      sessoes: 3,
      duracaoMin: 60,
      modo: 'tempo-real',
      velocidade: 60,
      agora: () => relogioVirtual,
      esperar: async (ms) => {
        esperas.push(ms);
        relogioVirtual += ms;
      },
    });
    assert.equal(resumo.interrompido, false);
    assert.ok(esperas.length > 0);
    // 60 min simulados a 60x cabem em 1 min de relógio.
    assert.ok(relogioVirtual - AGORA <= 60_000);
    const { resto } = await despejar(porta);
    for (const e of resto.flatMap((r) => r.eventos)) assert.ok(Date.parse(e.createdAt) <= relogioVirtual);
    await porta.close();
  });

  test('determinismo também em tempo real', async () => {
    const executar = async () => {
      let t = AGORA;
      const porta = openSqliteStorage({ path: ':memory:' });
      await simular(porta, { semente: 'rt', caos: true, modo: 'tempo-real', agora: () => t, esperar: async (ms) => void (t += ms) });
      const dados = await despejar(porta);
      await porta.close();
      return dados;
    };
    assert.deepEqual(await executar(), await executar());
  });

  test('o signal interrompe e mantém o que já foi gravado', async () => {
    let t = AGORA;
    const parar = new AbortController();
    let gravacoes = 0;
    const porta = openSqliteStorage({ path: ':memory:' });
    const resumo = await simular(porta, {
      semente: 22,
      modo: 'tempo-real',
      agora: () => t,
      esperar: async (ms) => void (t += ms),
      signal: parar.signal,
      aoGravar: () => {
        if (++gravacoes === 50) parar.abort();
      },
    });
    assert.equal(resumo.interrompido, true);
    assert.equal(gravacoes, 50);
    assert.ok((await despejar(porta)).sessoes.length > 0);
    await porta.close();
  });

  test('velocidade inválida é recusada', async () => {
    const porta = openSqliteStorage({ path: ':memory:' });
    await assert.rejects(simular(porta, { semente: 1, modo: 'tempo-real', velocidade: 0 }), RangeError);
    await porta.close();
  });

  test('gera duas contas sintéticas e reparte as sessões entre elas', async () => {
    const { porta, resumo, dados } = await rodar({ sessoes: 6 });
    const contas = await porta.listAccounts();
    assert.equal(contas.length, 2);
    assert.equal(resumo.gravados.contas, 2);
    for (const c of contas) {
      assert.match(c.accountUuid, /^00000000-0000-4000-8000-/);
      assert.match(c.organizationUuid, /^00000000-0000-4000-8000-/);
      assert.equal(c.metadata.simulado, true);
      assert.ok(c.configDirs.every((d) => d.startsWith('/simulacao/')));
      const daConta = dados.sessoes.filter((s) => s.accountId === c.id);
      assert.equal(daConta.length, 3);
      assert.equal(c.lastSeenAt, daConta.map((s) => s.updatedAt).sort().at(-1));
      assert.ok(c.firstSeenAt <= c.lastSeenAt);
      assert.equal((await porta.listSessions({ accountIds: [c.id] })).items.length, 3);
    }
    assert.ok(dados.sessoes.every((s) => s.accountId !== null && s.accountSource !== null));
    assert.deepEqual(new Set(dados.sessoes.map((s) => s.accountSource)), new Set(['env', 'config']));
    assert.deepEqual((await porta.listSessions({ accountIds: [null] })).items, []);
    await porta.close();
  });
});
