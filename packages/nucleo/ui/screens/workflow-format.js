// Os formatos da tela Workflows (C14) e da aba Workflow do detalhe (C7). Funções puras, sem DOM:
// o teste (test/api/workflows-ui.test.ts) as roda no node.

const NUM = new Intl.NumberFormat('pt-BR');
const DEC = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const num = (n) => NUM.format(n);

/** `null` vira "—"; o resto, uma casa decimal: 1,6. */
export const decimal = (n) => (n === null || n === undefined ? '—' : DEC.format(n));

/** 0,96 → "96%"; `null` → "—". */
export const percent = (f) => (f === null || f === undefined ? '—' : `${NUM.format(Math.round(f * 100))}%`);

/** 6.000.000 → "6,0 M"; 223.000 → "223 k"; 4.100 → "4,1 k". */
export function tokens(n) {
  if (n >= 1e6) return `${DEC.format(n / 1e6)} M`;
  if (n >= 1e4) return `${num(Math.round(n / 1e3))} k`;
  if (n >= 1e3) return `${DEC.format(n / 1e3)} k`;
  return num(n);
}

/** 12 s, 28 min, 1 h 05 min; `null` → "—". */
export function duration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "claude-opus-5-5" → "Opus 5.5"; um id que não é Claude fica como veio. */
export function modelName(id) {
  if (!id) return null;
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** "hoje", "ontem" ou "há 2 dias", pelo dia do calendário. */
export function when(iso, now = new Date()) {
  const d = new Date(iso);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (days <= 0) return 'hoje';
  if (days === 1) return 'ontem';
  return `há ${days} dias`;
}
