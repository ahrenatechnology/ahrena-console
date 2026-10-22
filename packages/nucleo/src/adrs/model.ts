// O contrato das telas de registros de decisão (#174): as ADRs (arquitetura) e as PDRs (produto) dos
// repositórios da conta. Bastidores em inglês; o texto que a pessoa vê (as mensagens de `error`) em pt-BR.
//
// O Markdown do repositório é dado: o núcleo só o devolve para a tela mostrar, sem HTML, e nunca o
// entrega a um agente como instrução (estudo docs/repo-instructions-install-adrs-study.md, "Segurança").

/** `adr`: decisão de arquitetura; `pdr`: decisão de produto. Sem sinal nenhum, `adr`. */
export type DecisionKind = 'adr' | 'pdr';

/** Por que o registro é ADR ou PDR, na ordem em que os sinais são lidos (estudo, "PDRs"). */
export type KindReason = 'type-field' | 'prefix' | 'folder' | 'default';

/** Os seis status normalizados; o texto original fica em `statusRaw`. */
export type DecisionStatus = 'accepted' | 'proposed' | 'superseded' | 'deprecated' | 'rejected' | 'unknown';
export const DECISION_STATUSES: readonly DecisionStatus[] = ['accepted', 'proposed', 'superseded', 'deprecated', 'rejected', 'unknown'];

export type DecisionFormat = 'madr4' | 'madr3' | 'madr2' | 'madr' | 'nygard' | 'adr-tools' | 'y-statement' | 'free';

/** Os campos que, quando faltam, a tela mostra tracejados ("não está no texto"). */
export type DecisionField = 'status' | 'date' | 'context' | 'decision' | 'options' | 'consequences';

export type LinkKind = 'supersedes' | 'superseded-by' | 'amends' | 'amended-by' | 'clarifies' | 'clarified-by' | 'related';

export interface DecisionLink {
  kind: LinkKind;
  /** O `id` do registro ligado, no mesmo repositório; `null` quando o alvo não foi achado. */
  target: string | null;
  /** Onde a ligação foi lida: `text` (com verbo), o nome do metadado (`mexe em`) ou `inverse` (a volta). */
  via: string;
  /** O arquivo do link (`0002-x.md`) ou o número citado, antes de resolver. */
  file?: string;
  number?: number;
  label?: string;
}

/** Uma alternativa considerada: o nome curto e, quando o texto traz, os prós e contras. */
export interface DecisionOption {
  name: string;
  chosen: boolean;
  pros: string[];
  cons: string[];
}

/** Uma seção do texto fora das que a tela estrutura ("Outras seções do texto", fechadas). */
export interface DecisionSection {
  heading: string;
  text: string;
}

/** O que o extrator tira de um arquivo, sem as ligações resolvidas (`link.ts` resolve). */
export interface ParsedDecision {
  /** O caminho no repositório (`docs/adr/0001-x.md`). */
  path: string;
  /** O nome do arquivo sem `.md`: a chave do registro no repositório (números podem repetir). */
  id: string;
  number: number | null;
  title: string;
  kind: DecisionKind;
  kindReason: KindReason;
  format: DecisionFormat;
  language: 'en' | 'pt';
  status: DecisionStatus;
  statusRaw: string | null;
  date: string | null;
  dateRaw: string | null;
  deciders: string[];
  consulted: string[];
  informed: string[];
  context: string | null;
  drivers: string[];
  decision: string | null;
  chosen: string | null;
  chosenReason: string | null;
  options: DecisionOption[];
  consequences: string | null;
  consequencesGood: string[];
  consequencesBad: string[];
  confirmation: string | null;
  other: DecisionSection[];
  links: DecisionLink[];
  missing: DecisionField[];
  /** A ligação diz "substituída por" e o status diz outra coisa. */
  statusConflict: string | null;
}

// ---------- as respostas da API ----------

/** O estado da leitura, como as outras telas do GitHub (repos, agent-instructions). */
export type DecisionsState = 'ready' | 'loading' | 'no-github' | 'not-found' | 'error';

/** Uma ligação pronta para a tela: o alvo com número, título, tipo e status. */
export interface DecisionLinkView {
  kind: LinkKind;
  target: string;
  via: string;
  number: number | null;
  title: string;
  targetKind: DecisionKind;
  status: DecisionStatus;
}

