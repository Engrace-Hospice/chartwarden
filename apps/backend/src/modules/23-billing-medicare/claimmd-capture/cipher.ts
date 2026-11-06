// Platform-held AES-256-GCM envelope, following the repository's M2/M23 cipher pattern.
// The key ring is injected from a secret manager; this module never reads a credential by itself.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAX_BYTES = 8 * 1024 * 1024;
export interface ClaimMdInboxKeyRing {
  readonly activeId: string;
  readonly byId: ReadonlyMap<string, Buffer>;
}
const aad = (streamId: string, cursor: string) => Buffer.from(`claimmd-response:v1:${streamId}:${cursor}`);

export function createClaimMdInboxCipher(keys: ClaimMdInboxKeyRing) {
  const key = keys.byId.get(keys.activeId);
  if (!key || key.length !== 32 || !/^[A-Za-z0-9._-]{1,64}$/.test(keys.activeId))
    throw new Error("Claim.MD inbox cipher key ring is unavailable");
  return {
    seal(streamId: string, cursor: string, plaintext: string): Buffer {
      const bytes = Buffer.from(plaintext, "utf8");
      if (bytes.length > MAX_BYTES) throw new Error("Claim.MD response exceeds protected payload limit");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(streamId, cursor));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([Buffer.from(`v1.${keys.activeId}.`), nonce, cipher.getAuthTag(), encrypted]);
    },
    open(streamId: string, cursor: string, sealed: Buffer): string {
      const marker = sealed.indexOf(46, 3);
      if (sealed.subarray(0, 3).toString() !== "v1." || marker < 4 || marker > 70)
        throw new Error("Claim.MD inbox ciphertext is invalid");
      const id = sealed.subarray(3, marker).toString();
      const oldKey = keys.byId.get(id);
      if (!oldKey || oldKey.length !== 32 || sealed.length < marker + 1 + 28)
        throw new Error("Claim.MD inbox decryption key is unavailable");
      const start = marker + 1;
      const decipher = createDecipheriv("aes-256-gcm", oldKey, sealed.subarray(start, start + 12));
      decipher.setAAD(aad(streamId, cursor));
      decipher.setAuthTag(sealed.subarray(start + 12, start + 28));
      try {
        return Buffer.concat([decipher.update(sealed.subarray(start + 28)), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("Claim.MD inbox ciphertext authentication failed");
      }
    },
  };
}
