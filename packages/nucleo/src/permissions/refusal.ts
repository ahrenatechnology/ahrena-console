// Why the domain refuses a request, shared by the aggregate and the digest (#618). Pure.

/** Why the domain refused. The API maps them: 409 `already_*`, 410 `gone`, 422 `terminal_only` and `invalid_*`, 400 `input_too_deep` (#618/AC-1). */
export const REFUSAL_CODES = ['already_answered', 'already_delivered', 'gone', 'not_answered', 'not_due', 'terminal_only', 'invalid_decision', 'invalid_answer', 'invalid_reason', 'input_too_deep'] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** A request refused by the rules of the aggregate. It changes nothing. */
export class PermissionRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string = code) {
    super(message);
    this.name = 'PermissionRefusal';
    this.code = code;
  }
}
