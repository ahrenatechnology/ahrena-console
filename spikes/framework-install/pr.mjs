// Spike #184: abrir o PR da instalação sem tocar no branch padrão. A porta `github` tem as cinco
// operações que o núcleo faria pelo GraphQL e pelo REST com o token do `gh` (ver o estudo):
// defaultBranch, findOpenPr, createRef, createCommitOnBranch e createPullRequest.

export const INSTALL_BRANCH = 'chore/install-ahrena-framework';

export class InstallRefused extends Error {}

/**
 * Cria o branch a partir do HEAD do padrão, grava um commit só com os arquivos do plano e abre o
 * PR. Idempotente: com um PR aberto desse branch, devolve o que já existe. Nunca escreve no padrão.
 */
export async function openInstallPr(github, { plan, title, body, branch = INSTALL_BRANCH }) {
  const refused = plan.filter((f) => f.action === 'refused');
  if (refused.length) throw new InstallRefused(refused.map((f) => `${f.path}: ${f.why}`).join('; '));
  const changes = plan.filter((f) => f.action === 'create' || f.action === 'merge');
  if (!changes.length) return { status: 'nothing-to-do' };

  const base = await github.defaultBranch();
  if (branch === base.name) throw new InstallRefused('o branch da instalação não pode ser o branch padrão');
  const open = await github.findOpenPr(branch);
  if (open) return { status: 'already-open', pr: open };

  await github.createRef(branch, base.oid);
  const commit = await github.createCommitOnBranch({
    branch,
    expectedHeadOid: base.oid,
    message: { headline: 'chore: install the Ahrena Framework', body: changes.map((f) => `${f.action} ${f.path}`).join('\n') },
    additions: changes.map((f) => ({ path: f.path, contents: Buffer.from(f.after, 'utf8').toString('base64') })),
  });
  const pr = await github.createPullRequest({ base: base.name, head: branch, title, body, draft: false });
  return { status: 'opened', commit, pr };
}
