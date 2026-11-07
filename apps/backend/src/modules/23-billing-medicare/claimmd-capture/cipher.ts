// Platform-held AES-256-GCM envelope, following the repository's M2/M23 cipher pattern.
// The key ring is injected from a secret manager; this module never reads a credential by itself.
import { createClaimMdProtectedPayloadCipher } from "../../../bootstrap/claimmd-payload-cipher";

const MAX_BYTES = 8 * 1024 * 1024;
export interface ClaimMdInboxKeyRing {
  readonly activeId: string;
  readonly byId: ReadonlyMap<string, Buffer>;
}
export function createClaimMdInboxCipher(keys: ClaimMdInboxKeyRing) {
  return createClaimMdProtectedPayloadCipher(keys, "claimmd-response:v1", MAX_BYTES);
}
