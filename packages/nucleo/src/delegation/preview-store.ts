/*
 * The previews the person was shown (#567): the last prompt per machine and alert, held in memory so a
 * delegation sends exactly what the preview showed. Bounded and expiring; the clock arrives as a parameter.
 */

export interface StoredPreview {
  prompt: string;
  takenAt: string;
}

export interface PreviewStore {
  save(machine: string, alertId: string, preview: StoredPreview, nowMs: number): void;
  find(machine: string, alertId: string, nowMs: number): StoredPreview | null;
}

export interface PreviewStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export const DEFAULT_MAX_PREVIEWS = 50;
export const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;

interface Held extends StoredPreview {
  savedAtMs: number;
}

function keyOf(machine: string, alertId: string): string {
  return JSON.stringify([machine, alertId]);
}

export function createPreviewStore(options: PreviewStoreOptions = {}): PreviewStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_PREVIEWS;
  const ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
  const held = new Map<string, Held>();
  return {
    save(machine, alertId, preview, nowMs) {
      const key = keyOf(machine, alertId);
      held.delete(key);
      held.set(key, { ...preview, savedAtMs: nowMs });
      while (held.size > maxEntries) {
        const oldest = held.keys().next();
        if (oldest.done) break;
        held.delete(oldest.value);
      }
    },
    find(machine, alertId, nowMs) {
      const key = keyOf(machine, alertId);
      const entry = held.get(key);
      if (!entry) return null;
      if (nowMs - entry.savedAtMs >= ttlMs) {
        held.delete(key);
        return null;
      }
      return { prompt: entry.prompt, takenAt: entry.takenAt };
    },
  };
}
