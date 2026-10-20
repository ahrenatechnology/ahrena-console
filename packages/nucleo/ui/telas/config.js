// A tela Agent Config (#63, wireframes C16 e C17): o que o Claude Code tem configurado nesta máquina
// e no projeto escolhido, e a edição de uma skill com backup.
//
// - A aba e o projeto moram na URL: `/ui/config?aba=skills&projeto=<abs>`. Trocar de aba é um
//   `pushState` dentro da tela (sem reler); o Voltar do navegador remonta a tela, que desenha na hora
//   com o que já leu e relê por trás.
// - O escopo (Todos, Usuário, Projeto) e a busca filtram no cliente.
// - Leitura por `ctx.ler('/api/config…')`; gravação por `ctx.escrever('/api/config/skill', …)`.
//   Com a raiz `p` (a `.claude` do projeto), o pedido leva sempre o `projeto`.
// - Apagar skill fica fora (decisão do dono): não há botão.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';

// ---------- Funções puras (testadas em test/api/ui.test.ts) ----------

/** O mesmo padrão de nome do núcleo (src/config/skills.ts). */
export const NOME_DE_SKILL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const ABAS = [
  { id: 'visao', rotulo: 'Visão geral', icone: 'mural' },
  { id: 'skills', rotulo: 'Skills', icone: 'sparkles', resumo: 'skills' },
  { id: 'subagentes', rotulo: 'Subagentes', icone: 'users', resumo: 'subagentes' },
  { id: 'comandos', rotulo: 'Comandos', icone: 'slash', resumo: 'comandos' },
  { id: 'memoria', rotulo: 'Memória', icone: 'book-open', resumo: 'memoria' },
  { id: 'plugins', rotulo: 'Plugins', icone: 'plug', resumo: 'plugins' },
  { id: 'mcp', rotulo: 'MCP', icone: 'server', resumo: 'mcp' },
  { id: 'hooks', rotulo: 'Hooks', icone: 'webhook', resumo: 'hooks' },
];

const RESUMO = [
  ['skills', 'sparkles', 'Skills'],
  ['subagentes', 'users', 'Subagentes'],
  ['comandos', 'slash', 'Comandos'],
  ['mcp', 'server', 'Servidores MCP'],
  ['plugins', 'plug', 'Plugins'],
  ['hooks', 'webhook', 'Hooks'],
  ['memoria', 'book-open', 'Memória'],
  ['configuracoes', 'settings', 'Configurações'],
];

export const ESCOPOS = [
  ['todos', 'Todos os escopos'],
  ['usuario', 'Usuário'],
  ['projeto', 'Projeto'],
];
const ROTULO_DO_ESCOPO = { usuario: 'Usuário', projeto: 'Projeto' };

/** A aba e o projeto de uma query (`?aba=skills&projeto=/x`); aba desconhecida vira a Visão geral. */
export function lerUrl(search) {
  const q = new URLSearchParams(search);
  const aba = q.get('aba');
  return { aba: ABAS.some((a) => a.id === aba) ? aba : 'visao', projeto: q.get('projeto') || null };
}

/** O caminho da tela para uma aba e um projeto. */
export function urlDa({ aba = 'visao', projeto = null } = {}) {
  const q = new URLSearchParams();
  if (aba && aba !== 'visao') q.set('aba', aba);
  if (projeto) q.set('projeto', projeto);
  const s = q.toString();
  return `/ui/config${s ? `?${s}` : ''}`;
}

/** Os itens de um escopo (`todos` devolve a lista como veio). */
export function doEscopo(itens, escopo) {
  return escopo === 'usuario' || escopo === 'projeto' ? itens.filter((i) => i.escopo === escopo) : itens;
}

const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** A busca de skills: no nome da pasta, no `name` do frontmatter e na descrição, sem caixa nem acento. */
export function buscarSkills(skills, termo) {
  const t = semAcento(termo).trim();
  if (!t) return skills;
  return skills.filter((s) => [s.nome, s.nomeDeclarado, s.descricao].some((c) => semAcento(c).includes(t)));
}

/** "editado há 3 dias", a partir do `editadoEm` (ms). */
export function editadoHa(ms, agora = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, (agora - ms) / 1000);
  if (s < 60) return 'editado agora';
  const min = Math.floor(s / 60);
  if (min < 60) return `editado há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `editado há ${h} h`;
  const d = Math.floor(h / 24);
  return `editado há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

/** A mensagem de erro do nome de uma skill nova, ou `null` se ele serve. */
export function validarNomeDeSkill(nome, existentes = new Set()) {
  if (!nome) return 'Dê um nome à skill.';
  if (!NOME_DE_SKILL.test(nome)) return 'Use minúsculas, números, ponto, hífen ou sublinhado, começando por letra ou número (até 64).';
  if (existentes.has(nome)) return 'Já existe uma skill com esse nome nessa pasta.';
  return null;
}

