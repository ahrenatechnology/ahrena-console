// Dictation in the compose box (#352, decision 0019): a person speaks, the /ui records and sends the
// WAV here, the local `whisper-server` (src/transcription) turns it into text and the box shows it.
//
// | Route                    | What                                                                                  |
// | ------------------------ | ------------------------------------------------------------------------------------- |
// | `GET /api/transcription` | `{ version, available, reason, model }`: whether the core can transcribe              |
// | `POST /api/transcription`| a 16 kHz mono PCM16 WAV (`audio/wav`) → `{ text, durationMs }`                         |
//
// Both routes are private: the owner proof (#302, owner-auth.ts) is checked in server.ts before
// anything here runs, so without the bearer the whisper is never reached.
// The POST is a same-origin exception of decision 0003, as the messages' (`transcriptionWriteFromSameOrigin`,
// called in server.ts `handle`): only `POST`, the exact raw path, `Origin` exactly `http://<Host>` with our
// Host, and a request WITHOUT `Origin` is refused too (`ui_only`): only audio the /ui recorded may go.
// The body is up to `MAX_AUDIO_BYTES` (5 minutes of 16 kHz mono PCM16 and a header). Neither the audio
// nor the text is kept, logged or put in an error. One transcription at a time (409 `busy`).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { TranscriptionError, type Transcription } from '../transcription/whisper.ts';

export const TRANSCRIPTION_ROUTE = '/api/transcription';
/** 5 minutes of 16 kHz mono PCM16 is 9 600 000 bytes; the rest is the header and some slack. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const ERRORS = {
  ui_only: 'O ditado só sai da tela do console.',
  unavailable: 'O ditado não está instalado nesta máquina.',
  busy: 'Ainda há uma transcrição em andamento. Espere ela terminar.',
  invalid_audio: 'O áudio não é um WAV de 16 kHz, mono, 16 bits.',
  too_large: 'O áudio passa de 5 minutos.',
  start_failed: 'O whisper-server não subiu. Veja o log do núcleo.',
  failed: 'O whisper-server não conseguiu transcrever. Tente de novo.',
} as const;

export function transcriptionWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  if (req.method !== 'POST' || req.url !== TRANSCRIPTION_ROUTE) return false;
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  return origin === `http://${host}`;
}

export type TranscriptionRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** The audio, or `null` as soon as it exceeds `max` (the rest is not kept). */
function readAudio(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) return resolve(null);
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (part: Buffer) => {
      if (over) return;
      size += part.length;
      if (size > max) {
        over = true;
        return resolve(null);
      }
      parts.push(part);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(parts));
    });
    req.on('error', reject);
  });
}

/** A RIFF/WAVE, PCM (1), mono, 16 kHz, 16 bits: what the /ui sends and what whisper.cpp reads without ffmpeg. */
export function isExpectedWav(b: Buffer): boolean {
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return false;
  return b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1 && b.readUInt32LE(24) === 16000 && b.readUInt16LE(34) === 16;
}

const BODY_CUTOFF_MS = 1000;

// The 413 goes out once the rest of the body is drained (none of it kept): answering first and closing
// resets the socket under a client still writing, which then sees ECONNRESET instead of the 413.
// A body still arriving after `BODY_CUTOFF_MS` gets the answer and the socket is dropped.
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('connection', 'close');
  const reply = () => {
    if (!res.headersSent) send(res, 413, { error: ERRORS.too_large, reason: 'too_large' });
  };
  const cutoff = setTimeout(() => {
    // Drop the socket only once the 413 is flushed, or a slow client gets no answer at all.
    res.once('finish', () => req.destroy());
    reply();
  }, BODY_CUTOFF_MS);
  cutoff.unref();
  req.once('end', () => {
    clearTimeout(cutoff);
    reply();
  });
  req.once('close', () => clearTimeout(cutoff));
  req.resume();
}

export function createTranscriptionRoute({ transcription, log = () => {} }: { transcription: Transcription; log?: (message: string) => void }): TranscriptionRoute {
  return async (req, res) => {
    if (req.method === 'GET') {
      const a = transcription.availability();
      return send(res, 200, { version: 1, available: a.available, reason: a.reason, model: a.model });
    }
    if (req.method !== 'POST') {
      req.resume();
      return send(res, 405, { error: 'use GET ou POST' });
    }
    if (typeof req.headers.origin !== 'string') {
      req.resume();
      return send(res, 403, { error: ERRORS.ui_only, reason: 'ui_only' });
    }
    if (!/^audio\/(?:x-)?wav\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return send(res, 415, { error: 'use audio/wav' });
    }
    if (!transcription.availability().available) {
      req.resume();
      return send(res, 503, { error: ERRORS.unavailable, reason: 'unavailable' });
    }
    const wav = await readAudio(req, MAX_AUDIO_BYTES);
    if (wav === null) return tooLarge(req, res);
    if (!isExpectedWav(wav)) return send(res, 400, { error: ERRORS.invalid_audio, reason: 'invalid_audio' });
    try {
      send(res, 200, await transcription.transcribe(wav));
    } catch (e) {
      const code = e instanceof TranscriptionError ? e.code : 'failed';
      log(`transcription: ${code}`);
      send(res, code === 'busy' ? 409 : code === 'unavailable' ? 503 : 502, { error: ERRORS[code], reason: code });
    }
  };
}
