// Os coletores do Mac e do Linux (#175/AC-1) sobre saídas gravadas (test/fixtures/telemetry): cada
// grupo, o comando que falta virando campo ausente, o tempo curto de cada comando e nenhum `sudo`.
// Nada aqui chama o sistema.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cpuUsedPct,
  listenInterfaceOf,
  networkOf,
  parseDockerSize,
  parseEtime,
  publishedPorts,
} from '../../src/telemetry/adapters/common.ts';
import { DarwinCollector, parseForwardSpec, parseSshArgs, parseSshG } from '../../src/telemetry/adapters/darwin.ts';
import { LinuxCollector } from '../../src/telemetry/adapters/linux.ts';
import { collectorFor } from '../../src/telemetry/adapters/system.ts';
import { DARWIN_COMMANDS, fixtureDeps, LINUX_COMMANDS, LINUX_FILES, T0 } from './fixture-deps.ts';

const KB = 1024;
const MiB = 1024 * 1024;

function darwin(over: Partial<Parameters<typeof fixtureDeps>[0]> = {}) {
  const probes: Record<number, 'open' | 'closed'> = { 14720: 'open', 13000: 'open', 15173: 'closed' };
  return fixtureDeps({
    commands: DARWIN_COMMANDS,
    statfs: async (m) => (m === '/' ? { totalBytes: 612e9, freeBytes: 400e9, availableBytes: 380e9 } : null),
    probe: async (p) => probes[p] ?? 'refused',
    ...over,
  });
}

