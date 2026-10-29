// Terminal sessions (#350): `ps` and `ss` outputs to sessions, "presa", what is never signaled, the
// alert, the collector reading and the remote's projection. Recorded outputs, no real system.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeAlerts } from '../../src/telemetry/alerts.ts';
import { LinuxCollector } from '../../src/telemetry/adapters/linux.ts';
import { buildTerminals, parseElapsed, parseTerminalsPs, parseTunnelSshd, sanitizeTerminals } from '../../src/telemetry/terminals.ts';
import type { CollectorDeps } from '../../src/telemetry/ports.ts';
import { T0 } from './reading.ts';

const SCRATCH = '/tmp/claude-85401147/-home-seguim-Workspace-ahrena/fe694084-bac4-42f8-a4c6-d8a3accf3a16/scratchpad/destrava-pedro.sh';
// The real case of 2026-10-29: pts/0 and pts/1 held by one sshd, pts/0 with a Claude script in the foreground.
const LINUX_PS = `
  812     1   812      -1 ?        Ss     90000  0 root     /usr/sbin/sshd -D
 2210   812  2210      -1 ?        Ss      5400  1000 seguim   sshd: seguim@pts/0,pts/1
 2231  2210  2231   41233 pts/0    Ss      5400  1000 seguim   -bash
41233  2231 41233   41233 pts/0    S+      1560  1000 seguim   bash ${SCRATCH}
41290 41233 41233   41233 pts/0    S+      1500  1000 seguim   sleep 300
 2260  2210  2260    2260 pts/1    Ss+     5400  1000 seguim   -bash
 3150   812  3150      -1 ?        Ss      3000  1000 seguim   sshd: seguim@pts/2
 3170  3150  3170    3199 pts/2    Ss      3000  1000 seguim   bash -l
 3199  3170  3199    3199 pts/2    S+       800  1000 seguim   python treino.py
 3880   812  3880      -1 ?        Ss      3000  1000 seguim   sshd: seguim@pts/3
 3890  3880  3890    3901 pts/3    Ss      3000  1000 seguim   bash -l
 3901  3890  3901    3901 pts/3    S+      9000  1000 seguim   vim notas.md
 3911   812  3911      -1 ?        Ss       600  1000 seguim   sshd: seguim@pts/4
 3920  3911  3920    3925 pts/4    Ss       600  1000 seguim   bash -l
 3925  3920  3925    3925 pts/4    T        300  1000 seguim   python treino.py
 4000   812  4000      -1 ?        Ss      3000     0 root     sshd: root@pts/5
 4010  4000  4010    4020 pts/5    Ss      3000     0 root     bash
 4020  4010  4020    4020 pts/5    S+       999     0 root     apt-get upgrade
`;
const NOW = T0;
const opts = (over = {}) => ({ nowMs: NOW, uid: 1000, selfPid: 999_999, ...over });
const byTty = (r: ReturnType<typeof buildTerminals>, tty: string) => r.sessions.find((s) => s.tty === tty)!;

describe('#350 parsing', () => {
  test('etimes in seconds and the Mac etime format', () => {
    assert.equal(parseElapsed('1560'), 1560);
    assert.equal(parseElapsed('26:00'), 1560);
    assert.equal(parseElapsed('02:03:04'), 7384);
    assert.equal(parseElapsed('2-03:04:05'), 183845);
    assert.equal(parseElapsed('abc'), null);
  });

  test('ps rows keep the args and skip lines that are not rows', () => {
    const rows = parseTerminalsPs(`${LINUX_PS}\nnot a row\n`);
    assert.equal(rows.length, 18);
    assert.equal(rows.find((r) => r.pid === 41233)?.args, `bash ${SCRATCH}`);
  });

  test('ss: only the sshd with an established connection to the núcleo port', () => {
    const ss = `State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
ESTAB 0 0 127.0.0.1:41500 127.0.0.1:4720 users:(("sshd",pid=2210,fd=12))
ESTAB 0 0 127.0.0.1:4720 127.0.0.1:41500 users:(("node",pid=900,fd=20))
ESTAB 0 0 10.0.0.5:22 10.0.0.9:50000 users:(("sshd",pid=3150,fd=4))`;
    assert.deepEqual([...parseTunnelSshd(ss, 4720)], [2210]);
  });
});

