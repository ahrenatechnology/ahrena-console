// Finding the core through the instance registry (issue #221, piece 5b; decision 0010, item 5).
//
// Every core writes `<home>/instances/<installation>-<pid>.json` once its API listens
// (packages/nucleo/src/owner/registry.ts), `<home>` being AHRENA_CONSOLE_HOME or ~/.ahrena-console.
// The mod reads that folder instead of assuming a port:
//
//   - Only files named like an entry (`app-123.json`, `dev-…`, `mcpb-…`) whose content is a valid
//     entry with the same id. Anything else is skipped; the mod never writes or deletes there.
//   - The module has no `process.kill`, so "alive" is what the core itself says: the entry's port
//     answers `GET /api/overview` as `ahrena-console` with the entry's pid. A dead pid, a reused
//     port or a malformed answer is not alive.
//   - The mod comes from a checkout or a marketplace, so its own installation is `dev`: a live `dev`
//     core first, then the oldest live core of any installation (`startedAt`, then `id`).
//   - No live core: the old fixed address, 127.0.0.1:4720, so a core from before the registry still
//     answers and the Offline card reads exactly as before.
import type { EngineInterface as Engine } from 'claude-code'

export const LEGACY_PORT = 4720
export const LEGACY_CORE = `127.0.0.1:${LEGACY_PORT}`
/** The installation this mod belongs to (decision 0010, item 5). */
export const OWN_INSTALLATION = 'dev'

const INSTALLATIONS = ['app', 'dev', 'mcpb'] as const
type Installation = (typeof INSTALLATIONS)[number]
const FILE = /^(app|dev|mcpb)-[1-9]\d*\.json$/

export type Instance = { id: string; installation: Installation; pid: number; port: number; startedAt: string }

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/** The entry, or `null` when the value is not one (or does not match its file name). */
export function toInstance(v: unknown, fileName: string): Instance | null {
  if (typeof v !== 'object' || v === null) return null
  const e = v as Record<string, unknown>
  if (!INSTALLATIONS.includes(e.installation as Installation) || !isPositiveInt(e.pid) || !isPositiveInt(e.port) || e.port > 65535) return null
  const id = `${e.installation as Installation}-${e.pid}`
  if (e.id !== id || fileName !== `${id}.json` || typeof e.startedAt !== 'string') return null
  return { id, installation: e.installation as Installation, pid: e.pid, port: e.port, startedAt: e.startedAt }
}

/** The registry folder: AHRENA_CONSOLE_HOME, else the home folder's `.ahrena-console`. */
export async function instancesDir($: Engine): Promise<string | null> {
  // Only an absolute AHRENA_CONSOLE_HOME: the core resolves a relative one against its own cwd,
  // which the mod does not know.
  const fromEnv = await $.env.get('AHRENA_CONSOLE_HOME')
  const absolute = fromEnv && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(fromEnv) ? fromEnv : null
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const root = absolute || (home ? `${home.replace(/[\\/]+$/, '')}/.ahrena-console` : null)
  return root ? `${root.replace(/[\\/]+$/, '')}/instances` : null
}

/** The entries the registry holds, valid ones only, in the order to try them. */
export async function readInstances($: Engine): Promise<Instance[]> {
  const dir = await instancesDir($)
  if (!dir) return []
  let names: string[]
  try {
    names = (await $.fs.list(dir)).filter((f) => f.kind === 'file' && FILE.test(f.name)).map((f) => f.name)
  } catch {
    return []
  }
  const entries: Instance[] = []
  for (const name of names) {
    try {
      const text = await $.fs.read(`${dir}/${name}`)
      const e = toInstance(JSON.parse(typeof text === 'string' ? text : ''), name)
      if (e) entries.push(e)
    } catch {
      // gone meanwhile, unreadable or not JSON: skipped
    }
  }
  return entries.sort(
    (a, b) =>
      Number(b.installation === OWN_INSTALLATION) - Number(a.installation === OWN_INSTALLATION) ||
      (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id.localeCompare(b.id)),
  )
}

/** Does the entry's port answer `/api/overview` as a core with the entry's pid? */
export async function isLive($: Engine, i: Instance): Promise<boolean> {
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${i.port}/api/overview`)
    if (!res.ok || !res.text) return false
    const v = JSON.parse(res.text) as { name?: unknown; nome?: unknown; pid?: unknown }
    const name = typeof v.name === 'string' ? v.name : v.nome
    return name === 'ahrena-console' && v.pid === i.pid
  } catch {
    return false
  }
}

/** `127.0.0.1:<port>` of the core to talk to, or `null` when the registry has no live one. */
export async function discoverCore($: Engine): Promise<string | null> {
  for (const i of await readInstances($)) {
    if (await isLive($, i)) return `127.0.0.1:${i.port}`
  }
  return null
}

/** Read only the credential belonging to the selected local core; never persist it in panel state. */
export async function ownerHeaders($: Engine, core: string): Promise<Record<string, string>> {
  const port = /^127\.0\.0\.1:(\d+)$/.exec(core)?.[1]
  if (!port) return {}
  const dir = await instancesDir($)
  if (!dir) return {}
  const candidates: { path: string; pid?: number }[] = [{ path: `${dir.slice(0, -'/instances'.length)}/nucleo.json` }]
  try {
    for (const name of await $.fs.list(dir)) {
      if (name.kind !== 'file' || !FILE.test(name.name)) continue
      try {
        const raw = await $.fs.read(`${dir}/${name.name}`)
        const entry = JSON.parse(typeof raw === 'string' ? raw : '')
        if (toInstance(entry, name.name)?.port === Number(port) && typeof entry.dataDir === 'string' && entry.dataDir.startsWith('/')) candidates.push({ path: `${entry.dataDir}/nucleo.json`, pid: entry.pid })
      } catch { /* A disappearing entry is not proof. */ }
    }
  } catch { /* The owner's dev lock can exist before its registry entry. */ }
  for (const candidate of candidates) {
    try {
      const raw = await $.fs.read(candidate.path)
      const lock = JSON.parse(typeof raw === 'string' ? raw : '')
      if (lock.port === Number(port) && (candidate.pid === undefined || lock.pid === candidate.pid) && typeof lock.token === 'string' && /^[a-f0-9]{64}$/.test(lock.token)) return { authorization: `Bearer ${lock.token}` }
    } catch { /* No readable owner lock: the core will refuse the request. */ }
  }
  return {}
}
