// `Clock` on the system's time and timers (#618, layer 3). The timer is not kept alive for the process: a long poll waiting
// on it never holds the core open. (#618)
import type { Clock, Timer } from '../ports.ts';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  timer(ms: number): Timer {
    let handle: NodeJS.Timeout | undefined;
    const elapsed = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
      handle.unref();
    });
    return { elapsed, cancel: () => clearTimeout(handle) };
  }
}
