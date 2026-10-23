// The cloud connectors' formats (issue 277, decision 0013, wireframes C57 to C61, C66 and C67), without DOM:
// the test imports this file directly.
//
// - The core answers `GET /api/connectors` (this Mac) and `GET /api/machines/<id>/connectors` (a remote,
//   read by this Mac's core through the tunnel). A core without those routes answers 404: the screens
//   then hide every cloud part (`normalizeConnectors` gives `null` for anything that is not a list).
// - What each pill, line, band and sidebar dot says, in pt-BR, comes from here.
// - Nothing typed on screen goes to the core: the writes take the session name the core itself sent,
//   and only when it can go on a command line (`SAFE_NAME`, the same rule as the core's).

import { ago, clockOf, clockTime } from './machine-format.js';

export const CONNECTORS_ROUTE = '/api/connectors';
export const LOCAL_ID = 'local';
/** A remote machine's connectors are polled: there are no change events for remote machines. */
export const REMOTE_POLL_MS = 30_000;
/** While a login runs, the screen re-reads sooner (a remote's device code shows up a moment after Entrar). */
export const RUNNING_POLL_MS = 3_000;
/** How long the "entrou" or "não terminou" band stays after a login ends. */
export const RECENT_LOGIN_MS = 10 * 60_000;

// The core's rule for a name that goes on a command line (src/clouds/aws-config.ts `SAFE_CLI_NAME`).
export const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SESSION_STATES = ['valid', 'expiring', 'expired', 'never', 'unknown'];
const CONNECTOR_STATES = ['missing-cli', 'unsupported-cli', 'not-configured', ...SESSION_STATES];
const LOGIN_STATES = ['idle', 'running', 'succeeded', 'failed', 'timed-out', 'canceled'];
const ENDED = new Set(['succeeded', 'failed', 'timed-out', 'canceled']);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const iso = (v) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const oneOf = (v, list) => (list.includes(v) ? v : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- routes ----------

export const isRemoteId = (id) => typeof id === 'string' && MACHINE_ID.test(id) && id !== LOCAL_ID;
export const remoteConnectorsRoute = (id) => `/api/machines/${id}/connectors`;

/** The login route of a session on a machine, or `null` when the name or the id cannot go in a path. */
export function loginRoute(machineId, name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) return null;
  if (machineId === LOCAL_ID || machineId == null) return `${CONNECTORS_ROUTE}/aws/sessions/${name}/login`;
  return isRemoteId(machineId) ? `/api/machines/${machineId}/connectors/aws/sessions/${name}/login` : null;
}

/** The AWS detail screen, for this Mac or a remote machine. */
export const awsScreenRoute = (machineId = LOCAL_ID) => (isRemoteId(machineId) ? `/ui/connections/aws?machine=${machineId}` : '/ui/connections/aws');

/** `?machine=<id>` of the AWS screen; anything else is this Mac. */
export function machineFromSearch(search) {
  const id = new URLSearchParams(search ?? '').get('machine');
  return isRemoteId(id) ? id : LOCAL_ID;
}

// ---------- shape checks ----------

function normalizeLogin(v) {
  if (!isObject(v)) return { state: 'idle', mode: null, startedAt: null, endedAt: null, timeoutSeconds: null, exitCode: null, logFile: null, deviceCode: null };
  const state = oneOf(v.state, LOGIN_STATES) ?? 'idle';
  let deviceCode = null;
  if (state === 'running' && isObject(v.deviceCode)) {
    const link = verificationLink(v.deviceCode.verificationUri);
    const code = typeof v.deviceCode.userCode === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(v.deviceCode.userCode) ? v.deviceCode.userCode : null;
    if (link && code) deviceCode = { verificationUri: link, userCode: code, expiresAt: iso(v.deviceCode.expiresAt) };
  }
  const timeout = int(v.timeoutSeconds);
  return {
    state,
    mode: oneOf(v.mode, ['browser', 'device-code']),
    startedAt: iso(v.startedAt),
    endedAt: iso(v.endedAt),
    timeoutSeconds: timeout && timeout > 0 && timeout <= 3600 ? timeout : null,
    exitCode: int(v.exitCode),
    logFile: str(v.logFile, 512),
    deviceCode,
  };
}

