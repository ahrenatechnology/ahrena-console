// The "Sessões de terminal" card (C90 to C93, issue 350) without the DOM: what each row says, which
// actions are on and why not, and what each confirmation shows. Read from the machine's telemetry
// reading (`terminals`, src/telemetry/model.ts); a remote's reading goes through `normalizeTerminals`.

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, max = 300) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const PROTECTIONS = ['tunnel', 'core', 'other-user'];
const protection = (v) => (PROTECTIONS.includes(v) ? v : null);

export const TERMINAL_ACTION_ROUTE = (id, action) => `/api/terminals/${id}/actions/${action}`;
export const TERMINAL_ID = /^(?:pts-\d{1,6}|ttys\d{1,4})$/;

/** `[tone, label]` of the state pill; a stuck terminal wins over `running`. */
export const TERMINAL_STATE = { idle: ['b-idle', 'Ocioso'], running: ['b-active', 'Rodando'], stopped: ['b-waiting', 'Parado'], stuck: ['b-error', 'Presa'] };

export function normalizeTerminals(t) {
  if (!isObject(t) || !Array.isArray(t.sessions)) return null;
  const sessions = t.sessions.slice(0, 64).flatMap((s) => {
    if (!isObject(s) || !isObject(s.connection) || !isObject(s.end)) return [];
    const id = str(s.id, 16);
    const tty = str(s.tty, 16);
    if (!id || !tty || !TERMINAL_ID.test(id) || !['idle', 'running', 'stopped'].includes(s.state)) return [];
    const c = s.connection;
    const fg = isObject(s.foreground) && int(s.foreground.pid) !== null && int(s.foreground.pgid) !== null && str(s.foreground.args) ? s.foreground : null;
    return [
      {
        id,
        tty,
        user: str(s.user, 64) ?? '',
        own: s.own === true,
        connection: { kind: ['sshd', 'app', 'local'].includes(c.kind) ? c.kind : 'local', pid: int(c.pid), label: str(c.label, 64), since: str(c.since, 40), ttys: Array.isArray(c.ttys) ? c.ttys.filter((x) => typeof x === 'string').slice(0, 16) : [tty], protection: protection(c.protection) },
        shell: isObject(s.shell) && str(s.shell.args) ? { pid: int(s.shell.pid), args: str(s.shell.args) } : null,
        foreground: fg ? { pid: fg.pid, pgid: fg.pgid, args: str(fg.args), ageSec: int(fg.ageSec) ?? 0, processes: int(fg.processes) ?? 1, protection: protection(fg.protection) } : null,
        end: { pid: int(s.end.pid), protection: protection(s.end.protection) },
        state: s.state,
        stuck: s.stuck === true,
        claudeSessionId: str(s.claudeSessionId, 40),
      },
    ];
  });
  return { sessions, stuckAfterSec: int(t.stuckAfterSec) ?? 900, remoteActions: t.remoteActions === true };
}

export const stateOf = (s) => TERMINAL_STATE[s.stuck ? 'stuck' : s.state];