/** Uma linha da lista: sem o texto. */
export interface DecisionSummary {
  /** `owner/name`. */
  repo: string;
  id: string;
  path: string;
  number: number | null;
  title: string;
  kind: DecisionKind;
  kindReason: KindReason;
  format: DecisionFormat;
  status: DecisionStatus;
  date: string | null;
  missing: DecisionField[];
  links: DecisionLinkView[];
}

/** Um nó da cadeia de substituição, da mais antiga à que vale hoje. */
export interface ChainNode {
  id: string;
  number: number | null;
  title: string;
  kind: DecisionKind;
  status: DecisionStatus;
}

/** A contagem por status da lista (o segmentado da tela): `all` mais um por status. */
export type StatusCounts = Record<'all' | DecisionStatus, number>;

/** Os números dos cards do topo, sobre a lista inteira do tipo, sem filtro. */
export interface DecisionTotals {
  records: number;
  /** Repositórios com ao menos um registro do tipo, e quantos foram lidos. */
  reposWith: number;
  reposRead: number;
  accepted: number;
  proposed: number;
  /** Substituídas ou obsoletas. */
  replaced: number;
  /** Com algum campo de `missing`. */
  incomplete: number;
}

export interface DecisionGroup {
  repo: string;
  /** As pastas onde os registros do tipo foram achados, na ordem de busca. */
  folders: string[];
  /** O formato mais comum no grupo. */
  format: DecisionFormat | null;
  /** Quantos registros do tipo o repositório tem (sem filtro). */
  total: number;
  /** Numa pasta mista, algum registro do grupo foi separado pelo campo de tipo. */
  byTypeField: boolean;
  records: DecisionSummary[];
}

/** `GET /api/adrs` e `GET /api/pdrs`. */
export interface DecisionList {
  state: DecisionsState;
  error: string | null;
  kind: DecisionKind;
  /** A hora da leitura mais antiga mostrada (a do cache, quando o GitHub falha). */
  readAt: string | null;
  /** Até quando o GitHub está limitando, quando está. */
  retryAt: string | null;
  account: string | null;
  totals: DecisionTotals;
  /** Por status, depois da busca e do repositório, antes do filtro de status. */
  counts: StatusCounts;
  groups: DecisionGroup[];
  /** Repositórios lidos sem nenhum registro do tipo. */
  without: string[];
  /** Os donos (org ou conta) dos repositórios lidos, para o filtro. */
  owners: string[];
  /** Os repositórios com registro do tipo, para o filtro. */
  repos: string[];
}

/** `GET /api/adrs/<owner>/<repo>`: um repositório, com os dois tipos contados. */
export interface RepoDecisions {
  state: DecisionsState;
  error: string | null;
  /** `adr`, `pdr` ou `all` (a aba do repositório, "Todas"). */
  kind: DecisionKind | 'all';
  repo: string;
  commit: string | null;
  readAt: string | null;
  retryAt: string | null;
  /** O resultado veio do cache porque o GitHub falhou. */
  fromCache: boolean;
  folders: string[];
  format: DecisionFormat | null;
  counts: { adr: number; pdr: number; all: number };
  statusCounts: StatusCounts;
  records: DecisionSummary[];
  /** As cadeias de substituição com dois ou mais registros, cada uma da mais antiga à mais nova. */
  chains: ChainNode[][];
}

/** `GET /api/adrs/<owner>/<repo>/<id>`: o registro estruturado e o Markdown original. */
export interface DecisionRecordView extends DecisionSummary {
  state: DecisionsState;
  error: string | null;
  readAt: string | null;
  commit: string | null;
  language: 'en' | 'pt';
  statusRaw: string | null;
  dateRaw: string | null;
  deciders: string[];
  consulted: string[];
  informed: string[];
  context: string | null;
  drivers: string[];
  decision: string | null;
  chosen: string | null;
  chosenReason: string | null;
  options: DecisionOption[];
  consequences: string | null;
  consequencesGood: string[];
  consequencesBad: string[];
  confirmation: string | null;
  other: DecisionSection[];
  statusConflict: string | null;
  chain: ChainNode[];
  /** O arquivo como está no repositório. */
  markdown: string;
}
