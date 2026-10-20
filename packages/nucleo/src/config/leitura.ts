// A leitura da tela Agent Config (#63): skills, subagentes, comandos, memória, hooks, MCP, plugins e
// arquivos de configuração de cada pasta de configuração de usuário (perfil, decisão 0006) e da
// `.claude` do projeto. Lê só o que o contrato pede (modelo.ts): o frontmatter das skills e dos
// subagentes, os nomes de evento dos hooks, as chaves de `mcpServers` e de `enabledPlugins`. Nunca
// abre `.credentials.json`, nunca devolve valor de settings e não lê o conteúdo da memória. Arquivo
// ilegível ou JSON quebrado tira só aquela parte da resposta.

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { PastaDeConfiguracao } from '../perfis/descoberta.ts';
import { lerFrontmatter } from './frontmatter.ts';
import {
  ErroDaConfig,
  type ComandoListado,
  type ConfigDoAgente,
  type ConfiguracaoListada,
  type Contagem,
  type EscopoDaConfig,
  type HookListado,
  type McpListado,
  type MemoriaListada,
  type PluginListado,
  type RaizDaConfig,
  type SkillListada,
  type SubagenteListado,
} from './modelo.ts';
import { NOME_DE_SKILL } from './skills.ts';

/** O máximo de itens lidos por pasta (skills, agentes, comandos, memória): uma pasta enorme não trava a resposta. */
const MAX_POR_PASTA = 500;
/** Quanto do começo de um `.md` se lê para achar o frontmatter. */
const MAX_FRONTMATTER = 32 * 1024;
const MAX_JSON = 8 * 1024 * 1024;
const MAX_PROFUNDIDADE_DOS_COMANDOS = 5;

export interface PedidoDaConfig {
  /** As pastas de configuração de usuário conhecidas (perfis), na ordem da descoberta. */
  pastas: readonly Pick<PastaDeConfiguracao, 'dir' | 'claudeJson'>[];
  /** Os diretórios de projeto conhecidos, recentes primeiro (projetos.ts). */
  projetos: readonly string[];
  /** O `?projeto=` do pedido; `null` escolhe o mais recente. */
  projeto?: string | null;
}

/**
 * A raiz do projeto do pedido: o `?projeto=` só vale se estiver entre os conhecidos (senão 400);
 * sem ele, o mais recente, ou nenhum.
 */
export function escolherProjeto(pedido: string | null | undefined, projetos: readonly string[]): string | null {
  if (pedido === null || pedido === undefined || pedido === '') return projetos[0] ?? null;
  if (!projetos.includes(pedido)) throw new ErroDaConfig(400, 'projeto: só um dos diretórios conhecidos (veja `projetos`)');
  return pedido;
}

/** Os cartões de raiz, com os ids opacos do contrato. */
export async function raizesDa(pastas: PedidoDaConfig['pastas'], projeto: string | null): Promise<RaizDaConfig[]> {
  const varias = pastas.length > 1;
  const raizes: RaizDaConfig[] = [];
  for (const [i, p] of pastas.entries()) {
    const sufixo = varias ? ` · ${basename(p.dir)}` : '';
    raizes.push({ id: `u${i}`, escopo: 'usuario', tipo: 'home', rotulo: `Claude home${sufixo}`, caminho: p.dir });
    if (await ehArquivo(p.claudeJson)) raizes.push({ id: `c${i}`, escopo: 'usuario', tipo: 'configuracao', rotulo: `.claude.json${sufixo}`, caminho: p.claudeJson });
  }
  if (projeto) {
    raizes.push({ id: 'p', escopo: 'projeto', tipo: 'claude-projeto', rotulo: '.claude do projeto', caminho: join(projeto, '.claude') });
    raizes.push({ id: 'r', escopo: 'projeto', tipo: 'projeto', rotulo: `Projeto · ${basename(projeto)}`, caminho: projeto });
  }
  return raizes;
}

