// The remote machine's connection (issue 278, decision 0013 §4 and §5, wireframes C62 to C65), without DOM:
// the test imports this file directly.
//
// - `GET /api/machines` gives each remote a `connection` (an older core gives none: the screen stays as
//   it was) and `GET /api/telemetry?machine=<id>` a `current.placement` (where it runs, read over there).
// - What each cell of the trio (Túnel / Sessão AWS / Núcleo de lá), each band, each reason and the
//   "Onde roda" card say, in pt-BR, comes from here. Only the closed list of reasons reaches the screen,
//   never a line of a command's output.
// - The writes take only the machine id the core sent: `/api/machines/<id>/connection/<action>` and the
//   DELETE that cancels. "Só entrar" is the issue-277 login of this Mac's session, in browser mode.

import { DASH, ago, clockOf, clockTime, duration, isMachineId, spanText } from './machine-format.js';
import { timeLeft, whenText } from './cloud-format.js';

export const CONNECTION_STATES = ['up', 'down', 'starting', 'stopping', 'failing', 'stopped'];
export const CONNECTION_REASONS = ['sso-expired', 'port-busy', 'core-not-answering', 'ssm-agent-offline', 'host-unknown', 'key-refused', 'exit-code'];
export const CLOUD_STATES = ['valid', 'expiring', 'expired', 'never', 'unknown', 'not-found', 'unavailable'];
const JOB_KINDS = ['start', 'stop', 'reconnect', 'login-and-start'];
const JOB_STEPS = ['login', 'stop', 'start', 'read'];
const JOB_STATES = ['running', 'succeeded', 'failed', 'timed-out', 'canceled'];
const PORT_STATES = ['up', 'idle', 'busy', 'down'];
export const ACTIONS = ['start', 'stop', 'reconnect', 'login-and-start'];
/** How long a job that just ended without bringing the tunnel up still says so (a cancel, a failed login). */
export const RECENT_JOB_MS = 10 * 60_000;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const iso = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const oneOf = (v, list) => (list.includes(v) ? v : null);
const args = (v) => (Array.isArray(v) ? v.slice(0, 32).filter((a) => typeof a === 'string').map((a) => a.slice(0, 1024)) : []);
const port = (v) => (Number.isInteger(v) && v > 0 && v < 65536 ? v : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const hm = (t) => (t ? clockTime(t) : null);
const sinceText = (t, now) => (t ? ago(t, now).replace(/^há /, '') : null);

// ---------- routes ----------

/** `POST /api/machines/<id>/connection/<action>`, or `null` for an id or action that cannot go in the path. */
export function actionRoute(id, action) {
  if (!isMachineId(id) || id === 'local' || !ACTIONS.includes(action)) return null;
  return `/api/machines/${id}/connection/${action}`;
}

/** `DELETE /api/machines/<id>/connection` (Cancelar), or `null`. */
export const cancelRoute = (id) => (isMachineId(id) && id !== 'local' ? `/api/machines/${id}/connection` : null);

// ---------- shape checks ----------

function normalizeCloud(c) {
  if (!isObject(c) || c.connector !== 'aws' || !str(c.profile, 64)) return null;
  return { connector: 'aws', profile: c.profile.slice(0, 64), session: str(c.session, 128), state: oneOf(c.state, CLOUD_STATES) ?? 'unknown', expiresAt: iso(c.expiresAt) };
}

function normalizeError(e) {
  if (!isObject(e)) return null;
  const reason = oneOf(e.reason, CONNECTION_REASONS);
  if (!reason) return null;
  return { reason, at: iso(e.at), exitCode: int(e.exitCode), holder: str(e.holder, 80) };
}

function normalizeJob(j) {
  if (!isObject(j)) return null;
  const kind = oneOf(j.kind, JOB_KINDS);
  const state = oneOf(j.state, JOB_STATES);
  const step = oneOf(j.step, JOB_STEPS);
  if (!kind || !state || !step) return null;
  const steps = (Array.isArray(j.steps) ? j.steps.slice(0, 6) : []).filter((s) => JOB_STEPS.includes(s));
  const timeout = int(j.stepTimeoutSeconds);
  return {
    kind,
    steps: steps.includes(step) ? steps : [step],
    step,
    state,
    startedAt: iso(j.startedAt),
    endedAt: iso(j.endedAt),
    stepStartedAt: iso(j.stepStartedAt),
    stepTimeoutSeconds: timeout !== null && timeout > 0 && timeout <= 3600 ? timeout : null,
    startedBy: j.startedBy === 'ui' || j.startedBy === 'local' ? j.startedBy : null,
  };
}

function normalizeCommand(c) {
  if (!isObject(c)) return null;
  const start = args(c.start);
  if (!start.length) return null;
  const stop = args(c.stop);
  const t = int(c.startTimeoutSeconds);
  const s = int(c.stopTimeoutSeconds);
  return { start, stop: stop.length ? stop : null, startTimeoutSeconds: t && t > 0 ? t : null, stopTimeoutSeconds: s && s > 0 ? s : null };
}

/** The `connection` of a remote in `GET /api/machines`, or `null` when the core sent none (an older core). */
export function normalizeConnection(c) {
  if (!isObject(c)) return null;
  const state = oneOf(c.state, CONNECTION_STATES);
  if (!state) return null;
  const a = isObject(c.actions) ? c.actions : {};
  const ports = (Array.isArray(c.ports) ? c.ports.slice(0, 50) : [])
    .filter((p) => isObject(p) && port(p.localPort) && port(p.remotePort))
    .map((p) => ({ localPort: p.localPort, remoteHost: str(p.remoteHost, 253), remotePort: p.remotePort, state: oneOf(p.state, PORT_STATES) ?? 'down', heldBy: str(p.heldBy, 80) }));
  return {
    configured: c.configured === true,
    state,
    since: iso(c.since),
    ports,
    cloud: normalizeCloud(c.cloud),
    lastError: normalizeError(c.lastError),
    actions: { start: a.start === true, stop: a.stop === true, reconnect: a.reconnect === true, loginAndStart: a.loginAndStart === true },
    command: normalizeCommand(c.command),
    job: normalizeJob(c.job),
    logFile: str(c.logFile, 1024),
  };
}

const PROVIDERS = ['aws', 'gcp', 'azure', 'unknown'];
const SOURCES = ['instance-metadata', 'ssm-registration', 'dmi'];

/** The `placement` of a reading, or `null` when the core over there does not send it (an older one). */
export function normalizePlacement(p) {
  if (!isObject(p)) return null;
  return {
    provider: oneOf(p.provider, PROVIDERS) ?? 'unknown',
    kind: str(p.kind, 64),
    region: str(p.region, 64),
    zone: str(p.zone, 64),
    instanceId: str(p.instanceId, 64),
    source: oneOf(p.source, SOURCES),
    readAt: iso(p.readAt),
  };
}

// ---------- what the screen shows ----------

/**
 * Which connection screen a remote gets: `full` (a `connection` with a stop command or a cloud profile:
 * C62 to C65), `start-only` (only the command that brings the tunnel up, a lone `reconnect` of issue 244:
 * the Reconectar of C50 stays, and a card shows how to get the rest), `none` (nothing in machines.json:
 * the issue-244 setup card stays). `null` without a `connection` (an older core: the screen as it was).
 */
export function connectionMode(connection) {
  if (!connection) return null;
  if (!connection.configured || !connection.command) return 'none';
  return connection.command.stop || connection.cloud ? 'full' : 'start-only';
}

const running = (connection) => (connection.job?.state === 'running' ? connection.job : null);

/** The header's state pill, `[tone, label]`. */
export function connectionPill(connection) {
  const job = running(connection);
  if (connection.state === 'starting' || connection.state === 'stopping') {
    if (job?.step === 'login') return ['b-waiting', 'Entrando na AWS'];
    if (connection.state === 'stopping' || (job?.kind === 'reconnect' && job.step === 'stop')) return ['b-waiting', 'Parando o túnel'];
    return ['b-waiting', 'Subindo o túnel'];
  }
  if (connection.state === 'up') return ['b-completed', 'Conectada'];
  if (connection.state === 'stopped') return ['b-abandoned', 'Parada por você'];
  return ['b-error', 'Sem conexão'];
}

const PROVIDER_LABEL = { aws: 'AWS', gcp: 'Google Cloud', azure: 'Azure' };

/** The header's line with the provider and the region before "porta N do Mac", when they are known. */
export function headerWithPlacement(line, placement) {
  if (!line || !placement || placement.provider === 'unknown') return line;
  const extra = [PROVIDER_LABEL[placement.provider], placement.region].filter(Boolean);
  const parts = line.split(' · ');
  const at = parts.findIndex((p) => /^porta \d+ do Mac$/.test(p));
  const read = parts.findIndex((p) => /^(lido |última leitura)/.test(p));
  parts.splice(at !== -1 ? at : read !== -1 ? read : parts.length, 0, ...extra);
  return parts.join(' · ');
}

/**
 * The trio of the "Conexão" card: three cells `{ key, label, tone, icon, value, sub }`, tone `ok`, `warn`,
 * `bad` or `off`. `machine` is the normalized machine (its state says whether the core over there
 * answers), `reading` its last reading.
 */
export function connectionTrio(connection, machine, reading, now = Date.now()) {
  const c = connection;
  const job = running(c);
  const n = c.ports.length;
  let tunnel;
  if (c.state === 'up') tunnel = { tone: 'ok', icon: 'check-circle-2', value: 'No ar', sub: [c.since ? `há ${duration(c.since, now)}` : null, n ? plural(n, 'porta', 'portas') : null].filter(Boolean).join(' · ') || 'respondendo pela porta do Mac' };
  else if (c.state === 'stopping' || (job && job.step === 'stop')) tunnel = { tone: 'warn', icon: 'wall-loader', value: 'Parando', sub: 'rodando o comando de parar' };
  else if (c.state === 'starting') tunnel = { tone: 'warn', icon: 'wall-loader', value: job?.step === 'login' ? 'Esperando' : 'Subindo', sub: job?.step === 'login' ? 'sobe quando o login terminar' : job?.step === 'read' ? 'lendo a máquina' : 'rodando o comando de subir' };
  else if (c.state === 'stopped') tunnel = { tone: 'off', icon: 'pause', value: 'Parado por você', sub: `${c.since ? `às ${hm(c.since)} · ` : ''}quedas não avisam` };
  else tunnel = { tone: 'bad', icon: 'error', value: 'Fora', sub: [c.since ? `desde ${hm(c.since)}` : null, n ? null : 'nenhum processo ssh'].filter(Boolean).join(' · ') };

  let core;
  const read = reading?.takenAt ?? null;
  if (machine?.state === 'connected') core = { tone: 'ok', icon: 'activity', value: 'Respondendo', sub: read ? `lido ${ago(read, now)}` : 'sem leitura ainda' };
  else if (machine?.state === 'incompatible-version') core = { tone: 'warn', icon: 'git-compare', value: 'Versão diferente', sub: 'responde, com outra telemetria' };
  else if (machine?.state === 'unreachable' && machine.reason === 'owner-auth-required') core = { tone: 'warn', icon: 'server-off', value: 'Acesso bloqueado', sub: 'autenticação do dono necessária' };
  else if (machine?.state === 'unreachable' && machine.reason === 'no-response') core = { tone: 'warn', icon: 'server-off', value: 'Não responde', sub: 'a porta aceita, ninguém responde' };
  else core = { tone: 'off', icon: 'circle-dashed', value: 'Sem leitura', sub: read ? `a última é de ${hm(read)}` : 'nenhuma leitura guardada' };

  return [
    { key: 'tunnel', label: 'Túnel', ...tunnel },
    { key: 'cloud', label: c.cloud ? 'Sessão AWS' : 'Sessão de nuvem', ...cloudCell(c, job, now) },
    { key: 'core', label: 'Núcleo de lá', ...core },
  ];
}

function cloudCell(c, job, now) {
  const cl = c.cloud;
  if (!cl) return { tone: 'off', icon: 'circle-dashed', value: 'Nenhuma', sub: 'sem cloudProfile no machines.json' };
  const p = cl.profile;
  if (job?.step === 'login') return { tone: 'warn', icon: 'wall-loader', value: 'Entrando…', sub: `${p} · no navegador deste Mac` };
  switch (cl.state) {
    case 'valid':
      return { tone: 'ok', icon: 'key', value: cl.expiresAt ? `Válida até ${whenText(cl.expiresAt, now)}` : 'Válida', sub: cl.expiresAt ? `${p} · faltam ${timeLeft(cl.expiresAt, now)}` : p };
    case 'expiring':
      return { tone: 'warn', icon: 'alert', value: cl.expiresAt ? `Expira em ${timeLeft(cl.expiresAt, now)}` : 'Expira logo', sub: `${p} · o túnel cai junto` };
    case 'expired': {
      const since = sinceText(cl.expiresAt, now);
      return { tone: 'bad', icon: 'key', value: since && since !== 'agora' ? `Expirada há ${since}` : 'Expirada', sub: cl.expiresAt ? `${p} · expirou às ${hm(cl.expiresAt)}` : p };
    }
    case 'never':
      return { tone: 'off', icon: 'key', value: 'Nunca entrou', sub: `${p} · sem login neste Mac` };
    case 'not-found':
      return { tone: 'bad', icon: 'file-warning', value: 'Perfil não achado', sub: `${p} não está no ~/.aws/config deste Mac` };
    case 'unavailable':
      return { tone: 'off', icon: 'circle-dashed', value: 'Sem o conector', sub: `${p} · o conector AWS não roda neste núcleo` };
    default:
      return { tone: 'off', icon: 'question', value: 'Desconhecida', sub: `${p} · a aws não disse` };
  }
}

/** The ports of the tunnel with what each one is (the pill comes from machine-format's TUNNEL_PORT_STATE). */
export function connectionPorts(connection, machine, remotePorts = null) {
  return connection.ports.map((p) => {
    let what;
    if (p.state === 'idle') what = `nada escuta na ${p.remotePort} de lá`;
    else if (p.state === 'busy') what = `${p.heldBy ?? 'outro processo'}, deste Mac, segura a ${p.localPort}`;
    else if (p.state === 'down') what = 'nada escuta nesta porta do Mac';
    else if (machine && p.localPort === machine.port) what = `Núcleo da ${machine.label}`;
    else what = remotePorts?.find((x) => x.port === p.remotePort)?.process ?? DASH;
    return { ...p, what, muted: p.state !== 'up' };
  });
}

/** The mono lines at the foot of the card: what runs, and the cloud profile it depends on. */
export function commandLines(connection) {
  const c = connection.command;
  const out = [];
  if (c) out.push(`subir: ${c.start.join(' ')}`);
  if (c?.stop) out.push(`parar: ${c.stop.join(' ')}`);
  if (connection.cloud) out.push(`nuvem: aws · ${connection.cloud.profile}${connection.cloud.session ? ` (${connection.cloud.session})` : ''}`);
  return out;
}

/** The buttons in the card's title: `up` has Reconectar and Parar (with a stop command), `stopped` has Subir. */
export function cardActions(connection) {
  const a = connection.actions;
  if (connection.state === 'up') return [a.reconnect ? 'reconnect' : null, a.stop ? 'stop' : null].filter(Boolean);
  if (connection.state === 'stopped') return a.start ? ['start'] : [];
  return [];
}

// ---------- the bands ----------

const STEP_LABEL = { login: 'entrando na AWS', stop: 'parando o túnel', start: 'subindo o túnel' };

/** The steps of a running job, `[{ label, at: 'done' | 'on' | 'next' }]`. */
export function jobSteps(job, label) {
  const at = job.steps.indexOf(job.step);
  return job.steps.map((s, i) => ({ label: s === 'read' ? `lendo a ${label}` : STEP_LABEL[s], at: i < at ? 'done' : i === at ? 'on' : 'next' }));
}

/** The running step's clock: `{ elapsed, limit, seconds, max }` (`limit` and `max` null without a timeout). */
export function stepClock(job, now = Date.now()) {
  const start = Date.parse(job?.stepStartedAt ?? job?.startedAt ?? '');
  const max = job?.stepTimeoutSeconds ?? null;
  let seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  if (max) seconds = Math.min(seconds, max);
  return { elapsed: clockOf(seconds * 1000), limit: max ? clockOf(max * 1000) : null, seconds, max };
}

/** The login command the AWS connector runs, said on screen: the fixed template with the session name. */
export const loginLine = (session) => `aws sso login --sso-session ${session}`;

const until = (s) => (s ? ` · até ${spanText(s * 1000)}` : '');

/** The band of a running job (C64): `{ title, text, command }`. */
export function jobBand(connection, label, now = Date.now()) {
  const job = connection.job;
  const c = connection.command;
  if (job.step === 'login') {
    const session = connection.cloud?.session;
    return { title: 'Entrando na AWS…', text: 'aguardando o login no navegador. Quando terminar, o console sobe o túnel sozinho.', command: session ? `Roda: ${loginLine(session)}${until(job.stepTimeoutSeconds)}` : null };
  }
  if (job.step === 'stop') {
    const reconnect = job.kind === 'reconnect';
    return { title: reconnect ? 'Reconectando…' : 'Parando o túnel…', text: reconnect ? 'primeiro roda o comando de parar, depois o de subir.' : 'roda o comando de parar.', command: c?.stop ? `Roda: ${c.stop.join(' ')}${until(job.stepTimeoutSeconds)}` : null };
  }
  if (job.step === 'start') {
    const cl = connection.cloud;
    const valid = cl && (cl.state === 'valid' || cl.state === 'expiring') && cl.expiresAt ? `a sessão AWS vale até ${whenText(cl.expiresAt, now)}; agora roda` : 'roda';
    return { title: job.kind === 'reconnect' ? 'Reconectando…' : 'Subindo o túnel…', text: `${valid} o comando de subir.`, command: c ? `Roda: ${c.start.join(' ')}${until(job.stepTimeoutSeconds ?? c.startTimeoutSeconds)}` : null };
  }
  return { title: job.kind === 'stop' ? 'Parando o túnel…' : 'Quase lá…', text: `lendo a ${label} agora.`, command: null };
}

/**
 * The band of a down connection's reason (C63, C65): `{ kind, tone, icon, title, text, from, command?, actions }`,
 * with where the reason came from. `actions` are ids the screen turns into buttons.
 */
export function reasonBand(connection, machine, reading, now = Date.now()) {
  const e = connection.lastError;
  const label = machine?.label ?? 'máquina';
  const p = machine?.port;
  const fromLog = 'de um padrão conhecido no log desta execução';
  switch (e?.reason) {
    case 'sso-expired': {
      const cl = connection.cloud;
      const since = sinceText(cl?.expiresAt, now);
      const dropped = reading?.takenAt ?? connection.since;
      const session = cl?.session;
      const what = session ? `A sessão ${session}, que o ${cl.profile} usa,` : 'A sessão AWS que o túnel usa';
      const when = cl?.expiresAt ? ` expirou às ${hm(cl.expiresAt)}` : ' expirou';
      const start = connection.command?.start.join(' ');
      return {
        kind: 'sso-expired',
        tone: 'error',
        icon: 'key',
        title: since && since !== 'agora' && cl?.state === 'expired' ? `Túnel fora · SSO expirado há ${since}.` : 'Túnel fora · SSO expirado.',
        text: `${what}${when}${dropped ? `, e o túnel caiu às ${hm(dropped)}` : ''}. Entre na AWS e o console sobe o túnel em seguida.`,
        from: cl?.state === 'expired' ? `do estado do ${cl.profile} no conector AWS` : fromLog,
        command: session && start ? `Roda: ${loginLine(session)}, depois ${start}` : null,
        actions: ['only-login', 'login-and-start'],
      };
    }
    case 'port-busy':
      return {
        kind: 'port-busy',
        tone: 'error',
        icon: 'plug',
        title: p ? `Porta ${p} ocupada no Mac.` : 'Porta ocupada no Mac.',
        text: `${e.holder ? `O ${e.holder}` : 'Outro processo'} deste Mac segura a porta que o túnel usa; o encaminhamento não sobe.`,
        from: e.holder || e.exitCode === null ? 'da sonda da porta' : fromLog,
        actions: ['see-local', 'start'],
      };
    case 'core-not-answering':
      return {
        kind: 'core-not-answering',
        tone: 'waiting',
        icon: 'server-off',
        title: 'Túnel no ar, núcleo de lá parado.',
        text: `${p ? `A porta ${p}` : 'A porta'} aceita a conexão e ninguém responde. Suba o núcleo na ${label}.`,
        from: 'da sonda da porta (o mesmo caso da C26)',
        actions: ['retry'],
      };
    case 'ssm-agent-offline':
      return {
        kind: 'ssm-agent-offline',
        tone: 'error',
        icon: 'radio-tower',
        title: `Agente SSM da ${label} offline.`,
        text: 'A AWS diz que a máquina não está conectada ao SSM: ela pode estar desligada, parada ou sem rede. Ligue-a pelo console do provedor e tente de novo.',
        from: `${fromLog} (alvo não conectado)`,
        actions: ['start'],
      };
    case 'host-unknown':
      return { kind: 'host-unknown', tone: 'error', icon: 'question', title: 'Host desconhecido no ~/.ssh/config.', text: 'O ssh não achou o apelido que o seu comando usa. Confira o ~/.ssh/config deste Mac.', from: fromLog, actions: ['start'] };
    case 'key-refused':
      return { kind: 'key-refused', tone: 'error', icon: 'key', title: 'Chave SSH recusada.', text: `A ${label} recusou a chave deste Mac.`, from: fromLog, actions: ['start'] };
    case 'exit-code': {
      const timedOut = connection.job?.state === 'timed-out' && connection.job.step === 'start';
      const limit = connection.command?.startTimeoutSeconds;
      const title = timedOut ? `O comando passou de ${limit ? spanText(limit * 1000) : 'o tempo limite'} e foi encerrado.` : e.exitCode !== null ? `O comando saiu com o código ${e.exitCode}.` : 'O comando terminou sem código de saída.';
      return {
        kind: 'exit-code',
        tone: 'error',
        icon: 'error',
        title,
        text: `Nenhum motivo conhecido apareceu. ${connection.logFile ? `A saída ficou no log da instalação: ${connection.logFile}` : 'A saída ficou no reconnect.log da instalação.'}`,
        from: 'nenhum padrão reconheceu a saída',
        actions: ['start'],
      };
    }
    default:
      return null;
  }
}

/** The band of a connection that is down with no reason the core could name. */
export function downBand(connection, machine, reading, now = Date.now()) {
  const label = machine?.label ?? 'máquina';
  const p = machine?.port ? `A porta ${machine.port} deste Mac não aceita conexão: o túnel parece caído.` : 'O túnel parece caído.';
  const last = reading?.takenAt ? ` Abaixo, a última leitura, de ${hm(reading.takenAt)} (${ago(reading.takenAt, now)}).` : '';
  return { kind: 'down', tone: 'error', icon: 'offline', title: `Sem conexão com a ${label}.`, text: `${p}${last} Tentamos de novo a cada 30 s.`, from: null, command: connection.command ? `Subir roda: ${connection.command.start.join(' ')}` : null, actions: ['retry', 'start'] };
}

/** The warning before the drop (C65): the linked session expires in 15 min or less while the tunnel is up. */
export function expiringWarning(connection, machine, now = Date.now()) {
  const cl = connection.cloud;
  if (connection.state !== 'up' || cl?.state !== 'expiring') return null;
  const left = cl.expiresAt ? timeLeft(cl.expiresAt, now) : null;
  return {
    title: left ? `A sessão AWS expira em ${left}.` : 'A sessão AWS está para expirar.',
    text: `O túnel da ${machine?.label ?? 'máquina'} cai junto. Entre agora e ele continua no ar.`,
    from: `do estado do ${cl.profile} no conector AWS`,
  };
}

/** The stopped band (C64 4). */
export function stoppedBand(connection, machine) {
  const at = connection.since ? ` às ${hm(connection.since)}` : '';
  return { title: `Túnel parado por você${at}.`, text: `A ${machine?.label ?? 'máquina'} não some: a última leitura fica embaixo, e não avisamos queda até você subir de novo.` };
}

/** The Parar confirmation (C64 3). */
export function stopDialog(connection, machine) {
  const n = connection.ports.length;
  const label = machine?.label ?? 'máquina';
  const ports = n ? `${n === 1 ? 'A porta para' : `As ${n} portas param`} de encaminhar para este Mac.` : 'O túnel deixa de encaminhar para este Mac.';
  const stop = connection.command?.stop;
  return {
    title: `Parar o túnel da ${label}?`,
    text: `${ports} As sessões do Claude lá continuam rodando, mas você perde a vista delas daqui até subir de novo.`,
    command: stop ? `Roda: ${stop.join(' ')}${until(connection.command.stopTimeoutSeconds)}` : null,
  };
}

/** A job that ended a moment ago without bringing the tunnel up, in one sentence, or `null`. */
export function endedJobNote(connection, now = Date.now()) {
  const j = connection.job;
  if (!j || j.state === 'running' || j.state === 'succeeded' || connection.state === 'up' || connection.state === 'stopped') return null;
  const end = Date.parse(j.endedAt ?? '');
  if (!Number.isFinite(end) || now - end > RECENT_JOB_MS) return null;
  const at = hm(j.endedAt);
  if (j.state === 'canceled') return `Você cancelou${j.step === 'login' ? ' o login' : ''} às ${at}.`;
  if (j.step === 'login') return j.state === 'timed-out' ? `O login não terminou a tempo (às ${at}); o túnel não rodou.` : `O login não terminou (às ${at}); o túnel não rodou.`;
  return null;
}

// ---------- "Onde roda" ----------

const KIND_LABEL = { 'managed-instance': 'Instância gerenciada (SSM)' };
const SOURCE_LABEL = {
  'instance-metadata': 'metadados da instância',
  'ssm-registration': 'registro do agente SSM (sem metadados de instância nesta máquina)',
  dmi: 'DMI da máquina (sem metadados de instância nem registro do agente SSM)',
};

/**
 * The "Onde roda" card: `{ known, fields: [{ key, label, value, mono }], source }`. `stale` when the
 * reading is the last one kept (the tunnel is down); `hasReading` false before any reading from there.
 */
export function placementView(placement, { stale = false, hasReading = true } = {}) {
  const known = Boolean(placement && placement.provider !== 'unknown');
  const p = placement ?? {};
  const fields = [
    { key: 'provider', label: 'Provedor', value: known ? PROVIDER_LABEL[p.provider] : 'desconhecido', mono: false },
    { key: 'kind', label: 'Tipo', value: known && p.kind ? (KIND_LABEL[p.kind] ?? p.kind) : 'desconhecido', mono: false },
    { key: 'region', label: 'Região', value: known && p.region ? (p.zone && p.zone !== p.region ? `${p.region} · ${p.zone}` : p.region) : 'desconhecida', mono: false },
    { key: 'id', label: 'Id', value: known && p.instanceId ? p.instanceId : DASH, mono: true },
  ];
  let source;
  if (!hasReading) source = 'Ainda não há leitura de lá.';
  else if (!placement) source = 'O núcleo de lá não diz onde roda: é de uma versão anterior.';
  else if (!known || !p.source) source = 'Nem metadados de instância, nem registro do agente SSM, nem DMI: não chutamos.';
  else {
    const at = hm(p.readAt);
    source = `Fonte: ${SOURCE_LABEL[p.source]}${at ? (stale ? ` · da última leitura, às ${at}` : ` · lido às ${at}`) : ''}`;
  }
  return { known, fields, source };
}

/** The `connection` example of the setup card (C65), for this machine, with a generic script and profile. */
export function connectionExample(machine) {
  const port = machine?.port ? `, "port": ${machine.port}` : '';
  return [
    '~/.ahrena-console/machines.json',
    `{ "machines": [ { "id": ${JSON.stringify(machine?.id ?? 'workstation')}, "label": ${JSON.stringify(machine?.label ?? 'Workstation')}${port},`,
    '    "connection": {',
    '      "start": { "command": ["/caminho/para/conectar.sh", "tunnel", "start"], "timeoutSeconds": 180 },',
    '      "stop":  { "command": ["/caminho/para/conectar.sh", "tunnel", "stop"] },',
    '      "cloudProfile": { "connector": "aws", "profile": "perfil-dev" } } } ] }',
  ].join('\n');
}

/** What each action is called in a sentence ("Não deu para subir o túnel"). */
export const ACTION_WORDS = { start: 'subir o túnel', stop: 'parar o túnel', reconnect: 'reconectar', 'login-and-start': 'entrar na AWS e subir o túnel', cancel: 'cancelar', 'only-login': 'entrar na AWS' };

/** A refused write, in pt-BR: the core's own sentence (it says what to fix), or why nothing answered. */
export function writeProblem(e, action) {
  const what = ACTION_WORDS[action] ?? 'fazer isso';
  if (e?.status === 403) return `Não deu para ${what}: o núcleo só aceita esse pedido a partir desta janela.`;
  if (!e?.status) return `Não deu para ${what}: o núcleo não respondeu.`;
  const why = String(e?.body?.error || e?.message || `o núcleo respondeu ${e.status}`).replace(/\.$/, '');
  return `Não deu para ${what}: ${why}.`;
}
