/*
 * The Linux diagnosis collector (#565): the swap from `/proc/meminfo`, and the cache folders a Linux
 * machine has (npm, pip under `.cache`). Everything else is `common.ts`.
 */

import { parseMeminfo } from '../../telemetry/adapters/linux.ts';
import { CACHE_ACTION_IDS, type CacheActionId } from '../model.ts';
import type { CollectResult } from '../diagnose.ts';
import type { ProcessSample, RegisteredSession, StartCheck } from '../attribution.ts';
import { DiagnosisCollector } from './common.ts';
import { parseProcStatStartTime } from './parsers.ts';

export class LinuxDiagnosisCollector extends DiagnosisCollector {
  protected async swap(): Promise<CollectResult<'swap'>> {
    const out = await this.deps.readFile('/proc/meminfo');
    const m = out ? parseMeminfo(out) : {};
    if (m.SwapTotal === undefined || m.SwapFree === undefined) return { unavailable: true, reason: 'swap not reported by /proc/meminfo' };
    return [{ usedBytes: Math.max(0, m.SwapTotal - m.SwapFree), totalBytes: m.SwapTotal }];
  }

  /**
   * Claude Code on Linux writes `procStart` as field 22 of `/proc/<pid>/stat` (clock ticks). It is read again here, only for the
   * registered pids that are alive in the sample, and compared as text; a stat that cannot be read or understood leaves the pid
   * unverified, so its tree is outside any session (#722).
   */
  override async startCheck(registry: readonly RegisteredSession[], samples: readonly ProcessSample[]): Promise<StartCheck> {
    const alive = new Set(samples.map((p) => p.pid));
    const pids = [...new Set(registry.map((e) => e.pid))].filter((pid) => alive.has(pid));
    const ticks = new Map<number, string | null>();
    await Promise.all(
      pids.map(async (pid) => {
        const stat = await this.deps.readFile(`/proc/${pid}/stat`);
        ticks.set(pid, stat === null ? null : parseProcStatStartTime(stat));
      }),
    );
    return (entry) => entry.procStart !== null && ticks.get(entry.pid) === entry.procStart.trim();
  }

  protected cacheFolders(): { path: string; actionId: CacheActionId }[] {
    const { home } = this.deps;
    return [
      { path: `${home}/.npm`, actionId: CACHE_ACTION_IDS.npm },
      { path: `${home}/.cache/pip`, actionId: CACHE_ACTION_IDS.pip },
    ];
  }
}
