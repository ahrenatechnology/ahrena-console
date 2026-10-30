// What the daemon says now (#288): the containers, the Compose volumes and what `docker system df` says
// is reclaimable. Read through the injected runner, so a test never touches a daemon. Every plan is built
// from this reading, never from the request. A read that fails or times out gives `null` (the daemon does
// not answer); a read that is only slow (`volume` sizes, images) leaves its field `null`.
//
// - Containers: `docker ps -a --no-trunc` with a tab-separated format (the Compose project through the
//   label function, so a comma in another label cannot split a field); the id is cut to the 12 characters
//   `docker ps` shows.
// - Volumes: `docker volume ls` with the Compose project label. Sizes only from `docker system df -v`
//   (JSON), read when a plan asks for them (it walks every volume and can take long).
// - The daemon kind (`colima`, `rootless`, `system`) from the platform, the login PATH and the context.

import { DOCKER_DF_ARGS, parseDockerDf, parseDockerSize, publishedPorts } from '../telemetry/adapters/common.ts';
import type { RunResult, ToolRunner } from '../tools/runner.ts';
import type { DaemonKind, DockerContainer, DockerVolume, Inventory } from './catalog.ts';

export const PS_ARGS = ['docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Label "com.docker.compose.project"}}\t{{.Mounts}}\t{{.Ports}}'];
export const VOLUMES_ARGS = ['docker', 'volume', 'ls', '--format', '{{.Name}}\t{{.Label "com.docker.compose.project"}}'];
export const DF_ARGS = ['docker', ...DOCKER_DF_ARGS];
export const DF_VERBOSE_ARGS = ['docker', 'system', 'df', '-v', '--format', 'json'];
export const DANGLING_ARGS = ['docker', 'images', '--filter', 'dangling=true', '--format', '{{.Size}}'];
export const NETWORKS_ARGS = ['docker', 'network', 'ls', '--format', '{{.ID}}\t{{.Name}}\t{{.Driver}}'];
export const READ_TIMEOUT_MS = 8_000;
export const DF_VERBOSE_TIMEOUT_MS = 30_000;

export interface InventoryContext {
  run: ToolRunner;
  /** The environment of a Docker process: the login PATH (ToolsService.processEnv). */
  env: () => Promise<NodeJS.ProcessEnv>;
  platform: NodeJS.Platform;
  /** The full path of an executable on the login PATH, or `null`. */
  resolve: (name: string) => Promise<string | null>;
  now?: () => number;
}

const ok = (r: RunResult): boolean => r.code === 0;
const RUNNING = new Set(['running', 'restarting']);
const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none']);

