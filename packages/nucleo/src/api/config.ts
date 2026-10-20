// As rotas da tela Agent Config (#63, wireframes C16 e C17). A leitura e a gravação moram em
// src/config/; aqui ficam só o HTTP e a exceção de origem da gravação.
//
// | Rota                                   | O quê                                                     |
// | -------------------------------------- | --------------------------------------------------------- |
// | `GET /api/config?projeto=<abs>`        | Raízes, resumo e as listas (src/config/modelo.ts), e `backups`: a pasta dos backups |
// | `GET /api/config/skill?raiz=&nome=`    | O `SKILL.md` de uma skill, com a `versao` (sha256)         |
// | `POST /api/config/skill`               | `{ raiz, nome, conteudo, versao?, projeto?, criar? }`: cria ou troca, com backup; `criar: true` só cria (409 se existe) |
//
// `?projeto=` (e `projeto` no corpo do POST) só vale se for um dos `projetos` conhecidos (os `cwd`
// das sessões, src/config/projetos.ts); outro valor dá 400. Sem ele, o mais recente.
//
// Origem (decisão 0003): como as outras escritas, o POST sem `Origin` vale de 127.0.0.1. A tela
// `/ui` manda `Origin`, então este POST, e só ele, também aceita `Origin` exatamente igual a
// `http://<Host>`, com o Host nosso (`escritaDaConfigNaMesmaOrigem`, chamada no `handle`). Pede
// `Content-Type: application/json` (415) e tem limite de corpo próprio, maior que o das decisões.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { PastaDeConfiguracao } from '../perfis/descoberta.ts';
import { escolherProjeto, lerConfigDoAgente, raizesDa } from '../config/leitura.ts';
import { ErroDaConfig } from '../config/modelo.ts';
import { gravarSkill, lerSkill, MAX_CONTEUDO, pastaPadraoDeBackups, raizDeSkill } from '../config/skills.ts';

export const ROTA_DA_CONFIG = '/api/config';
export const ROTA_DA_SKILL = '/api/config/skill';
/** O corpo do POST: o conteúdo em JSON, com folga para os escapes. */
const MAX_CORPO_DA_SKILL = 4 * MAX_CONTEUDO + 4096;

export interface OpcoesDaConfig {
  /** As pastas de configuração de usuário (perfis), relidas a cada pedido. */
  pastas: () => Promise<readonly Pick<PastaDeConfiguracao, 'dir' | 'claudeJson'>[]>;
  /** Os diretórios de projeto conhecidos, recentes primeiro. */
  projetos: () => Promise<readonly string[]>;
  /** Pasta dos backups; padrão `~/.ahrena-console/backups`. */
  backups?: string;
  log?: (mensagem: string) => void;
  agora?: () => Date;
}

export type RotaDaConfig = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** O POST da skill vindo da própria `/ui`: `Origin` igual a `http://<Host>`, com o Host nosso. */
export function escritaDaConfigNaMesmaOrigem(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const origem = req.headers.origin;
  if (req.method !== 'POST' || typeof origem !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (new URL(req.url ?? '/', 'http://x').pathname !== ROTA_DA_SKILL) return false;
  return origem === `http://${host}`;
}

function lerCorpo(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    let tamanho = 0;
    let grande = Number(req.headers['content-length']) > max;
    req.on('data', (parte: Buffer) => {
      if (grande) return;
      tamanho += parte.length;
      if (tamanho > max) grande = true;
      else partes.push(parte);
    });
    req.on('end', () => resolve(grande ? null : Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

export function criarRotaDaConfig(opts: OpcoesDaConfig): RotaDaConfig {
  const backups = opts.backups ?? pastaPadraoDeBackups();
  const log = opts.log ?? (() => {});

  async function contexto(projetoPedido: unknown) {
    if (projetoPedido !== undefined && projetoPedido !== null && typeof projetoPedido !== 'string') throw new ErroDaConfig(400, 'projeto: um caminho de `projetos`');
    const [pastas, projetos] = await Promise.all([opts.pastas(), opts.projetos()]);
    const projeto = escolherProjeto(projetoPedido as string | null | undefined, projetos);
    return { pastas, projetos, projeto, raizes: await raizesDa(pastas, projeto) };
  }

  async function gravar(req: IncomingMessage, res: ServerResponse) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    const texto = await lerCorpo(req, MAX_CORPO_DA_SKILL);
    if (texto === null) return send(res, 413, { error: 'corpo grande demais' });
    let corpo: Record<string, unknown>;
    try {
      const o: unknown = JSON.parse(texto);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error();
      corpo = o as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: 'JSON inválido: { raiz, nome, conteudo, versao? }' });
    }
    const { raizes } = await contexto(corpo.projeto);
    const raiz = raizDeSkill(corpo.raiz, raizes);
    // `criar: true` (o "Nova" da tela): só cria; se a skill já existe, 409 em vez de trocar com backup.
    if (corpo.criar === true && (await lerSkill(raiz, corpo.nome))) return send(res, 409, { error: 'a skill já existe' });
    const r = await gravarSkill({ raiz, nome: corpo.nome, conteudo: corpo.conteudo, versao: corpo.versao, backups, agora: opts.agora });
    log(`skill ${String(corpo.nome)} gravada em ${raiz.id}${r.backup ? ' (com backup)' : ' (nova)'}`);
    send(res, 200, r);
  }

  async function rotear(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (url.pathname === ROTA_DA_CONFIG) {
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
      const [pastas, projetos] = await Promise.all([opts.pastas(), opts.projetos()]);
      // `backups`: a pasta onde a gravação guarda o que troca, para o botão "Backups" da tela.
      return send(res, 200, { ...(await lerConfigDoAgente({ pastas, projetos, projeto: url.searchParams.get('projeto') })), backups });
    }
    if (url.pathname === ROTA_DA_SKILL) {
      if (req.method === 'POST') return gravar(req, res);
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET ou POST' });
      const { raizes } = await contexto(url.searchParams.get('projeto'));
      const skill = await lerSkill(raizDeSkill(url.searchParams.get('raiz'), raizes), url.searchParams.get('nome'));
      return skill ? send(res, 200, skill) : send(res, 404, { error: 'skill não encontrada' });
    }
    send(res, 404, { error: 'não encontrado' });
  }

  return async (req, res, url) => {
    try {
      await rotear(req, res, url);
    } catch (err) {
      if (err instanceof ErroDaConfig) return send(res, err.status, { error: err.message });
      throw err;
    }
  };
}
