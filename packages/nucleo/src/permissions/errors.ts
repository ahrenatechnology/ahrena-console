// What the use cases refuse that the aggregate cannot know: the request is not there for this session, or the digest
// the hook sent is not the one the core computes (#618/AC-1). The API maps them: 404 and 400. The aggregate's own
// refusals stay `PermissionRefusal`.

export class PermissionNotFound extends Error {
  readonly code = 'not_found';
  constructor() {
    super('not_found');
    this.name = 'PermissionNotFound';
  }
}

export class DigestMismatch extends Error {
  readonly code = 'digest_mismatch';
  constructor() {
    super('digest_mismatch');
    this.name = 'DigestMismatch';
  }
}
