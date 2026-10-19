import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { diretoriosDoLsof, ehClaude, pidsDoPs, sondaDoSistema, sondaFixa } from '../../src/estados/index.ts';

describe('leitura da saída', () => {
  test('reconhece o Claude Code pelo binário ou pelo pacote npm', () => {
    assert.equal(ehClaude('claude'), true);
    assert.equal(ehClaude('/opt/homebrew/bin/claude --resume abc'), true);
    assert.equal(ehClaude('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), true);
    assert.equal(ehClaude('/Applications/Claude.app/Contents/MacOS/Claude'), false);
    assert.equal(ehClaude('vim claude.md'), false);
  });

  test('ps → pids', () => {
    const saida = ['  101 /usr/local/bin/claude', '  202 vim notas.txt', '303 node /x/@anthropic-ai/claude-code/cli.js -c', ''].join('\n');
    assert.deepEqual(pidsDoPs(saida), [101, 303]);
  });

  test('lsof → diretórios', () => {
    assert.deepEqual(diretoriosDoLsof('p101\nfcwd\nn/repo/app\np303\nfcwd\nn/repo/api/\n'), ['/repo/app', '/repo/api']);
  });
});

describe('sondaDoSistema', () => {
  test('macOS: ps e depois lsof só com os pids do Claude', async () => {
    const chamadas: string[][] = [];
    const sonda = sondaDoSistema({
      plataforma: 'darwin',
      emConteiner: false,
      executar: async (cmd, args) => {
        chamadas.push([cmd, ...args]);
        if (cmd === 'ps') return '  101 claude\n  202 bash\n';
        return 'p101\nfcwd\nn/repo/app\n';
      },
    });
    assert.deepEqual([...(await sonda.diretoriosVivos())!], ['/repo/app']);
    assert.deepEqual(chamadas[1], ['lsof', '-Fn', '-a', '-d', 'cwd', '-p', '101']);
  });

  test('macOS sem nenhum Claude rodando: conjunto vazio, sem chamar lsof', async () => {
    let lsof = false;
    const sonda = sondaDoSistema({
      plataforma: 'darwin',
      emConteiner: false,
      executar: async (cmd) => {
        if (cmd === 'lsof') lsof = true;
        return '  1 launchd\n';
      },
    });
    assert.equal((await sonda.diretoriosVivos())?.size, 0);
    assert.equal(lsof, false);
  });

  test('falha do comando vira "não sei" (null)', async () => {
    const sonda = sondaDoSistema({ plataforma: 'darwin', emConteiner: false, executar: async () => Promise.reject(new Error('sem ps')) });
    assert.equal(await sonda.diretoriosVivos(), null);
  });

  test('Linux: lê /proc', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'proc-'));
    try {
      const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
      for (const [pid, cmd] of [['10', 'claude\0--resume\0'], ['20', 'bash\0']] as const) {
        mkdirSync(join(proc, pid));
        writeFileSync(join(proc, pid, 'cmdline'), cmd);
        symlinkSync(cwd, join(proc, pid, 'cwd'));
      }
      mkdirSync(join(proc, 'self'));
      const vivos = await sondaDoSistema({ plataforma: 'linux', emConteiner: false, proc }).diretoriosVivos();
      assert.deepEqual([...vivos!], [cwd]);
      rmSync(cwd, { recursive: true });
    } finally {
      rmSync(proc, { recursive: true });
    }
  });

  test('desligada no Windows e em contêiner', async () => {
    assert.equal(await sondaDoSistema({ plataforma: 'win32', emConteiner: false }).diretoriosVivos(), null);
    assert.equal(await sondaDoSistema({ plataforma: 'darwin', emConteiner: true }).diretoriosVivos(), null);
  });

  test('sondaFixa', async () => {
    assert.deepEqual([...(await sondaFixa(['/a/']).diretoriosVivos())!], ['/a']);
    assert.equal(await sondaFixa(null).diretoriosVivos(), null);
  });
});
