// The Atualizar button of the remote núcleo, as the screen reads it (issue 462, decision 0022, wireframes 462-1 to
// 462-6). Pure: no DOM. The core sends `update` on every remote machine of `GET /api/machines`
// (`telemetry/core-update.ts`); here it is read again with the exact shapes, so nothing the remote or the file said
// reaches the screen but the closed words below. The screen writes NO text of its own for a result: the words of an
// exit, a refusal or a "falta configurar" come from `update.message.text` (rendered by the core from
// `core-update-texts.ts`, the table of decision 0022 section 7). What is written here is only static labels: the
// phase names, the titles and the buttons.

const STATES = new Set(['idle', 'checking', 'ready', 'refused', 'running', 'succeeded', 'rolled-back', 'rollback-failed', 'failed', 'timed-out', 'canceled']);
const PHASES = new Set(['check', 'backup', 'swap', 'start', 'verify', 'rollback']);
const PROBLEMS = new Set(['missing', 'invalid', 'credential-missing', 'invalid-file']);
const CONFIRMATIONS = new Set(['confirming', 'confirmed', 'diverged']);
const VERSION = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{4,40}$/;
const KEY = /^[a-z0-9-]{1,48}$/;
const MAX_PATH = 512;
const MAX_TEXT = 1000;
const MAX_BLOCK = 4000;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const clean = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v) ? v : null);

/** The `update` of a machine in `GET /api/machines`, or `null` (an older core sends none: the screen stays as the 449 had it). */
export function normalizeUpdate(raw) {
  if (!isObject(raw) || typeof raw.configured !== 'boolean' || !STATES.has(raw.state)) return null;
  const message = isObject(raw.message) && KEY.test(raw.message.key ?? '') && text(raw.message.text, MAX_TEXT) ? { key: raw.message.key, text: raw.message.text } : null;
  return {
    configured: raw.configured,
    problem: PROBLEMS.has(raw.problem) ? raw.problem : null,
    state: raw.state,
    kind: raw.kind === 'check' || raw.kind === 'update' ? raw.kind : null,
    phase: PHASES.has(raw.phase) ? raw.phase : null,
    targetVersion: typeof raw.targetVersion === 'string' && VERSION.test(raw.targetVersion) ? raw.targetVersion : null,
    startedAt: text(raw.startedAt, 40),
    endedAt: text(raw.endedAt, 40),
    exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    reason: text(raw.reason, 48),
    backupPath: clean(raw.backupPath, MAX_PATH),
    oldCommit: typeof raw.oldCommit === 'string' && COMMIT.test(raw.oldCommit) ? raw.oldCommit : null,
    canCancel: raw.canCancel === true,
    timeoutSeconds: Number.isInteger(raw.timeoutSeconds) ? raw.timeoutSeconds : null,
    confirmation: CONFIRMATIONS.has(raw.confirmation) ? raw.confirmation : null,
    readyUntil: text(raw.readyUntil, 40),
    message,
    block: isObject(raw.setup) ? clean(raw.setup.block, MAX_BLOCK) : null,
  };
}

export const updateRoute = (id) => `/api/machines/${encodeURIComponent(id)}/update`;
export const checkRoute = (id) => `${updateRoute(id)}/check`;

/** A run is going on (the check, the update, or the wait for the remote to answer the new version): poll fast, the button is busy. */
export const isBusy = (u) => u.state === 'checking' || u.state === 'running' || (u.kind === 'update' && u.state === 'succeeded' && u.confirmation === 'confirming');

/** The phases, in order, as the person reads them (decision 0022 section 4). `rollback` is an extra row, only when it happens. */
export const PHASE_ROWS = [
  { key: 'check', label: 'Conferindo', icon: 'search' },
  { key: 'backup', label: 'Fazendo backup do banco', icon: 'hard-drive' },
  { key: 'swap', label: 'Trocando o código', icon: 'repeat' },
  { key: 'start', label: 'Subindo o núcleo', icon: 'power' },
  { key: 'verify', label: 'Conferindo que respondeu', icon: 'search' },
];
export const ROLLBACK_ROW = { key: 'rollback', label: 'Voltando ao código anterior', icon: 'history' };