export async function lerConfigDoAgente(pedido: PedidoDaConfig): Promise<ConfigDoAgente> {
  const projeto = escolherProjeto(pedido.projeto, pedido.projetos);
  const raizes = await raizesDa(pedido.pastas, projeto);
  const r: Omit<ConfigDoAgente, 'resumo'> = {
    projeto,
    projetos: [...pedido.projetos],
    raizes,
    skills: [],
    subagentes: [],
    comandos: [],
    memoria: [],
    mcp: [],
    plugins: [],
    hooks: [],
    configuracoes: [],
    edicao: true,
  };
  const hooks = new Map<string, HookListado>();
  const vistos = new Set<string>();
  const uma = (chave: string) => (vistos.has(chave) ? false : (vistos.add(chave), true));

  // As pastas onde moram skills, agentes, comandos e settings: cada home e a `.claude` do projeto.
  const pastasDeClaude = raizes.filter((x) => x.tipo === 'home' || x.tipo === 'claude-projeto');
  for (const raiz of pastasDeClaude) {
    r.skills.push(...(await lerSkills(raiz)));
    r.subagentes.push(...(await lerSubagentes(raiz)));
    r.comandos.push(...(await lerComandos(raiz)));
    for (const arquivo of ['settings.json', 'settings.local.json'] as const) {
      const caminho = join(raiz.caminho, arquivo);
      const settings = await lerJsonSemValores(caminho);
      if (settings === undefined) continue;
      r.configuracoes.push({ arquivo, escopo: raiz.escopo, caminho });
      if (!settings) continue;
      for (const [evento, quantos] of hooksDe(settings)) {
        const k = `${raiz.escopo}\0${evento}`;
        const h = hooks.get(k) ?? { evento, quantos: 0, escopo: raiz.escopo };
        h.quantos += quantos;
        hooks.set(k, h);
      }
      for (const nome of pluginsDe(settings)) if (uma(`plugin\0${raiz.escopo}\0${nome}`)) r.plugins.push({ nome, escopo: raiz.escopo });
    }
  }

  // Cada pasta de usuário: o CLAUDE.md dela, o `.claude.json` (MCP do usuário e do projeto) e a
  // memória automática do projeto, que o Claude Code guarda dentro dela.
  for (const p of pedido.pastas) {
    const claudeMd = join(p.dir, 'CLAUDE.md');
    if (await ehArquivo(claudeMd)) r.memoria.push({ nome: 'CLAUDE.md', escopo: 'usuario', caminho: claudeMd, tipo: 'instrucoes' });
    const claudeJson = await lerJsonSemValores(p.claudeJson);
    if (claudeJson !== undefined) r.configuracoes.push({ arquivo: '.claude.json', escopo: 'usuario', caminho: p.claudeJson });
    if (claudeJson) {
      for (const nome of chavesDe(claudeJson.mcpServers)) if (uma(`mcp\0usuario\0.claude.json\0${nome}`)) r.mcp.push({ nome, escopo: 'usuario', origem: '.claude.json' });
      const doProjeto = projeto ? objeto(objeto(claudeJson.projects)?.[projeto]) : null;
      for (const nome of chavesDe(doProjeto?.mcpServers)) if (uma(`mcp\0projeto\0.claude.json\0${nome}`)) r.mcp.push({ nome, escopo: 'projeto', origem: '.claude.json' });
    }
    if (projeto) r.memoria.push(...(await lerMemoriaAutomatica(p.dir, projeto)));
  }

  if (projeto) {
    for (const caminho of [join(projeto, 'CLAUDE.md'), join(projeto, 'CLAUDE.local.md'), join(projeto, '.claude', 'CLAUDE.md')]) {
      if (await ehArquivo(caminho)) r.memoria.push({ nome: relative(projeto, caminho), escopo: 'projeto', caminho, tipo: 'instrucoes' });
    }
    const mcpJson = await lerJsonSemValores(join(projeto, '.mcp.json'));
    if (mcpJson) for (const nome of chavesDe(mcpJson.mcpServers)) if (uma(`mcp\0projeto\0.mcp.json\0${nome}`)) r.mcp.push({ nome, escopo: 'projeto', origem: '.mcp.json' });
  }
  r.hooks.push(...hooks.values());

  const conta = (lista: readonly { escopo: EscopoDaConfig }[], peso: (x: never) => number = () => 1): Contagem => {
    const c = { total: 0, usuario: 0, projeto: 0 };
    for (const x of lista) {
      const n = peso(x as never);
      c.total += n;
      c[x.escopo] += n;
    }
    return c;
  };
  return {
    ...r,
    resumo: {
      skills: conta(r.skills),
      subagentes: conta(r.subagentes),
      comandos: conta(r.comandos),
      mcp: conta(r.mcp),
      plugins: conta(r.plugins),
      hooks: conta(r.hooks, (h: HookListado) => h.quantos),
      memoria: conta(r.memoria),
      configuracoes: conta(r.configuracoes),
    },
  };
}

async function lerSkills(raiz: RaizDaConfig): Promise<SkillListada[]> {
  const pasta = join(raiz.caminho, 'skills');
  const skills: SkillListada[] = [];
  for (const nome of (await entradas(pasta)).sort()) {
    const caminho = join(pasta, nome, 'SKILL.md');
    const info = await stat(caminho).catch(() => null);
    if (!info?.isFile()) continue;
    const fm = lerFrontmatter(await comecoDe(caminho));
    const declarado = texto(fm.name);
    skills.push({
      nome,
      nomeDeclarado: declarado && declarado !== nome ? declarado : null,
      descricao: texto(fm.description),
      escopo: raiz.escopo,
      raiz: raiz.id,
      caminho,
      editadoEm: Math.round(info.mtimeMs),
      editavel: NOME_DE_SKILL.test(nome) && !nome.includes('..'),
    });
  }
  return skills;
}

async function lerSubagentes(raiz: RaizDaConfig): Promise<SubagenteListado[]> {
  const pasta = join(raiz.caminho, 'agents');
  const lista: SubagenteListado[] = [];
  for (const arquivo of (await entradas(pasta)).filter((a) => a.endsWith('.md')).sort()) {
    const caminho = join(pasta, arquivo);
    if (!(await ehArquivo(caminho))) continue;
    const fm = lerFrontmatter(await comecoDe(caminho));
    lista.push({ nome: texto(fm.name) ?? arquivo.slice(0, -3), descricao: texto(fm.description), escopo: raiz.escopo, raiz: raiz.id, caminho });
  }
  return lista;
}

