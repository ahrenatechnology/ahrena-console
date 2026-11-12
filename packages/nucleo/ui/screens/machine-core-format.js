// The remote núcleo's version and the command that updates it, as the screen says them (issue 449, decision 0021,
// wireframes 449-1 to 449-5). Pure: no DOM. The core sends `core` on every machine of `GET /api/machines`
// (`telemetry/core-version.ts`); here it is read again with the exact shapes, so a remote that lies about its version
// or a bad `connection.checkout` never reaches the screen or the pasted command, and only `core.mac` of what the Mac
// declares is kept. The Mac runs nothing: the command is text for a person to paste on the remote machine.

const VERSION = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{4,40}$/;
const STATUSES = new Set(['current', 'outdated', 'ahead', 'unknown']);
const MAX_TEXT = 64;
const MAX_CHECKOUT = 512;

/**
 * The first app version whose release carries the update script and the contract manifest. The same value as
 * `FIRST_UPDATER_VERSION` in `src/telemetry/core-version.ts`; a test keeps the two equal.
 */
export const FIRST_UPDATER_VERSION = '0.0.17';

const semver = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** `true` when this app version carries the update command in its release; below it, the bootstrap is shown. */
export function hasUpdater(appVersion) {
  const a = typeof appVersion === 'string' ? semver(appVersion) : null;
  const b = semver(FIRST_UPDATER_VERSION);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// `connection.checkout` was validated by the core; checked again because it goes into a command pasted in a shell.
const checkoutOf = (v) => (typeof v === 'string' && v.startsWith('/') && v.length <= MAX_CHECKOUT && !v.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);

/** The `core` of a machine in `GET /api/machines`, or `null` (never read, or without what the command needs). */
export function normalizeCore(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const mac = typeof raw.mac === 'object' && raw.mac !== null ? raw.mac : null;
  const expected = typeof raw.expectedVersion === 'string' && VERSION.test(raw.expectedVersion) ? raw.expectedVersion : null;
  if (!expected || !mac || !Number.isInteger(mac.telemetryVersion) || typeof mac.credentialCommand !== 'boolean') return null;
  return {
    version: typeof raw.version === 'string' && raw.version.length <= MAX_TEXT && VERSION.test(raw.version) ? raw.version : null,
    commit: typeof raw.commit === 'string' && raw.commit.length <= MAX_TEXT && COMMIT.test(raw.commit) ? raw.commit : null,
    expectedVersion: expected,
    status: STATUSES.has(raw.status) ? raw.status : 'unknown',
    readAt: typeof raw.readAt === 'string' ? raw.readAt.slice(0, 40) : null,
    mac: { telemetryVersion: mac.telemetryVersion, credentialCommand: mac.credentialCommand, checkout: checkoutOf(mac.checkout) },
  };
}

/** The warning (band, command, sidebar arrow) is for an outdated remote only; "ahead" and "unknown" have none. */
export const coreOutdated = (core) => core?.status === 'outdated';

/** `outdated` with the same version means the commit is older (the version only moves on a release). */
export const sameVersion = (core) => core.version === core.expectedVersion;

/** `update` (the explicit `--ref app-v<version>`) or `bootstrap` (the app is below the first release with the script). */
export const updateKind = (core) => (hasUpdater(core.expectedVersion) ? 'update' : 'bootstrap');

/** A path as one shell word: single quotes, and a quote inside it closed, escaped and reopened. */
export const shellQuote = (path) => `'${path.replaceAll("'", "'\\''")}'`;

const checkoutWord = (core) => (core.mac.checkout ? shellQuote(core.mac.checkout) : '<checkout>');
const flags = (core) => `--mac-telemetry-version ${core.mac.telemetryVersion} --mac-credential-command ${core.mac.credentialCommand ? 'yes' : 'no'}`;

function chain(core, ref, extra) {
  const c = checkoutWord(core);
  return `git -C ${c} fetch origin --tags \\\n  && git -C ${c} show ${ref}:scripts/remote-core/update-remote-core.mjs > ~/.ahrena-console/update-remote-core.mjs \\\n  && node ~/.ahrena-console/update-remote-core.mjs --checkout ${c} --ref ${ref}${extra} \\\n       ${flags(core)}`;
}

/** The command of decision 0021 section 3, with the app's tag as an explicit `--ref` and the Mac's flags from `core.mac`. */
export const updateCommand = (core) => chain(core, `app-v${core.expectedVersion}`, '');

/** Below the first release with the script: take it from `main` and only check (`--check` changes nothing). */
export const bootstrapCommand = (core) => chain(core, 'origin/main', ' --check');

const hhmm = (iso) => {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const PILLS = {
  current: ['b-completed', 'Em dia', 'igual à do app'],
  outdated: ['b-waiting', 'Defasado', 'abaixo do app'],
  ahead: ['b-active', 'Mais nova', 'sem aviso'],
  unknown: ['b-idle', 'Sem versão', 'sem versão válida'],
};

/** The three cells of the Versão row: the remote's version and commit, the app's, and the status. */
export function versionCells(core) {
  const [tone, label, sub] = PILLS[core.status];
  return [
    { key: 'core-remote', label: 'Núcleo de lá', value: core.version ?? '—', mono: Boolean(core.version), sub: core.version || core.commit ? (core.commit ? `commit ${core.commit}` : 'sem commit') : 'sem versão nem commit' },
    { key: 'core-app', label: 'App deste Mac', value: core.expectedVersion, mono: true, sub: 'este Mac' },
    { key: 'core-status', label: 'Situação', pill: [tone, label], sub: core.status === 'outdated' && sameVersion(core) ? 'commit mais antigo' : sub },
  ];
}

/** The yellow band above the command (449-2), or the "configure first" one (449-3) when this Mac has no credential command. */
export function outdatedBand(core, label) {
  const from = `lido do núcleo de lá às ${hhmm(core.readAt)}, sem a prova do dono · serve para avisar${core.commit ? `, commit ${core.commit}` : ''}`;
  if (!core.mac.credentialCommand) {
    return {
      icon: 'key-round',
      title: `Configure o comando de credencial antes de atualizar a ${label}.`,
      text: `A versão ${core.expectedVersion} só responde a quem prova ser o dono (decisão 0020), e este Mac ainda não tem o comando de credencial no machines.json. Se você atualizasse assim, a ${label} passaria a recusar este Mac e sumiria daqui. Por isso o comando do passo 2 leva --mac-credential-command no e, ao rodar, se recusa com o código 21 antes de parar o núcleo que funciona. Depois que você gravar o connection.credential, esta tela troca o no por yes e o comando passa.`,
      from: `o núcleo de lá está na ${core.version ?? 'versão desconhecida'}, lido sem a prova do dono`,
    };
  }
  if (sameVersion(core)) {
    return {
      icon: 'arrow-up-circle',
      title: `O núcleo da ${label} tem a mesma versão do app (${core.expectedVersion}), mas um commit mais antigo.`,
      text: `A versão só muda no release, então o código de lá é de antes do deste Mac${core.commit ? ` (commit ${core.commit})` : ''}. O comando abaixo leva a ${label} ao do app.`,
      from: 'só vale quando o núcleo deste Mac roda de um checkout; o app empacotado compara só a versão',
    };
  }
  return {
    icon: 'arrow-up-circle',
    title: `O núcleo da ${label} está na ${core.version} e o app, na ${core.expectedVersion}.`,
    text: `O Console de lá roda um código mais antigo que o deste Mac, e as correções das versões novas não chegam até ele. Este Mac não atualiza a ${label}: a atualização é um comando que você roda lá, logo abaixo.`,
    from,
  };
}
