// A detecção (#184, estudo "Escolher os plugins pelo que o repositório tem"): o que a tela mostra em
// "o que achamos" e os plugins sugeridos, com o motivo. Recebe os arquivos do repositório como
// caminho → texto: todos os caminhos que interessam (`isDetectionPath`) e o texto só dos que a
// detecção lê (`DETECTION_TEXTS`); os outros vêm com `''`.

import { BASE_PLUGINS, type Detection, type Suggestion } from './model.ts';

/** Os arquivos cujo texto a detecção lê (as dependências), além dos de instrução que o plano mescla. */
export const DETECTION_TEXTS = ['package.json', 'pyproject.toml', 'requirements.txt'] as const;

interface Signals {
  has(path: string): boolean;
  any(re: RegExp): boolean;
  dep(re: RegExp): boolean;
  pyDep(re: RegExp): boolean;
}

// Sinal no repositório → plugin sugerido, com o motivo que a tela mostra.
const SIGNALS: readonly [string, (f: Signals) => boolean, string][] = [
  ['ahrena-engineering-typescript', (f) => f.has('tsconfig.json') || f.any(/\.tsx?$/), 'tsconfig.json ou arquivos .ts'],
  ['ahrena-engineering-python', (f) => f.has('pyproject.toml') || f.has('requirements.txt') || f.has('setup.py'), 'pyproject.toml ou requirements.txt'],
  ['ahrena-engineering-go', (f) => f.has('go.mod'), 'go.mod'],
  ['ahrena-engineering-rust', (f) => f.has('Cargo.toml'), 'Cargo.toml'],
  ['ahrena-engineering-frontend', (f) => f.dep(/^(react|vue|svelte|next|@angular\/core|solid-js)$/) || f.any(/\.(tsx|jsx|vue|svelte)$/), 'React, Vue, Svelte ou Angular'],
  [
    'ahrena-engineering-backend',
    (f) => f.dep(/^(express|fastify|@nestjs\/core|koa|hono)$/) || f.pyDep(/^(fastapi|django|flask)$/) || (f.has('go.mod') && f.any(/(^|\/)(cmd|internal)\//)),
    'um framework de servidor',
  ],
  ['ahrena-engineering-data', (f) => f.has('dbt_project.yml') || f.pyDep(/^(great-expectations|great_expectations|pyspark|dbt-core)$/), 'dbt, Spark ou Great Expectations'],
];

const LANGUAGES: readonly [string, (f: Signals) => boolean][] = [
  ['TypeScript', (f) => f.has('tsconfig.json') || f.any(/\.tsx?$/)],
  ['JavaScript', (f) => f.any(/\.(m?js|jsx)$/) || (f.has('package.json') && !f.has('tsconfig.json') && !f.any(/\.tsx?$/))],
  ['Python', (f) => f.has('pyproject.toml') || f.has('requirements.txt') || f.has('setup.py') || f.any(/\.py$/)],
  ['Go', (f) => f.has('go.mod') || f.any(/\.go$/)],
  ['Rust', (f) => f.has('Cargo.toml') || f.any(/\.rs$/)],
];

const FRAMEWORKS: readonly [string, (f: Signals) => boolean][] = [
  ['React', (f) => f.dep(/^(react|next)$/)],
  ['Vue', (f) => f.dep(/^vue$/)],
  ['Svelte', (f) => f.dep(/^svelte$/)],
  ['Angular', (f) => f.dep(/^@angular\/core$/)],
  ['Express', (f) => f.dep(/^express$/)],
  ['Fastify', (f) => f.dep(/^fastify$/)],
  ['NestJS', (f) => f.dep(/^@nestjs\/core$/)],
  ['Koa', (f) => f.dep(/^koa$/)],
  ['Hono', (f) => f.dep(/^hono$/)],
  ['FastAPI', (f) => f.pyDep(/^fastapi$/)],
  ['Django', (f) => f.pyDep(/^django$/)],
  ['Flask', (f) => f.pyDep(/^flask$/)],
  ['dbt', (f) => f.has('dbt_project.yml') || f.pyDep(/^dbt-core$/)],
  ['Spark', (f) => f.pyDep(/^pyspark$/)],
];

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.\w+$|_test\.go$|(^|\/)test_[^/]+\.py$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ROOT_SIGNALS = new Set(['package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'dbt_project.yml']);

/**
 * Os caminhos da árvore que a detecção guarda (a árvore inteira pode ter 13 MB): os manifestos da
 * raiz, o código pela extensão, os testes, os workflows e os arquivos que o plano mescla.
 */
export function isDetectionPath(path: string): boolean {
  return (
    ROOT_SIGNALS.has(path) ||
    path === 'CLAUDE.md' ||
    path === 'AGENTS.md' ||
    path === '.claude/settings.json' ||
    WORKFLOW.test(path) ||
    TEST_PATH.test(path) ||
    /\.(tsx?|m?js|jsx|vue|svelte|py|go|rs)$/.test(path) ||
    /(^|\/)(cmd|internal)\//.test(path)
  );
}

function safeJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A pasta de teste (`tests/`) ou o arquivo, para "achamos testes em …". */
function testPlace(path: string): string {
  const m = /^(.*?(?:^|\/)(?:test|tests|__tests__|spec)\/)/.exec(path);
  return m ? m[1] : path;
}

/** O que a tela mostra em "o que achamos": linguagens, testes, CI e os plugins sugeridos com o motivo. */
export function detect(files: Readonly<Record<string, string>>): Detection {
  const paths = Object.keys(files);
  const pkg = safeJson(files['package.json']) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } | null;
  const deps = new Set(Object.keys({ ...(pkg && typeof pkg === 'object' ? pkg.dependencies : {}), ...(pkg && typeof pkg === 'object' ? pkg.devDependencies : {}) }));
  const py = `${files['pyproject.toml'] ?? ''}\n${files['requirements.txt'] ?? ''}`;
  const pyWords = py.split(/[\s"',[\]=<>~!;()]+/).map((d) => d.toLowerCase().replace(/\[.*$/, ''));
  const f: Signals = {
    has: (p) => Object.hasOwn(files, p),
    any: (re) => paths.some((p) => re.test(p)),
    dep: (re) => [...deps].some((d) => re.test(d)),
    pyDep: (re) => pyWords.some((d) => re.test(d)),
  };
  const suggested: Suggestion[] = SIGNALS.filter(([, test]) => test(f)).map(([name, , why]) => ({ name, why: `achamos ${why}` }));
  const test = paths.filter((p) => TEST_PATH.test(p)).sort()[0];
  return {
    languages: LANGUAGES.filter(([, t]) => t(f)).map(([n]) => n),
    frameworks: FRAMEWORKS.filter(([, t]) => t(f)).map(([n]) => n),
    tests: test === undefined ? false : testPlace(test),
    ci: paths.some((p) => WORKFLOW.test(p)) ? 'GitHub Actions' : false,
    suggested,
    plugins: [...BASE_PLUGINS, ...suggested.map((s) => s.name)],
  };
}