describe('#350 sessions', () => {
  const r = buildTerminals(parseTerminalsPs(LINUX_PS), opts());

  test('one row per pts, the connection that holds it, shared by pts/0 and pts/1', () => {
    assert.deepEqual(r.sessions.map((s) => s.tty), ['pts/0', 'pts/1', 'pts/2', 'pts/3', 'pts/4', 'pts/5']);
    const p0 = byTty(r, 'pts/0');
    assert.equal(p0.id, 'pts-0');
    assert.equal(p0.connection.kind, 'sshd');
    assert.equal(p0.connection.pid, 2210);
    assert.deepEqual(p0.connection.ttys, ['pts/0', 'pts/1']);
    assert.equal(p0.connection.since, new Date(NOW - 5400_000).toISOString());
    assert.equal(p0.shell?.pid, 2231);
    assert.equal(byTty(r, 'pts/1').connection.pid, 2210);
  });

  test('the Claude scratchpad script is the foreground, stuck after 2 min, with the Claude session id', () => {
    const p0 = byTty(r, 'pts/0');
    assert.equal(p0.state, 'running');
    assert.equal(p0.foreground?.pid, 41233);
    assert.equal(p0.foreground?.pgid, 41233);
    assert.equal(p0.foreground?.processes, 2);
    assert.equal(p0.foreground?.ageSec, 1560);
    assert.equal(p0.stuck, true);
    assert.equal(p0.claudeSessionId, 'fe694084-bac4-42f8-a4c6-d8a3accf3a16');
  });

  test('only the prompt is idle, with no foreground and never stuck', () => {
    const p1 = byTty(r, 'pts/1');
    assert.equal(p1.state, 'idle');
    assert.equal(p1.foreground, null);
    assert.equal(p1.stuck, false);
  });

  test('a command past 15 min is stuck; a known interactive one (vim) is not; a suspended one is stopped, not stuck', () => {
    assert.equal(byTty(r, 'pts/2').stuck, false); // python 800 s
    assert.equal(byTty(r, 'pts/3').stuck, false); // vim, 9000 s
    assert.equal(byTty(r, 'pts/3').state, 'running');
    assert.equal(byTty(r, 'pts/4').state, 'stopped');
    assert.equal(byTty(r, 'pts/4').stuck, false);
    const later = buildTerminals(parseTerminalsPs(LINUX_PS.replace(' 800  1000 seguim   python', ' 901  1000 seguim   python')), opts());
    assert.equal(byTty(later, 'pts/2').stuck, true);
  });

  test('terminal.interactiveCommands keeps a command out of "presa"', () => {
    const later = buildTerminals(parseTerminalsPs(LINUX_PS.replace(' 800  1000 seguim   python', ' 901  1000 seguim   python')), opts({ interactive: ['python'] }));
    assert.equal(byTty(later, 'pts/2').stuck, false);
  });

  test('another user\'s session is listed, not own and protected', () => {
    const p5 = byTty(r, 'pts/5');
    assert.equal(p5.own, false);
    assert.equal(p5.foreground?.protection, 'other-user');
    assert.equal(p5.end.protection, 'other-user');
  });

  test('the sshd the tunnel passes through is protected for ending the session; the command is still interruptible', () => {
    const t = buildTerminals(parseTerminalsPs(LINUX_PS), opts({ tunnelSshd: new Set([2210]) }));
    assert.equal(byTty(t, 'pts/0').end.protection, 'tunnel');
    assert.equal(byTty(t, 'pts/1').end.protection, 'tunnel');
    assert.equal(byTty(t, 'pts/0').foreground?.protection, null);
    assert.equal(byTty(t, 'pts/2').end.protection, null);
  });

  test('the núcleo and what runs it are protected, and never "presa"', () => {
    // The núcleo (pid 3199) runs in the foreground of pts/2, started from that bash and that sshd.
    const t = buildTerminals(parseTerminalsPs(LINUX_PS.replace(' 800  1000 seguim   python treino.py', ' 3000  1000 seguim   node core.js')), opts({ selfPid: 3199 }));
    const p2 = byTty(t, 'pts/2');
    assert.equal(p2.foreground?.protection, 'core');
    assert.equal(p2.end.protection, 'core');
    assert.equal(p2.stuck, false);
    assert.equal(byTty(t, 'pts/0').end.protection, null);
  });
});

