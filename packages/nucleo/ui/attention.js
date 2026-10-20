// The attention vocabulary of every /ui screen (issue 245): the old "waiting for you" split in two.
//
// - `blocked` ("Precisa de você"): the session is stuck until the person acts. Yellow, highlighted, always
//   with the reason (permission, question, plan, decision). An `error` session is blocked too, but keeps
//   its own red "Com erro" pill.
// - `idle` ("Ociosa"): the turn ended and nothing is stuck. Neutral tokens, hollow dot, no fill, the
//   reason in a light chip (turn ended, interrupted, at the prompt).
//
// Every route answers the same `attention: { level, reason } | null` (packages/nucleo/README.md,
// "Precisa de você e ociosa (issue 245)"). The classes live in shell.css, loaded by every screen.

import { el, icon } from './dom.js';

/** The singular label of each level, as the pill says it. */
export const ATTENTION_LABEL = { blocked: 'Precisa de você', idle: 'Ociosa' };
/** The plural, for pills, filters and columns. */
export const ATTENTION_PLURAL = { blocked: 'Precisam de você', idle: 'Ociosas' };

/** The reasons, with the label and the icon (from dom.js) of each one. */
export const ATTENTION_REASONS = {
  permission: { level: 'blocked', label: 'Pede permissão', icon: 'permission' },
  question: { level: 'blocked', label: 'Pergunta', icon: 'question' },
  plan: { level: 'blocked', label: 'Plano para aprovar', icon: 'list-checks' },
  decision: { level: 'blocked', label: 'Decisão pedida', icon: 'hand' },
  error: { level: 'blocked', label: 'Com erro', icon: 'error' },
  turn_ended: { level: 'idle', label: 'Sua vez', icon: 'your-turn' },
  interrupted: { level: 'idle', label: 'Interrompida', icon: 'interrupted' },
  first_prompt: { level: 'idle', label: 'No prompt', icon: 'no-prompt' },
};

/** The attention of a payload, checked: `{ level, reason }` or `null` (anything else is `null`). */
export function attentionOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.level !== 'blocked' && value.level !== 'idle') return null;
  return { level: value.level, reason: typeof value.reason === 'string' ? value.reason : null };
}

/**
 * The attention of an item of `GET /api/attention`: its `attention`, or, from an older core (a remote
 * machine that was not updated), the old `level` (`needs` is blocked, `your-turn` idle) and `reason`.
 */
export function attentionOfItem(item) {
  const a = attentionOf(item?.attention);
  if (a) return a;
  if (item?.reason === 'error') return { level: 'blocked', reason: 'error' };
  if (item?.level === 'needs') return { level: 'blocked', reason: ATTENTION_REASONS[item.reason]?.level === 'blocked' ? item.reason : null };
  if (item?.level === 'your-turn') return { level: 'idle', reason: null };
  return null;
}

/**
 * The status to draw when a payload carries no attention (`attention: null`): the core does not wait on
 * the person (delegating, background…), so a `waiting` status is drawn as `active`, never as idle. This is
 * the same column as `sessionColumnOf` in src/api/kanban.ts. Any other status is returned unchanged.
 */
export function statusWithoutAttention(status) {
  return status === 'waiting' ? 'active' : status;
}

export const isBlocked = (value) => attentionOf(value)?.level === 'blocked';
export const isIdle = (value) => attentionOf(value)?.level === 'idle';
/** A blocked session stopped by an error: it keeps the red "Com erro" pill. */
export const isError = (value) => {
  const a = attentionOf(value);
  return a?.level === 'blocked' && a.reason === 'error';
};

/** The tone of an attention: `error`, `blocked`, `idle` or `null` (picks the pill and edge colors). */
export function attentionTone(value) {
  const a = attentionOf(value);
  if (!a) return null;
  return isError(a) ? 'error' : a.level;
}

/** The pill text: "Com erro", "Precisa de você", "Ociosa"; `null` without attention. */
export function attentionText(value) {
  const tone = attentionTone(value);
  if (!tone) return null;
  return tone === 'error' ? ATTENTION_REASONS.error.label : ATTENTION_LABEL[tone];
}

/** The reason label ("Pede permissão", "Sua vez"…); an unknown reason is `null`, never the raw value. */
export function reasonLabel(value) {
  const a = attentionOf(value);
  return a?.reason ? (ATTENTION_REASONS[a.reason]?.label ?? null) : null;
}

/** The pill of an attention: yellow "Precisa de você", neutral hollow "Ociosa" or red "Com erro". */
export function attentionPill(value, { extraClass = '' } = {}) {
  const tone = attentionTone(value);
  if (!tone) return null;
  return el(
    'span',
    { class: `attention-pill attention-pill-${tone}${extraClass ? ` ${extraClass}` : ''}`, 'data-attention': tone },
    el('span', { class: 'attention-pill-dot' }),
    attentionText(value),
  );
}

/**
 * The reason chip: strong (yellow) when blocked, light (neutral) when idle. The error reason has no
 * chip by default (the red pill already says it); `withError` draws a red chip where only the chip shows.
 */
export function reasonChip(value, { withError = false } = {}) {
  const a = attentionOf(value);
  const reason = a?.reason ? ATTENTION_REASONS[a.reason] : null;
  if (!reason) return null;
  if (a.reason === 'error' && !withError) return null;
  const kind = a.reason === 'error' ? ' attention-chip-error' : a.level === 'idle' ? ' attention-chip-light' : '';
  return el('span', { class: `attention-chip${kind}`, 'data-reason': a.reason }, icon(reason.icon), reason.label);
}

/** The pill and, after it, the reason chip (none for an error). */
export function attentionBadges(value) {
  return [attentionPill(value), reasonChip(value)].filter(Boolean);
}

/** The status dot: solid yellow for blocked, hollow neutral for idle. */
export function attentionDot(level) {
  return el('span', { class: `attention-dot attention-dot-${level === 'blocked' ? 'blocked' : 'idle'}`, 'aria-hidden': 'true' });
}
