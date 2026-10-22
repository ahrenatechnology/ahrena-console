// The sidebar (C1, C24): one block per section of the registry, and the remote machines (issue 178).
//
// The registry is static; the remote machines come from `machines.json`, which only the core reads.
// `readMachines()` reads `GET /api/machines` and, when the list changed, draws the sidebar again with
// `machineItems(list)` added: each remote is an item of the Máquinas block, after "Esta máquina",
// with its state dot. The counters (the "4" of the Dashboard) and the lit item survive the redraw.
// `readConnectors()` reads `GET /api/connectors` (issue 277) and puts on Conexões the dot that sums up the
// worst cloud connector; a core without the route (404) shows no dot.

import { el, icon } from './dom.js';
import { machineItems, MACHINES_ROUTE, SCREENS, sidebarSections } from './screens.js';
import { CONNECTORS_ROUTE, connectorsDot } from './screens/cloud-format.js';

/** The state of a remote machine, said on its dot: the color alone does not say it. */
export const MACHINE_STATE_LABELS = { connected: 'Conectada', unreachable: 'Sem conexão', 'incompatible-version': 'Versão diferente', 'not-configured': 'Sem configuração' };

/** Draws the sidebar into `nav` at once; `read` is the shell's read layer. */
export function createNav({ nav, read, screens = SCREENS }) {
  const items = new Map();
  const counts = new Map();
  let lit = null;
  let remoteItems = [];
  // The dots that are not a machine's: `id → { state, label }` (Conexões, issue 277).
  const dots = new Map();

  function draw() {
    items.clear();
    const groups = [];
    for (const section of sidebarSections([...screens, ...remoteItems])) {
      const titleId = section.label ? `cc-nav-title-${section.id}` : null;
      const group = el(
        'div',
        { class: 'cc-nav-section', 'data-section': section.id, role: titleId && 'group', 'aria-labelledby': titleId },
        titleId && el('div', { class: 'cc-nav-title eyebrow', id: titleId }, section.label),
      );
      for (const screen of section.items) {
        const q = el('span', { class: 'q', hidden: true });
        const mark = screen.state ? { state: screen.state, label: MACHINE_STATE_LABELS[screen.state] ?? screen.state } : (dots.get(screen.id) ?? null);
        const dot = mark ? el('span', { class: 'cc-nav-dot', 'data-state': mark.state, role: 'img', 'aria-label': mark.label, title: mark.label }) : null;
        const a = el('a', { class: 'cc-nav', href: screen.route, 'data-screen': screen.id }, icon(screen.item.icon), el('span', { class: 'cc-nav-label' }, screen.item.label), dot, q);
        items.set(screen.id, { a, q });
        group.append(a);
      }
      groups.push(group);
    }
    nav.replaceChildren(...groups);
    for (const [id, n] of counts) counter(id, n);
    highlight(lit);
  }

  function highlight(id) {
    lit = id;
    for (const [k, { a }] of items) {
      a.classList.toggle('on', k === id);
      if (k === id) {
        a.setAttribute('aria-current', 'page');
        // On a short window the list scrolls: the lit item must not stay out of sight.
        a.scrollIntoView?.({ block: 'nearest' });
      } else a.removeAttribute('aria-current');
    }
  }

  function counter(id, n) {
    counts.set(id, n);
    const item = items.get(id);
    if (!item) return;
    item.q.hidden = !n;
    item.q.textContent = n ? String(n) : '';
  }

  async function readMachines() {
    let list;
    try {
      list = await read(MACHINES_ROUTE);
    } catch {
      // Without telemetry (404) or offline: the remote items stay as they were.
      return;
    }
    const next = machineItems(list);
    if (JSON.stringify(next) === JSON.stringify(remoteItems)) return;
    remoteItems = next;
    draw();
  }

  async function readConnectors() {
    let next;
    try {
      next = connectorsDot(await read(CONNECTORS_ROUTE));
    } catch (e) {
      // A core without the cloud routes (404): no dot. Offline: the dot stays as it was.
      if (e?.status !== 404) return;
      next = null;
    }
    const before = dots.get('connections') ?? null;
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    if (next) dots.set('connections', next);
    else dots.delete('connections');
    draw();
  }

  draw();
  return { draw, readMachines, readConnectors, highlight, counter };
}
