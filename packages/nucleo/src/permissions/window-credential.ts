// The window credential the core holds for the app's /ui window (decision 0025, #619). In memory only: it is never written to a
// file, a log, a URL, a page or a GET response. The holder redacts itself, so a whole object that reaches a log or a response
// carries no value. Pure: no import of a mechanism. (#619)

export interface WindowCredentialHolder {
  /** The credential the window must present, or `null` when there is none (the capability is then unavailable). */
  current(): string | null;
  /** Replaces the credential: the previous one is revoked at once. */
  accept(value: string): void;
  /** Clears the credential. */
  revoke(): void;
}

export function createWindowCredentialHolder(): WindowCredentialHolder {
  let value: string | null = null;
  const holder: WindowCredentialHolder = {
    current: () => value,
    accept: (next) => {
      value = next;
    },
    revoke: () => {
      value = null;
    },
  };
  // The value lives in the closure: no property, no enumerable key, nothing for JSON or inspect to print.
  return Object.freeze(holder);
}
