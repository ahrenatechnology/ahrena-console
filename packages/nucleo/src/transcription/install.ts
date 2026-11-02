// `npm run core -- voice install` (#352, decision 0019): puts a `whisper-server` and the ggml model under
// `consoleHome()/voice` for the core's dictation. It builds whisper.cpp from a PINNED tag (with CUDA when
// the machine has an NVIDIA GPU and `nvcc`; else on the CPU, which is slower) and downloads the model from
// the whisper.cpp repository on Hugging Face. Every process runs with an argument list, no shell, and
// only what is listed here: git, cmake and the model download. Without a `cmake` on the PATH the install
// downloads Kitware's own pinned release into `voice/tools`, so the app needs no package manager.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODEL_NAME, voiceFolder } from './whisper.ts';

/**
 * The whisper.cpp release the install builds, in `whisper-cpp.json` (the desktop app's CI build,
 * apps/desktop/scripts/build-whisper-server.sh, reads the same file). Moving it is a decision: the
 * server's flags can change. The commit is the one the tag points at: the clone is refused when the tag moved.
 */
const PIN = JSON.parse(readFileSync(new URL('./whisper-cpp.json', import.meta.url), 'utf8')) as { tag: string; commit: string; repo: string };
export const WHISPER_CPP_TAG: string = PIN.tag;
export const WHISPER_CPP_COMMIT: string = PIN.commit;
export const WHISPER_CPP_REPO: string = PIN.repo;
export const CMAKE_VERSION = '3.31.6';
/** SHA-256 of Kitware's `cmake-<version>-linux-<arch>.tar.gz` (from the release's `-SHA-256.txt`). */
export const CMAKE_SHA256: Record<string, string> = {
  x86_64: '5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf',
  aarch64: 'b4cc788d63112b2749b40627e719eb5d3b8ed8f00c36d77189f4019cfe64bc9e',
};
/** The Hugging Face revision the model is read from, and the SHA-256 of the file at it. */
export const MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
export const MODEL_SHA256 = '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69';
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/ggml-${MODEL_NAME}.bin`;

export interface InstallOptions {
  home: string;
  log: (message: string) => void;
  /** `true` forces the CUDA build, `false` the CPU one; `null` decides by `nvidia-smi` and `nvcc`. */
  cuda?: boolean | null;
}

function run(cmd: string, args: string[], cwd: string | undefined, log: (m: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    c.once('error', () => reject(new Error(`${cmd}: não encontrado. Instale-o e rode de novo.`)));
    c.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0] ?? ''} saiu com código ${code}`))));
    log(`$ ${cmd} ${args.join(' ')}`);
  });
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Refuses (and deletes) a download whose digest is not the pinned one. */
async function verify(file: string, expected: string, what: string): Promise<void> {
  if ((await sha256(file)) === expected) return;
  rmSync(file, { force: true });
  throw new Error(`${what}: o SHA-256 do arquivo baixado não confere com o fixado; apagado.`);
}

function has(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(cmd, ['--version'], { stdio: 'ignore' });
    c.once('error', () => resolve(false));
    c.once('exit', (code) => resolve(code === 0));
  });
}

export type ModelDownloadFailure = 'http_error' | 'network_error' | 'disk_error' | 'checksum_mismatch';

export class ModelDownloadError extends Error {
  readonly code: ModelDownloadFailure;
  constructor(code: ModelDownloadFailure, message: string) {
    super(message);
    this.name = 'ModelDownloadError';
    this.code = code;
  }
}

export interface ModelDownloadOptions {
  log?: (m: string) => void;
  /** The pinned URL and digest by default; the tests point them at a local server and a fake digest. */
  url?: string;
  sha256?: string;
  fetch?: typeof fetch;
  /** Called as bytes arrive (`downloading`) and once more while the digest is checked (`verifying`). */
  onProgress?: (p: { phase: 'downloading' | 'verifying'; receivedBytes: number; totalBytes: number }) => void;
}

/**
 * Downloads the model to `to` through `to.part`, then checks the pinned SHA-256 and renames. A `.part`
 * left by an earlier attempt is resumed with a `Range` request (a server that answers 200 instead restarts
 * it); a download that fails on the network keeps its `.part`; a digest that does not match deletes it.
 */