async function lerComandos(raiz: RaizDaConfig): Promise<ComandoListado[]> {
  const base = join(raiz.caminho, 'commands');
  const lista: ComandoListado[] = [];
  const andar = async (pasta: string, profundidade: number): Promise<void> => {
    for (const nome of (await entradas(pasta)).sort()) {
      if (lista.length >= MAX_POR_PASTA) return;
      const caminho = join(pasta, nome);
      const info = await stat(caminho).catch(() => null);
      if (info?.isDirectory() && profundidade < MAX_PROFUNDIDADE_DOS_COMANDOS) await andar(caminho, profundidade + 1);
      else if (info?.isFile() && nome.endsWith('.md')) lista.push({ nome: relative(base, caminho).slice(0, -3).split(sep).join(':'), escopo: raiz.escopo, raiz: raiz.id, caminho });
    }
  };
  await andar(base, 0);
  return lista;
}

/**
 * A pasta de memória automática do projeto: `<pasta de configuração>/projects/<cwd codificado>/memory`,
 * com o cwd codificado como o Claude Code faz (todo caractere fora de `[A-Za-z0-9]` vira `-`).
 * Só nome e caminho dos `.md`.
 */
export function pastaDaMemoriaAutomatica(dir: string, projeto: string): string {
  return join(dir, 'projects', projeto.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
}

async function lerMemoriaAutomatica(dir: string, projeto: string): Promise<MemoriaListada[]> {
  const pasta = pastaDaMemoriaAutomatica(dir, projeto);
  const lista: MemoriaListada[] = [];
  for (const nome of (await entradas(pasta)).filter((a) => a.endsWith('.md')).sort()) {
    const caminho = join(pasta, nome);
    if (await ehArquivo(caminho)) lista.push({ nome, escopo: 'projeto', caminho, tipo: 'automatica' });
  }
  return lista;
}

/** Os eventos de `hooks` e quantos hooks cada um tem (`hooks.<Evento>[].hooks[]`). Nenhum comando sai. */
function hooksDe(settings: Record<string, unknown>): [string, number][] {
  const hooks = objeto(settings.hooks);
  if (!hooks) return [];
  const eventos: [string, number][] = [];
  for (const [evento, grupos] of Object.entries(hooks)) {
    if (!Array.isArray(grupos)) continue;
    const quantos = grupos.reduce((n: number, g) => n + (Array.isArray(objeto(g)?.hooks) ? (objeto(g)!.hooks as unknown[]).length : 0), 0);
    if (quantos > 0) eventos.push([evento, quantos]);
  }
  return eventos;
}

/** As chaves de `enabledPlugins` ligadas. O parse sem valores (abaixo) troca o `true` por um marcador. */
function pluginsDe(settings: Record<string, unknown>): string[] {
  const ligados = objeto(settings.enabledPlugins);
  return ligados ? Object.keys(ligados).filter((k) => ligados[k] === LIGADO) : [];
}

const LIGADO = 1;

/**
 * Lê um JSON guardando só a forma: objetos, listas, chaves e o marcador `LIGADO` no lugar de `true`.
 * Todo texto e número vira nada no próprio parse, então nenhum valor (`env`, `command`, `url`,
 * tokens, e-mail do `oauthAccount`) existe no objeto que sai daqui. `undefined`: o arquivo não
 * existe; `null`: existe, mas é ilegível, grande demais ou não é um objeto JSON.
 */
async function lerJsonSemValores(caminho: string): Promise<Record<string, unknown> | null | undefined> {
  const info = await stat(caminho).catch(() => null);
  if (!info?.isFile()) return undefined;
  if (info.size > MAX_JSON) return null;
  try {
    const o: unknown = JSON.parse(await readFile(caminho, 'utf8'), (_k, v: unknown) => (v === true ? LIGADO : v !== null && typeof v === 'object' ? v : undefined));
    return objeto(o);
  } catch {
    return null;
  }
}

function objeto(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function chavesDe(v: unknown): string[] {
  const o = objeto(v);
  return o ? Object.keys(o) : [];
}

function texto(v: string | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

async function entradas(pasta: string): Promise<string[]> {
  try {
    return (await readdir(pasta)).filter((n) => !n.startsWith('.')).slice(0, MAX_POR_PASTA);
  } catch {
    return [];
  }
}

async function ehArquivo(caminho: string): Promise<boolean> {
  return (await stat(caminho).catch(() => null))?.isFile() ?? false;
}

/** O começo do arquivo, onde o frontmatter mora; `''` se ilegível. */
async function comecoDe(caminho: string): Promise<string> {
  try {
    const f = await open(caminho, 'r');
    try {
      const buf = Buffer.alloc(MAX_FRONTMATTER);
      const { bytesRead } = await f.read(buf, 0, MAX_FRONTMATTER, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await f.close();
    }
  } catch {
    return '';
  }
}