/** `2025-10-23 08:12:01 -0300 -03` to an ISO time; `null` when it is not that shape. */
export function parseCreatedAt(text: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})/.exec(text.trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The output of `docker ps -a` with `PS_ARGS`. A line that does not parse is dropped. */
export function parseContainers(out: string): DockerContainer[] {
  const rows: DockerContainer[] = [];
  for (const line of out.split('\n')) {
    const [id = '', names = '', image = '', state = '', status = '', created = '', project = '', mounts = '', ports = ''] = line.split('\t');
    const short = id.trim().slice(0, 12);
    if (!/^[a-f0-9]{12}$/.test(short)) continue;
    rows.push({
      id: short,
      name: names.split(',')[0]!.trim(),
      image: image.trim(),
      running: RUNNING.has(state.trim()),
      status: status.trim(),
      stack: project.trim() === '' ? null : project.trim(),
      // `Mounts` lists named volumes by name and bind mounts by path: only the names are volumes.
      volumes: mounts.split(',').map((m) => m.trim()).filter((m) => m !== '' && !m.includes('/')),
      createdAt: parseCreatedAt(created),
      ports: publishedPorts(ports),
    });
  }
  return rows;
}

export function parseVolumes(out: string): DockerVolume[] {
  const rows: DockerVolume[] = [];
  for (const line of out.split('\n')) {
    const [name = '', project = ''] = line.split('\t');
    if (name.trim() === '') continue;
    rows.push({ name: name.trim(), stack: project.trim() === '' ? null : project.trim(), sizeBytes: null });
  }
  return rows;
}

/** `Volumes[{ Name, Size }]` of `docker system df -v --format json`, by name; `{}` when it is not that shape. */
export function parseVolumeSizes(out: string): Record<string, number> {
  try {
    const j = JSON.parse(out) as { Volumes?: { Name?: unknown; Size?: unknown }[] };
    const sizes: Record<string, number> = {};
    for (const v of j.Volumes ?? []) {
      if (typeof v.Name !== 'string' || typeof v.Size !== 'string') continue;
      const bytes = parseDockerSize(v.Size);
      if (bytes !== null) sizes[v.Name] = bytes;
    }
    return sizes;
  } catch {
    return {};
  }
}

export async function detectDaemon(ctx: InventoryContext): Promise<DaemonKind | null> {
  const env = await ctx.env();
  const context = await ctx.run(['docker', 'context', 'show'], { timeoutMs: 5_000, env });
  // Docker Desktop is read only: the console neither starts nor restarts it (decision 0014 section 7).
  if (ok(context) && /^desktop/.test(context.stdout.trim())) return null;
  if (ctx.platform === 'darwin') return (await ctx.resolve('colima')) !== null ? 'colima' : null;
  if (ctx.platform === 'linux') {
    const user = await ctx.run(['systemctl', '--user', 'cat', 'docker.service'], { timeoutMs: 5_000, env });
    return ok(user) ? 'rootless' : 'system';
  }
  return null;
}

/** `null` when the daemon does not answer `docker ps` (the screen then offers to restart it). */
export async function readInventory(ctx: InventoryContext, o: { volumeSizes?: boolean } = {}): Promise<Inventory | null> {
  const timeoutMs = READ_TIMEOUT_MS;
  const env = await ctx.env();
  const [ps, volumes, df, dangling, networks, daemon] = await Promise.all([
    ctx.run(PS_ARGS, { timeoutMs, env }),
    ctx.run(VOLUMES_ARGS, { timeoutMs, env }),
    ctx.run(DF_ARGS, { timeoutMs, env }),
    ctx.run(DANGLING_ARGS, { timeoutMs, env }),
    ctx.run(NETWORKS_ARGS, { timeoutMs, env }),
    detectDaemon(ctx),
  ]);
  if (!ok(ps)) return null;
  const containers = parseContainers(ps.stdout);
  const vols = ok(volumes) ? parseVolumes(volumes.stdout) : [];
  if (o.volumeSizes && vols.length > 0) {
    const verbose = await ctx.run(DF_VERBOSE_ARGS, { timeoutMs: DF_VERBOSE_TIMEOUT_MS, env });
    const sizes = ok(verbose) ? parseVolumeSizes(verbose.stdout) : {};
    for (const v of vols) v.sizeBytes = sizes[v.name] ?? null;
  }
  const reclaimable: Record<string, number | null> = {};
  if (ok(df)) for (const row of parseDockerDf(df.stdout)) reclaimable[row.type] = row.reclaimableBytes;
  const sizes = ok(dangling) ? dangling.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => parseDockerSize(l)) : null;
  const now = (ctx.now ?? Date.now)();
  const stoppedOlderThan24h = containers.filter((c) => !c.running && c.createdAt !== null && now - Date.parse(c.createdAt) > 24 * 3600 * 1000).length;
  return {
    containers,
    volumes: vols,
    reclaimable,
    danglingImages: sizes === null ? null : { count: sizes.length, bytes: sizes.reduce<number>((a, b) => a + (b ?? 0), 0) },
    // `docker network ls` cannot say which ones are in use; the screen says "até N" and `network prune` decides.
    networks: { unused: ok(networks) ? networks.stdout.split('\n').filter((l) => l.trim() !== '' && !BUILT_IN_NETWORKS.has(l.split('\t')[1]?.trim() ?? '')).length : null },
    stoppedOlderThan24h,
    daemon,
  };
}
