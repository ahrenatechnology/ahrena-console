// Dictation (#352, decision 0019): the transcription of what a person said into the compose box,
// by a whisper.cpp `whisper-server` on this machine. The core starts it on the first request, keeps
// it while it is used and stops it when idle and at shutdown; or, with `AHRENA_CONSOLE_WHISPER_URL`,
// only points at one that already runs. It listens on 127.0.0.1 only and the audio never leaves the
// machine. The audio and the text are never logged.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MODEL_NAME = 'large-v3-turbo';
const LOOPBACK = '127.0.0.1';

/** Where `voice install` puts the binary and the model, under the per-user folder (`consoleHome()`). */
export function voiceFolder(home: string): string {
  return join(home, 'voice');
}

export interface WhisperConfig {
  /** An already running `whisper-server` (`AHRENA_CONSOLE_WHISPER_URL`, loopback only); else the core starts its own. */
  url: string | null;
  bin: string;
  model: string;
}

/** `AHRENA_CONSOLE_WHISPER_URL`, `AHRENA_CONSOLE_WHISPER_BIN` and `AHRENA_CONSOLE_WHISPER_MODEL`, over the folder `voice install` fills. */
export function resolveWhisperConfig(home: string, env: NodeJS.ProcessEnv = process.env): WhisperConfig {
  const folder = voiceFolder(home);
  const url = env.AHRENA_CONSOLE_WHISPER_URL?.trim() || null;
  if (url !== null) {
    const u = new URL(url);
    if (u.protocol !== 'http:' || (u.hostname !== LOOPBACK && u.hostname !== 'localhost' && u.hostname !== '[::1]')) throw new Error('AHRENA_CONSOLE_WHISPER_URL: an http URL on 127.0.0.1 or localhost');
  }
  return {
    url,
    bin: env.AHRENA_CONSOLE_WHISPER_BIN?.trim() || join(folder, 'bin', 'whisper-server'),
    model: env.AHRENA_CONSOLE_WHISPER_MODEL?.trim() || join(folder, 'models', `ggml-${MODEL_NAME}.bin`),
  };
}

export type UnavailableReason = 'not_installed' | 'model_missing';

export interface TranscriptionAvailability {
  available: boolean;
  reason: UnavailableReason | null;
  model: string;
}

export type TranscriptionFailure = 'unavailable' | 'busy' | 'start_failed' | 'failed';

export class TranscriptionError extends Error {
  readonly code: TranscriptionFailure;
  constructor(code: TranscriptionFailure, message: string) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
  }
}

export interface TranscriptionOptions {
  config: WhisperConfig;
  log?: (message: string) => void;
  /** How long the server stays up after the last use. */
  idleMs?: number;
  /** How long to wait for a started server to answer (the model loads from disk). */
  startTimeoutMs?: number;
  /** How long one inference may take. */
  inferenceTimeoutMs?: number;
  // Doubles for the tests.
  exists?: (path: string) => boolean;
  start?: (bin: string, args: string[]) => ChildProcess;
  fetch?: typeof fetch;
  freePort?: () => Promise<number>;
}

export interface Transcription {
  availability(): TranscriptionAvailability;
  /** The text of a 16 kHz mono PCM16 WAV, and how long the transcription took. One at a time. */
  transcribe(wav: Buffer): Promise<{ text: string; durationMs: number }>;
  close(): void;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, LOOPBACK, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fresh 0700 folder (mkdtemp) with one random file holding a random value: what only our child can serve. */
function readinessProof(): { dir: string; file: string; value: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ahrena-whisper-'));
  const file = `${randomBytes(16).toString('hex')}.txt`;
  const value = randomBytes(32).toString('hex');
  writeFileSync(join(dir, file), value, { mode: 0o600, flag: 'wx' });
  return { dir, file, value, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What whisper.cpp prints for silence and for sounds, which are not words. */
const NOISE = /\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]|\((?:music|silence)\)/gi;

export function cleanText(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(NOISE, ' ').replace(/\s+/g, ' ').trim() : '';
}

export function createTranscription(opts: TranscriptionOptions): Transcription {
  const { config, log = () => {}, idleMs = 10 * 60_000, startTimeoutMs = 120_000, inferenceTimeoutMs = 180_000 } = opts;
  const exists = opts.exists ?? existsSync;
  const doFetch = opts.fetch ?? fetch;
  const startChild =
    opts.start ??
    ((bin, args) => spawn(bin, args, { stdio: 'ignore', detached: false }));
  const freePort = opts.freePort ?? freeLoopbackPort;

  let child: ChildProcess | null = null;
  let base: string | null = config.url ? config.url.replace(/\/+$/, '') : null;
  let starting: Promise<string> | null = null;
  let idle: NodeJS.Timeout | null = null;
  let busy = false;
  let cleanup: (() => void) | null = null;

  const availability = (): TranscriptionAvailability => {
    if (config.url) return { available: true, reason: null, model: MODEL_NAME };
    if (!exists(config.bin)) return { available: false, reason: 'not_installed', model: MODEL_NAME };
    if (!exists(config.model)) return { available: false, reason: 'model_missing', model: MODEL_NAME };
    return { available: true, reason: null, model: MODEL_NAME };
  };

  function stopChild(): void {
    if (idle) clearTimeout(idle);
    idle = null;
    const c = child;
    child = null;
    starting = null;
    if (!config.url) base = null;
    if (c && c.exitCode === null) c.kill('SIGTERM');
    removeProof();
  }

  function removeProof(): void {
    const remove = cleanup;
    cleanup = null;
    remove?.();
  }

  function armIdle(): void {
    if (config.url) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      log('transcription: whisper-server stopped (idle)');
      stopChild();
    }, idleMs);
    idle.unref();
  }

