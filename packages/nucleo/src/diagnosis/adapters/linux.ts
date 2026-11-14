/*
 * The Linux diagnosis collector (#565): the swap from `/proc/meminfo`, and the cache folders a Linux
 * machine has (npm, pip under `.cache`). Everything else is `common.ts`.
 */

import { parseMeminfo } from '../../telemetry/adapters/linux.ts';
import { CACHE_ACTION_IDS, type CacheActionId } from '../model.ts';
import type { CollectResult } from '../diagnose.ts';
import { DiagnosisCollector } from './common.ts';

export class LinuxDiagnosisCollector extends DiagnosisCollector {
  protected async swap(): Promise<CollectResult<'swap'>> {
    const out = await this.deps.readFile('/proc/meminfo');
    const m = out ? parseMeminfo(out) : {};
    if (m.SwapTotal === undefined || m.SwapFree === undefined) return { unavailable: true, reason: 'swap not reported by /proc/meminfo' };
    return [{ usedBytes: Math.max(0, m.SwapTotal - m.SwapFree), totalBytes: m.SwapTotal }];
  }

  protected cacheFolders(): { path: string; actionId: CacheActionId }[] {
    const { home } = this.deps;
    return [
      { path: `${home}/.npm`, actionId: CACHE_ACTION_IDS.npm },
      { path: `${home}/.cache/pip`, actionId: CACHE_ACTION_IDS.pip },
    ];
  }
}
