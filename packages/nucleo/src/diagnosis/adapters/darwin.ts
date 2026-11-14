/*
 * The Mac's diagnosis collector (#565): the swap from `sysctl vm.swapusage`, and the cache folders a
 * Mac has (npm, pip under `Library/Caches`, Xcode DerivedData). Everything else is `common.ts`.
 */

import { parseSwapUsage } from '../../telemetry/adapters/darwin.ts';
import { CACHE_ACTION_IDS, type CacheActionId } from '../model.ts';
import type { CollectResult } from '../diagnose.ts';
import { DiagnosisCollector } from './common.ts';

export class DarwinDiagnosisCollector extends DiagnosisCollector {
  protected async swap(signal: AbortSignal): Promise<CollectResult<'swap'>> {
    const r = await this.exec('swap-usage', signal);
    if (!('stdout' in r)) return r;
    const swap = parseSwapUsage(r.stdout);
    return swap ? [{ usedBytes: swap.usedBytes, totalBytes: swap.totalBytes }] : { unavailable: true, reason: 'sysctl output not understood' };
  }

  /** The journal is systemd's: there is none on the Mac. */
  protected async journal(): Promise<CollectResult<'journal'>> {
    return { unavailable: true, reason: 'no journal on this OS' };
  }

  protected cacheFolders(): { path: string; actionId: CacheActionId }[] {
    const { home } = this.deps;
    return [
      { path: `${home}/.npm`, actionId: CACHE_ACTION_IDS.npm },
      { path: `${home}/Library/Caches/pip`, actionId: CACHE_ACTION_IDS.pip },
      { path: `${home}/Library/Developer/Xcode/DerivedData`, actionId: CACHE_ACTION_IDS.xcodeDerivedData },
    ];
  }
}
