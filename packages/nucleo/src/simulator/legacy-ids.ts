// The demo's session ids before #173 (phase 3, layer 16), still accepted as input until phase 6:
// a bookmarked session page or a script that asks for a session by its old id (`sim-detalhe-pedidos`,
// `sim-painel-esta`) gets the session under its new id. Only the --demo consults this map (the panel alias, the Detail's
// `local_…` and the server's URLs); the data the screens show (titles, project folders) did not change.

/** Old id → current id, one per demo session whose id had Portuguese words. */
export const LEGACY_DEMO_IDS: Readonly<Record<string, string>> = {
  // Panel scenarios (panel.ts): the prefix, "this session" and the parents from yesterday; the rest
  // of each id is the project folder, which stays.
  'sim-painel-esta': 'sim-panel-current',
  'sim-painel-kanban-ontem': 'sim-panel-kanban-yesterday',
  'sim-painel-vitrine-ontem': 'sim-panel-vitrine-yesterday',
  'sim-painel-vitrine-demo': 'sim-panel-vitrine-demo',
  'sim-painel-motor-de-regras': 'sim-panel-motor-de-regras',
  'sim-painel-app-receitas': 'sim-panel-app-receitas',
  'sim-painel-painel-de-metricas': 'sim-panel-painel-de-metricas',
  'sim-painel-fila-de-tarefas': 'sim-panel-fila-de-tarefas',
  'sim-painel-catalogo-exemplo': 'sim-panel-catalogo-exemplo',
  'sim-painel-blog-estatico': 'sim-panel-blog-estatico',
  // The Detail (detail.ts).
  'sim-detalhe-pedidos': 'sim-detail-orders',
  // P4's ended sessions (history-ended.ts).
  'sim-historico-mapear-pagamentos': 'sim-history-map-payments',
  'sim-historico-extrair-cobranca': 'sim-history-extract-billing',
  'sim-historico-relatorio-mensal': 'sim-history-monthly-report',
  'sim-historico-busca-de-receitas': 'sim-history-recipe-search',
  'sim-historico-regras-de-desconto': 'sim-history-discount-rules',
  'sim-historico-notas-em-markdown': 'sim-history-markdown-notes',
  'sim-historico-agenda-semanal': 'sim-history-weekly-agenda',
  'sim-historico-limites-do-gateway': 'sim-history-gateway-limits',
  // The workflows (workflows.ts); `sim-wf-csv`, `sim-wf-parser` and `sim-wf-cache` did not change.
  'sim-wf-pagamentos': 'sim-wf-payments',
  'sim-wf-triagem': 'sim-wf-triage',
  'sim-wf-bibliotecas': 'sim-wf-libraries',
  'sim-wf-categoria': 'sim-wf-category',
  'sim-wf-erros': 'sim-wf-errors',
  'sim-wf-cadastro': 'sim-wf-signup',
  'sim-wf-retomada': 'sim-wf-resume',
};

/** The current id of a demo session: the old ids become the new ones; any other id stays. */
export const currentDemoId = (id: string): string => (Object.hasOwn(LEGACY_DEMO_IDS, id) ? LEGACY_DEMO_IDS[id] : id);

/**
 * The demo server's URL with the old ids replaced: a path segment or a query value that is exactly an
 * old id (the session in a sessions or panel path, the `session` of the events query). The others
 * come back unchanged, as the same object.
 */
export function upgradeDemoUrl(url: URL): URL {
  let changed = false;
  const segments = url.pathname.split('/').map((s) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      return s;
    }
    const current = currentDemoId(decoded);
    if (current === decoded) return s;
    changed = true;
    return encodeURIComponent(current);
  });
  const params = [...new URLSearchParams(url.search)].map(([key, value]): [string, string] => {
    const current = currentDemoId(value);
    if (current !== value) changed = true;
    return [key, current];
  });
  if (!changed) return url;
  const out = new URL(url.href);
  out.pathname = segments.join('/');
  const search = new URLSearchParams(params).toString();
  out.search = search ? `?${search}` : '';
  return out;
}
