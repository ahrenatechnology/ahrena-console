import { el, header } from '../dom.js';
import { loading, error } from '../states.js';

const KIND = { user: 'Usuário', project: 'Projeto', local: 'Local', managed: 'Gerenciada', auxiliary: 'Fonte separada' };
const STATUS = { read: 'Lido', absent: 'Ausente', unknown: 'Desconhecido' };
const shown = value => value === null || value === undefined ? 'Desconhecido' : String(value);
export function configHighlights(data) {
  const value = key => data.declared.find(r => r.key === key)?.value;
  return [
    ['Modelo declarado', value('model')],
    ['Modelo dos subagentes declarado', value('env.CLAUDE_CODE_SUBAGENT_MODEL')],
    ['Compactação declarada (%)', value('env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')],
    ['Janela de compactação declarada (tokens)', value('env.CLAUDE_CODE_AUTO_COMPACT_WINDOW') ?? value('autoCompactWindow')],
    ['Janela confirmada (tokens)', data.runtime.contextWindow],
    ['Contexto atual (tokens)', data.runtime.contextUsed],
    ['Até compactar (tokens)', data.runtime.remaining],
  ];
}

export async function mountClaudeConfig(area, ctx) {
  ctx.title('Configurações do Claude');
  const params = new URLSearchParams(location.search);
  params.delete('tab');
  let sequence = 0;
  const pageHeader = () => header({ icon: 'settings', title: 'Configurações do Claude', sub: 'Esta máquina · somente leitura', actions: [el('a', { class: 'btn outline', href: '/ui/agent-config?provider=codex' }, 'Codex'), el('a', { class: 'btn outline', href: '/ui/agent-config' }, 'Agent Config'), el('button', { class: 'btn', onClick: load }, 'Atualizar')] });
  async function load() {
    const current = ++sequence;
    area.replaceChildren(pageHeader(), loading({ label: 'Lendo configurações' }));
    try {
      const d = await ctx.read(`/api/agent-config/claude?${params}`);
      if (ctx.signal.aborted || current !== sequence) return;
      draw(d);
    } catch (e) {
      if (ctx.signal.aborted || current !== sequence) return;
      area.replaceChildren(pageHeader(), error({ text: 'Não foi possível ler a configuração.', retry: load }));
    }
  }
  function selector(label, key, values, selected) {
    const select = el('select', { class: 'ac-select', 'aria-label': label },
      el('option', { value: '', selected: !selected }, 'Selecione'),
      ...values.map(v => el('option', { value: v.id, selected: v.id === selected }, v.path)));
    select.addEventListener('change', () => {
      if (select.value) params.set(key, select.value); else params.delete(key);
      history.replaceState(null, '', `/ui/agent-config?tab=settings&${params}`);
      load();
    });
    return el('label', { class: 'ac-project-label' }, label, select);
  }
  function rowsTable(rows) {
    return el('div', { class: 'ac-config-scroll' }, el('table', { class: 'ac-config-table' },
      el('thead', {}, el('tr', {}, ...['Chave', 'Valor declarado', 'Origem', 'Sobrescritas', 'Runtime'].map(t => el('th', {}, t)))),
      el('tbody', {}, ...rows.map(r => el('tr', {},
        el('td', { class: 'mono' }, r.key.replace(/\[entry (\d+)\]/g, '[entrada $1]').replace('[truncated]', '[leitura incompleta]')), el('td', {}, shown(r.value), r.itemCount === undefined ? '' : ` (${r.itemCount} itens)`, r.resolution === 'unknown' ? ' · resolução desconhecida' : ''),
        el('td', {}, r.sources.join(', ')), el('td', {}, r.overridden.join(', ') || '—'), el('td', {}, 'Desconhecido'))))));
  }
  function draw(d) {
    if (d.availability === 'unavailable') {
      area.replaceChildren(pageHeader(), el('section', { class: 'card ac-panel' }, el('h2', {}, 'Configuração indisponível'), el('p', {}, 'Esta leitura cobre apenas Claude nesta máquina. Configuração remota e de outros provedores não foi consultada.')));
      return;
    }
    const controls = d.session ? el('p', {}, 'Diretório da sessão: ', d.project ?? 'Desconhecido', ' · Perfil: ', d.profiles.find(p => p.id === d.profile)?.path ?? 'Desconhecido') : el('div', { class: 'ac-roots' },
      selector('Projeto', 'project', (d.projects ?? []).map(path => ({ id: path, path })), d.project), selector('Perfil', 'profile', d.profiles, d.profile));
    area.replaceChildren(pageHeader(), controls,
      el('section', { class: 'card ac-panel' }, el('h2', {}, 'Configuração efetiva: desconhecida'),
        el('p', {}, 'Arquivos atuais não confirmam o que a sessão carregou. Ambiente de lançamento, linha de comando e políticas do sistema ou servidor não foram observados. A franquia não foi comprovada; execução estrita permanece bloqueada.'),
        el('p', {}, 'Valores livres, comandos, URLs e segredos são ocultados antes de sair da API. Fontes separadas não entram na precedência dos settings.')),
      el('div', { class: 'ac-summary' }, ...configHighlights(d).map(([label, value]) => el('section', { class: 'card ac-panel' }, el('div', { class: 'eyebrow' }, label), el('b', {}, shown(value))))),
      el('p', { class: 'ac-muted' }, 'Percentual declarado não comprova o limite real em tokens. Janela e margem até compactar exigem evidência do runtime; nenhuma janela é inferida pelo nome do modelo.'),
      el('section', { class: 'card ac-panel' }, el('h2', {}, 'Declarações por origem'), el('p', {}, 'Ordem dos arquivos: usuário → projeto → local → gerenciada. Regras específicas de listas e políticas permanecem desconhecidas.'), rowsTable(d.declared)),
      el('section', { class: 'card ac-panel' }, el('h2', {}, 'Camadas e fontes'), ...d.layers.map(layer => el('details', {},
        el('summary', {}, `${KIND[layer.kind] ?? layer.kind} · ${layer.id} · ${STATUS[layer.status]}`),
        el('p', { class: 'mono' }, layer.path ?? 'Origem não confirmada'), rowsTable(layer.settings)))),
      el('section', { class: 'card ac-panel' }, el('h2', {}, 'Diagnóstico de autenticação'),
        el('p', {}, 'Somente presença de configuração; login, conta e modalidade de cobrança não confirmados.'),
        ...d.diagnostics.authSources.map(s => el('p', {}, `${s.kind} · ${s.source} · presente (valor oculto)`))),
      el('p', {}, 'Referências: ', el('a', { href: 'https://code.claude.com/docs/en/settings', target: '_blank', rel: 'noreferrer' }, 'precedência'), ' · ', el('a', { href: 'https://code.claude.com/docs/en/model-config', target: '_blank', rel: 'noreferrer' }, 'modelos e compactação')));
  }
  ctx.onRestart?.(load);
  await load();
}
