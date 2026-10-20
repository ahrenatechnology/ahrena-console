// Abrir o PR da instalação sem tocar no branch padrão (#184, estudo "Como o PR é aberto"; porta do
// spike `pr.mjs`). A porta tem uma leitura e três escritas: o branch novo a partir do HEAD do padrão,
// um commit só com os arquivos do plano (`expectedHeadOid`) e o PR. Quem a implementa é
// src/github/pull-request-writer.ts (token do `gh`, fila do núcleo) ou o GitHub falso.

import { INSTALL_BRANCH, InstallRefused, type PlanFile, type PullRequestState } from './model.ts';

export interface FileAddition {
  path: string;
  /** O conteúdo em base64, como o `createCommitOnBranch` pede. */
  contents: string;
}

/** A porta do GitHub para um repositório. */
export interface InstallPullRequestPort {
  /** O nome e o commit do HEAD do branch padrão. */
  defaultBranch(): Promise<{ name: string; oid: string }>;
  /** O PR aberto deste branch para o padrão; `null` sem PR aberto. */
  findOpenPr(branch: string): Promise<PullRequestState | null>;
  /** O commit do branch, se ele existe; `null` sem branch. */
  branchHead(branch: string): Promise<string | null>;
  createRef(branch: string, oid: string): Promise<void>;
  createCommitOnBranch(input: { branch: string; expectedHeadOid: string; message: { headline: string; body: string }; additions: FileAddition[] }): Promise<{ oid: string }>;
  createPullRequest(input: { base: string; head: string; title: string; body: string }): Promise<PullRequestState>;
}

export type InstallOutcome =
  | { status: 'opened'; commit: string; pullRequest: PullRequestState }
  | { status: 'already-open'; pullRequest: PullRequestState }
  | { status: 'nothing-to-do' };

/** O campo de issue (decisão 3 de 20/10): só o número, ou vazio. Qualquer outra coisa é recusada antes de qualquer escrita. */
export function parseIssue(issue: unknown): number | null {
  if (issue === null || issue === undefined || (typeof issue === 'string' && issue.trim() === '')) return null;
  const text = typeof issue === 'number' ? String(issue) : typeof issue === 'string' ? issue.trim().replace(/^#/, '') : null;
  if (text === null || !/^[1-9]\d{0,9}$/.test(text)) throw new InstallRefused('invalid-issue', 'issue: só o número da issue, ou vazio');
  return Number(text);
}

/** O corpo do PR: o que o plano escreve e, com issue, `Refs #N`. Em inglês, como o framework. */
export function pullRequestBody(files: readonly PlanFile[], plugins: readonly string[], issue: number | null): string {
  const changes = files.filter((f) => f.action === 'create' || f.action === 'merge');
  const body = [
    'Installs the Ahrena Framework in this repository, opened from the Ahrena Console.',
    '',
    `Plugins: ${plugins.map((p) => `\`${p}\``).join(', ')}.`,
    '',
    'Files (existing content is merged between markers, never overwritten):',
    '',
    ...changes.map((f) => `- ${f.action} \`${f.path}\``),
  ].join('\n');
  return issue === null ? body : `${body}\n\nRefs #${issue}`;
}

/**
 * Cria o branch a partir do HEAD do padrão, grava um commit só com os arquivos do plano e abre o
 * PR. Idempotente: com um PR aberto desse branch, devolve o que já existe sem escrever. Nunca
 * escreve no padrão, e não escreve nada se algum arquivo foi recusado.
 */
export async function openInstallPullRequest(
  port: InstallPullRequestPort,
  { files, title, body, branch = INSTALL_BRANCH }: { files: readonly PlanFile[]; title: string; body: string; branch?: string },
): Promise<InstallOutcome> {
  const refused = files.filter((f) => f.action === 'refused');
  if (refused.length) throw new InstallRefused('invalid-json', refused.map((f) => `${f.path}: ${f.why}`).join('; '));
  const changes = files.filter((f) => f.action === 'create' || f.action === 'merge');
  if (!changes.length) return { status: 'nothing-to-do' };

  const base = await port.defaultBranch();
  if (branch === base.name) throw new InstallRefused('default-branch', 'o branch da instalação não pode ser o branch padrão');
  const open = await port.findOpenPr(branch);
  if (open) return { status: 'already-open', pullRequest: open };
  // Um branch que sobrou (PR fechado, ou criado à mão) não é sobrescrito: a pessoa decide.
  if ((await port.branchHead(branch)) !== null) throw new InstallRefused('branch-exists', `o branch ${branch} já existe sem PR aberto: apague-o ou abra o PR dele`);

  await port.createRef(branch, base.oid);
  const commit = await port.createCommitOnBranch({
    branch,
    expectedHeadOid: base.oid,
    message: { headline: title, body: changes.map((f) => `${f.action} ${f.path}`).join('\n') },
    additions: changes.map((f) => ({ path: f.path, contents: Buffer.from(f.after ?? '', 'utf8').toString('base64') })),
  });
  const pullRequest = await port.createPullRequest({ base: base.name, head: branch, title, body });
  return { status: 'opened', commit: commit.oid, pullRequest };
}
