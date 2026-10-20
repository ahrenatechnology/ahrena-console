// Text coming from the transcript or from a hook is untrusted content: here it is only cleaned and truncated.
// Nothing here interprets, executes or follows what the text says.

/** Tamanho máximo de escolha, contexto e alternativa gravados na decisão. */
export const DECISION_TEXT_MAX = 280;
/** Quantas perguntas, opções ou alternativas uma captura aceita, no máximo. */
export const DECISION_LIST_MAX = 12;

// Controles C0/C1 (menos o espaço), sequências ANSI, e os caracteres invisíveis e de direção
// que servem para esconder ou inverter texto na interface.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

/** Uma linha só, sem controles nem invisíveis, cortada em `max`; `null` se nada sobrar. */
export function cleanText(v: unknown, max = DECISION_TEXT_MAX): string | null {
  if (typeof v !== 'string') return null;
  const clean = v.replace(ANSI, ' ').replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Lista limpa, sem vazios nem repetidos, com no máximo `DECISION_LIST_MAX` itens. */
export function cleanList(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const c = cleanText(v);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= DECISION_LIST_MAX) break;
  }
  return out;
}

/** Chave de assunto: minúsculas, sem acento nem pontuação. Dois textos iguais a menos disso são o mesmo assunto. */
export function topicKey(prefix: string, text: string | null): string | null {
  if (!text) return null;
  const k = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);
  return k ? `${prefix}:${k}` : null;
}

/** Primeira linha com conteúdo de um plano em Markdown, sem os `#`: o título dele. */
export function planTitle(plan: unknown): string | null {
  if (typeof plan !== 'string') return null;
  for (const line of plan.split('\n')) {
    const t = cleanText(line.replace(/^\s*#+\s*/, ''));
    if (t) return t;
  }
  return null;
}

// Começos de mensagem que contrariam o que o agente acabou de propor. A lista é curta de propósito:
// melhor perder uma correção do que inventar uma.
const CORRECTION_START =
  /^(n[aã]o[\s,.!]|n[aã]o$|nope\b|no[\s,.!]|na verdade\b|melhor n[aã]o\b|em vez d|ao inv[eé]s d|errado\b|pare\b|espera[\s,.!]|actually\b|instead\b|don'?t\b|wrong\b|stop\b)/i;

/** "Não" que não contraria nada: dúvida, não ter entendido, não lembrar. */
const NOT_A_CORRECTION = /\bn[aã]o\s+(sei|entendi|lembro|consigo|tenho certeza|sabia|vi|ficou claro)\b/i;
/** Correção é curta: uma mensagem longa é conversa, não uma decisão. */
export const CORRECTION_MAX = 160;
/** Palavras depois da negação: "Não, calma." é reação; "Não mexa no LangChain agora" é correção. */
const CORRECTION_MIN_WORDS = 3;

/**
 * A mensagem da pessoa contraria a proposta anterior? Conservador, na dúvida não: curta, sem
 * pergunta nem dúvida, começando por uma negação e dizendo o que fazer em vez disso.
 */
export function looksLikeCorrection(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length > CORRECTION_MAX || t.includes('?') || NOT_A_CORRECTION.test(t)) return false;
  const m = CORRECTION_START.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length).replace(/^[\s,.!;:]+/, '');
  return rest.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length >= CORRECTION_MIN_WORDS;
}

/** A pergunta foi fechada sem resposta ("[User dismissed — do not proceed…]"): não é decisão. */
export function isDismissedAnswer(answer: string | null): boolean {
  return answer !== null && /^\[?\s*user dismissed\b/i.test(answer.trim());
}

/** A primeira frase, para o título da decisão; o texto inteiro fica no detalhe. */
export const SHORT_CHOICE_MAX = 90;
export function shortChoice(text: string): string {
  const first = text.split(/(?<=[.!;])\s+|\n/)[0]?.trim() || text.trim();
  return cleanText(first, SHORT_CHOICE_MAX) ?? text;
}

/** O que descreve a chamada de ferramenta numa linha: o comando, o arquivo, a URL... */
export function toolSubject(toolName: string, input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const i = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query', 'path', 'description']) {
      const c = cleanText(i[k], 160);
      if (c) return `${toolName}: ${c}`;
    }
  }
  return toolName;
}

/** Texto da recusa de ferramenta que o Claude Code devolve ao modelo. */
const REJECTION = /^The user doesn['’]t want to (proceed|take this action)/;
const REJECTION_FEEDBACK = /the user said:\s*([\s\S]+)$/i;

export function isRejection(content: string | null, toolUseResult?: unknown): boolean {
  if (typeof toolUseResult === 'string' && /^User rejected tool use/.test(toolUseResult)) return true;
  return content !== null && REJECTION.test(content);
}

/** O que a pessoa escreveu ao recusar, quando escreveu. */
export function rejectionFeedback(content: string | null): string | null {
  if (!content) return null;
  const m = REJECTION_FEEDBACK.exec(content);
  return m ? cleanText(m[1]) : null;
}
