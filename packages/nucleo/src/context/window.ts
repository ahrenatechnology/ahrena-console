// Context window size from the model and the mode.
// Claude models default to a 200k window; the long one (1M) comes from the session's mode, which Claude Code
// marks with the `[1m]` suffix on the model (e.g. `claude-opus-5-5[1m]`). The transcript records the model
// without the suffix, so a session that already sent more than the default window is on the long one too.

import type { WindowSource } from './model.ts';

export const DEFAULT_WINDOW = 200_000;
export const LONG_WINDOW = 1_000_000;

/** Default window per model, when it is not the 200k one. The first pattern that matches wins. */
export const WINDOWS_BY_MODEL: readonly { pattern: RegExp; tokens: number }[] = [];

const LONG_SUFFIX = /\[1m\]/i;

export interface ContextWindow {
  tokens: number;
  source: WindowSource;
}

/**
 * The agent's window, given the model of the measurement, the session's (which may carry the suffix), the
 * largest context seen so far and the window stored before. The window never shrinks: a session that
 * reached the long one stays on it.
 */
export function windowFor(
  model: string | null,
  sessionModel: string | null,
  largestSeen: number,
  previous: ContextWindow | null = null,
): ContextWindow {
  let window: ContextWindow;
  if ((model && LONG_SUFFIX.test(model)) || (sessionModel && LONG_SUFFIX.test(sessionModel))) {
    window = { tokens: LONG_WINDOW, source: 'sufixo' };
  } else {
    const fromModel = model ? WINDOWS_BY_MODEL.find((w) => w.pattern.test(model))?.tokens : undefined;
    window = { tokens: fromModel ?? DEFAULT_WINDOW, source: 'modelo' };
  }
  if (largestSeen > window.tokens) window = { tokens: LONG_WINDOW, source: 'observado' };
  if (previous && previous.tokens > window.tokens) return previous;
  return window;
}
