// Núcleo com dono único (#86). Os testes de processo sobem núcleos de verdade, cada um com um HOME
// falso numa pasta temporária e numa porta livre: nunca tocam a 4720 nem o ~/.ahrena-console real.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  arquivoDaTrava,
  clientesVivos,
  compararVersoes,
  examinar,
  gravarTrava,
  lerTrava,
  liberarTrava,
  novoToken,
  pidVivo,
  registrarCliente,
  vigiarPai,
  type Trava,
} from '../../src/dono/index.ts';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const CLI_API = join(RAIZ, 'src/api/cli.ts');
const CLI_NUCLEO = join(RAIZ, 'src/dono/cli.ts');
const SO_HOOKS = ['--sem-historico', '--sem-desktop', '--sem-github'];

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function ate(cond: () => boolean | Promise<boolean>, ms = 10_000, passo = 50): Promise<boolean> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await dormir(passo);
  }
  return cond();
}

/** Um pid que acabou de morrer. */
async function pidMorto(): Promise<number> {
  const p = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => p.once('exit', r));
  return p.pid!;
}

let home: string;
let pasta: string;
const filhos: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ahrena-dono-'));
  pasta = join(home, '.ahrena-console');
});

afterEach(async () => {
  const t = lerTrava(pasta);
  for (const p of filhos.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  if (t && t !== 'invalida' && pidVivo(t.pid) && t.pid !== process.pid) process.kill(t.pid, 'SIGKILL');
  rmSync(home, { recursive: true, force: true });
});

interface Rodada {
  proc: ChildProcess;
  saida: Promise<{ codigo: number | null; stdout: string; stderr: string }>;
}

function semVariaveisDoNucleo(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.AHRENA_CONSOLE_PORT;
  delete env.AHRENA_CONSOLE_DB;
  return env;
}

function rodar(cli: string, args: string[]): Rodada {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
    env: semVariaveisDoNucleo(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  filhos.push(proc);
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (c) => (stdout += c));
  proc.stderr!.on('data', (c) => (stderr += c));
  const saida = new Promise<{ codigo: number | null; stdout: string; stderr: string }>((r) => proc.once('close', (codigo) => r({ codigo, stdout, stderr })));
  return { proc, saida };
}

const api = (porta: number, ...extra: string[]) => rodar(CLI_API, ['--porta', String(porta), ...SO_HOOKS, ...extra]);
const nucleo = (...args: string[]) => rodar(CLI_NUCLEO, args);

/** Espera a trava de um núcleo vivo e a devolve. */
async function travaViva(): Promise<Trava> {
  let viva: Trava | null = null;
  const ok = await ate(async () => {
    const ex = await examinar(pasta);
    if (ex.estado === 'vivo') viva = ex.trava;
    return viva !== null;
  });
  assert.ok(ok && viva, 'o núcleo não subiu');
  return viva;
}

function dormente(): ChildProcess {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  filhos.push(p);
  return p;
}

describe('trava', () => {
  test('grava de uma vez, com 0600, sem deixar temporário, e lê de volta', () => {
    const t: Trava = { pid: 123, porta: 4799, versao: '0.0.1', inicio: new Date().toISOString(), token: novoToken(), pai: null };
    gravarTrava(t, pasta);
    assert.deepEqual(lerTrava(pasta), t);
    assert.equal(statSync(arquivoDaTrava(pasta)).mode & 0o777, 0o600);
    assert.equal(statSync(pasta).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(pasta), ['nucleo.json']);
    assert.equal(t.token.length, 64);
  });

  test('sem arquivo é null; arquivo que não é trava é inválido', () => {
    assert.equal(lerTrava(pasta), null);
    gravarTrava({ pid: 0 } as Trava, pasta);
    assert.equal(lerTrava(pasta), 'invalida');
  });

  test('só quem tem o token libera', () => {
    const t: Trava = { pid: 1, porta: 1, versao: '0.0.1', inicio: 'x', token: novoToken(), pai: null };
    gravarTrava(t, pasta);
    assert.equal(liberarTrava('outro', pasta), false);
    assert.ok(lerTrava(pasta));
    assert.equal(liberarTrava(t.token, pasta), true);
    assert.equal(lerTrava(pasta), null);
  });

  test('compara versões por número', () => {
    assert.equal(compararVersoes('0.0.1', '0.0.2'), -1);
    assert.equal(compararVersoes('0.10.0', '0.9.9'), 1);
    assert.equal(compararVersoes('1.0', '1.0.0'), 0);
    assert.equal(compararVersoes('0.0.2-beta.1', '0.0.2'), 0);
  });
});

describe('clientes e o pai', () => {
  test('cliente morto sai da lista', async () => {
    const morto = await pidMorto();
    registrarCliente(process.pid, pasta);
    registrarCliente(morto, pasta);
    assert.deepEqual(clientesVivos(pasta), [process.pid]);
    assert.deepEqual(readdirSync(join(pasta, 'clientes')), [String(process.pid)]);
  });

  test('pai morto sem cliente avisa; com cliente vivo, não', async () => {
    const morto = await pidMorto();
    const avisos: string[] = [];
    registrarCliente(process.pid, pasta);
    const parar = vigiarPai({ pai: morto, pasta, intervaloMs: 20, aoSumir: (m) => avisos.push(m) });
    await dormir(100);
    assert.deepEqual(avisos, []);
    rmSync(join(pasta, 'clientes'), { recursive: true });
    assert.ok(await ate(() => avisos.length === 1, 1000));
    await dormir(100);
    assert.equal(avisos.length, 1, 'avisa uma vez só');
    parar();
  });
});

describe('subir ou adotar', { timeout: 60_000 }, () => {
  test('duas subidas ao mesmo tempo dão um núcleo só', async () => {
    const porta = await portaLivre();
    const a = api(porta);
    const b = api(porta);
    const t = await travaViva();
    const vivo = [a, b].find((r) => r.proc.pid === t.pid);
    const outro = [a, b].find((r) => r.proc.pid !== t.pid)!;
    assert.ok(vivo, 'a trava é de um dos dois');
    const s = await outro.saida;
    assert.equal(s.codigo, 0, s.stderr);
    assert.match(s.stdout, new RegExp(`127\\.0\\.0\\.1:${porta} · versão 0\\.0\\.1 \\(adotado\\)`));
    assert.equal(vivo.proc.exitCode, null);
  });

  test('três `nucleo subir` ao mesmo tempo: um sobe, os outros adotam o mesmo pid', async () => {
    const porta = await portaLivre();
    const rodadas = [1, 2, 3].map(() => nucleo('subir', '--porta', String(porta), '--json', '--', ...SO_HOOKS));
    const saidas = await Promise.all(rodadas.map((r) => r.saida));
    const json = saidas.map((s) => {
      assert.equal(s.codigo, 0, s.stderr);
      return JSON.parse(s.stdout) as { pid: number; subiu: boolean; porta: number };
    });
    assert.equal(new Set(json.map((j) => j.pid)).size, 1, JSON.stringify(json));
    assert.equal(json.filter((j) => j.subiu).length, 1, JSON.stringify(json));
    assert.ok(json.every((j) => j.porta === porta));
    const t = await travaViva();
    assert.equal(t.pid, json[0].pid);
    const st = await nucleo('status', '--json').saida;
    assert.equal(st.codigo, 0);
    assert.equal(JSON.parse(st.stdout).estado, 'de-pe');
    assert.doesNotMatch(st.stdout, new RegExp(t.token), 'o status não mostra o token');
    const parado = await nucleo('parar').saida;
    assert.equal(parado.codigo, 0, parado.stderr);
    assert.ok(!pidVivo(t.pid));
    assert.equal(lerTrava(pasta), null);
    assert.equal((await nucleo('status').saida).codigo, 1);
  });

  test('trava órfã com pid morto é recuperada', async () => {
    const porta = await portaLivre();
    gravarTrava({ pid: await pidMorto(), porta, versao: '0.0.1', inicio: 'antes', token: 'velho', pai: null }, pasta);
    const a = api(porta);
    const t = await travaViva();
    assert.equal(t.pid, a.proc.pid);
    assert.notEqual(t.token, 'velho');
    assert.equal(t.porta, porta);
  });

  test('trava órfã com pid vivo mas porta muda é recuperada', async () => {
    const [muda, porta] = [await portaLivre(), await portaLivre()];
    gravarTrava({ pid: process.pid, porta: muda, versao: '0.0.1', inicio: 'antes', token: 'velho', pai: null }, pasta);
    const s = nucleo('subir', '--porta', String(porta), '--json', '--', ...SO_HOOKS);
    const r = await s.saida;
    assert.equal(r.codigo, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.subiu, true);
    assert.equal(j.porta, porta);
    assert.notEqual(j.pid, process.pid);
    assert.equal((await travaViva()).token.length, 64);
  });

  test('ao sair, o núcleo apaga a própria trava', async () => {
    const a = api(await portaLivre());
    await travaViva();
    a.proc.kill('SIGTERM');
    await a.saida;
    assert.equal(lerTrava(pasta), null);
  });
});

describe('versão', { timeout: 60_000 }, () => {
  test('núcleo mais velho: avisa e adota; com --substituir, troca', async () => {
    const porta = await portaLivre();
    const velho = api(porta);
    const t = await travaViva();
    gravarTrava({ ...t, versao: '0.0.0' }, pasta);

    const avisado = await api(porta).saida;
    assert.equal(avisado.codigo, 0);
    assert.match(avisado.stderr, /versão 0\.0\.0, mais velha que esta \(0\.0\.1\).*--substituir/);
    assert.match(avisado.stdout, /\(adotado\)/);
    assert.ok(pidVivo(t.pid), 'sem --substituir, o velho continua');

    const novo = api(porta, '--substituir');
    await ate(() => velho.proc.exitCode !== null || velho.proc.signalCode !== null);
    const t2 = await travaViva();
    assert.equal(t2.pid, novo.proc.pid);
    assert.equal(t2.versao, '0.0.1');
    assert.ok(!pidVivo(t.pid));
  });

  test('núcleo da mesma versão ou mais novo é adotado sem aviso', async () => {
    const porta = await portaLivre();
    api(porta);
    const t = await travaViva();
    gravarTrava({ ...t, versao: '9.0.0' }, pasta);
    const r = await api(porta, '--substituir').saida;
    assert.equal(r.codigo, 0);
    assert.doesNotMatch(r.stderr, /atenção/);
    assert.match(r.stdout, /versão 9\.0\.0 \(adotado\)/);
  });
});

describe('--pai', { timeout: 60_000 }, () => {
  test('o núcleo sai quando o pai morre e apaga a trava', async () => {
    const pai = dormente();
    const a = api(await portaLivre(), '--pai', String(pai.pid));
    const t = await travaViva();
    assert.equal(t.pai, pai.pid);
    pai.kill('SIGKILL');
    const s = await a.saida;
    assert.equal(s.codigo, 0);
    assert.match(s.stderr, /o pai \(pid \d+\) sumiu e não há cliente registrado; saindo/);
    assert.equal(lerTrava(pasta), null);
  });

  test('com outro cliente registrado, fica até o último sumir', async () => {
    const porta = await portaLivre();
    const app = dormente();
    const extensao = dormente();
    const a = api(porta, '--pai', String(app.pid));
    await travaViva();
    const adotou = await nucleo('subir', '--pai', String(extensao.pid), '--json').saida;
    assert.equal(JSON.parse(adotou.stdout).subiu, false);
    assert.deepEqual(clientesVivos(pasta), [extensao.pid]);

    app.kill('SIGKILL');
    await dormir(2500);
    assert.equal(a.proc.exitCode, null, 'a extensão ainda precisa do núcleo');

    extensao.kill('SIGKILL');
    const s = await a.saida;
    assert.equal(s.codigo, 0);
    assert.equal(lerTrava(pasta), null);
  });

  test('sem --pai, ninguém vigia', async () => {
    const a = api(await portaLivre());
    await travaViva();
    await dormir(1500);
    assert.equal(a.proc.exitCode, null);
  });
});
