// `npm run core -- voice install` (#352, decision 0019): puts a `whisper-server` and the ggml model under
// `consoleHome()/voice` for the core's dictation. It builds whisper.cpp from a PINNED tag (with CUDA when
// the machine has an NVIDIA GPU and `nvcc`; else on the CPU, which is slower) and downloads the model from
// the whisper.cpp repository on Hugging Face. Every process runs with an argument list, no shell, and
// only what is listed here: git, cmake and the model download. Without a `cmake` on the PATH the install
// downloads Kitware's own pinned release into `voice/tools`, so the app needs no package manager.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODEL_NAME, voiceFolder } from './whisper.ts';

/** The whisper.cpp release the install builds. Moving it is a decision: the server's flags can change. */
export const WHISPER_CPP_TAG = 'v1.9.5';
/** The commit the tag points at: the clone is refused when the tag moved. */
export const WHISPER_CPP_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
export const WHISPER_CPP_REPO = 'https://github.com/ggml-org/whisper.cpp';
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

async function downloadModel(to: string, log: (m: string) => void): Promise<void> {
  const res = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download do modelo: HTTP ${res.status}`);
  const part = `${to}.part`;
  log(`downloading ${MODEL_URL} (${Math.round(Number(res.headers.get('content-length') ?? 0) / 1e6)} MB)`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  await verify(part, MODEL_SHA256, 'modelo');
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

  if (!existsSync(model)) await downloadModel(model, log);
  else log(`model already at ${model}`);
  return { bin, model, cuda: cuda ?? false };
}
