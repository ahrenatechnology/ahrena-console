// The model download the core owns (#405, decision 0019 item 10): on a machine with a `whisper-server` but
// without the model, the first use of dictation starts one download of the pinned model, in the core, so
// it survives the /ui tab closing. One at a time; the state lives in memory and is what
// `GET /api/transcription` reports. Nothing but sizes and a failure code is logged or kept.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { downloadModel, ModelDownloadError, type ModelDownloadFailure, type ModelDownloadOptions } from './install.ts';

export type ModelDownloadState = 'idle' | 'downloading' | 'verifying' | 'failed';

export interface ModelDownloadStatus {
  state: ModelDownloadState;
  receivedBytes: number;
  totalBytes: number;
  /** Set only when `state` is `failed`: a code, never a message from the network or a stack. */
  error?: ModelDownloadFailure;
}

export interface ModelDownload {
  status(): ModelDownloadStatus;
  /** Starts the download unless one runs (then it only returns the current state). Never throws. */
  start(): ModelDownloadStatus;
  /** Resolves when the running download ends (for the tests and the shutdown). */
  settled(): Promise<void>;
}

export interface ModelDownloadConfig extends Pick<ModelDownloadOptions, 'url' | 'sha256' | 'fetch'> {
  /** Where the model lands (`WhisperConfig.model`). */
  target: string;
  log?: (message: string) => void;
}

export function createModelDownload({ target, log = () => {}, url, sha256, fetch }: ModelDownloadConfig): ModelDownload {
  let current: ModelDownloadStatus = { state: 'idle', receivedBytes: 0, totalBytes: 0 };
  let running: Promise<void> = Promise.resolve();

  return {
    status: () => ({ ...current }),
    start() {
      if (current.state === 'downloading' || current.state === 'verifying') return { ...current };
      current = { state: 'downloading', receivedBytes: 0, totalBytes: 0 };
      log('transcription: model download started');
      running = (async () => {
        try {
          mkdirSync(dirname(target), { recursive: true });
          await downloadModel(target, {
            url,
            sha256,
            fetch,
            onProgress: (p) => {
              current = { state: p.phase, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes };
            },
          });
          log(`transcription: model downloaded (${current.receivedBytes} bytes)`);
          current = { state: 'idle', receivedBytes: 0, totalBytes: 0 };
        } catch (e) {
          const error: ModelDownloadFailure = e instanceof ModelDownloadError ? e.code : 'disk_error';
          log(`transcription: model download failed (${error}) after ${current.receivedBytes} bytes`);
          current = { state: 'failed', receivedBytes: current.receivedBytes, totalBytes: current.totalBytes, error };
        }
      })();
      return { ...current };
    },
    settled: () => running,
  };
}
