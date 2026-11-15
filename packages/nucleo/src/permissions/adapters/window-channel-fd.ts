// Opens the inherited descriptor of the window channel as a read-only stream and starts reading it (#619). The descriptor is the
// app's socketpair end, handed through the owner `start` to a core it started; the core only reads from it.
import { Socket } from 'node:net';
import { readWindowChannel, type PeerVerifier, type WindowChannel } from '../window-channel.ts';
import type { WindowCredentialHolder } from '../window-credential.ts';

export interface OpenWindowChannelOptions {
  fd: number;
  verifier: PeerVerifier;
  holder: WindowCredentialHolder;
  log: (message: string) => void;
}

export function openWindowChannel(o: OpenWindowChannelOptions): WindowChannel {
  let stream: Socket;
  try {
    stream = new Socket({ fd: o.fd, readable: true, writable: false });
  } catch {
    // Not a socket, or not open: no channel, no credential. The cause's text stays out of the log.
    o.log('window channel revoked reason=error');
    o.holder.revoke();
    return { done: Promise.resolve() };
  }
  return readWindowChannel({ fd: o.fd, stream, verifier: o.verifier, holder: o.holder, log: o.log });
}
