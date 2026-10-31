import { el, header } from '../dom.js';
import { loading, error } from '../states.js';

const STATUS = { read: 'Lido', absent: 'Ausente', unknown: 'Desconhecido' };
const KIND = { system: 'Sistema', user: 'Usuário', profile: 'Perfil', 'legacy-profile': 'Perfil legado', project: 'Projeto', instructions: 'Instruções', skill: 'Skill', mcp: 'MCP' };
export const codexInspectionIncomplete = data => data.layers.some(l => l.status === 'unknown') || data.assets.some(a => a.status === 'unknown') || data.diagnostics.reasons.some(r => /incomplete|unreadable|root-unresolved/.test(r));
export const codexConfigUrl = params => `/api/agent-config/codex?${new URLSearchParams(params)}`;
export async function mountCodexConfig(area, ctx) {
  ctx.title('Configurações do Codex');
  const params = new URLSearchParams(location.search);
  params.delete('provider'); params.delete('tab');
  let sequence = 0;
  const pageHeader = () => header({ icon: 'settings', title: 'Configurações do Codex', sub: 'Esta máquina · somente leitura', actions: [
    el('a', { class: 'btn outline', href: '/ui/agent-config' }, 'Claude'),
    el('a', { class: 'btn outline', href: '/ui/machines/local' }, 'Processos'),
    el('button', { class: 'btn', onClick: load }, 'Atualizar'),
  ] });
  function selector(label, key, options, selected) {
    const input = el('select', { class: 'ac-select', 'aria-label': label }, el('option', { value: '', selected: !selected }, 'Sem seleção'), ...options.map(o => el('option', { value: o.id, selected: o.id === selected }, o.label)));
    input.addEventListener('change', () => {
      if (input.value) params.set(key, input.value); else params.delete(key);
      history.replaceState(null, '', `/ui/agent-config?provider=codex&${params}`);
      load();
    });
    return el('label', { class: 'ac-project-label' }, label, input);
  }
  function rows(settings) {
    return el('div', { class: 'ac-config-scroll' }, el('table', { class: 'ac-config-table' },
      el('thead', {}, el('tr', {}, ...['Chave', 'Declaração', 'Origem', 'Efetiva'].map(t => el('th', {}, t)))),
      el('tbody', {}, ...settings.map(r => el('tr', {}, el('td', { class: 'mono' }, r.key), el('td', {}, String(r.value)), el('td', {}, r.source), el('td', {}, 'Desconhecida'))))));
  }
  async function load() {
    const current = ++sequence;
    area.replaceChildren(pageHeader(), loading({ label: 'Lendo configurações' }));
    try {
      const d = await ctx.read(codexConfigUrl(params));
      if (ctx.signal.aborted || current !== sequence) return;
      if (d.availability === 'unavailable') {
        area.replaceChildren(pageHeader(), el('section', { class: 'card ac-panel' }, el('h2', {}, 'Configuração indisponível'), el('p', {}, 'Esta leitura cobre somente Codex local. Nenhuma configuração local foi atribuída à sessão remota ou de outro provedor.')));
        return;
      }
      const controls = d.session ? el('p', {}, 'Sessão observada · diretório: ', d.project ?? 'Desconhecido', ' · perfil e pasta de configuração: desconhecidos') : el('div', { class: 'ac-roots' }, selector('Projeto', 'project', (d.projects ?? []).map(p => ({ id: p, label: p })), d.project), selector('Perfil para inspeção', 'profile', d.profiles.map(p => ({ ...p, label: `${p.label} · ${p.format === 'file-since-0.134' ? 'arquivo (0.134+)' : 'legado (anterior a 0.134)'}` })), d.profile));
      area.replaceChildren(pageHeader(), controls,
        ...(codexInspectionIncomplete(d) ? [el('section', { class: 'card ac-panel', role: 'status' }, el('h2', {}, 'Inspeção incompleta'), el('p', {}, 'Há fontes inválidas, inacessíveis, limites de leitura atingidos ou raiz do projeto não confirmada. A lista abaixo pode estar incompleta.'))] : []),
        el('section', { class: 'card ac-panel' }, el('h2', {}, 'Configuração efetiva: desconhecida'),
          el('p', {}, 'Inspecionar um perfil não o ativa. Arquivos atuais não comprovam o que a sessão carregou. Versão em execução, login, franquia, ferramentas disponíveis e suporte nativo não foram confirmados. Execução estrita permanece bloqueada.'),
          el('p', {}, 'Valores livres e nomes personalizados são ocultados na API, inclusive comandos, URLs, credenciais e conteúdo de instruções/skills. Nenhum provedor ou helper foi executado.')),
        el('section', { class: 'card ac-panel' }, el('h2', {}, 'Instalação local'),
          el('p', {}, d.installation.status === 'found' ? 'Executável encontrado no PATH inspecionado.' : d.installation.status === 'not-found-on-path' ? 'Não encontrado no PATH inspecionado; outras instalações podem existir.' : 'Instalação da sessão desconhecida.'),
          el('p', {}, 'Versão declarada no pacote local: ', d.installation.version ?? 'Desconhecida', '. A versão da sessão continua desconhecida.')) ,
        el('section', { class: 'card ac-panel' }, el('h2', {}, 'Declarações por origem'),
          el('p', {}, 'Ordem documentada: sistema → nuvem → usuário → perfil → projeto confiável (raiz até diretório atual) → linha de comando. Nuvem, confiança, políticas e argumentos não observados; não há cálculo de configuração efetiva.'), rows(d.declared)),
        el('section', { class: 'card ac-panel' }, el('h2', {}, 'Camadas e fontes'), ...d.layers.map(l => el('details', {}, el('summary', {}, `${KIND[l.kind] ?? l.kind} · ${l.id} · ${STATUS[l.status]}`), el('p', { class: 'mono' }, l.path), rows(l.settings)))),
        el('section', { class: 'card ac-panel' }, el('h2', {}, 'Instruções, skills e MCP encontrados'),
          el('p', {}, 'Presença declarada; aplicação à sessão desconhecida. AGENTS.override.md precede AGENTS.md no mesmo diretório. Codex lê AGENTS.md diretamente, sem importação por CLAUDE.md. Skills de plugins/sistema, caminhos alternativos e ferramentas negociadas não foram enumerados.'),
          ...d.assets.map(a => el('p', {}, `${KIND[a.kind]} · ${a.id} · ${a.source} · ${a.location} · ${STATUS[a.status]} · aplicação desconhecida`)),
          d.assets.length ? '' : el('p', {}, 'Nenhum item encontrado nas fontes inspecionadas.')),
        el('p', {}, 'Precedência e formatos de perfil seguem a documentação oficial do Codex; a versão instalada pode ter regras diferentes.'));
    } catch {
      if (ctx.signal.aborted || current !== sequence) return;
      area.replaceChildren(pageHeader(), error({ text: 'Não foi possível ler a configuração.', retry: load }));
    }
  }
  ctx.onRestart?.(load);
  await load();
}