function normalizeSession(s) {
  if (!isObject(s) || !str(s.name, 128)) return null;
  const profiles = (Array.isArray(s.profiles) ? s.profiles.slice(0, 100) : []).filter((p) => isObject(p) && str(p.name, 128));
  return {
    name: s.name.slice(0, 128),
    kind: s.kind === 'legacy' ? 'legacy' : 'sso-session',
    startUrlHost: str(s.startUrlHost, 253),
    region: str(s.region, 64),
    loginSupported: s.loginSupported === true && SAFE_NAME.test(s.name),
    state: oneOf(s.state, SESSION_STATES) ?? 'unknown',
    expiresAt: iso(s.expiresAt),
    checkedAt: iso(s.checkedAt),
    profiles: profiles.map((p) => ({ name: p.name.slice(0, 128), accountId: str(p.accountId, 32), roleName: str(p.roleName, 128), region: str(p.region, 64) })),
    login: normalizeLogin(s.login),
  };
}

function normalizeAws(c) {
  const cli = isObject(c.cli) ? c.cli : {};
  const file = isObject(c.configFile) ? c.configFile : {};
  const fileStatus = oneOf(file.status, ['ok', 'missing', 'error']) ?? 'ok';
  return {
    kind: 'aws',
    state: oneOf(c.state, CONNECTOR_STATES) ?? 'unknown',
    cli: { found: cli.found === true, version: int(cli.version), deviceCodeSupported: cli.deviceCodeSupported === true },
    configFile: { status: fileStatus, error: fileStatus === 'error' && isObject(file.error) ? { line: int(file.error.line), message: str(file.error.message) } : null },
    sessions: (Array.isArray(c.sessions) ? c.sessions.slice(0, 100) : []).map(normalizeSession).filter(Boolean),
    outOfScope: (Array.isArray(c.outOfScope) ? c.outOfScope.slice(0, 100) : []).filter((p) => isObject(p) && str(p.name, 128)).map((p) => ({ name: p.name.slice(0, 128), reason: p.reason === 'missing-sso-session' ? 'missing-sso-session' : 'no-sso' })),
  };
}

/** `{ aws, soon }` from a `{ connectors }` answer (`aws` may be `null`), or `null` when it is not one. */
export function normalizeConnectors(body) {
  if (!isObject(body) || !Array.isArray(body.connectors)) return null;
  let aws = null;
  const soon = [];
  for (const c of body.connectors.slice(0, 10)) {
    if (!isObject(c)) continue;
    if (c.kind === 'aws' && !aws) aws = normalizeAws(c);
    else if ((c.kind === 'gcp' || c.kind === 'azure') && !soon.includes(c.kind)) soon.push(c.kind);
  }
  return { aws, soon };
}

/** A remote machine's answer: `{ status: 'ok' | 'unreachable' | 'unsupported', connectors }`, or `null`. */
export function normalizeRemote(body) {
  if (!isObject(body)) return null;
  const status = oneOf(body.status, ['ok', 'unreachable', 'unsupported']);
  if (!status) return null;
  return { status, connectors: status === 'ok' ? normalizeConnectors(body) : null };
}

// ---------- times ----------

