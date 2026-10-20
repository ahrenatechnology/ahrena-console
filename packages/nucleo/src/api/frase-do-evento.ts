// A frase legível de um evento, como o console a escreve: "Bash: npm test", "Turno concluído em 38,2 s",
// "Pede permissão: Bash npm run build", "Erro de API 529 · overloaded_error", "Interrompida (Esc)".
// (O "Sua vez" do Dashboard sai do estado da sessão, não de um evento.)
// O Dashboard (atividade recente, #27) e o Feed de atividade (#94) usam a mesma.
//
// O texto do evento vem do transcript ou do hook e não é confiável: quem mostra corta e limpa
// (o Feed passa por `textoDeUmaLinha`). Do erro da API sai só o código, nunca a mensagem.

import type { SessionEvent } from '../model.ts';

/** O que a frase precisa saber de antes do evento, na mesma sessão. */
export interface ContextoDaFrase {
  /** Quando foi o último prompt (ms): o `Stop` vira "Turno concluído em …". */
  ultimoPrompt?: number | null;
  /** A última ferramenta chamada: o pedido de permissão diz qual. */
  ultimaFerramenta?: { nome: string | null; resumo: string | null } | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Só o código: o status HTTP e o tipo do erro da API, nunca a mensagem. */
export function codigoDoErro(texto: string | null): string | null {
  if (!texto) return null;
  const partes = [/\b([45]\d\d)\b/.exec(texto)?.[1], /\b([a-z]+(?:_[a-z]+)*_error)\b/.exec(texto)?.[1]].filter(Boolean);
  return partes.length > 0 ? partes.join(' · ') : null;
}

/** Segundos como o console escreve: "38,2 s", "4 min", "1 h 5 min". */
export function duracao(s: number): string {
  if (s < 60) return `${s.toFixed(1).replace('.', ',')} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "Bash npm run build": a ferramenta e o alvo, sem repetir quando o resumo é o próprio nome. */
export function ferramentaEAlvo(f: { nome: string | null; resumo: string | null } | null | undefined): string | null {
  if (!f?.nome) return null;
  return [f.nome, f.resumo && f.resumo !== f.nome ? f.resumo : null].filter(Boolean).join(' ');
}

const DIA_S = 24 * 3600;

/** O turno, do último prompt até `t`: "Turno concluído em 38,2 s", ou sem a duração quando não dá para medir. */
function turno(t: number, ultimoPrompt: number | null | undefined): string {
  const s = ultimoPrompt != null && Number.isFinite(t) ? (t - ultimoPrompt) / 1000 : null;
  return s !== null && s >= 0 && s < DIA_S ? `Turno concluído em ${duracao(s)}` : 'Turno concluído';
}

/** O resumo entre aspas, ou nada quando é vazio. */
const citar = (prefixo: string, texto: string | null): string => (texto ? `${prefixo}: "${texto}"` : prefixo);

/**
 * A frase do evento, ou `null` quando o tipo não tem uma (quem mostra cai no resumo ou no tipo).
 * Pura: o que precisa de antes do evento vem em `ctx`.
 */
export function fraseDoEvento(e: Pick<SessionEvent, 'type' | 'toolName' | 'summary' | 'data' | 'createdAt'>, ctx: ContextoDaFrase = {}): string | null {
  const d = obj(e.data);
  const t = Date.parse(e.createdAt);
  switch (e.type) {
    case 'UserPromptSubmit':
    case 'UserPrompt':
      return citar('Prompt', str(e.summary));
    case 'PreToolUse':
    case 'ToolUse': {
      if (e.toolName === 'Agent' || e.toolName === 'Task') {
        const tipo = str(obj(d?.tool_input)?.subagent_type);
        return `Subagente ${tipo ?? ''} iniciado`.replace(/\s+/g, ' ');
      }
      if (e.toolName === 'TodoWrite') return 'Plano atualizado';
      if (!e.toolName) return null;
      const alvo = str(e.summary);
      return alvo && alvo !== e.toolName ? `${e.toolName}: ${alvo}` : e.toolName;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const falhou = e.type === 'PostToolUseFailure' || str(e.summary)?.startsWith('erro:');
      if (!e.toolName) return falhou ? 'Ferramenta falhou' : null;
      return falhou ? `${e.toolName} falhou` : `${e.toolName} concluído`;
    }
    case 'PermissionRequest': {
      const qual = e.toolName ? ferramentaEAlvo({ nome: e.toolName, resumo: str(e.summary) }) : ferramentaEAlvo(ctx.ultimaFerramenta);
      return qual ? `Pede permissão: ${qual}` : 'Pede permissão';
    }
    case 'Notification': {
      const tipo = str(d?.notification_type);
      if (tipo === 'elicitation_dialog') return 'Fez uma pergunta';
      if (tipo === 'permission_prompt') {
        const qual = ferramentaEAlvo(ctx.ultimaFerramenta);
        return qual ? `Pede permissão: ${qual}` : 'Pede permissão';
      }
      if (tipo === 'idle_prompt') return 'Sua vez';
      return str(e.summary) ? `Aviso: ${str(e.summary)}` : 'Aviso';
    }
    case 'AssistantMessage':
      return citar('Resposta', str(e.summary));
    case 'Stop':
      return turno(t, ctx.ultimoPrompt);
    case 'TurnDuration': {
      const ms = d?.durationMs;
      return typeof ms === 'number' && ms >= 0 && ms < DIA_S * 1000 ? `Turno concluído em ${duracao(ms / 1000)}` : turno(t, ctx.ultimoPrompt);
    }
    case 'Interrupted':
      return 'Interrompida (Esc)';
    case 'APIError':
    case 'StopFailure': {
      const codigo = codigoDoErro(str(e.summary) ?? str(d?.error) ?? str(d?.message));
      return codigo ? `Erro de API ${codigo}` : 'Erro de API';
    }
    case 'SubagentStop':
      return `Subagente ${str(e.summary) ?? ''} terminou`.replace(/\s+/g, ' ');
    case 'SessionStart':
      return e.summary === 'resume' ? 'Sessão retomada' : e.summary === 'compact' ? 'Contexto compactado' : 'Sessão iniciada';
    case 'SessionEnd':
      return 'Sessão encerrada';
    case 'Compaction':
      return 'Contexto compactado';
    default:
      return null;
  }
}
