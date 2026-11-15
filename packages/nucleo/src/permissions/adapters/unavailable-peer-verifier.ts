// The `PeerVerifier` of #619's layer 1: it never matches. Production stays off until the native adapter (layer 2) replaces it, so a
// core holds no window credential and the capability is unavailable. (#619)
import type { PeerVerdict, PeerVerifier } from '../window-channel.ts';

export class UnavailablePeerVerifier implements PeerVerifier {
  verify(_fd: number): Promise<PeerVerdict> {
    return Promise.resolve('unavailable');
  }
}
