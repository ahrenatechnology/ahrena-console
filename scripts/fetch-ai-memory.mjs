// Fetch the pinned ai-memory release and verify its SHA-256 before the app build (#725).
// Usage: node scripts/fetch-ai-memory.mjs [--arch aarch64|x86_64] [--out <folder>] (#725)
// Move the pin by changing AI_MEMORY_VERSION; the hash is read from the release (#725).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const AI_MEMORY_VERSION = 'v3.5.1';
const RELEASE_BASE = `https://github.com/akitaonrails/ai-memory/releases/download/${AI_MEMORY_VERSION}`;
export const ARCHES = ['aarch64', 'x86_64'];
const MEMBERS = ['ai-memory', 'LICENSE'];
const DEFAULT_OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'src-tauri', 'resources', 'ai-memory');

export function tarballUrl(arch) {
  return `${RELEASE_BASE}/ai-memory-macos-${arch}.tar.gz`;
}

/** The first 64-hex token of a `.sha256` file (`<hex>  <filename>`), lowercased; null when there is none. */
export function parseSha256(text) {
  const token = text.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-fA-F]{64}$/.test(token) ? token.toLowerCase() : null;
}

function hostArch() {
  return process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
}

function parseArgs(argv) {
  const opts = { arch: hostArch(), out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!value || (flag !== '--arch' && flag !== '--out')) throw new Error(`unknown or incomplete argument: ${flag}`);
    opts[flag.slice(2)] = value;
  }
  if (!ARCHES.includes(opts.arch)) throw new Error(`unsupported arch ${opts.arch} (expected ${ARCHES.join(' or ')})`);
  return opts;
}

export async function httpDownload(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function extractMembers(tarball, work) {
  const file = join(work, 'release.tar.gz');
  const extracted = join(work, 'extracted');
  await writeFile(file, tarball);
  await mkdir(extracted);
  await execFileAsync('tar', ['-xzf', file, '-C', extracted, ...MEMBERS.map((m) => `./${m}`)]);
  return extracted;
}

/** Returns the exit code: 0 on success, 1 on any failure (nothing is copied before the hash matched). */
export async function run(argv, { download = httpDownload, log = console.log, error = console.error } = {}) {
  let work;
  try {
    const { arch, out } = parseArgs(argv);
    const url = tarballUrl(arch);
    const tarball = await download(url);
    const published = parseSha256((await download(`${url}.sha256`)).toString('utf8'));
    if (!published) throw new Error(`${url}.sha256 holds no SHA-256`);
    const actual = createHash('sha256').update(tarball).digest('hex');
    if (actual !== published) throw new Error(`SHA-256 mismatch for ${url}: published ${published}, got ${actual}`);

    work = await mkdtemp(join(tmpdir(), 'fetch-ai-memory-'));
    const extracted = await extractMembers(tarball, work);
    const found = await readdir(extracted);
    for (const m of MEMBERS) if (!found.includes(m)) throw new Error(`the tarball has no ./${m}`);

    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    for (const m of MEMBERS) await copyFile(join(extracted, m), join(out, m));
    await chmod(join(out, 'ai-memory'), 0o755);
    log(`ai-memory ${AI_MEMORY_VERSION} (${arch}) verified and copied to ${out}`);
    return 0;
  } catch (e) {
    error(`fetch-ai-memory: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2));
}