/** "14 min", "7 h 12 min", "2 dias" between now and a later time; `null` without one. */
export function timeLeft(isoTime, now = Date.now()) {
  const t = Date.parse(isoTime ?? '');
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((t - now) / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
  const d = Math.floor(m / (24 * 60));
  return `${d} ${d === 1 ? 'dia' : 'dias'}`;
}

/** "5 h" since an earlier time ("há" left out, for "Expirada há 5 h"); `null` without one. */
const since = (isoTime, now) => {
  const a = ago(isoTime, now);
  return a ? a.replace(/^há /, '') : null;
};

/** "18:40" today, "amanhã 09:00", or "23/10 09:00". */
export function whenText(isoTime, now = Date.now()) {
  const t = Date.parse(isoTime ?? '');
  if (!Number.isFinite(t)) return null;
  const day = (ms) => new Date(ms).toDateString();
  const clock = clockTime(isoTime);
  if (day(t) === day(now)) return clock;
  if (day(t) === day(now + 86_400_000)) return `amanhã ${clock}`;
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${clock}`;
}

// ---------- session and connector pills ----------

/** The pill of a session: `{ tone, label }`, tone a `b-*` seal. A running login wins. */
export function sessionPill(session, now = Date.now()) {
  if (session?.login?.state === 'running') return { tone: 'b-waiting', label: 'Entrando…' };
  const s = session?.state;
  if (s === 'valid') return { tone: 'b-completed', label: session.expiresAt ? `Válida até ${whenText(session.expiresAt, now)}` : 'Válida' };
  if (s === 'expiring') return { tone: 'b-waiting', label: session.expiresAt ? `Expira em ${timeLeft(session.expiresAt, now)}` : 'Expira logo' };
  if (s === 'expired') {
    const t = since(session.expiresAt, now);
    return { tone: 'b-error', label: t && t !== 'agora' ? `Expirada há ${t}` : 'Expirada' };
  }
  if (s === 'never') return { tone: 'b-abandoned', label: 'Nunca entrou' };
  return { tone: 'b-abandoned', label: 'Desconhecida' };
}

/** "Entrar" for a session that needs a login, "Entrar de novo" for a valid one. */
export const loginLabel = (session) => (session?.state === 'valid' || session?.state === 'expiring' ? (session.state === 'expiring' ? 'Entrar' : 'Entrar de novo') : 'Entrar');

/** Whether the screen offers Entrar for a session: a safe name and a file and CLI that allow it. */
export function canLogin(aws, session) {
  if (!aws || !session?.loginSupported) return false;
  if (aws.configFile.status === 'error') return false;
  if (!aws.cli.found || (aws.cli.version !== null && aws.cli.version < 2)) return false;
  return true;
}

const count = (aws, state) => aws.sessions.filter((s) => s.state === state).length;

/** The connector's pill on its catalog card and on the AWS header. */
export function connectorPill(aws, now = Date.now()) {
  if (!aws) return { tone: 'b-abandoned', label: 'Não configurada' };
  switch (aws.state) {
    case 'missing-cli':
      return { tone: 'b-waiting', label: 'aws CLI não encontrada' };
    case 'unsupported-cli':
      return { tone: 'b-waiting', label: 'aws CLI v1' };
    case 'not-configured':
      return { tone: 'b-abandoned', label: 'Não configurada' };
    case 'expired': {
      const n = count(aws, 'expired');
      return { tone: 'b-error', label: n === 1 ? '1 sessão expirada' : `${n} sessões expiradas` };
    }
    case 'expiring': {
      const first = aws.sessions.filter((s) => s.state === 'expiring').map((s) => s.expiresAt).filter(Boolean).sort()[0];
      const n = count(aws, 'expiring');
      return { tone: 'b-waiting', label: first ? `${n} expira em ${timeLeft(first, now)}` : `${n} expirando` };
    }
    case 'unknown':
      return { tone: 'b-abandoned', label: 'Estado desconhecido' };
    case 'never':
      return { tone: 'b-abandoned', label: aws.sessions.length === 1 ? 'Nunca entrou' : 'Sem login ainda' };
    default:
      return { tone: 'b-completed', label: 'Sessões válidas' };
  }
}

/** Whether the AWS card goes under "Conectadas" (it has sessions) or "Adicionar uma conexão". */
export const awsConnected = (aws) => Boolean(aws && aws.sessions.length && !['missing-cli', 'unsupported-cli', 'not-configured'].includes(aws.state));

/** The two lines of the AWS catalog card (C57, C60). Strings; `{ strong }` parts in bold. */
export function awsCardLines(aws, now = Date.now()) {
  if (!aws || aws.state === 'not-configured') {
    return [
      [aws?.cli.found ? 'Achamos a aws CLI v2 no PATH do login, mas o ~/.aws/config não tem nenhum perfil com SSO.' : 'O ~/.aws/config desta máquina não tem nenhum perfil com SSO.'],
      ['Para criar um, no terminal: ', { mono: 'aws configure sso' }, '. O console relê o arquivo sozinho e o card sobe para Conectadas.'],
    ];
  }
  if (aws.state === 'missing-cli') return [['O PATH do shell de login não tem a aws. Instale a v2 e o console acha sozinho.'], [{ mono: 'brew install awscli' }]];
  if (aws.state === 'unsupported-cli') return [['A v1 não tem o login do IAM Identity Center. Atualize para a v2; até lá, os perfis aparecem sem estado.']];
  const sso = aws.sessions.length;
  const profiles = aws.sessions.reduce((n, s) => n + s.profiles.length, 0) + aws.outOfScope.length;
  const first = [{ strong: plural(sso, 'sessão SSO', 'sessões SSO') }, ` · ${plural(profiles, 'perfil lido', 'perfis lidos')} do ~/.aws/config`];
  const expired = aws.sessions.filter((s) => s.state === 'expired');
  const expiring = aws.sessions.filter((s) => s.state === 'expiring');
  const valid = aws.sessions.filter((s) => s.state === 'valid');
  let second;
  if (expired.length) second = [expired.length === 1 ? `${expired[0].name} expirou${expired[0].expiresAt ? ` às ${clockTime(expired[0].expiresAt)}` : ''}` : `${list(expired.map((s) => s.name))} expiraram`];
  else if (expiring.length) second = [`${expiring[0].name} expira em ${timeLeft(expiring[0].expiresAt, now) ?? 'pouco'}`];
  else if (valid.length === aws.sessions.length) second = [`${list(valid.map((s) => s.name))} ${valid.length === 1 ? 'válida' : 'válidas'}`];
  else second = [`${list(aws.sessions.filter((s) => s.state === 'never').map((s) => s.name)) || 'Uma sessão'} sem login ainda`];
  if (aws.configFile.status === 'error') second = [`O ~/.aws/config tem um erro${aws.configFile.error?.line ? ` na linha ${aws.configFile.error.line}` : ''}`];
  return [first, second];
}

const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`);

/** The mono line at the foot of the AWS card: "aws-cli 2 · PATH do login". */
export function cliLine(aws) {
  if (!aws?.cli.found) return 'aws CLI fora do PATH do login';
  return `aws-cli ${aws.cli.version ?? '?'}.x · PATH do login`;
}

/** The sidebar dot of Conexões: the worst cloud connector, `{ state, label }`; `null` without the routes. */
export function connectorsDot(body) {
  const c = normalizeConnectors(body);
  if (!c) return null;
  const aws = c.aws;
  if (!aws || ['not-configured', 'missing-cli', 'unsupported-cli', 'never'].includes(aws.state)) return { state: 'cloud-none', label: aws?.state === 'never' ? 'Nuvem sem login ainda' : 'Nenhuma nuvem conectada' };
  if (aws.state === 'expired') return { state: 'cloud-error', label: connectorPill(aws).label.replace(/^1 sessão/, 'AWS · 1 sessão').replace(/^(\d+) sessões/, 'AWS · $1 sessões') };
  if (aws.state === 'expiring') return { state: 'cloud-warn', label: `AWS · ${connectorPill(aws).label}` };
  if (aws.state === 'unknown') return { state: 'cloud-warn', label: 'AWS · estado desconhecido' };
  return { state: 'cloud-ok', label: 'AWS · sessões válidas' };
}

// ---------- the login ----------

/** The band a session shows: `'running'`, a recent end (`'succeeded'`, `'failed'`, `'timed-out'`, `'canceled'`), or `null`. */
export function loginBand(session, now = Date.now()) {
  const l = session?.login;
  if (!l) return null;
  if (l.state === 'running') return 'running';
  if (!ENDED.has(l.state)) return null;
  const end = Date.parse(l.endedAt ?? '');
  if (!Number.isFinite(end) || now - end > RECENT_LOGIN_MS) return null;
  // A failure the session already got past (another login made it valid) says nothing any more.
  if (l.state !== 'succeeded' && session.state === 'valid') return null;
  return l.state;
}

/** The running clock against the limit: `{ elapsed: "0:48", limit: "5:00", seconds, max }`. */
export function loginClock(login, now = Date.now()) {
  const start = Date.parse(login?.startedAt ?? '');
  const max = login?.timeoutSeconds ?? 300;
  const seconds = Number.isFinite(start) ? Math.min(max, Math.max(0, Math.floor((now - start) / 1000))) : 0;
  return { elapsed: clockOf(seconds * 1000), limit: clockOf(max * 1000), seconds, max };
}

/** What the core runs, said on screen (never run from here): the fixed template with the session name. */
export function loginCommand(session, mode = 'browser') {
  const target = session?.kind === 'legacy' ? `--profile ${session.name}` : `--sso-session ${session?.name ?? ''}`;
  return `aws sso login ${target}${mode === 'device-code' ? ' --use-device-code --no-browser' : ''}`;
}

/** The command for a terminal over there when the remote core cannot log in by itself (C67 state 4). */
export function fallbackCommand(session) {
  const target = session?.kind === 'legacy' ? `--profile ${session.name}` : `--sso-session ${session?.name ?? ''}`;
  return `aws sso login ${target} --use-device-code`;
}

const AWS_HOST = /(^|\.)(awsapps\.com|amazonaws\.com|aws)$/i;

/** The device code's page: https on an AWS host, no credentials in the URL; the URL or `null`. */
export function verificationLink(uri) {
  if (typeof uri !== 'string' || uri.length > 512) return null;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !AWS_HOST.test(u.hostname)) return null;
  return u.href;
}

