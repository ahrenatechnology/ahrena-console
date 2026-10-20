// The Portuguese detector of decision 0009 (issue #173), shared by the guards: the guard of the
// repository (english-internals.test.mjs) and the one of the mod (mod-english.test.mjs).

// Words of the legacy internals and their family. A new name with any of them, an accent or a
// Portuguese ending (-ção, -dade, -mento…) is refused.
const PORTUGUESE = new Set(`
  abrir aberta aberto abertas abertos acao acoes acende agente agentes agora ajustar ajuste ao aba abas
  analise antes apagar arquivo arquivos atencao atividade atual atualizacao aviso avisos
  banco bandeja barra busca buscar
  cabecalho caminho captura carga cartao cartoes cenario cenarios chave clientes codigo coluna colunas
  comum conferir confirmar conta contas contexto conversa custo custos
  dados decisao decisoes depois descartar desfazer desde detalhe dia dias dom dono
  encerrada encerradas entrada escopo escrita espera esperando esperas estado estados evento eventos
  falso fechado fechar feito fila filtro fonte frase frases fuso
  gerado gravacao gravar grafo
  historico hoje
  icone icones indice inferencia inicio item itens
  janela
  leitura ler ligacao limite linha linhas lista
  maquina maquinas marca medicao medir migracao modelo moldura mover mudanca mudancas mural
  nativo nome nova novas novo novos nucleo origem
  painel pagina paginas para pasta pastas perfil perfis piso plano planos porta precos projeto
  projetos proximo
  quadro
  registro regras reprocessamento resumo rota rotas rotulo
  sessao sessoes simulador sinal sonda status subir sub
  tabela tela telas tempo texto tipos titulo trabalho trava turno
  ultima ultimo
  valor versao vigia visao vivo
  acento aleatorio alto alvo amarela amostra anel anterior apagada arrastando artefato arvore ativa
  atualizar barras bloco botao caixa calma campo carregando centro cheia cheio cinco cinza comando
  concluida consulta conteudo continuou contorno contrato copiado copiar cor cores corpo curto datas
  descoberta duas eixo empacotar erro extensao faixa faixas falhou falsa fatia ferramenta ferramentas
  filho filtros fluxo fontes frente frota fundo gerar gravado grupo historia hora lado larga legenda
  leve lido lugar mais mensagem mensagens medio motivo multiplas nada numero numeros ordem osso outro
  outros padrao parcial passos pede pedido pedidos pendente pergunta pessoa permissao permissoes pilula
  pilulas ponta pontas ponto prova pulso quadrado quatro regiao repositorio repositorios resposta
  respostas rodando rodape rosa rosca saida seletor selo selos seta sobre tarefa tarefas teste testes
  tipo topo trilha trilho usuario vazio verde vocabulario voce voltar
`.split(/\s+/).filter(Boolean))
// The English words above that also show up in English names.
for (const english of ['status', 'item', 'sub', 'dom']) PORTUGUESE.delete(english)
const PORTUGUESE_ENDING = /(cao|coes|dade|dades|mento|mentos|agem|inho|inha|^.{3,}ao)$/

/** Words of a name: split on separators and camelCase, lower case, accents kept. */
export function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-zÀ-ÿ0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** The Portuguese words of a name, or an empty list. */
export function portugueseWords(name) {
  return words(name).filter((w) => /[À-ÿ]/.test(w) || PORTUGUESE.has(w) || PORTUGUESE_ENDING.test(w))
}

/**
 * Routes written in a source: `/api/…`, `/ui/…`, `/abrir/…` and the other roots a router matches,
 * as templates (`/api/decisoes/*\/confirmar`). Parameters become `*` and regex alternations expand.
 */
export function routes(source) {
  const text = source.replace(/\\\//g, '/')
  const roots = new Set(['api', 'ui', 'mcp', 'abrir'])
  for (const m of text.matchAll(/pathname(?:\s*===\s*|\.startsWith\()\s*['"`]\/([A-Za-z0-9_-]+)|\^\/(?:\(\?:)?([A-Za-z0-9_|-]+)/g)) {
    for (const r of (m[1] ?? m[2]).split('|')) roots.add(r)
  }
  const found = new Set()
  const start = new RegExp(`(?<![\\w.~-])/(?:${[...roots].join('|')})(?![\\w-])`, 'g')
  for (const m of text.matchAll(start)) {
    let rest = /^[A-Za-z0-9_/<>:|()?*+\[\]^-]*/.exec(text.slice(m.index))[0]
    // A file (`/ui/telas/x.js`) is checked as a file name, not as a route.
    if (text[m.index + rest.length] === '.') rest = rest.slice(0, rest.lastIndexOf('/'))
    for (const route of expand(rest)) found.add(route)
  }
  return found
}

function expand(raw) {
  const segments = []
  // A parameter group (`([^/]+)`) has slashes of its own: it becomes `*` before the split.
  for (const seg of raw.replace(/\(\[\^[^\]]*\][^)]*\)/g, '*').split('/').slice(1)) {
    if (seg === '') break
    if (/^(<|:|\(\[\^|\[|\*)/.test(seg) || /^\([^?|]*\)$/.test(seg)) { segments.push(['*']); continue }
    const alt = /^\((?:\?:)?([A-Za-z0-9_|-]+)\)/.exec(seg)
    if (alt) { segments.push(alt[1].split('|')); continue }
    const word = /^[A-Za-z0-9_-]+/.exec(seg)
    if (!word) break
    segments.push([word[0]])
    if (word[0].length !== seg.length) break
  }
  let out = ['']
  for (const options of segments) out = out.flatMap((p) => options.map((o) => `${p}/${o}`))
  return out.filter((r) => r !== '')
}
