// `PermissionChangeNotifier` inside the core's process (#618, layer 3): the listeners of one request, called on its next
// change. Nothing here is persisted; the change feed of the `/ui` reads the rows.
import type { PermissionChange, PermissionChangeNotifier } from '../ports.ts';

export class InProcessChangeNotifier implements PermissionChangeNotifier {
  private readonly listeners = new Map<string, Set<() => void>>();

  publish(change: PermissionChange): void {
    for (const listener of [...(this.listeners.get(change.requestId) ?? [])]) listener();
  }

  subscribe(requestId: string, listener: () => void): () => void {
    const set = this.listeners.get(requestId) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(requestId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(requestId) === set) this.listeners.delete(requestId);
    };
  }
}
