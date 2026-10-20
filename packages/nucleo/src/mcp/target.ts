// Which core the stdio bridge talks to (decision 0010, item 5; issue #221). There is no fixed port
// any more: every core listens on a random one and writes itself into the instance registry
// (src/owner/registry.ts). The bridge reads the registry on every request, so it follows a core that
// restarted on another port.
//
// The rule, for a bridge of installation `I`:
//
//   1. The oldest live core of `I` in the registry.
//   2. The core this bridge started or adopted through `I`'s lock (a core that is not in the
//      registry, such as one from before #221, or the instant between the lock and the entry).
//   3. Otherwise, the oldest live core of any installation.
//   4. With no core of `I` live, the bridge may start its own (`start --installation I`, port 0 or
//      the forced one, `--parent` on the bridge), in the background:
//        - `mcpb` (the extension) always starts its own: it is autonomous, and while its core comes
//          up it answers through rule 3;
//        - `dev` and `app` start their own only when no core of any installation is live: a checkout
//          that finds the app's core uses it instead of opening a second database.
//      `--no-start` never starts.
//
// Before the first request to a core, `verifyInstance` checks that its port answers with its pid (a
// live pid may be a reused number). A core that does not answer is skipped for that request and the
// next candidate is tried.

import { resolve } from 'node:path';
import { registerClient } from '../owner/clients.ts';
import type { Installation } from '../owner/installation.ts';
import { listInstances, verifyInstance, type Instance } from '../owner/registry.ts';
import type { StartOptions, StartOutput } from '../owner/start.ts';

/** A core to send to: its port, and the registry id (or `lock:<port>` for rule 2). */
export interface CoreTarget {
  key: string;
  port: number;
  installation: Installation | null;
}

/**
 * Rules 1 and 3 over a list of live instances (oldest first), skipping `exclude`d ids. `own` says
 * whether the choice is of the bridge's installation.
 */
export function chooseInstance(instances: readonly Instance[], installation: Installation, exclude: ReadonlySet<string> = new Set()): { instance: Instance | null; own: boolean } {
  const usable = instances.filter((i) => !exclude.has(i.id));
  const own = usable.find((i) => i.installation === installation);
  if (own) return { instance: own, own: true };
  return { instance: usable[0] ?? null, own: false };
}

/** Rule 4: whether a bridge of `installation` starts its own core, given the live instances. */
export function shouldStartOwn(installation: Installation, instances: readonly Instance[]): boolean {
  if (instances.some((i) => i.installation === installation)) return false;
  return installation === 'mcpb' || instances.length === 0;
}

export interface ResolverOptions {
  installation: Installation;
  /** The data folder of the bridge's installation (where its own core lives). */
  dataDir: string;
  /** The port its own core is started on: 0 (random) unless one is forced. */
  startPort: number;
  /** `--no-start`: never starts a core. */
  noStart: boolean;
  /** The bridge's pid: `--parent` of the core it starts, and a client of the core of its installation. */
  parent: number;
  /** The per-user folder with the registry (tests). */
  home?: string;
  start: (o: StartOptions) => Promise<StartOutput>;
  verify?: (i: Instance) => Promise<boolean>;
  log?: (m: string) => void;
}

export class CoreResolver {
  private readonly o: ResolverOptions;
  private starting: Promise<void> | null = null;
  /** Rule 2: the port of the core of this installation that `start` started or adopted. */
  private lockPort: number | null = null;
  /** Ids already verified (pid and port match). */
  private readonly verified = new Set<string>();
  /** Ids this bridge is already a client of. */
  private readonly clientOf = new Set<string>();

  constructor(o: ResolverOptions) {
    this.o = o;
  }

  /** The core to try next, skipping the keys in `exclude`; `null` if there is none right now. */
  async target(exclude: Set<string> = new Set()): Promise<CoreTarget | null> {
    const { installation } = this.o;
    for (;;) {
      const live = listInstances({ home: this.o.home });
      if (!this.o.noStart && shouldStartOwn(installation, live)) this.startOwn();
      const { instance, own } = chooseInstance(live, installation, exclude);
      // Rule 2 comes before another installation's core.
      if ((!instance || !own) && this.lockPort !== null && !exclude.has(lockKey(this.lockPort))) {
        return { key: lockKey(this.lockPort), port: this.lockPort, installation };
      }
      if (!instance) return null;
      if (!this.verified.has(instance.id)) {
        if (!(await (this.o.verify ?? verifyInstance)(instance))) {
          this.o.log?.(`skipping ${instance.id}: port ${instance.port} does not answer with pid ${instance.pid}`);
          exclude.add(instance.id);
          continue;
        }
        this.verified.add(instance.id);
      }
      if (own) this.becomeClient(instance);
      return { key: instance.id, port: instance.port, installation: instance.installation };
    }
  }

  /** The core at `t` did not answer: forget it, so the next request looks again. */
  failed(t: CoreTarget): void {
    this.verified.delete(t.key);
    if (t.key === lockKey(t.port) && this.lockPort === t.port) this.lockPort = null;
  }

  /** Waits for a start already under way (tests and the first request). */
  async settled(): Promise<void> {
    await this.starting;
  }

  /** Starts (or adopts, through the lock) the core of this installation, in the background. */
  startOwn(): void {
    if (this.o.noStart || this.starting) return;
    const { installation, dataDir, startPort, parent, log } = this.o;
    this.starting = this.o
      .start({ installation, dir: dataDir, port: startPort, parent, log })
      .then((r) => {
        if (r.estado === 'de-pe' && typeof r.porta === 'number') {
          this.lockPort = r.porta;
          log?.(`core ${installation} at ${r.url} (${r.subiu ? 'started now' : 'adopted'})`);
        } else log?.(`the core did not start: ${r.motivo ?? 'unknown reason'}`);
      })
      .catch((e) => log?.(`the core did not start: ${(e as Error).message}`))
      .finally(() => {
        this.starting = null;
      });
  }

  /**
   * The bridge keeps the core of its own installation up while it runs (the `--parent` rule). Only
   * for the core of its own data folder: it never writes into a folder it only read in the registry.
   */
  private becomeClient(i: Instance): void {
    if (this.clientOf.has(i.id) || resolve(i.dataDir) !== resolve(this.o.dataDir)) return;
    this.clientOf.add(i.id);
    try {
      registerClient(this.o.parent, i.dataDir);
    } catch (e) {
      this.o.log?.(`could not register as a client of ${i.id}: ${(e as Error).message}`);
    }
  }
}

const lockKey = (port: number) => `lock:${port}`;