/** "26 min", "3 h 05", "45 s". */
export function ageText(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

/** A long path keeps only its last name: `bash …/destrava-pedro.sh`. */
export function shortCommand(args) {
  const out = String(args ?? '').split(/\s+/).map((t) => (t.length > 40 && t.includes('/') ? `…/${t.slice(t.lastIndexOf('/') + 1)}` : t)).join(' ');
  return out.length > 80 ? `${out.slice(0, 79)}…` : out;
}

const HM = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** The connection cell: `[title, detail]`. */
export function connectionCell(s) {
  const c = s.connection;
  const since = c.since && Number.isFinite(Date.parse(c.since)) ? `desde ${HM.format(new Date(c.since))}` : null;
  if (c.kind === 'sshd') return [`sshd ${c.pid}`, [c.label, since].filter(Boolean).join(' · ')];
  if (c.kind === 'app') return [c.label ?? 'Terminal', since ?? ''];
  return ['local', ''];
}

/** What a stuck row says about the Claude session: its title when the screen knows it, else the short id. */
export function claudeLabel(s, sessions) {
  if (!s.claudeSessionId) return null;
  const hit = (sessions ?? []).find((i) => isObject(i) && [i.id, i.sessionId].includes(s.claudeSessionId) && str(i.title));
  return hit ? hit.title : s.claudeSessionId.slice(0, 8);
}

const WHY = {
  'other-user': 'É de outro usuário. O console só age nos processos do seu.',
  core: 'É o núcleo do console, ou o que o roda. Pare-o pela bandeja.',
  tunnel: 'Esta conexão leva o túnel do console. Encerrá-la derrubaria a máquina do Mac.',
};

/** Whether Interromper o comando is on, and if not, why. */
export function interruptState(s) {
  if (!s.own) return { on: false, why: WHY['other-user'] };
  if (!s.foreground) return { on: false, why: 'Só o prompt: não há comando para interromper.' };
  if (s.foreground.protection) return { on: false, why: WHY[s.foreground.protection] };
  return { on: true, why: null };
}

/** Whether Encerrar a sessão is on, and if not, why. */
export function endState(s) {
  if (!s.own) return { on: false, why: WHY['other-user'] };
  if (s.end.pid === null) return { on: false, why: 'Não achei o processo que segura esta sessão.' };
  if (s.end.protection) return { on: false, why: WHY[s.end.protection] };
  return { on: true, why: null };
}

/** The ladder: each step is a click; `kill` is the second confirmation. */
export const COMMAND_STEPS = ['interrupt', 'terminate', 'kill'];
export const SESSION_STEPS = ['hangup', 'end'];
export const STEP = {
  interrupt: { signal: 'SIGINT', target: 'command', title: 'Interromper o comando', ok: 'Interromper', icon: 'square', note: 'O mesmo que Ctrl-C na aba. O shell da aba não recebe nada: só o comando.' },
  terminate: { signal: 'SIGTERM', target: 'command', title: 'Ainda rodando · enviar SIGTERM?', ok: 'Enviar SIGTERM', icon: 'square', note: 'Pede ao processo que termine, e ele pode limpar o que abriu. Se ainda assim ficar, o próximo passo é o SIGKILL, com uma segunda confirmação.' },
  kill: { signal: 'SIGKILL', target: 'command', title: 'Matar à força · segunda confirmação', ok: 'Matar à força', icon: 'zap', danger: true, note: 'O processo morre sem poder limpar nada: arquivos temporários e travas podem ficar. Só use quando o SIGTERM não resolveu.' },
  hangup: { signal: 'SIGHUP', target: 'session', title: 'Encerrar a sessão', ok: 'Encerrar a sessão', icon: 'power', note: 'Vale para a conexão inteira, não só para esta aba. Uma aba nova abre quando o terminal for aberto de novo.' },
  end: { signal: 'SIGTERM', target: 'session', title: 'A sessão continua · enviar SIGTERM?', ok: 'Enviar SIGTERM', icon: 'power', note: 'O SIGHUP não bastou. O SIGTERM pede que a conexão termine.' },
};

/** The confirmation for `step` on session `s`: `{ title, rows, lines, note, ok, icon, danger }`. */
export function confirmation(s, step, { machineLabel, local }) {
  const def = STEP[step];
  const where = local ? `Esta máquina · terminal ${s.tty}` : `Na ${machineLabel} · terminal ${s.tty}`;
  const rows = [['Onde', where]];
  const lines = [];
  if (def.target === 'command') {
    const fg = s.foreground;
    rows.push(['Processo', `${shortCommand(fg.args)} · pid ${fg.pid} · grupo ${fg.pgid} · seu usuário`], ['Rodando há', ageText(fg.ageSec)], ['No grupo', `${fg.processes} ${fg.processes === 1 ? 'processo' : 'processos'}`]);
    lines.push(`${def.signal} no grupo ${fg.pgid}`);
    if (step === 'interrupt') lines.push('o mesmo que Ctrl-C na aba');
  } else {
    const [title] = connectionCell(s);
    const others = s.connection.ttys.length;
    rows.push(['Conexão', `${title}${s.connection.label ? ` · ${s.connection.label}` : ''}`]);
    if (s.connection.kind === 'sshd' && others > 1) rows.push(['Esta conexão segura', `${others} terminais: ${s.connection.ttys.join(' e ')}. As ${others === 2 ? 'duas abas fecham' : 'abas fecham'}.`]);
    if (s.foreground) rows.push(['Em primeiro plano', `${shortCommand(s.foreground.args)} · ${ageText(s.foreground.ageSec)}`]);
    lines.push(`${def.signal} no ${s.connection.kind === 'sshd' ? 'sshd' : 'shell'} ${s.end.pid}`);
  }
  return { title: step === 'interrupt' ? `Interromper o comando em ${s.tty}` : step === 'hangup' ? `Encerrar a sessão de ${s.tty}` : def.title, rows, lines, note: def.note, ok: def.ok, icon: def.icon, danger: def.danger === true };
}

/** The line to paste in a terminal over there when the Mac's actions are off. */
export function copyCommand(s, kind) {
  if (kind === 'command') return s.foreground ? `kill -INT -- -${s.foreground.pgid}` : null;
  return s.end.pid === null ? null : `kill -HUP ${s.end.pid}`;
}

/** The message when a write was refused, by the core's `reason` (or the status). */
export function actionProblem(e, { local, machineLabel }) {
  const reason = e?.body?.reason;
  if (reason === 'changed' || reason === 'unknown-session') return 'Nada foi enviado. O processo não é mais o mesmo neste terminal. A lista foi lida de novo.';
  if (reason === 'unreadable') return 'Nada foi enviado: não deu para ler os terminais agora.';
  if (reason === 'tunnel' || reason === 'core' || reason === 'other-user') return WHY[reason];
  if (!local && e?.status === 403) return `A ${machineLabel} não aceita ações vindas deste Mac. Use Copiar comando, num terminal de lá.`;
  if (e?.status === 404 && !local) return `A ${machineLabel} ainda não tem esta ação: atualize o núcleo de lá.`;
  if (e?.status === 502 || reason === 'unreachable') return `A ${machineLabel} não respondeu.`;
  return e?.message || 'Não deu para enviar.';
}

/** The next step of a ladder, or `null` at its end. */
export function nextStep(step) {
  const steps = STEP[step].target === 'command' ? COMMAND_STEPS : SESSION_STEPS;
  return steps[steps.indexOf(step) + 1] ?? null;
}