/** O SKILL.md com que uma skill nova começa. */
export function modeloDeSkill(nome) {
  return `---\nname: ${nome}\ndescription: O que a skill faz e quando o Claude deve usá-la.\n---\n\n# ${nome}\n\n`;
}

/** O número grande de um cartão do resumo, no escopo escolhido. */
export function numeroDo(contagem, escopo) {
  if (!contagem) return 0;
  return escopo === 'usuario' ? contagem.usuario : escopo === 'projeto' ? contagem.projeto : contagem.total;
}

/** A legenda de um cartão do resumo: "18 do usuário · 6 do projeto", ou só o escopo filtrado. */
export function legendaDo(contagem, escopo) {
  if (escopo === 'usuario') return 'do usuário';
  if (escopo === 'projeto') return 'do projeto';
  return `${contagem?.usuario ?? 0} do usuário · ${contagem?.projeto ?? 0} do projeto`;
}

// ---------- Estado da tela (sobrevive ao Voltar: a tela remonta e desenha com o que já tem) ----------

const estado = {
  escopo: 'todos',
  busca: '',
  /** A última resposta de `/api/config` e o `?projeto=` que a pediu. */
  dados: null,
  pedido: undefined,
  /** O editor aberto: `{ raiz, nome, escopo, caminho, modo: 'ver'|'editar'|'nova', conteudo, texto, versao, editadoEm, projeto, carregando, salvando, erro, aviso }`. */
  editor: null,
  /** A skill nova sendo nomeada: `{ nome, raiz, erro }`. */
  nova: null,
  backupsAbertos: false,
  /** Os backups feitos por esta janela, mais recentes primeiro. */
  backupsDaJanela: [],
};

const SUB = 'Seu Claude Code: skills, subagentes, comandos, MCP, hooks e memória';

/** O CSS da tela, uma vez só no `<head>`; espera carregar para não piscar sem estilo. */
function garantirCss() {
  let link = document.querySelector('link[data-tela="config"]');
  if (link) return Promise.resolve();
  link = el('link', { rel: 'stylesheet', 'data-tela': 'config', href: '/ui/config.css' });
  const pronto = new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 1500);
  });
  document.head.append(link);
  return pronto;
}

const sujo = (ed) => !!ed && ((ed.modo === 'nova' && ed.texto !== modeloDeSkill(ed.nome)) || (ed.modo === 'editar' && ed.texto !== ed.conteudo));
/** Pode salvar: a skill foi lida (tem `versao`) ou é nova. Sem isso, um POST sem `versao` trocaria o arquivo às cegas. */
const podeSalvar = (ed) => !!ed && !ed.carregando && !ed.salvando && (ed.modo === 'nova' || (ed.modo === 'editar' && !!ed.versao && ed.texto !== ed.conteudo));

// Fechar ou recarregar a janela com texto não salvo pergunta antes.
globalThis.addEventListener?.('beforeunload', (ev) => {
  if (sujo(estado.editor)) ev.preventDefault();
});

