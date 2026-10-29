// `npm run core -- voice install` (#352, decision 0015): puts a `whisper-server` and the ggml model under
// `consoleHome()/voice` for the core's dictation. It builds whisper.cpp from a PINNED tag (with CUDA when
// the machine has an NVIDIA GPU and `nvcc`; else on the CPU, which is slower) and downloads the model from
// the whisper.cpp repository on Hugging Face. Every process runs with an argument list, no shell, and
// only what is listed here: git, cmake and the model download.

import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODEL_NAME, voiceFolder } from './whisper.ts';

/** The whisper.cpp release the install builds. Moving it is a decision: the server's flags can change. */
export const WHISPER_CPP_TAG = 'v1.9.5';
export const WHISPER_CPP_REPO = 'https://github.com/ggml-org/whisper.cpp';
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin`;

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
  renameSync(part, to);
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
    if (!(await has('cmake'))) throw new Error('cmake: não encontrado. Instale-o (apt install cmake) e rode de novo.');
    if (!existsSync(join(src, '.git'))) await run('git', ['clone', '--depth', '1', '--branch', WHISPER_CPP_TAG, WHISPER_CPP_REPO, src], undefined, log);
    await run('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', `-DGGML_CUDA=${gpu ? 'ON' : 'OFF'}`], src, log);
    await run('cmake', ['--build', 'build', '--config', 'Release', '-j', '--target', 'whisper-server'], src, log);
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