/** "o código vale mais 9 min", from the device code's `expiresAt`. */
export function deviceCodeLeft(deviceCode, now = Date.now()) {
  const left = timeLeft(deviceCode?.expiresAt, now);
  return left ? `o código vale mais ${left}` : null;
}

/** The ended-login band text: `{ title, text }`. `where` names a remote machine, or `null` for this Mac. */
export function endedText(kind, session, { where = null, now = Date.now() } = {}) {
  const l = session.login;
  const profiles = session.profiles.length;
  if (kind === 'succeeded') {
    const at = l.endedAt ? clockTime(l.endedAt) : null;
    const until = session.state === 'valid' && session.expiresAt ? whenText(session.expiresAt, now) : null;
    if (where) return { title: `A ${where} entrou na AWS${at ? ` às ${at}` : ''}.`, text: `${until ? `A sessão de lá vale até ${until}. ` : ''}A credencial ficou na aws CLI de lá; nada passou por este Mac.` };
    return { title: `Entrou${at ? ` às ${at}` : ''}.`, text: until ? `A sessão vale até ${until}, para ${profiles === 1 ? 'o perfil' : `os ${profiles} perfis`}.` : `A sessão vale para ${profiles === 1 ? 'o perfil' : `os ${profiles} perfis`} desta sessão.` };
  }
  const still = session.state === 'expired' ? ' A sessão continua expirada.' : '';
  const mins = Math.round((l.timeoutSeconds ?? 300) / 60);
  if (kind === 'timed-out') return { title: 'O login não terminou.', text: `Passou de ${mins} min sem resposta do navegador e o console encerrou a aws CLI.${still}` };
  if (kind === 'canceled') return { title: 'O login foi cancelado.', text: `O console encerrou a aws CLI; a página no navegador, se ficou aberta, não vale mais.${still}` };
  return { title: 'O login não terminou.', text: `A aws CLI saiu${l.exitCode !== null ? ` com o código ${l.exitCode}` : ' com erro'}.${still}` };
}

