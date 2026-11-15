// The channel the app uses to hand the core its window credential (decision 0025, #619). The app writes one credential per line
// over an inherited Unix socket; the core accepts a line only when the peer verifier says the peer is the installed app. Anything
// else revokes and closes: a line that is not 64 lowercase hex characters, a peer that does not match or cannot be checked, the
// end of the stream, an error. The value is never logged: only closed codes. (#619, layer 1; the native verifier is layer 2)
import type { Readable } from 'node:stream';
import type { WindowCredentialHolder } from './window-credential.ts';

export type PeerVerdict = 'match' | 'mismatch' | 'unavailable';

/** Whether the process at the other end of the channel's descriptor is the installed app. The native adapter is #619's layer 2. */
export interface PeerVerifier {
  verify(fd: number): Promise<PeerVerdict>;
}

export interface WindowChannelDeps {
  /** The channel's descriptor, handed to the verifier before each line is accepted. */
  fd: number;
  stream: Readable;
  verifier: PeerVerifier;
  holder: WindowCredentialHolder;
  /** Receives closed codes only (`window channel refused peer=mismatch`), never the value. */
  log: (message: string) => void;
}

export interface WindowChannel {
  /** Settles when the channel is closed, for whatever reason. Never rejects. */
  done: Promise<void>;
}

const CREDENTIAL = /^[0-9a-f]{64}$/;
/** A credential is 64 characters; a longer unterminated run is not one. */
const MAX_LINE = 64;
const MIN_FD = 3;
const MAX_FD = 65535;

/** `--window-channel <fd>`: a small integer, 3 or more. Absent is `undefined`; anything else invalid throws. */
export function parseWindowChannelFd(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error('--window-channel: a descriptor number, 3 or more');
  const fd = Number(value);
  if (fd < MIN_FD || fd > MAX_FD) throw new Error('--window-channel: a descriptor number, 3 or more');
  return fd;
}

export function readWindowChannel(deps: WindowChannelDeps): WindowChannel {
  const { fd, stream, verifier, holder, log } = deps;
  let buffered = '';
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));

  const close = (reason: 'eof' | 'error' | 'invalid_line' | 'refused'): void => {
    if (closed) return;
    closed = true;
    holder.revoke();
    if (reason !== 'refused') log(`window channel revoked reason=${reason}`);
    stream.destroy();
    // The queued verdicts of lines read before the close are awaited, so `done` means nothing can set a credential any more.
    void queue.then(finish);
  };

  const verdictOf = async (): Promise<PeerVerdict> => {
    try {
      return await verifier.verify(fd);
    } catch {
      // The native failure's text stays out of the log: the verdict is all that is recorded.
      return 'unavailable';
    }
  };

  const accept = async (line: string): Promise<void> => {
    // A new line revokes the previous credential before the peer is checked again: rotation never leaves the old one live.
    holder.revoke();
    const verdict = await verdictOf();
    if (closed) return;
    if (verdict === 'match') {
      holder.accept(line);
      return;
    }
    log(`window channel refused peer=${verdict}`);
    close('refused');
  };

  stream.setEncoding('latin1');
  stream.on('data', (chunk: string) => {
    if (closed) return;
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!CREDENTIAL.test(line)) return close('invalid_line');
      queue = queue.then(() => accept(line));
    }
    if (buffered.length > MAX_LINE) close('invalid_line');
  });
  stream.on('end', () => close('eof'));
  stream.on('error', () => close('error'));
  stream.on('close', () => close('eof'));
  return { done };
}