/** The rows of the progress: `done` before the phase, `now` on it, `next` after. `allDone` marks every one (exit 0). */
export function stepRows(u, { allDone = false } = {}) {
  const at = allDone ? PHASE_ROWS.length : u.phase === 'rollback' ? PHASE_ROWS.length : Math.max(0, PHASE_ROWS.findIndex((r) => r.key === u.phase));
  const rows = PHASE_ROWS.map((r, i) => ({ ...r, tone: allDone || i < at ? 'done' : i === at ? 'now' : 'next' }));
  if (!allDone && u.phase === 'rollback') rows.push({ ...ROLLBACK_ROW, tone: 'now' });
  return rows;
}

/** "fase 3 de 5" for the progress title; the rollback has no number of its own. */
export function phaseLabel(u) {
  if (u.phase === 'rollback') return 'voltando ao código anterior';
  const i = PHASE_ROWS.findIndex((r) => r.key === u.phase);
  return `fase ${(i < 0 ? 0 : i) + 1} de ${PHASE_ROWS.length}`;
}

/** m:ss since an ISO moment. */
export function elapsed(iso, now) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '0:00';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How long a finished update stays on the screen by itself (the rollback that failed stays until the person closes it). */
export const RESULT_MS = 30 * 60_000;

// What a finished update looks like: a static title, a tone (`ok`, `warn`, `bad`) and an icon. The sentence is the core's.
const RESULTS = {
  succeeded: { tone: 'ok', icon: 'check-circle-2', title: 'Atualizado' },
  'rolled-back': { tone: 'bad', icon: 'history', title: 'Falhou e voltou ao código de antes' },
  'rollback-failed': { tone: 'bad', icon: 'shield-alert', title: 'Falhou e a volta também falhou' },
  failed: { tone: 'bad', icon: 'alert', title: 'A atualização não aconteceu' },
  refused: { tone: 'warn', icon: 'shield-alert', title: 'A Workstation recusou, nada foi parado' },
  'timed-out': { tone: 'warn', icon: 'timer', title: 'A Workstation não respondeu a tempo' },
  canceled: { tone: 'warn', icon: 'x', title: 'Cancelado' },
};

/** The look of a finished run (`kind` update or check), or `null` for a state that is not an ending. */
export function resultLook(u) {
  if (u.state === 'succeeded' && u.confirmation === 'diverged') return { tone: 'warn', icon: 'alert', title: 'A versão de lá não bateu' };
  if (u.state === 'succeeded' && u.confirmation === 'confirming') return { tone: 'warn', icon: 'wall-loader', title: 'Conferindo a versão' };
  return RESULTS[u.state] ?? null;
}

/** An ending of the update itself (not of the check) the page keeps showing until closed; the check's endings live in the dialog. */
export function showsResult(u, now) {
  if (u.kind !== 'update' || !resultLook(u) || u.state === 'running') return false;
  if (u.state === 'rollback-failed') return true;
  const t = Date.parse(u.endedAt ?? '');
  return Number.isFinite(t) && now - t <= RESULT_MS;
}

/** A key that identifies one run, so closing its result does not hide the next one. */
export const runKey = (u) => `${u.kind}|${u.startedAt ?? ''}`;

/** The states after which trying again makes sense (never the lost contact after the swap: the script is still running there). */
export function canRetry(u) {
  if (u.message?.key === 'timeout-after-swap') return false;
  return ['rolled-back', 'failed', 'refused', 'timed-out', 'canceled'].includes(u.state);
}

/** The keys that point at the command to paste: the guard that only a person can lift, and a version that did not arrive. */
export const pointsToCommand = (u) => u.message?.key === 'exit-22' || u.confirmation === 'diverged';