/** A write refused by the core, in pt-BR. */
export function writeErrorText(e) {
  if (e?.status === 502) return e?.body?.reason === 'unreachable' ? 'A máquina não respondeu. Confira o túnel e tente de novo.' : 'A máquina respondeu algo que o console não entende.';
  if (e?.status === 403) return 'O núcleo recusou o pedido: ele só aceita Entrar a partir desta janela.';
  if (e?.status === 0 || !e?.status) return 'O núcleo não respondeu.';
  return e?.body?.error || e?.message || `O núcleo respondeu ${e.status}.`;
}

/** A remote core without the login route (404 without `reason`), or a CLI there without the device code. */
export const isFallback = (e) => (e?.status === 404 && !e?.body?.reason) || (e?.status === 409 && e?.body?.reason === 'device-code-unsupported');

// ---------- the AWS screen ----------

/** The cards of the states that are not the happy path (C60), in order: `{ id, icon, tone, title, text, code? }`. */
export function awsProblems(aws) {
  if (!aws) return [];
  const out = [];
  if (!aws.cli.found) out.push({ id: 'missing-cli', icon: 'terminal', tone: 'waiting', title: 'aws CLI não encontrada', text: 'O PATH do shell de login não tem a aws. Instale a v2 e o console acha sozinho.', code: 'brew install awscli' });
  else if (aws.cli.version !== null && aws.cli.version < 2) out.push({ id: 'unsupported-cli', icon: 'git-compare', tone: 'waiting', title: 'aws CLI v1', text: 'A v1 não tem o login do IAM Identity Center. Atualize para a v2; até lá, os perfis aparecem sem estado.' });
  if (aws.configFile.status === 'error') {
    const line = aws.configFile.error?.line;
    const message = aws.configFile.error?.message;
    out.push({ id: 'config-error', icon: 'file-warning', tone: 'error', title: 'O ~/.aws/config tem um erro', text: `${line ? `Linha ${line}: ` : ''}${message ?? 'o arquivo não pôde ser lido'}. Mostramos a última leitura boa, e Entrar fica desligado até corrigir.` });
  }
  for (const s of aws.sessions.filter((x) => !x.loginSupported).slice(0, 3)) {
    out.push({ id: `name-${s.name}`, icon: 'slash', tone: 'muted', title: 'Nome que o console não usa', text: `A sessão "${s.name}" tem um nome que não vai para a linha de comando. Ela aparece, mas sem Entrar: só letras, números, ponto, hífen e sublinhado passam.` });
  }
  const unknown = aws.sessions.filter((s) => s.state === 'unknown' && s.checkedAt);
  if (unknown.length) out.push({ id: 'unknown', icon: 'question', tone: 'muted', title: 'Estado desconhecido', text: `A aws respondeu sobre ${list(unknown.map((s) => s.name))} com um erro que não é de sessão (rede, por exemplo). Tentamos de novo em 5 min; Entrar continua disponível.` });
  return out;
}

