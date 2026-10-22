// A GitHub login or organization name (#241): letters, digits and hyphens, up to 39, not starting
// with a hyphen. One rule for the vault accounts, the installation settings and the Project owner.

export const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export function isGithubLogin(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_LOGIN.test(value);
}