  async function ensureServer(): Promise<string> {
    if (base) return base;
    if (starting) return starting;
    starting = (async () => {
      const port = await freePort();
      // Ready only when the port answers with a secret only OUR child can read. The port is free
      // between `freePort` and the child's bind, which comes after the model loads (seconds), and
      // `--port` is in its argv, which `ps` shows to every user of the machine: a plain probe would
      // accept whoever bound it first, and that process would get the owner's audio and choose the
      // text (#302 threat model). The child serves `--public` from a fresh 0700 folder holding a
      // random file with a random value; another user can neither list nor read it, so a server that
      // returns the value is ours. (Its "listening" line is no signal: it goes to a fully buffered
      // stdout.) A child that lost the port exits: start_failed.
      const proof = readinessProof();
      cleanup = proof.remove;
      log('transcription: starting whisper-server on 127.0.0.1');
      const c = startChild(config.bin, ['-m', config.model, '--host', LOOPBACK, '--port', String(port), '--public', proof.dir, '-l', 'pt']);
      child = c;
      let gone = false;
      c.once('exit', () => {
        gone = true;
        if (child === c) {
          child = null;
          starting = null;
          if (!config.url) base = null;
          removeProof();
        }
      });
      c.once('error', () => {
        gone = true;
      });
      const url = `http://${LOOPBACK}:${port}`;
      const deadline = Date.now() + startTimeoutMs;
      while (Date.now() < deadline) {
        if (gone) throw new TranscriptionError('start_failed', 'o whisper-server não subiu');
        try {
          const r = await doFetch(`${url}/${proof.file}`, { signal: AbortSignal.timeout(2000) });
          if (r.ok && (await r.text()) === proof.value) {
            base = url;
            return url;
          }
        } catch {
          // not bound yet
        }
        await sleep(250);
      }
      stopChild();
      throw new TranscriptionError('start_failed', 'o whisper-server não respondeu a tempo');
    })();
    try {
      return await starting;
    } catch (e) {
      starting = null;
      stopChild();
      throw e;
    }
  }

  return {
    availability,
    async transcribe(wav) {
      if (!availability().available) throw new TranscriptionError('unavailable', 'a transcrição não está instalada');
      if (busy) throw new TranscriptionError('busy', 'já há uma transcrição em andamento');
      busy = true;
      const t0 = Date.now();
      try {
        const url = await ensureServer();
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
        form.append('language', 'pt');
        form.append('response_format', 'json');
        form.append('temperature', '0.0');
        let r: Response;
        try {
          r = await doFetch(`${url}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(inferenceTimeoutMs) });
        } catch {
          // A server that died or hung: next time starts a fresh one.
          if (!config.url) stopChild();
          throw new TranscriptionError('failed', 'o whisper-server não respondeu');
        }
        if (!r.ok) throw new TranscriptionError('failed', `o whisper-server respondeu ${r.status}`);
        const body = (await r.json().catch(() => null)) as { text?: unknown } | null;
        return { text: cleanText(body?.text), durationMs: Date.now() - t0 };
      } finally {
        busy = false;
        armIdle();
      }
    },
    close: stopChild,
  };
}