export async function montar(area, ctx) {
  let url = lerUrl(location.search);
  const sinal = ctx.sinal;
  await garantirCss();
  if (sinal.aborted) return;
  /** O `data-foco` a focar depois do próximo desenho (Cancelar da Nova volta ao botão Nova…). */
  let focoPedido = null;
  /** Só a última leitura de `/api/config` vale: uma resposta atrasada de outro projeto é descartada. */
  let leitura = 0;

  // ---------- Cabeçalho ----------
  const lugarDoProjeto = el('span', { class: 'cfg-projeto' });
  const seg = el('div', { class: 'cfg-seg', role: 'group', 'aria-label': 'Escopo' });
  const botaoAtualizar = el('button', { type: 'button', class: 'btn', aoClicar: () => carregar({ silencioso: true, comSkill: true }) }, icone('atualizar'), 'Atualizar');
  const cab = cabecalho({ icone: 'bot', titulo: 'Agent Config', sub: SUB, acoes: [lugarDoProjeto, seg, botaoAtualizar] });

  function desenharSeg() {
    seg.replaceChildren(
      ...ESCOPOS.map(([id, rotulo]) =>
        el('button', { type: 'button', 'data-foco': `escopo:${id}`, 'aria-pressed': String(estado.escopo === id), aoClicar: () => ((estado.escopo = id), desenhar()) }, rotulo),
      ),
    );
  }

  function desenharProjeto() {
    const d = estado.dados;
    if (!d || d.projetos.length < 2) return lugarDoProjeto.replaceChildren();
    const select = el(
      'select',
      { class: 'cfg-select', 'data-foco': 'projeto', 'aria-label': 'Projeto', title: d.projeto ?? '' },
      ...d.projetos.map((p) => el('option', { value: p, selected: p === d.projeto }, nomeCurto(p))),
    );
    select.addEventListener('change', () => {
      if (sujo(estado.editor) && !confirm('Descartar as alterações da skill aberta?')) return void (select.value = d.projeto);
      estado.editor = null;
      estado.nova = null;
      irPara({ aba: url.aba, projeto: select.value });
      carregar();
    });
    lugarDoProjeto.replaceChildren(el('label', { class: 'cfg-projeto-rotulo' }, icone('pasta'), select));
  }

  // ---------- Navegação dentro da tela ----------
  function irPara(destino) {
    const rota = urlDa(destino);
    if (rota !== location.pathname + location.search) history.pushState(null, '', rota);
    url = lerUrl(location.search);
  }

  function abas() {
    const d = estado.dados;
    return el(
      'nav',
      { class: 'cfg-abas', 'aria-label': 'Partes da configuração' },
      ...ABAS.map((a) => {
        const n = a.resumo ? numeroDo(d?.resumo?.[a.resumo], estado.escopo) : null;
        const link = el(
          'a',
          { href: urlDa({ aba: a.id, projeto: url.projeto }), 'data-foco': `aba:${a.id}`, class: a.id === url.aba ? 'on' : null, 'aria-current': a.id === url.aba ? 'page' : null },
          icone(a.icone),
          a.rotulo,
          n === null ? null : el('span', { class: 'cfg-chip' }, String(n)),
        );
        link.addEventListener('click', (ev) => {
          if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
          ev.preventDefault();
          irPara({ aba: a.id, projeto: url.projeto });
          desenhar();
        });
        return link;
      }),
    );
  }

  // ---------- Leitura ----------
  let faixaDeLeitura = null;

  async function carregar({ silencioso = false, comSkill = false } = {}) {
    const pedido = url.projeto;
    const minha = ++leitura;
    const valeAinda = () => !sinal.aborted && minha === leitura && pedido === url.projeto;
    if (!silencioso || !estado.dados) area.replaceChildren(cab, carregando({ rotulo: 'Lendo as pastas de configuração' }));
    try {
      const dados = await ctx.ler(`/api/config${pedido ? `?projeto=${encodeURIComponent(pedido)}` : ''}`);
      if (!valeAinda()) return;
      estado.dados = dados;
      estado.pedido = pedido;
      faixaDeLeitura = null;
      desenhar();
      if (comSkill && estado.editor && !sujo(estado.editor) && estado.editor.modo !== 'nova') abrirSkill(estado.editor, estado.editor.modo);
    } catch (e) {
      if (e?.name === 'AbortError' || !valeAinda()) return;
      if (e?.status === 400 && pedido) {
        area.replaceChildren(
          cab,
          vazio({
            icone: 'pasta',
            titulo: 'Projeto desconhecido',
            texto: `${pedido} não está entre os projetos das sessões desta máquina.`,
            acao: { rotulo: 'Abrir o projeto mais recente', aoClicar: () => (irPara({ aba: url.aba }), carregar()) },
          }),
        );
        return;
      }
      if (silencioso && estado.dados) {
        faixaDeLeitura = faixaDeErro({ titulo: 'Não releu.', texto: e?.message ?? String(e), acao: { rotulo: 'Tentar de novo', aoClicar: () => carregar({ silencioso: true }) } });
        desenhar();
        return;
      }
      area.replaceChildren(cab, erro({ texto: e?.message ?? String(e), tentar: () => carregar() }));
    }
  }

  // ---------- Desenho ----------
  function desenhar() {
    if (sinal.aborted) return;
    const d = estado.dados;
    if (!d) return;
    // Redesenhar não tira o foco (nem o cursor) de quem está no teclado: o controle equivalente,
    // achado pelo `data-foco`, volta a ter o foco. `focoPedido` diz para onde ir quando o controle some.
    const ativo = document.activeElement;
    const chave = focoPedido ?? (area.contains(ativo) ? ativo?.dataset?.foco : null);
    const texto = !focoPedido && ativo && 'selectionStart' in ativo && area.contains(ativo) ? { de: ativo.selectionStart, ate: ativo.selectionEnd, rolagem: ativo.scrollTop } : null;
    focoPedido = null;
    const aba = ABAS.find((a) => a.id === url.aba);
    ctx.titulo(url.aba === 'visao' ? 'Agent Config' : `Agent Config · ${aba.rotulo}`);
    desenharSeg();
    desenharProjeto();
    const partes = [cab, faixaDeLeitura];
    if (url.aba === 'visao') partes.push(...visaoGeral(d));
    else partes.push(abas(), url.aba === 'skills' ? skills(d) : listaSimples(d, url.aba));
    area.replaceChildren(...partes.filter(Boolean));
    const novo = chave ? area.querySelector(`[data-foco="${CSS.escape(chave)}"]`) : null;
    if (novo && !novo.disabled) {
      novo.focus();
      if (texto && 'selectionStart' in novo) {
        try {
          novo.setSelectionRange(texto.de, texto.ate);
        } catch {}
        novo.scrollTop = texto.rolagem;
      }
    }
  }

  // ---------- C16 · Visão geral ----------
  function visaoGeral(d) {
    const raizes = doEscopo(d.raizes, estado.escopo);
    const botaoBackups = el(
      'button',
      { type: 'button', class: 'btn contorno', 'data-foco': 'backups', 'aria-expanded': String(estado.backupsAbertos), 'aria-controls': estado.backupsAbertos ? 'cfg-backups' : null },
      icone('historico'),
      'Backups',
    );
    botaoBackups.addEventListener('click', () => ((estado.backupsAbertos = !estado.backupsAbertos), desenhar()));
    const faixa = el(
      'div',
      { class: 'cfg-faixa' },
      el('span', { class: 'cfg-faixa-ico' }, icone('shield-check')),
      el(
        'p',
        {},
        el('b', {}, 'Edição ligada.'),
        ' Ver é livre. Ao salvar uma skill, o núcleo guarda o SKILL.md anterior na pasta de backups antes de gravar o novo.',
      ),
      botaoBackups,
    );
    const backups = estado.backupsAbertos
      ? el(
          'section',
          { class: 'cartao cfg-painel', id: 'cfg-backups' },
          el('div', { class: 'olhinho' }, 'Backups'),
          d.backups ? cartaoDeCaminho('Pasta dos backups', d.backups, 'historico') : el('p', { class: 'cfg-mudo' }, 'O núcleo não informou a pasta dos backups.'),
          estado.backupsDaJanela.length
            ? el('ul', { class: 'cfg-backups' }, ...estado.backupsDaJanela.map((b) => el('li', { class: 'mono' }, b)))
            : el('p', { class: 'cfg-mudo' }, 'Nenhuma gravação com backup nesta janela ainda.'),
        )
      : null;
    return [
      faixa,
      backups,
      abas(),
      el(
        'section',
        { class: 'cartao cfg-painel' },
        el('div', { class: 'olhinho' }, 'Raízes'),
        raizes.length
          ? el('div', { class: 'cfg-raizes' }, ...raizes.map((r) => cartaoDeCaminho(r.rotulo, r.caminho, 'folder-tree')))
          : el('p', { class: 'cfg-mudo' }, 'Nenhuma raiz neste escopo.'),
        el('div', { class: 'olhinho' }, 'Resumo'),
        el(
          'div',
          { class: 'cfg-resumo' },
          ...RESUMO.map(([chave, ic, rotulo]) =>
            el(
              'div',
              { class: 'cfg-numero' },
              el('div', { class: 'olhinho' }, el('span', { class: 'cfg-acento' }, icone(ic)), rotulo),
              el('div', { class: 'cfg-numero-linha' }, el('span', { class: 'mono cfg-grande' }, String(numeroDo(d.resumo[chave], estado.escopo))), el('span', { class: 'cfg-mudo' }, legendaDo(d.resumo[chave], estado.escopo))),
            ),
          ),
        ),
      ),
    ];
  }

  function cartaoDeCaminho(rotulo, caminho, ic) {
    const texto = el('div', { class: 'mono cfg-trunc cfg-caminho cfg-corta-inicio', title: caminho }, el('bdi', { dir: 'ltr' }, caminho));
    const copiar = el('button', { type: 'button', class: 'cfg-copiar', title: `Copiar ${caminho}`, 'aria-label': `Copiar o caminho de ${rotulo}` }, icone('copiar'));
    copiar.addEventListener('click', () => copiarTexto(caminho, copiar, texto));
    return el(
      'div',
      { class: 'cfg-raiz' },
      el('span', { class: 'cfg-acento' }, icone(ic)),
      el('div', { class: 'cfg-trunc cfg-cresce' }, el('div', { class: 'olhinho cfg-olhinho-p' }, rotulo), texto),
      copiar,
    );
  }

  // ---------- C17 · Skills ----------
  function raizesDeSkill(d) {
    return d.raizes.filter((r) => r.tipo === 'home' || r.tipo === 'claude-projeto');
  }

  function skills(d) {
    const lista = el('div', { class: 'cfg-lista' });
    const desenharLista = () => {
      const achadas = buscarSkills(doEscopo(d.skills, estado.escopo), estado.busca);
      lista.replaceChildren(
        ...(achadas.length
          ? achadas.map(cartaoDeSkill)
          : [
              vazio({
                icone: 'sparkles',
                titulo: estado.busca ? 'Nenhuma skill com essa busca' : 'Nenhuma skill neste escopo',
                texto: estado.busca ? `Nada em ${d.skills.length} skill(s) bate com “${estado.busca}”.` : `Há ${d.resumo.skills.total} skill(s) em todos os escopos.`,
              }),
            ]),
      );
    };
    const busca = el('input', { type: 'buscar', 'data-foco': 'busca', class: 'cfg-entrada', placeholder: 'Buscar skills…', 'aria-label': 'Buscar skills', value: estado.busca, autocomplete: 'off', spellcheck: 'false' });
    busca.addEventListener('input', () => ((estado.busca = busca.value), desenharLista()));
    const nova = el('button', { type: 'button', class: 'btn cheio cfg-acao', 'data-foco': 'nova', 'aria-expanded': String(!!estado.nova) }, icone('plus'), 'Nova');
    nova.addEventListener('click', () => {
      const primeira = raizesDeSkill(d)[0];
      estado.nova = estado.nova ? null : { nome: '', raiz: primeira?.id ?? null, erro: null };
      focoPedido = estado.nova ? 'nova-nome' : 'nova';
      desenhar();
    });
    desenharLista();
    return el(
      'div',
      { class: 'cfg-skills' },
      el('div', { class: 'cfg-coluna' }, el('div', { class: 'cfg-busca-linha' }, el('label', { class: 'cfg-campo' }, icone('buscar'), busca), nova), estado.nova ? formularioNova(d) : null, lista),
      editor(),
    );
  }

  function cartaoDeSkill(s) {
    const ed = estado.editor;
    const aberta = ed && ed.raiz === s.raiz && ed.nome === s.nome;
    return el(
      'article',
      { class: `cartao cfg-item${aberta ? ' sel' : ''}` },
      el(
        'div',
        { class: 'cfg-item-linha' },
        el('span', { class: 'cfg-acento' }, icone('sparkles')),
        el('b', { class: 'cfg-trunc' }, s.nome),
        el('span', { class: 'cfg-chip' }, ROTULO_DO_ESCOPO[s.escopo] ?? s.escopo),
        s.nomeDeclarado && s.nomeDeclarado !== s.nome ? el('span', { class: 'mono cfg-mudo cfg-trunc', title: 'O name do frontmatter' }, `name: ${s.nomeDeclarado}`) : null,
      ),
      el('span', { class: `cfg-trunc ${s.descricao ? 'cfg-mudo' : 'cfg-mudo cfg-italico'}` }, s.descricao ?? 'Sem descrição no frontmatter'),
      el(
        'div',
        { class: 'cfg-item-linha cfg-item-pe' },
        caminhoEl(s.caminho, 'cfg-cresce'),
        el('button', { type: 'button', class: 'cfg-link', 'data-foco': `ver:${s.raiz}/${s.nome}`, 'aria-label': `Ver ${s.nome}`, aoClicar: () => trocarPara(s, 'ver') }, 'Ver'),
        s.editavel ? el('button', { type: 'button', class: 'cfg-link', 'data-foco': `editar:${s.raiz}/${s.nome}`, 'aria-label': `Editar ${s.nome}`, aoClicar: () => trocarPara(s, 'editar') }, 'Editar') : null,
      ),
    );
  }

  function trocarPara(s, modo) {
    const ed = estado.editor;
    if (ed && ed.raiz === s.raiz && ed.nome === s.nome && !ed.carregando && ed.modo !== 'nova') {
      if (modo === 'editar' && ed.modo === 'ver') {
        ed.modo = 'editar';
        ed.aviso = null;
        focoPedido = 'texto';
        desenhar();
      }
      return;
    }
    if (sujo(ed) && !confirm('Descartar as alterações da skill aberta?')) return;
    abrirSkill(s, modo);
  }

  async function abrirSkill(s, modo) {
    const d = estado.dados;
    const ed = { raiz: s.raiz, nome: s.nome, escopo: s.escopo, caminho: s.caminho, modo, conteudo: '', texto: '', versao: null, editadoEm: s.editadoEm ?? null, projeto: d.projeto ?? null, carregando: true, salvando: false, erro: null, aviso: null };
    estado.editor = ed;
    estado.nova = null;
    desenhar();
    const q = new URLSearchParams({ raiz: s.raiz, nome: s.nome });
    if (d.projeto) q.set('projeto', d.projeto);
    try {
      const r = await ctx.ler(`/api/config/skill?${q}`);
      if (sinal.aborted || estado.editor !== ed) return;
      Object.assign(ed, { conteudo: r.conteudo, texto: r.conteudo, versao: r.versao, editadoEm: r.editadoEm, caminho: r.caminho, carregando: false });
    } catch (e) {
      if (e?.name === 'AbortError' || sinal.aborted || estado.editor !== ed) return;
      // Sem a leitura não há `versao`: fica só leitura, sem Salvar (um POST sem versão trocaria o arquivo).
      Object.assign(ed, { carregando: false, modo: 'ver', erro: { titulo: 'Não abriu.', texto: e?.message ?? String(e), acao: { rotulo: 'Tentar de novo', aoClicar: () => abrirSkill(ed, modo) } } });
    }
    if (modo === 'editar' && !ed.erro) focoPedido = 'texto';
    desenhar();
  }

  function formularioNova(d) {
    const nova = estado.nova;
    const opcoes = raizesDeSkill(d);
    const variosPerfis = opcoes.filter((r) => r.tipo === 'home').length > 1;
    const entrada = el('input', { type: 'text', class: 'cfg-entrada mono', id: 'cfg-nova-nome', 'data-foco': 'nova-nome', value: nova.nome, autocomplete: 'off', spellcheck: 'false', maxlength: '64', placeholder: 'minha-skill', 'aria-describedby': 'cfg-nova-msg', 'aria-invalid': nova.erro ? 'true' : null });
    const msg = el('p', { class: `cfg-nova-msg${nova.erro ? ' erro' : ''}`, id: 'cfg-nova-msg', 'aria-live': 'polite' }, nova.erro ?? 'Minúsculas, números, ponto, hífen ou sublinhado.');
    const existentes = () => new Set(d.skills.filter((s) => s.raiz === nova.raiz).map((s) => s.nome));
    entrada.addEventListener('input', () => {
      nova.nome = entrada.value.trim();
      nova.erro = nova.nome ? validarNomeDeSkill(nova.nome, existentes()) : null;
      msg.textContent = nova.erro ?? 'Minúsculas, números, ponto, hífen ou sublinhado.';
      msg.classList.toggle('erro', !!nova.erro);
      if (nova.erro) entrada.setAttribute('aria-invalid', 'true');
      else entrada.removeAttribute('aria-invalid');
    });
    const escolha = el(
      'div',
      { class: 'cfg-seg', role: 'group', 'aria-label': 'Onde criar' },
      ...opcoes.map((r) =>
        el(
          'button',
          { type: 'button', 'data-foco': `nova-raiz:${r.id}`, 'aria-pressed': String(nova.raiz === r.id), title: r.caminho, aoClicar: () => ((nova.raiz = r.id), (nova.erro = nova.nome ? validarNomeDeSkill(nova.nome, existentes()) : null), desenhar()) },
          r.tipo === 'home' ? (variosPerfis ? `Usuário · ${r.rotulo}` : 'Usuário') : 'Projeto',
        ),
      ),
    );
    const form = el(
      'form',
      { class: 'cartao cfg-nova', novalidate: true, 'aria-label': 'Nova skill' },
      el('label', { class: 'olhinho', for: 'cfg-nova-nome' }, 'Nome da skill'),
      entrada,
      msg,
      el('div', { class: 'olhinho' }, 'Escopo'),
      opcoes.length ? escolha : el('p', { class: 'cfg-mudo' }, 'Nenhuma pasta recebe skill aqui.'),
      el(
        'div',
        { class: 'cfg-pe' },
        el('button', { type: 'button', class: 'btn contorno cfg-empurra', aoClicar: () => ((estado.nova = null), (focoPedido = 'nova'), desenhar()) }, 'Cancelar'),
        el('button', { type: 'submit', class: 'btn cheio cfg-acao', disabled: !opcoes.length }, icone('plus'), 'Criar'),
      ),
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      nova.nome = entrada.value.trim();
      nova.erro = validarNomeDeSkill(nova.nome, existentes());
      const raiz = opcoes.find((r) => r.id === nova.raiz);
      if (!nova.erro && !raiz) nova.erro = 'Escolha onde criar.';
      if (nova.erro) {
        focoPedido = 'nova-nome';
        desenhar();
        return;
      }
      if (sujo(estado.editor) && !confirm('Descartar as alterações da skill aberta?')) return;
      estado.editor = {
        raiz: raiz.id,
        nome: nova.nome,
        escopo: raiz.escopo,
        caminho: `${raiz.caminho}/skills/${nova.nome}/SKILL.md`,
        modo: 'nova',
        conteudo: '',
        texto: modeloDeSkill(nova.nome),
        versao: null,
        editadoEm: null,
        projeto: d.projeto ?? null,
        carregando: false,
        salvando: false,
        erro: null,
        aviso: null,
      };
      estado.nova = null;
      focoPedido = 'texto';
      desenhar();
    });
    return form;
  }

  function editor() {
    const ed = estado.editor;
    if (!ed) {
      return el(
        'section',
        { class: 'cartao cfg-editor cfg-editor-vazio' },
        el('div', { class: 'selo' }, icone('file-text')),
        el('p', { class: 'cfg-mudo' }, 'Escolha uma skill para ver ou editar o SKILL.md, ou crie uma com Nova.'),
      );
    }
    const quando = ed.modo === 'nova' ? 'nova' : ed.carregando ? 'abrindo…' : editadoHa(ed.editadoEm);
    const texto = el('textarea', {
      class: 'cfg-texto mono',
      'data-foco': 'texto',
      'aria-label': `${ed.nome} / SKILL.md`,
      spellcheck: 'false',
      readonly: ed.modo === 'ver' || ed.carregando || ed.salvando,
      'aria-busy': ed.carregando ? 'true' : null,
    });
    texto.value = ed.texto;
    const estadoPe = el('span', { class: 'cfg-mudo cfg-estado-pe', 'aria-live': 'polite' });
    const salvar = el('button', { type: 'button', class: 'btn cheio cfg-acao' }, icone('save'), ed.salvando ? 'Salvando…' : 'Salvar com backup');
    const atualizarPe = () => {
      salvar.disabled = !podeSalvar(ed);
      estadoPe.replaceChildren(
        ...(ed.modo === 'ver'
          ? [icone('lock'), ' Só leitura']
          : sujo(ed) && ed.modo !== 'nova'
            ? ['Alterações não salvas']
            : [icone('shield-check'), ed.modo === 'nova' ? ' Cria a pasta e o SKILL.md' : ' Toda gravação faz backup antes']),
      );
    };
    texto.addEventListener('input', () => {
      ed.texto = texto.value;
      if (ed.aviso) {
        ed.aviso = null;
        area.querySelector('.cfg-ok')?.remove();
      }
      atualizarPe();
    });
    salvar.addEventListener('click', () => gravar(ed));
    const fechar = el('button', { type: 'button', class: 'btn contorno', 'data-foco': 'fechar' }, ed.modo === 'ver' ? 'Fechar' : 'Cancelar');
    fechar.addEventListener('click', () => {
      if (sujo(ed) && !confirm('Descartar as alterações?')) return;
      if (ed.modo === 'editar') {
        // Cancelar a edição volta ao texto lido, em modo de leitura.
        Object.assign(ed, { modo: 'ver', texto: ed.conteudo, erro: null, aviso: null });
      } else {
        estado.editor = null;
        focoPedido = ed.modo === 'nova' ? 'nova' : `ver:${ed.raiz}/${ed.nome}`;
      }
      desenhar();
    });
    const editavel = estado.dados?.skills.find((s) => s.raiz === ed.raiz && s.nome === ed.nome)?.editavel;
    atualizarPe();
    return el(
      'section',
      { class: 'cartao cfg-editor', 'aria-label': `Editor de ${ed.nome}` },
      el('div', { class: 'cfg-ttl' }, icone('file-text'), el('span', { class: 'cfg-trunc' }, `${ed.nome} / SKILL.md`), el('span', { class: 'cfg-ttl-r' }, `${ROTULO_DO_ESCOPO[ed.escopo] ?? ed.escopo} · ${quando}`)),
      caminhoEl(ed.caminho),
      ed.erro ? faixaDeErro(ed.erro) : null,
      ed.aviso ? el('div', { class: 'cfg-ok', role: 'status' }, icone('feito'), el('p', {}, ed.aviso)) : null,
      texto,
      el(
        'div',
        { class: 'cfg-pe' },
        estadoPe,
        fechar,
        ed.modo === 'ver'
          ? editavel
            ? el('button', { type: 'button', class: 'btn cheio cfg-acao', 'data-foco': 'editar', disabled: ed.carregando || !ed.versao, aoClicar: () => trocarPara(ed, 'editar') }, icone('pencil'), 'Editar')
            : null
          : salvar,
      ),
    );
  }

  async function gravar(ed) {
    if (!podeSalvar(ed)) return;
    ed.salvando = true;
    ed.erro = null;
    ed.aviso = null;
    desenhar();
    const corpo = { raiz: ed.raiz, nome: ed.nome, conteudo: ed.texto };
    if (ed.versao) corpo.versao = ed.versao;
    if (ed.projeto) corpo.projeto = ed.projeto;
    // Nova só cria: se a pasta já tem a skill (outro processo criou), o núcleo dá 409 em vez de trocar.
    if (ed.modo === 'nova') corpo.criar = true;
    try {
      // Sem o `signal` da tela: sair no meio não desfaz a gravação, e a resposta ainda acerta o editor
      // (que mora no módulo e reaparece quando a pessoa volta).
      const r = await ctx.escrever('/api/config/skill', corpo, { signal: undefined });
      const nova = ed.modo === 'nova';
      Object.assign(ed, { conteudo: corpo.conteudo, versao: r.versao, editadoEm: r.editadoEm, caminho: r.caminho, modo: 'editar', salvando: false });
      ed.aviso = r.backup ? `Salvo. O anterior ficou em ${r.backup}` : nova ? `Criada em ${r.caminho}` : `Salvo em ${r.caminho}`;
      if (r.backup) estado.backupsDaJanela.unshift(r.backup);
      if (sinal.aborted) return;
      desenhar();
      carregar({ silencioso: true });
    } catch (e) {
      ed.salvando = false;
      ed.erro =
        e?.status === 409 && corpo.criar
          ? { titulo: 'Essa skill já existe.', texto: `Alguém criou ${ed.nome} nessa pasta depois da última leitura. Feche e abra a que existe, ou use outro nome.` }
          : e?.status === 409
          ? {
              titulo: 'A skill mudou por fora.',
              texto: 'Recarregue para ver a versão do disco. O seu texto continua aqui até você recarregar: copie o que quiser guardar.',
              acao: { rotulo: 'Recarregar', aoClicar: () => abrirSkill(ed, 'editar') },
            }
          : { titulo: 'Não salvou.', texto: e?.message ?? String(e) };
      if (sinal.aborted) return;
      desenhar();
    }
  }

  // ---------- Outras abas: listas só leitura ----------
  const LISTAS = {
    subagentes: { chave: 'subagentes', ic: 'users', nada: 'Nenhum subagente', titulo: (i) => i.nome, desc: (i) => i.descricao, caminho: (i) => i.caminho },
    comandos: { chave: 'comandos', ic: 'slash', nada: 'Nenhum comando', titulo: (i) => `/${i.nome}`, caminho: (i) => i.caminho },
    memoria: { chave: 'memoria', ic: 'book-open', nada: 'Nenhuma memória', titulo: (i) => i.nome, extra: (i) => (i.tipo === 'automatica' ? 'Memória automática' : 'Instruções'), caminho: (i) => i.caminho },
    plugins: { chave: 'plugins', ic: 'plug', nada: 'Nenhum plugin', titulo: (i) => i.nome },
    mcp: { chave: 'mcp', ic: 'server', nada: 'Nenhum servidor MCP', titulo: (i) => i.nome, extra: (i) => i.origem },
    hooks: { chave: 'hooks', ic: 'webhook', nada: 'Nenhum hook', titulo: (i) => i.evento, desc: (i) => `${i.quantos} ${i.quantos === 1 ? 'hook' : 'hooks'}` },
  };

  function listaSimples(d, aba) {
    const t = LISTAS[aba];
    const itens = doEscopo(d[t.chave] ?? [], estado.escopo);
    if (!itens.length) {
      const total = d.resumo?.[t.chave]?.total ?? 0;
      return vazio({
        icone: t.ic,
        titulo: `${t.nada}${estado.escopo === 'todos' ? '' : estado.escopo === 'usuario' ? ' do usuário' : ' do projeto'}`,
        texto: total ? `Há ${total} em todos os escopos.` : 'Nada configurado nas pastas lidas.',
      });
    }
    return el(
      'div',
      { class: 'cfg-lista cfg-lista-larga' },
      ...itens.map((i) =>
        el(
          'article',
          { class: 'cartao cfg-item' },
          el(
            'div',
            { class: 'cfg-item-linha' },
            el('span', { class: 'cfg-acento' }, icone(t.ic)),
            el('b', { class: 'cfg-trunc' }, t.titulo(i)),
            el('span', { class: 'cfg-chip' }, ROTULO_DO_ESCOPO[i.escopo] ?? i.escopo),
            t.extra ? el('span', { class: 'cfg-chip' }, t.extra(i)) : null,
          ),
          t.desc?.(i) ? el('span', { class: 'cfg-mudo cfg-trunc' }, t.desc(i)) : null,
          t.caminho ? caminhoEl(t.caminho(i)) : null,
        ),
      ),
    );
  }

  // ---------- Início ----------
  ctx.aoReiniciar(() => carregar({ silencioso: true }));
  // Uma leitura da skill cortada ao sair da tela recomeça (a gravação não é cortada: veja `gravar`).
  const recomecar = () => estado.editor?.carregando && estado.dados && abrirSkill(estado.editor, estado.editor.modo);
  if (estado.dados && estado.pedido === url.projeto) {
    desenhar();
    recomecar();
    carregar({ silencioso: true });
  } else {
    // Outro projeto: o editor limpo sai; o sujo fica (ele grava no projeto dele, `ed.projeto`).
    if (!sujo(estado.editor)) estado.editor = null;
    estado.nova = null;
    await carregar();
  }
}