describe('#350 macOS', () => {
  const MAC_PS = `
  100     1   100      -1 ??       Ss   10:00:00   501 seguim   /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  210   100   210     211 ttys003  Ss      09:01   501 seguim   login -pf seguim
  211   210   211     211 ttys003  S+      09:00   501 seguim   -zsh
  220   100   220     321 ttys007  Ss      16:00   501 seguim   login -pf seguim
  221   220   221     321 ttys007  S       16:00   501 seguim   -zsh
  321   221   321     321 ttys007  S+      16:00   501 seguim   node servidor.js
`;
  const r = buildTerminals(parseTerminalsPs(MAC_PS), opts({ uid: 501 }));
  test('the terminal app is the connection; the etime format gives the age', () => {
    const s = byTty(r, 'ttys007');
    assert.equal(s.connection.kind, 'app');
    assert.equal(s.connection.label, 'Terminal');
    assert.equal(s.foreground?.ageSec, 960);
    assert.equal(s.stuck, true);
    assert.equal(s.end.pid, 221);
  });
  test('an idle prompt behind login has no foreground', () => {
    assert.equal(byTty(r, 'ttys003').state, 'idle');
    assert.equal(byTty(r, 'ttys003').foreground, null);
  });
});

describe('#350 alert and collector', () => {
  test('terminal-stuck: one alert per stuck terminal, since when the command started', () => {
    const terminals = buildTerminals(parseTerminalsPs(LINUX_PS), opts());
    const alerts = computeAlerts({ ...({ takenAt: new Date(NOW).toISOString(), cpu: { cores: 4, usedPct: 1, model: null, load: { one: 0, five: 0, fifteen: 0 } }, disk: { volumes: [] }, ports: null, tunnels: null, memory: { totalBytes: 1, usedBytes: 1, swapTotalBytes: null, swapUsedBytes: null, pressure: null } } as never), terminals }, []);
    const a = alerts.find((x) => x.kind === 'terminal-stuck')!;
    assert.equal(a.id, 'terminal-stuck:pts-0');
    assert.equal(a.level, 'error');
    assert.equal(a.message, 'O terminal pts/0 está preso há 26 min');
    assert.match(a.detail ?? '', /^bash …\/destrava-pedro\.sh · da sessão do Claude fe694084$/);
    assert.equal(a.since, new Date(NOW - 1560_000).toISOString());
    assert.equal(alerts.filter((x) => x.kind === 'terminal-stuck').length, 1);
  });

  test('the Linux collector asks ps and ss and fills terminals; no ps, null', async () => {
    const calls: string[] = [];
    const deps = (ps: string | null): CollectorDeps => ({
      run: async (c, a) => {
        calls.push(`${c} ${a.join(' ')}`);
        if (c === 'ps' && a[0] === '-eo' && a[1]!.includes('tpgid')) return ps;
        if (c === 'ss' && a[0] === '-tnp') return 'ESTAB 0 0 127.0.0.1:41500 127.0.0.1:4720 users:(("sshd",pid=2210,fd=12))';
        return null;
      },
      readFile: async () => null,
      statfs: async () => null,
      fileOwner: async () => null,
      probe: async () => 'refused',
      os: { hostname: () => 'h', arch: () => 'x64', uptime: () => 1, totalmem: () => 1, freemem: () => 1, loadavg: () => [0, 0, 0], cpus: () => [], uid: () => 1000 },
      now: () => NOW,
      sleep: async () => {},
      selfPid: 999_999,
      corePort: 4720,
    });
    const c = new LinuxCollector(deps(LINUX_PS));
    const reading = await c.collect();
    assert.equal(reading.terminals?.sessions.length, 6);
    assert.equal(reading.terminals?.sessions[0]?.end.protection, 'tunnel');
    assert.ok(calls.includes('ps -eo pid=,ppid=,pgid=,tpgid=,tty=,stat=,etimes=,uid=,user=,args='));
    assert.equal((await new LinuxCollector(deps(null)).collect()).terminals, null);
  });
});

describe('#350 the remote\'s terminals', () => {
  const sent = buildTerminals(parseTerminalsPs(LINUX_PS), opts());
  test('a well-formed reading round-trips', () => {
    assert.deepEqual(sanitizeTerminals(JSON.parse(JSON.stringify(sent))), sent);
  });
  test('a session with a bad id or kind is left out; a non-reading is null', () => {
    const bad = JSON.parse(JSON.stringify(sent)) as typeof sent;
    bad.sessions[0]!.id = '../etc';
    bad.sessions[1]!.connection.kind = 'x' as never;
    assert.equal(sanitizeTerminals(bad)?.sessions.length, 4);
    assert.equal(sanitizeTerminals('nope'), null);
    assert.equal(sanitizeTerminals({ sessions: 3 }), null);
  });
});
