import { el } from './dom.js';

export function providerLabel(provider) { return provider === 'codex' ? 'Codex' : 'Claude'; }
export function sessionOrigin(provider) {
  const label = providerLabel(provider);
  return el('span', { class: 'session-origin', 'data-provider': provider === 'codex' ? 'codex' : 'claude', 'aria-label': `Origem: ${label}` }, label);
}