/** The four numbers of the AWS screen (C58). */
export function awsStats(aws) {
  const sso = aws.sessions.length;
  const withSso = aws.sessions.reduce((n, s) => n + s.profiles.length, 0);
  const without = aws.outOfScope.length;
  const valid = aws.sessions.filter((s) => s.state === 'valid' || s.state === 'expiring');
  const expired = aws.sessions.filter((s) => s.state === 'expired');
  return [
    { id: 'sessions', label: 'Sessões SSO', value: String(sso), sub: 'de ~/.aws/config', icon: 'key', tone: 'accent' },
    { id: 'profiles', label: 'Perfis', value: String(withSso + without), sub: `${withSso} com SSO · ${without} sem SSO`, icon: 'users', tone: 'accent' },
    { id: 'valid', label: valid.length === 1 ? 'Válida' : 'Válidas', value: String(valid.length), sub: valid.length ? list(valid.map((s) => s.name)) : 'nenhuma agora', icon: 'check-circle-2', tone: 'completed' },
    { id: 'expired', label: expired.length === 1 ? 'Expirada' : 'Expiradas', value: String(expired.length), sub: expired.length ? list(expired.map((s) => s.name)) : 'nenhuma', icon: 'x', tone: expired.length ? 'error' : 'muted' },
  ];
}

