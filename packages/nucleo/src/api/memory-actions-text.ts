/*
 * The pt-BR text of the memory actions (#740): what a person reads before confirming one. Text only: it reads no file, opens no
 * channel and writes no log. The one place that names the credential folder of ai-memory's data folder, as a thing that stays
 * when the data is deleted (#740/AC-4); nothing here opens it (#719/AC-10).
 */

import type { MemoryActionId, MemoryActionPlan, MemoryNotOffered } from '../memory/actions.ts';

/** The labels of the jobs and the buttons' dialogs (#740). */
export const MEMORY_LABELS: Record<MemoryActionId, string> = {
  activate: 'Ativar a memória',
  stop: 'Parar a memória',
  start: 'Iniciar a memória',
  deactivate: 'Desativar a memória',
  'delete-data': 'Apagar os dados da memória',
};

/** Why an action is not offered now, said to the person (#740). */
export const NOT_OFFERED_TEXT: Record<MemoryNotOffered, string> = {
  'no-binary': 'Esta versão do console não traz o ai-memory.',
  'state-unknown': 'Não deu para saber se a memória está rodando; tente de novo em instantes.',
  'already-running': 'A memória já está rodando.',
  'not-running': 'A memória não está rodando.',
  'not-stopped': 'Apagar os dados só é possível com a memória parada: pare-a antes.',
  'no-accounts': 'O console não conhece nenhuma conta do Claude Code: abra uma sessão numa conta antes de ativar.',
  'not-installed': 'O serviço da memória não está instalado: ative a memória primeiro.',
  'unsupported-platform': 'Parar e iniciar a memória só funciona no macOS.',
};

/** The field of the confirm that carries the person's acknowledgment of a data loss (#740/AC-4). */
export const ACKNOWLEDGMENT_FIELD = 'acknowledgeDataLoss';
export const ACKNOWLEDGMENT_TEXT = 'Entendo que os dados apagados não podem ser recuperados.';

// The capture policy is upstream's: ai-memory v3.5.1 capture_policy.rs:24-31 (the marker's `[capture] ignore_paths`), 61-66 (the default denylist admits every repository) and cli.rs:3622-3628 (`--capture-mode allowlist` leaves out repositories without a marker); the command applies only with `--apply`: cli.rs:3581-3587 (install-hooks changes nothing without --apply), install_hooks.rs:1068-1072 and 1641-1675 (#740).
/** The consent shown with the activate plan: what is captured, where it lives, how to exclude a repository and that nothing is downloaded (#740/AC-1, #719/AC-2). */
export function consentText(dataDir: string | null): string[] {
  const where = dataDir === null ? 'na pasta de dados do ai-memory' : `na pasta de dados do ai-memory (${dataDir})`;
  return [
    'O que é capturado: o texto dos seus prompts, as respostas e o uso de ferramentas das sessões do Claude Code das contas listadas passam a ser gravados como memória.',
    `Onde fica: neste computador, ${where}.`,
    'As contas listadas compartilham uma única memória: o que uma sessão captura pode ser lido pelas outras.',
    'Por padrão, todos os repositórios são capturados. Para tirar da captura o uso de ferramentas em caminhos de um repositório, crie nele o marcador .ai-memory.toml com [capture] ignore_paths (os prompts continuam sendo capturados); para capturar só os repositórios escolhidos, use o modo lista permitida (ai-memory install-hooks --apply --capture-mode allowlist), e só os repositórios com o marcador são capturados.',
    'Nada é baixado: os embeddings são desligados antes de o serviço iniciar, então o primeiro início não baixa nenhum modelo.',
  ];
}

const KEEPS_TEXT: Record<string, string> = { 'config.toml': 'config.toml', 'access-credentials': 'auth-tokens/', logs: 'logs' };

/** What stays when the data is deleted, by the ids of the plan (#740/AC-4). */
export function keepsText(ids: readonly string[]): string[] {
  return ids.map((id) => KEEPS_TEXT[id] ?? id);
}

/** The notices of a plan, in pt-BR (#740). */
export function noticesOf(plan: MemoryActionPlan): string[] {
  switch (plan.actionId) {
    case 'stop':
      return ['Parar encerra o serviço do ai-memory; Iniciar o põe de volta.'];
    case 'start':
      return ['Iniciar registra de novo o serviço do ai-memory.'];
    case 'deactivate':
      return [
        'Desativar remove a ligação do ai-memory com o Claude Code (hooks, MCP e skills) e o serviço; os dados ficam na pasta, intactos.',
        'Depois de desativar, Iniciar não funciona: é preciso ativar de novo.',
      ];
    case 'delete-data':
      return [`Serão apagados: ${plan.deletes.join(', ')}.`, `Continuam: ${keepsText(plan.keeps).join(', ')}.`];
    case 'activate':
      return [];
  }
}
