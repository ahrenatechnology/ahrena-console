// The in-app route of a link, or null when the link leaves the console: the shell switches screens
// without a reload for `/ui...` links on its own origin. The route keeps the hash: the Workflow node's open
// icon ends in `#conversation`, which picks the session's tab (issue 520).
export function internalRoute(href, base) {
  const url = new URL(href, base);
  if (url.origin !== new URL(base).origin) return null;
  if (!(url.pathname === '/ui' || url.pathname.startsWith('/ui/'))) return null;
  return url.pathname + url.search + url.hash;
}
