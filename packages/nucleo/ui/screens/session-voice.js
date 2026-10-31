// Dictation in the compose box (issue 352, decision 0019): records the microphone in the browser and makes
// the WAV the core's whisper-server reads (16 kHz, mono, PCM16), with no ffmpeg anywhere.
//
// The audio lives in memory only: it goes in the body of one POST to /api/transcription and nowhere
// else (never a URL, a log, localStorage or the DOM). The tracks and the AudioContext are released
// as soon as the recording ends, is cancelled or fails.
//
// Capture is a ScriptProcessorNode, not an AudioWorklet: it is deprecated but works in every browser
// the console runs in, and a worklet would need a second file served beside this one.

import { el } from '../dom.js';

export const SAMPLE_RATE = 16000;
/** The recording stops by itself here; the core refuses more than 5 minutes (api/transcription.ts). */
export const MAX_SECONDS = 300;
/** The bars of the level meter. */
export const BARS = 40;

/** m:ss, as in the wireframe: "0:12". */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "1,4 s", the way the person reads a short time. */
export function secondsText(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1).replace('.', ',')} s`;
}

/** Whether this browser can record at all (a secure context, which localhost is). */
export function dictationSupported(env = globalThis) {
  return typeof env.navigator?.mediaDevices?.getUserMedia === 'function' && !!(env.AudioContext ?? env.webkitAudioContext);
}

/** One Float32Array from the chunks the processor delivered. */
function join(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Samples at `fromRate` to 16 kHz: the mean of the window each output sample covers (a box filter, enough for speech). */
export function resampleTo16k(samples, fromRate) {
  if (fromRate === SAMPLE_RATE) return samples;
  const ratio = fromRate / SAMPLE_RATE;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j];
    out[i] = sum / (to - from);
  }
  return out;
}

/** A WAV file (RIFF, PCM, mono, 16 bits, 16 kHz) of the samples, which are floats in -1..1. */
export function encodeWav(samples) {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const v = new DataView(buffer);
  const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Why the microphone could not be opened, in one sentence for the status line. */
export function microphoneError(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { denied: true, text: 'o navegador negou o microfone. Libere nas permissões do site e tente de novo.' };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { denied: false, text: 'o navegador não achou um microfone.' };
    case 'NotReadableError':
      return { denied: false, text: 'o microfone está em uso por outro programa.' };
    default:
      return { denied: false, text: 'não deu para abrir o microfone.' };
  }
}

/**
 * Opens the microphone and starts recording. Rejects with the browser's error (`NotAllowedError`, …).
 * Returns `{ seconds(), level(), stop(), cancel() }`: `level()` is 0 to 1 right now, `stop()` resolves
 * `{ wav, seconds }` and `cancel()` throws the audio away.
 */
export async function startRecording(env = globalThis) {
  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const Context = env.AudioContext ?? env.webkitAudioContext;
  let context;
  try {
    context = new Context();
    // Chrome starts a context made outside a gesture suspended; this one comes from a click or a key.
    await context.resume?.();
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  const processor = context.createScriptProcessor(4096, 1, 1);
  // The processor only runs when it reaches the destination; muted, so nothing is played back.
  const silent = context.createGain();
  silent.gain.value = 0;
  source.connect(analyser);
  source.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);

  const chunks = [];
  let total = 0;
  processor.onaudioprocess = (ev) => {
    const data = ev.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    total += data.length;
  };
  const wave = new Uint8Array(analyser.fftSize);
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
      silent.disconnect();
    } catch {
      /* already disconnected */
    }
    stream.getTracks().forEach((t) => t.stop());
    context.close?.().catch?.(() => {});
  };
  // The clock the person sees (and the 5-minute limit) is the wall clock: the audio thread may deliver
  // its blocks late (a tab without an audio sink), the samples still say how much audio there is.
  const began = Date.now();
  const seconds = () => (Date.now() - began) / 1000;
  return {
    seconds,
    level() {
      analyser.getByteTimeDomainData(wave);
      let sum = 0;
      for (const b of wave) sum += ((b - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / wave.length) * 4);
    },
    async stop() {
      const rate = context.sampleRate;
      release();
      const samples = join(chunks);
      return { wav: encodeWav(resampleTo16k(samples, rate)), seconds: samples.length / rate };
    },
    cancel() {
      release();
      chunks.length = 0;
    },
  };
}

/** The red strip that takes the text field's place while recording: dot, time, level and the Esc hint. */
export function createRecordingBar() {
  const time = el('span', { class: 'sm-rectime mono' }, '0:00');
  const bars = Array.from({ length: BARS }, () => el('i'));
  const node = el(
    'div',
    { class: 'sm-recbar', role: 'status', 'aria-label': 'Gravando' },
    el('span', { class: 'sm-recdot' }),
    time,
    el('div', { class: 'sm-level', 'aria-hidden': 'true' }, ...bars),
    el('span', { class: 'sm-rechint' }, 'Esc cancela'),
  );
  node.hidden = true;
  return {
    node,
    /** Draws the time and pushes the newest level (0 to 1) onto the right of the meter. */
    update(seconds, levels) {
      time.textContent = clock(seconds);
      bars.forEach((b, i) => b.style.setProperty('--h', `${Math.round(4 + (levels[i] ?? 0) * 22)}px`));
    },
  };
}