export async function downloadModel(to: string, opts: ModelDownloadOptions = {}): Promise<void> {
  const { log = () => {}, url = MODEL_URL, sha256: expected = MODEL_SHA256, fetch: doFetch = fetch, onProgress = () => {} } = opts;
  const part = `${to}.part`;
  const have = existsSync(part) ? statSync(part).size : 0;
  let res: Response;
  try {
    res = await doFetch(url, { redirect: 'follow', headers: have > 0 ? { range: `bytes=${have}-` } : {} });
  } catch {
    throw new ModelDownloadError('network_error', 'download do modelo: sem conexão');
  }
  let start = 0;
  let total = 0;
  if (res.status === 416 && have > 0) {
    // The .part is already the whole file (or longer than it): the digest decides.
    start = have;
    total = have;
    await res.body?.cancel().catch(() => {});
  } else if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new ModelDownloadError('http_error', `download do modelo: HTTP ${res.status}`);
  } else {
    const length = Number(res.headers.get('content-length') ?? 0);
    start = res.status === 206 ? have : 0;
    total = start + length;
    log(`downloading ${url} (${Math.round(total / 1e6)} MB${start > 0 ? `, resuming at ${Math.round(start / 1e6)} MB` : ''})`);
    let received = start;
    onProgress({ phase: 'downloading', receivedBytes: received, totalBytes: total });
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        onProgress({ phase: 'downloading', receivedBytes: received, totalBytes: total });
        cb(null, chunk);
      },
    });
    const out = createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
    try {
      await pipeline(Readable.fromWeb(res.body as never), counter, out);
    } catch (e) {
      throw e instanceof Error && 'code' in e && typeof e.code === 'string' && /^E(NOSPC|ACCES|PERM|ROFS|DQUOT|IO)$/.test(e.code)
        ? new ModelDownloadError('disk_error', 'download do modelo: não foi possível gravar no disco')
        : new ModelDownloadError('network_error', 'download do modelo: a conexão caiu');
    }
  }
  const size = statSync(part).size;
  onProgress({ phase: 'verifying', receivedBytes: size, totalBytes: Math.max(total, size) });
  if ((await sha256(part)) !== expected) {
    rmSync(part, { force: true });
    throw new ModelDownloadError('checksum_mismatch', 'modelo: o SHA-256 do arquivo baixado não confere com o fixado; apagado.');
  }
  renameSync(part, to);
}

/** A `cmake` to run: the one on the PATH, else Kitware's release, downloaded once under `voice/tools`. */
async function ensureCmake(folder: string, log: (m: string) => void): Promise<string> {
  if (await has('cmake')) return 'cmake';
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  if (process.platform !== 'linux' || arch === null) throw new Error('cmake: não encontrado. Instale-o e rode de novo.');
  const name = `cmake-${CMAKE_VERSION}-linux-${arch}`;
  const tools = join(folder, 'tools');
  const cmake = join(tools, name, 'bin', 'cmake');
  if (existsSync(cmake)) return cmake;
  mkdirSync(tools, { recursive: true });
  const url = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/${name}.tar.gz`;
  log(`cmake not found: downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download do cmake: HTTP ${res.status}`);
  const tgz = join(tools, `${name}.tar.gz`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tgz));
  await verify(tgz, CMAKE_SHA256[arch]!, 'cmake');
  await run('tar', ['-xzf', tgz, '-C', tools], undefined, log);
  rmSync(tgz, { force: true });
  return cmake;
}

export async function installVoice({ home, log, cuda = null }: InstallOptions): Promise<{ bin: string; model: string; cuda: boolean }> {
  const folder = voiceFolder(home);
  const src = join(folder, 'src');
  const bin = join(folder, 'bin', 'whisper-server');
  const model = join(folder, 'models', `ggml-${MODEL_NAME}.bin`);
  mkdirSync(join(folder, 'bin'), { recursive: true });
  mkdirSync(join(folder, 'models'), { recursive: true });

  if (!existsSync(bin)) {
    const gpu = cuda ?? ((await has('nvidia-smi')) && (await has('nvcc')));
    if (cuda === null && (await has('nvidia-smi')) && !gpu) log('NVIDIA GPU found but no `nvcc`: building for the CPU (much slower). Install the CUDA toolkit and run again for the GPU.');
    const cmake = await ensureCmake(folder, log);
    if (!existsSync(join(src, '.git'))) await run('git', ['clone', '--depth', '1', '--branch', WHISPER_CPP_TAG, WHISPER_CPP_REPO, src], undefined, log);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();
    if (head !== WHISPER_CPP_COMMIT) throw new Error(`whisper.cpp ${WHISPER_CPP_TAG}: o commit ${head} não é o fixado (${WHISPER_CPP_COMMIT}). Apague ${src} e rode de novo.`);
    await run(cmake, ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', `-DGGML_CUDA=${gpu ? 'ON' : 'OFF'}`], src, log);
    await run(cmake, ['--build', 'build', '--config', 'Release', '-j', '--target', 'whisper-server'], src, log);
    copyFileSync(join(src, 'build', 'bin', 'whisper-server'), bin);
    chmodSync(bin, 0o755);
    rmSync(join(src, 'build'), { recursive: true, force: true });
    log(`whisper-server (${gpu ? 'CUDA' : 'CPU'}) at ${bin}`);
    if (!gpu) log('built for the CPU');
  } else log(`whisper-server already at ${bin}`);

  if (!existsSync(model)) await downloadModel(model, { log });
  else log(`model already at ${model}`);
  return { bin, model, cuda: cuda ?? false };
}
