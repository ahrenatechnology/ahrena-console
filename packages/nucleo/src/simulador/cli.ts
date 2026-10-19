// Linha de comando do simulador: `npm run simular -- --caos`. Ver o README do pacote.

import { parseArgs } from 'node:util';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { simular } from './simulador.ts';

const AJUDA = `Uso: npm run simular -- [opções]

Gera sessões, agentes, eventos e uso de tokens sintéticos e grava pela porta de armazenamento.

  --banco <arquivo>     banco SQLite de destino (padrão: simulacao.sqlite)
  --seed <semente>      semente; a mesma semente gera os mesmos dados (padrão: sorteada e exibida)
  --sessoes <n>         número de sessões (padrão: 12)
  --duracao <min>       janela simulada em minutos (padrão: 360)
  --caos                injeta sessões travadas, erros, abandono, estouro de contexto e enxames
  --intensidade <0..1>  fração extra de sessões com caos (padrão: 0.4)
  --tempo-real          grava no ritmo do relógio em vez de tudo de uma vez
  --velocidade <x>      minutos simulados por minuto de relógio, em tempo real (padrão: 30)
  --precos              grava preços ilustrativos para os modelos simulados sem preço
  -h, --help            esta ajuda
`;

function numero(nome: string, valor: string | undefined): number | undefined {
  if (valor === undefined) return undefined;
  const n = Number(valor);
  if (!Number.isFinite(n)) throw new Error(`--${nome} precisa ser número, recebeu ${JSON.stringify(valor)}`);
  return n;
}

const { values: args } = parseArgs({
  options: {
    banco: { type: 'string', default: 'simulacao.sqlite' },
    seed: { type: 'string' },
    sessoes: { type: 'string' },
    duracao: { type: 'string' },
    caos: { type: 'boolean', default: false },
    intensidade: { type: 'string' },
    'tempo-real': { type: 'boolean', default: false },
    velocidade: { type: 'string' },
    precos: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  process.stdout.write(AJUDA);
  process.exit(0);
}

const semente = args.seed ?? String(Math.floor(Math.random() * 1_000_000));
const modo = args['tempo-real'] ? 'tempo-real' : 'lote';
const porta = openSqliteStorage({ path: args.banco });
const parar = new AbortController();
process.once('SIGINT', () => parar.abort());

console.log(`simulando em ${args.banco} · seed ${semente} · ${modo}${args.caos ? ' · caos' : ''}`);
if (modo === 'tempo-real') console.log('Ctrl+C para parar; o que já foi gravado fica.');

try {
  const resumo = await simular(porta, {
    semente,
    sessoes: numero('sessoes', args.sessoes),
    duracaoMin: numero('duracao', args.duracao),
    caos: args.caos,
    intensidadeDoCaos: numero('intensidade', args.intensidade),
    modo,
    velocidade: numero('velocidade', args.velocidade),
    precos: args.precos,
    signal: parar.signal,
    aoGravar:
      modo === 'tempo-real'
        ? (op) => {
            if (op.tipo === 'evento') console.log(`${op.registro.createdAt}  ${op.registro.sessionId}  ${op.registro.type}  ${op.registro.summary ?? ''}`);
          }
        : undefined,
  });
  const roteiros = Object.entries(resumo.roteiros)
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${r} ${n}`)
    .join(', ');
  const g = resumo.gravados;
  console.log(`${resumo.interrompido ? 'interrompido' : 'pronto'}: ${g.contas} contas, ${g.sessoes} sessões, ${g.agentes} agentes, ${g.eventos} eventos novos, ${g.usos} gravações de uso, ${g.precos} preços`);
  console.log(`roteiros: ${roteiros}`);
  console.log(`para repetir: npm run simular -- --seed ${semente}${args.caos ? ' --caos' : ''}`);
} finally {
  await porta.close();
}
