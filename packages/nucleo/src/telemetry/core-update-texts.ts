// The words of the Update button, as data (issue 462, decision 0022 section 7). The keys are English; the values
// are the pt-BR text the person reads (decision 0009). `GET /api/machines` carries the rendered `message` of each
// machine's update, so the screen reads the text from here and writes none of its own.
//
// Section 7 of decision 0022 is the SOURCE of the exit texts and test/telemetry/core-update-texts.test.ts compares
// them with its table. Placeholders are written as in the table: `<newVersion>`, `<oldCommit>`, `<backupPath>`,
// `<port>`, `<n>`, `<seconds>`, `<observed>`.
//
// Carry-in fix (wireframe 462-4, exit 40): the wireframe's cell lacks "se estava no ar antes", which the table has.
// The text here is the table's.

export const UPDATE_TEXTS = {
  // The check and the screen states.
  'check-ready': 'Pronto para atualizar a Workstation para a <newVersion>. O núcleo de lá vai parar por cerca de um minuto e voltar sozinho.',
  confirming: 'O núcleo foi reiniciado. Conferindo a versão que a Workstation responde.',
  diverged: 'O núcleo respondeu a versão <observed>; esperava a <newVersion>. Confira a Workstation pelo terminal, com o comando para copiar.',
  canceled: 'Cancelado. Nada foi alterado.',

  // Section 7, one per exit.
  'exit-0': 'O núcleo da Workstation foi atualizado para a <newVersion> e respondeu. A conexão voltou.',
  'exit-20': 'A Workstation e este app falam versões diferentes da telemetria. Nada foi parado. Atualize o app deste Mac e tente de novo.',
  'exit-21': 'A versão nova só responde a quem prova ser o dono, e este Mac ainda não tem o comando de credencial. Nada foi parado. Configure o connection.credential e tente de novo.',
  'exit-22': 'A versão <newVersion> não traz o manifesto do contrato, então não dá para saber se a Workstation continuaria conectada. Nada foi parado. Para seguir mesmo assim, rode o comando no terminal da Workstation com --allow-disconnect.',
  'exit-23': 'Este Mac não conseguiu informar à Workstation o que suporta. Nada foi parado. É um defeito do app: avise o time.',
  'exit-30': 'A Workstation recusou a atualização antes de parar qualquer coisa. Nada foi parado.',
  'exit-30-not-a-checkout': 'O caminho do repositório não é um checkout acessível. Nada foi parado.',
  'exit-30-dirty-tree': 'O repositório da Workstation tem mudanças locais não commitadas. Nada foi parado.',
  'exit-30-unknown-ref': 'A versão <newVersion> não existe no repositório de lá. Nada foi parado.',
  'exit-30-new-dependencies': 'A versão traz dependências novas, que o script não instala. Nada foi parado.',
  'exit-31': 'Não foi possível fazer o backup do banco. Nada foi parado; o núcleo segue no ar.',
  'exit-32': 'O Console não conseguiu confirmar o processo do núcleo na Workstation, nem tomar a trava da atualização. Nada foi parado.',
  'exit-32-data-dir-mismatch': 'O --data-dir não bate com o do núcleo que está rodando. Nada foi parado.',
  'exit-32-process-mismatch': 'O Console não confirmou que o processo na porta <port> é o núcleo deste repositório, ou não conseguiu ler as opções dele. Nada foi parado.',
  'exit-32-no-options': 'O Console não confirmou que o processo na porta <port> é o núcleo deste repositório, ou não conseguiu ler as opções dele. Nada foi parado.',
  'exit-33': 'Outra atualização está rodando nesta Workstation (outro Mac ou outro terminal). Nada foi parado. Espere terminar e tente de novo.',
  'exit-40': 'A atualização falhou e a Workstation voltou ao código de antes (<oldCommit>), com o banco restaurado do backup, se o núcleo novo chegou a subir. O núcleo de lá está no ar como estava, se estava no ar antes.',
  'exit-41': 'A atualização falhou e a volta também. A Workstation pode estar sem núcleo. O backup está em <backupPath> e o commit anterior era <oldCommit>. Restaure pelo terminal da Workstation, seguindo o runbook.',
  'ssh-unreachable': 'O SSH não chegou à Workstation. Nada foi parado. Confira o túnel (Reconectar) e tente de novo.',
  'timeout-before-swap': 'A Workstation não respondeu em <seconds> s. Cancelei antes de trocar qualquer coisa.',
  'timeout-after-swap': 'O SSH parou de responder depois de a troca começar. O script continua lá até o fim e volta sozinho se algo falhar. Confira a versão daqui a pouco: a tela relê a Workstation a cada 30 s.',
  'unknown-exit': 'O comando saiu com o código <n>. Nada na tela é lido da saída.',

  // Not in the table: the Mac's own outcomes.
  'node-not-found': 'O connection.update não achou o node ou o checkout lá. Nada foi parado.',
  'spawn-failed': 'Este Mac não conseguiu rodar o comando do connection.update. Nada foi parado.',
  'output-too-large': 'O comando devolveu mais texto do que o limite e foi encerrado. Nada foi alterado.',
  'script-unavailable': 'O app não achou o script de atualização que vem empacotado com ele. Nada foi parado. Reinstale o app.',

  // What is missing before the core can update itself: decision 0024 section 4 is the SOURCE of these two, and
  // test/telemetry/core-update-texts.test.ts compares them with its table.
  'problem-missing': 'Não deu para montar o comando de atualização a partir do connection.credential. Declare um connection.update no machines.json.',
  'problem-credential-missing': 'Falta o connection.credential no machines.json. Configure-o e o Console passa a atualizar o núcleo de lá sozinho.',
  'problem-invalid': 'O connection.update do machines.json está inválido (<problem>); corrija o arquivo.',
  'problem-invalid-file': 'O machines.json está inválido; corrija o arquivo para atualizar o núcleo.',

  // The fixed reasons of an invalid connection.update.
  'invalid-not-an-object': 'precisa ser um objeto com "command"',
  'invalid-bad-command': 'o "command" precisa ser uma lista de textos',
  'invalid-bad-timeout': 'o "timeoutSeconds" precisa ser um inteiro de 60 a 900',
  'invalid-forbidden-flag': 'o botão não aceita --allow-disconnect, --force, --core-options, install-unit nem as opções que o app acrescenta sozinho',
} as const;

export type UpdateTextKey = keyof typeof UPDATE_TEXTS;

export interface UpdateTextParams {
  newVersion?: string;
  oldCommit?: string | null;
  backupPath?: string | null;
  port?: string | number | null;
  n?: number | string | null;
  seconds?: number | null;
  observed?: string | null;
  problem?: string;
}

const PLACEHOLDER = /<(newVersion|oldCommit|backupPath|port|n|seconds|observed|problem)>/g;

/** The text of a key with its placeholders filled; a value that is not known stays as the neutral word "?" (never a raw `<…>`). */
export function renderUpdateText(key: UpdateTextKey, params: UpdateTextParams = {}): string {
  return UPDATE_TEXTS[key].replace(PLACEHOLDER, (_m, name: keyof UpdateTextParams) => {
    const v = params[name];
    return v === undefined || v === null ? '?' : String(v);
  });
}

/** A key from the classifier that has a text; an unknown one falls back to `unknown-exit`. */
export function textKeyOrFallback(key: string): UpdateTextKey {
  return key in UPDATE_TEXTS ? (key as UpdateTextKey) : 'unknown-exit';
}
