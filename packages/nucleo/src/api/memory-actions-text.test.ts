// The pt-BR text a person reads before confirming a memory action (#740/AC-1, #740/AC-4): what is captured, where it lives, how to
// exclude a repository, that nothing is downloaded, and for delete-data what goes and what stays. (#740)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MemoryActionPlan } from '../memory/actions.ts';
import { MEMORY_ACTIONS } from '../memory/actions.ts';
import { ACKNOWLEDGMENT_TEXT, consentText, keepsText, MEMORY_LABELS, noticesOf, NOT_OFFERED_TEXT } from './memory-actions-text.ts';

const plan = (over: Partial<MemoryActionPlan>): MemoryActionPlan => ({
  actionId: 'activate',
  label: 'x',
  steps: [],
  timeoutSeconds: 180,
  planDigest: '0123456789abcdef',
  accounts: [],
  service: null,
  dataDir: null,
  deletes: [],
  keeps: [],
  needsAcknowledgment: false,
  startNeedsActivation: false,
  ...over,
});

describe('#740/AC-1 the consent text of activate', () => {
  const text = consentText('/Users/someone/.local/share/ai-memory').join('\n');

  test('#740/AC-1 Then it says what is captured, where it lives, how to exclude a repository and that nothing is downloaded', () => {
    assert.match(text, /captur/i, 'what is captured');
    assert.match(text, /prompts|respostas|ferramentas/i);
    assert.ok(text.includes('/Users/someone/.local/share/ai-memory'), 'where it lives');
    assert.match(text, /neste computador/i);
    assert.ok(text.includes('[capture]'), 'how to exclude a repository');
    assert.match(text, /reposit[óo]rio/i);
    assert.match(text, /nada é baixado|não baixa/i, 'nothing is downloaded');
    assert.match(text, /embeddings/i);
  });

  test('#740/AC-1 Given no known data folder, Then the text still says where it lives without a path', () => {
    const generic = consentText(null).join('\n');
    assert.match(generic, /pasta de dados do ai-memory/i);
    assert.equal(/\/Users\//.test(generic), false);
  });
});

describe('#740/AC-4 the texts of the other actions', () => {
  test('#740/AC-4 Given deactivate, Then the notice says the data is kept and that starting needs a new activation', () => {
    const notices = noticesOf(plan({ actionId: 'deactivate', startNeedsActivation: true })).join(' ');
    assert.match(notices, /ativar de novo|nova ativação/i);
    assert.match(notices, /dados.*(ficam|mantid|continuam)/i);
  });

  test('#740/AC-4 Given delete-data, Then the keeps text names config.toml, auth-tokens/ and the logs', () => {
    const keeps = keepsText(['config.toml', 'access-credentials', 'logs']).join(' ');
    for (const kept of ['config.toml', 'auth-tokens/', 'logs']) assert.ok(keeps.includes(kept), kept);
    assert.match(ACKNOWLEDGMENT_TEXT, /não (podem|pode) ser (desfeit|recuperad)|não volta/i);
  });

  test('#740 Every action has a pt-BR label and every refusal a pt-BR sentence', () => {
    for (const id of MEMORY_ACTIONS) assert.match(MEMORY_LABELS[id], /\S/);
    for (const text of Object.values(NOT_OFFERED_TEXT)) assert.match(text, /\S/);
  });
});