/** The line under a session's name: "sso-session · portal x · 3 perfis". */
export function sessionMeta(session) {
  const parts = [session.kind === 'legacy' ? 'perfil antigo, sem sso-session' : 'sso-session'];
  if (session.startUrlHost) parts.push(`portal ${session.startUrlHost}`);
  parts.push(plural(session.profiles.length, 'perfil', 'perfis'));
  return parts.join(' · ');
}

/** The foot of a session card. */
export function sessionFoot(session, now = Date.now()) {
  const checked = session.checkedAt ? `conferida ${ago(session.checkedAt, now)}` : 'ainda não conferida';
  const n = session.profiles.length;
  if (session.state === 'expired') return `Expirou${session.expiresAt ? ` às ${clockTime(session.expiresAt)}` : ''}. Um login vale para ${n === 1 ? 'o perfil' : `os ${n} perfis`} desta sessão.`;
  if (session.state === 'valid' || session.state === 'expiring') return `${session.expiresAt ? `Faltam ${timeLeft(session.expiresAt, now)} · ` : ''}${checked}`;
  if (session.state === 'never') return `Sem login ainda nesta máquina. Um login vale para ${n === 1 ? 'o perfil' : `os ${n} perfis`} desta sessão.`;
  return `Estado desconhecido · ${checked}`;
}

/** Why a profile is out of scope. */
export const outOfScopeText = (p) =>
  p.reason === 'missing-sso-session'
    ? 'Aponta para uma sso-session que o ~/.aws/config não tem: sem estado e sem Entrar.'
    : 'Sem SSO (chave de acesso ou outro método): o console não abre o ~/.aws/credentials, não mostra estado e não oferece Entrar.';

// ---------- all the sessions of all the machines (C61) ----------

const URGENCY = { expired: 0, expiring: 1, unknown: 2, never: 3, valid: 4 };

/**
 * One row per AWS session of every machine, the closest to expiring first: expired, expiring, unknown,
 * never, valid; inside a state, the earliest `expiresAt` first. `machines` is `[{ id, label, aws }]`.
 */
export function allSessions(machines) {
  const rows = [];
  for (const m of machines ?? []) {
    for (const s of m?.aws?.sessions ?? []) rows.push({ machineId: m.id, machine: m.label, cloud: 'AWS', session: s, aws: m.aws });
  }
  const time = (s) => {
    const t = Date.parse(s.expiresAt ?? '');
    return Number.isFinite(t) ? t : Infinity;
  };
  return rows.sort((a, b) => URGENCY[a.session.state] - URGENCY[b.session.state] || time(a.session) - time(b.session) || a.machine.localeCompare(b.machine) || a.session.name.localeCompare(b.session.name));
}

/** "3 perfis", or the one profile's name. */
export const profilesText = (session) => (session.profiles.length === 1 ? session.profiles[0].name : plural(session.profiles.length, 'perfil', 'perfis'));

/**
 * The line under a device code: which page the person is about to confirm on (decision 0013 §2a).
 * "o da sessão" only when the URL is on the session's own portal; the region's SSO device page is
 * named as such. `{ host, text }`, or null for a URL that does not parse.
 */
export function portalLine(verificationUri, session) {
  let host;
  try {
    host = new URL(verificationUri).hostname;
  } catch {
    return null;
  }
  if (session?.startUrlHost && host === String(session.startUrlHost).toLowerCase()) return { host, text: `, o portal da sessão ${session.name}. Confira antes de confirmar.` };
  const region = /^device\.sso\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host)?.[1];
  if (region) return { host, text: `, a página de dispositivo do SSO da AWS na região ${region}. Confira antes de confirmar.` };
  return { host, text: '. Confira antes de confirmar.' };
}