/** Um caminho numa linha, cortado no começo (o fim é o que distingue), inteiro no `title`. */
function caminhoEl(caminho, extra = '') {
  return el('span', { class: `mono cfg-mudo cfg-trunc cfg-pequeno cfg-corta-inicio ${extra}`.trim(), title: caminho }, el('bdi', { dir: 'ltr' }, caminho));
}

/** As duas últimas partes de um caminho de projeto, para o seletor. */
function nomeCurto(caminho) {
  const partes = String(caminho).split('/').filter(Boolean);
  return partes.slice(-2).join('/') || caminho;
}

/** Copia `texto`; mostra "Copiado" no botão. Sem área de transferência, seleciona o caminho para copiar à mão. */
function copiarTexto(texto, botao, alvo) {
  const rotuloOriginal = botao.getAttribute('aria-label');
  const voltar = () => {
    botao.classList.remove('ok');
    botao.setAttribute('aria-label', rotuloOriginal);
    botao.replaceChildren(icone('copiar'));
  };
  const mostrar = (rotulo, ok) => {
    botao.setAttribute('aria-label', rotulo);
    botao.classList.toggle('ok', ok);
    botao.replaceChildren(icone(ok ? 'feito' : 'copiar'), el('span', {}, rotulo));
    setTimeout(voltar, 1600);
  };
  const selecionar = () => {
    const faixa = document.createRange();
    faixa.selectNodeContents(alvo);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(faixa);
    mostrar('Copie com ⌘C', false);
  };
  if (!navigator.clipboard?.writeText) return selecionar();
  navigator.clipboard.writeText(texto).then(() => mostrar('Copiado', true), selecionar);
}