describe('#175/AC-1 coletor do Mac, sobre saídas gravadas', () => {
  test('host, CPU (uso pela diferença, carga contra os núcleos) e memória com swap e pressão', async () => {
    const { deps } = darwin();
    const r = await new DarwinCollector(deps).collect();
    assert.equal(r.takenAt, new Date(T0).toISOString());
    assert.deepEqual(r.host, { hostname: 'mac-exemplo', platform: 'darwin', os: 'macOS 26.1', arch: 'arm64', uptimeSec: 3600 });
    assert.deepEqual(r.cpu, { cores: 12, model: 'CPU Exemplo', usedPct: 50, load: { one: 4.11, five: 3.8, fifteen: 3.2 } });
    // (anônimas − purgáveis + fixas + comprimidas) × página
    assert.deepEqual(r.memory, { totalBytes: 38_654_705_664, usedBytes: (900_000 - 20_000 + 250_000 + 150_000) * 16_384, swapTotalBytes: 2048 * MiB, swapUsedBytes: 819.25 * MiB, pressure: 'normal' });
  });

  test('GPU pelo ioreg, volumes pelo statfs (sem os de sistema do APFS) e rede da rota padrão em bytes/s', async () => {
    const { deps } = darwin();
    const r = await new DarwinCollector(deps).collect();
    assert.deepEqual(r.gpu, { name: 'Apple M-exemplo', usedPct: 12, memoryUsedBytes: 1_932_735_283, memoryTotalBytes: null });
    assert.deepEqual(r.disk.volumes, [
      { mount: '/', totalBytes: 612e9, usedBytes: 232e9, freeBytes: 380e9, usedPct: 37.9 },
      // Sem statfs, os números do próprio df (blocos de 512).
      { mount: '/Volumes/Dados Externos', totalBytes: 2e12, usedBytes: 0.9e12, freeBytes: 1.1e12, usedPct: 45 },
    ]);
    assert.deepEqual(r.network, { interface: 'en0', rxBytesPerSec: 2_400_000, txBytesPerSec: 310_000, rxBytesTotal: 41_002_400_000, txBytesTotal: 6_000_310_000 });
  });

  test('processos do Claude (CLI, o CLI do Desktop e o Desktop com os helpers) e os seis que mais usam CPU', async () => {
    const { deps } = darwin();
    const r = await new DarwinCollector(deps).collect();
    assert.deepEqual(r.claude, {
      processes: { count: 5, cpuPct: 15.9, memoryBytes: (300_000 + 280_000 + 120_000 + 520_000 + 300_000) * KB },
      cli: { count: 3, cpuPct: 9.9, memoryBytes: (300_000 + 280_000 + 120_000) * KB },
      desktop: { count: 2, cpuPct: 6, memoryBytes: (520_000 + 300_000) * KB },
    });
    assert.deepEqual(r.topProcesses?.map((p) => [p.pid, p.name, p.cpuPct]), [
      [401, 'node', 14],
      [402, 'claude', 6],
      [420, 'com.apple.WebKit.WebContent', 4.2],
      [410, 'Claude', 4],
      [403, 'claude', 3.1],
      [460, 'node', 2.5],
    ]);
  });

  test('Docker: rodando e parados, stacks pelo rótulo do Compose com as portas, e o espaço do system df', async () => {
    const { deps } = darwin();
    const r = await new DarwinCollector(deps).collect();
    assert.deepEqual(r.docker, {
      running: 3,
      stopped: 3,
      stacks: [
        { name: 'catalogo-local', running: 2, stopped: 0, ports: [3000] },
        { name: 'loja-validacao', running: 0, stopped: 3, ports: [15432, 17233, 17234] },
      ],
      space: [
        { type: 'Images', totalCount: 12, active: 5, sizeBytes: 25.2e9, reclaimableBytes: 8.7e9 },
        { type: 'Containers', totalCount: 6, active: 3, sizeBytes: 1.8e9, reclaimableBytes: 712.4e6 },
        { type: 'Local Volumes', totalCount: 4, active: 2, sizeBytes: 4.6e9, reclaimableBytes: 1.26e9 },
        { type: 'Build Cache', totalCount: 40, active: 0, sizeBytes: 2.3e9, reclaimableBytes: 2.3e9 },
      ],
    });
  });

  test('portas em escuta: interface, processo, IPv4 e IPv6 numa linha só', async () => {
    const { deps } = darwin();
    const r = await new DarwinCollector(deps).collect();
    assert.deepEqual(r.ports?.map((p) => [p.port, p.interface, p.process, p.pid]), [
      [3000, 'loopback', 'Code H', 470],
      [4720, 'loopback', 'node', 401],
      [5432, 'all', 'postgres', 450],
      [13000, 'loopback', 'ssh', 430],
      [14720, 'loopback', 'ssh', 430],
      [15173, 'loopback', 'ssh', 430],
      [18080, 'loopback', 'node', 460],
    ]);
  });

  test('túnel: o ssh com -L, o estado de cada porta (up, idle, busy) e o ssh sem -L que não ganhou a porta fica de fora', async () => {
    const sondadas: number[] = [];
    const { deps, calls } = darwin({ probe: async (p) => (sondadas.push(p), ({ 14720: 'open', 13000: 'open', 15173: 'closed' }) as Record<number, 'open' | 'closed'>)[p] ?? 'refused' });
    const r = await new DarwinCollector(deps).collect();
    assert.deepEqual(r.tunnels, [
      {
        pid: 430,
        destination: 'ws-exemplo',
        since: new Date(T0 - (3 * 3600 + 12 * 60) * 1000).toISOString(),
        ports: [
          { localPort: 14720, remoteHost: '127.0.0.1', remotePort: 4720, state: 'up', heldBy: null },
          { localPort: 13000, remoteHost: 'localhost', remotePort: 3000, state: 'up', heldBy: null },
          { localPort: 15173, remoteHost: '127.0.0.1', remotePort: 5173, state: 'idle', heldBy: null },
          { localPort: 18080, remoteHost: '127.0.0.1', remotePort: 8080, state: 'busy', heldBy: 'node' },
        ],
      },
    ]);
    assert.deepEqual(sondadas.sort(), [13000, 14720, 15173]);
    // O `ssh ws-exemplo` sem -L leu o LocalForward pelo `ssh -G`; o mestre do ControlMaster não, e o
    // `ssh -F …` de outra conta (uid 502) também não.
    assert.deepEqual(calls.filter((c) => c.command === 'ssh').map((c) => c.args), [['-G', '--', 'ws-exemplo']]);
  });

  test('túnel: o ssh de outra conta nunca vira `ssh -G`, nem com -F, nem sem ele', async () => {
    const ps = [
      '  480   502    00:10:00 ssh -F /Users/outra/.ssh/config-dela ws-dela',
      '  481   502    00:10:00 ssh ws-dela',
      '  482   502    00:10:00 ssh -fN -L 19000:127.0.0.1:9000 ws-dela',
    ].join('\n');
    const { deps, calls } = darwin({
      commands: { ...DARWIN_COMMANDS, 'ps -axo pid=,uid=,etime=,args=': ps },
      // Mesmo que o arquivo parecesse nosso, o processo não é.
      fileOwner: async () => ({ uid: 501, mode: 0o100600 }),
    });
    const r = await new DarwinCollector(deps).collect();
    assert.deepEqual(r.tunnels, []);
    assert.deepEqual(calls.filter((c) => c.command === 'ssh'), []);
  });

  test('túnel: o -F só vai ao `ssh -G` quando é caminho absoluto do usuário que só ele escreve', async () => {
    const ps = [
      '  480   501    00:10:00 ssh -F /Users/dev/.ssh/meu ws-a',
      '  481   501    00:10:00 ssh -F /tmp/de-outro ws-b',
      '  482   501    00:10:00 ssh -F /Users/dev/.ssh/aberto ws-c',
      '  483   501    00:10:00 ssh -F relativo ws-d',
    ].join('\n');
    const donos: Record<string, { uid: number; mode: number }> = {
      '/Users/dev/.ssh/meu': { uid: 501, mode: 0o100600 },
      '/tmp/de-outro': { uid: 502, mode: 0o100644 },
      '/Users/dev/.ssh/aberto': { uid: 501, mode: 0o100666 },
    };
    const { deps, calls } = darwin({
      commands: { ...DARWIN_COMMANDS, 'ps -axo pid=,uid=,etime=,args=': ps },
      fileOwner: async (path) => donos[path] ?? null,
    });
    await new DarwinCollector(deps).collect();
    assert.deepEqual(calls.filter((c) => c.command === 'ssh').map((c) => c.args), [['-F', '/Users/dev/.ssh/meu', '-G', '--', 'ws-a']]);
  });

  test('túnel: dois ssh para o mesmo destino e arquivo dão um `ssh -G` só', async () => {
    const ps = [
      '  480   501    00:10:00 ssh ws-exemplo',
      '  481   501    00:05:00 ssh ws-exemplo',
      '  482   501    00:05:00 ssh ws-outro',
    ].join('\n');
    const { deps, calls } = darwin({ commands: { ...DARWIN_COMMANDS, 'ps -axo pid=,uid=,etime=,args=': ps } });
    await new DarwinCollector(deps).collect();
    assert.deepEqual(calls.filter((c) => c.command === 'ssh').map((c) => c.args), [
      ['-G', '--', 'ws-exemplo'],
      ['-G', '--', 'ws-outro'],
    ]);
  });

  test('porta do túnel que ninguém escuta é `down`', async () => {
    const { deps } = darwin({ commands: { ...DARWIN_COMMANDS, 'lsof -nP -iTCP -sTCP:LISTEN': 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n' }, probe: async () => 'refused' });
    const r = await new DarwinCollector(deps).collect();
    assert.deepEqual(r.tunnels?.[0].ports.map((p) => p.state), ['down', 'down', 'down', 'down']);
  });

  test('cada comando com tempo curto, nenhum sudo, nenhum shell', async () => {
    const { deps, calls } = darwin();
    await new DarwinCollector(deps).collect();
    assert.ok(calls.length > 10);
    for (const c of calls) {
      assert.ok(c.timeoutMs !== undefined && c.timeoutMs <= 3000, `${c.command}: ${c.timeoutMs}`);
      assert.notEqual(c.command, 'sudo');
      assert.ok(!/[|;&$`]/.test(c.command));
    }
  });
});

describe('#175/AC-1 coletor do Linux, sobre saídas gravadas', () => {
  const linux = () => fixtureDeps({ commands: LINUX_COMMANDS, files: LINUX_FILES, hostname: 'ws-exemplo', cores: 16 });

  test('host, memória pelo /proc/meminfo, GPU pelo nvidia-smi, sem túnel', async () => {
    const r = await new LinuxCollector(linux().deps).collect();
    assert.deepEqual(r.host, { hostname: 'ws-exemplo', platform: 'linux', os: 'Ubuntu 24.04.1 LTS', arch: 'arm64', uptimeSec: 3600 });
    assert.equal(r.cpu.cores, 16);
    assert.deepEqual(r.memory, {
      totalBytes: 65_011_712 * KB,
      usedBytes: (65_011_712 - 34_603_008) * KB,
      swapTotalBytes: 130_023_424 * KB,
      swapUsedBytes: (130_023_424 - 121_425_920) * KB,
      pressure: null,
    });
    assert.deepEqual(r.gpu, { name: 'GPU Exemplo T4', usedPct: 2, memoryUsedBytes: 1843 * MiB, memoryTotalBytes: 15360 * MiB });
    assert.equal(r.tunnels, null);
  });

  test('volumes reais (sem tmpfs, snap e EFI), rede da rota padrão e portas pelo ss', async () => {
    const r = await new LinuxCollector(linux().deps).collect();
    assert.deepEqual(r.disk.volumes.map((v) => [v.mount, v.usedPct]), [['/', 85.9], ['/home', 22.2], ['/tmp', 11.2]]);
    assert.deepEqual(r.network, { interface: 'ens5', rxBytesPerSec: 5_000_000, txBytesPerSec: 1_000_000, rxBytesTotal: 805_000_000, txBytesTotal: 121_000_000 });
    assert.deepEqual(r.ports?.map((p) => [p.port, p.interface, p.process, p.pid]), [
      [22, 'all', null, null],
      [53, 'loopback', null, null],
      [3000, 'loopback', 'vite', 2350],
      [4720, 'loopback', 'node', 2200],
      [15432, 'all', null, null],
    ]);
  });

  test('processos do Claude (o binário e o pacote npm pelo título) e o Docker ausente sem o comando', async () => {
    const r = await new LinuxCollector(linux().deps).collect();
    assert.deepEqual(r.claude?.cli, { count: 2, cpuPct: 20.5, memoryBytes: 900_000 * KB });
    assert.deepEqual(r.claude?.desktop, { count: 0, cpuPct: 0, memoryBytes: 0 });
    assert.deepEqual(r.topProcesses?.map((p) => p.name), ['java', 'claude', 'claude', 'node', 'dockerd', 'postgres']);
    assert.equal(r.docker, null);
  });
});

describe('#175/AC-1 comando que falta é campo ausente, nunca erro', () => {
  test('nada responde: a leitura sai, com o que o node:os dá e o resto nulo', async () => {
    for (const C of [DarwinCollector, LinuxCollector]) {
      const { deps } = fixtureDeps({});
      const r = await new C(deps).collect();
      assert.equal(r.cpu.usedPct, 50);
      assert.deepEqual(r.memory, { totalBytes: 38_654_705_664, usedBytes: 38_654_705_664 - 1_000_000_000, swapTotalBytes: null, swapUsedBytes: null, pressure: null });
      assert.equal(r.host.os, null);
      for (const k of ['gpu', 'network', 'claude', 'topProcesses', 'docker', 'ports', 'tunnels'] as const) assert.equal(r[k], null, k);
      assert.deepEqual(r.disk.volumes, []);
    }
  });

  test('o executor que lança e o statfs que lança também viram ausência', async () => {
    const { deps } = fixtureDeps({});
    deps.run = async () => {
      throw new Error('ENOENT');
    };
    deps.statfs = async () => {
      throw new Error('EACCES');
    };
    const r = await new DarwinCollector(deps).collect();
    assert.equal(r.ports, null);
  });

  test('docker ps responde e o system df estoura o tempo: o espaço sai nulo, o resto fica', async () => {
    const commands = { ...DARWIN_COMMANDS };
    for (const k of Object.keys(commands)) if (k.startsWith('docker system df')) commands[k] = null;
    const r = await new DarwinCollector(darwin({ commands }).deps).collect();
    assert.equal(r.docker?.running, 3);
    assert.equal(r.docker?.space, null);
  });

  test('sem coletor fora do Mac e do Linux', () => {
    assert.equal(collectorFor('win32'), null);
  });
});

describe('#175/AC-1 leituras de saída', () => {
  test('linha de comando do ssh: grupos de opções, -o, --, e o que não é cliente', () => {
    assert.deepEqual(parseSshArgs('/usr/bin/ssh -NL14720:127.0.0.1:4720 -p 2222 -F /Users/dev/.ssh/outro dev@ws-exemplo uptime'), {
      destination: 'dev@ws-exemplo',
      forwards: [{ localPort: 14720, remoteHost: '127.0.0.1', remotePort: 4720 }],
      configFile: '/Users/dev/.ssh/outro',
    });
    assert.equal(parseSshArgs('ssh: /Users/dev/.ssh/cm [mux]'), null);
    assert.equal(parseSshArgs('sshd: dev@pts/0'), null);
    assert.equal(parseSshArgs('ssh -L'), null);
    assert.equal(parseSshArgs('ssh -- ws-exemplo')?.destination, 'ws-exemplo');
    // Depois do `--`, um destino que começa com `-` seria opção do `ssh -G`.
    assert.equal(parseSshArgs('ssh -- -oProxyCommand=x'), null);
  });

  test('linha de comando do ssh: -o LocalForward, com `=`, com espaço (o ps perde as aspas) e colado', () => {
    const f = [{ localPort: 14720, remoteHost: '127.0.0.1', remotePort: 4720 }];
    assert.deepEqual(parseSshArgs('ssh -o LocalForward=14720 127.0.0.1:4720 ws-exemplo'), { destination: 'ws-exemplo', forwards: f, configFile: null });
    assert.deepEqual(parseSshArgs('ssh -o LocalForward 14720 127.0.0.1:4720 ws-exemplo'), { destination: 'ws-exemplo', forwards: f, configFile: null });
    assert.deepEqual(parseSshArgs('ssh -oLocalForward=14720 127.0.0.1:4720 ws-exemplo'), { destination: 'ws-exemplo', forwards: f, configFile: null });
    assert.deepEqual(parseSshArgs('ssh -o localforward = 14720 127.0.0.1:4720 ws-exemplo'), { destination: 'ws-exemplo', forwards: f, configFile: null });
    assert.deepEqual(parseSshArgs('ssh -o LocalForward=localhost:15432 [::1]:5432 ws-exemplo')?.forwards, [{ localPort: 15432, remoteHost: '::1', remotePort: 5432 }]);
    // Outra opção com -o não consome palavra nenhuma além do valor.
    assert.deepEqual(parseSshArgs('ssh -o ExitOnForwardFailure=no ws-exemplo'), { destination: 'ws-exemplo', forwards: [], configFile: null });
  });

  test('especificação de -L: com bind, IPv6 e socket Unix (fora)', () => {
    assert.deepEqual(parseForwardSpec('127.0.0.1:15432:[::1]:5432'), { localPort: 15432, remoteHost: '::1', remotePort: 5432 });
    assert.deepEqual(parseForwardSpec('*:8080:db:80'), { localPort: 8080, remoteHost: 'db', remotePort: 80 });
    assert.equal(parseForwardSpec('/tmp/sock:/var/run/x.sock'), null);
    assert.deepEqual(parseSshG('localforward [localhost]:13000 [localhost]:3000\n'), [{ localPort: 13000, remoteHost: 'localhost', remotePort: 3000 }]);
  });

  test('etime, tamanhos do Docker, portas publicadas e interface de escuta', () => {
    assert.equal(parseEtime('2-01:00:00'), 2 * 86_400 + 3600);
    assert.equal(parseEtime('05:00'), 300);
    assert.equal(parseEtime('agora'), null);
    assert.equal(parseDockerSize('0B'), 0);
    assert.equal(parseDockerSize('1.5kB'), 1500);
    assert.equal(parseDockerSize('?'), null);
    assert.deepEqual(publishedPorts('5432/tcp'), []);
    assert.deepEqual(listenInterfaceOf('[::]'), { interface: 'all', address: null });
    assert.deepEqual(listenInterfaceOf('192.0.2.10'), { interface: 'address', address: '192.0.2.10' });
  });

  test('CPU sem diferença e contador de rede que voltou dão nulo', () => {
    const t = { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 };
    assert.equal(cpuUsedPct([{ times: t }], [{ times: t }]), null);
    assert.equal(cpuUsedPct([], []), null);
    const n = networkOf({ interface: 'en0', rxBytes: 10, txBytes: 10, atMs: 2000 }, { interface: 'en0', rxBytes: 50, txBytes: 5, atMs: 1000 });
    assert.equal(n.rxBytesPerSec, null);
    assert.equal(networkOf({ interface: 'en1', rxBytes: 10, txBytes: 10, atMs: 2000 }, { interface: 'en0', rxBytes: 1, txBytes: 1, atMs: 1000 }).txBytesPerSec, null);
  });
});
