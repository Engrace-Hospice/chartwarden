// Shared Claim.MD protected-payload cipher. Account keys never enter this module; only the secret-manager key ring does.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface ClaimMdPayloadKeyRing { readonly activeId: string; readonly byId: ReadonlyMap<string, Buffer> }
export interface ClaimMdProtectedPayloadCipher {
  seal(streamId: string, itemId: string, plaintext: string): Buffer;
  open(streamId: string, itemId: string, sealed: Buffer): string;
}

export function createClaimMdProtectedPayloadCipher(
  keys: ClaimMdPayloadKeyRing,
  purpose: "claimmd-response:v1" | "claimmd-era:v1",
  maxBytes = 32 * 1024 * 1024,
): ClaimMdProtectedPayloadCipher {
  const key = keys.byId.get(keys.activeId);
  if (!key || key.length !== 32 || !/^[A-Za-z0-9._-]{1,64}$/.test(keys.activeId))
    throw new Error("Claim.MD protected payload key ring is unavailable");
  const aad = (streamId: string, itemId: string) => Buffer.from(`${purpose}:${streamId}:${itemId}`);
  return {
    seal(streamId, itemId, plaintext) {
      const bytes = Buffer.from(plaintext, "utf8");
      if (bytes.length > maxBytes) throw new Error("Claim.MD protected payload exceeds configured size limit");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(streamId, itemId));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([Buffer.from(`v1.${keys.activeId}.`), nonce, cipher.getAuthTag(), encrypted]);
    },
    open(streamId, itemId, sealed) {
      const marker = sealed.indexOf(46, 3);
      if (sealed.subarray(0, 3).toString() !== "v1." || marker < 4 || marker > 70)
        throw new Error("Claim.MD protected payload ciphertext is invalid");
      const id = sealed.subarray(3, marker).toString();
      const oldKey = keys.byId.get(id);
      if (!oldKey || oldKey.length !== 32 || sealed.length < marker + 1 + 28)
        throw new Error("Claim.MD protected payload key is unavailable");
      const start = marker + 1;
      const decipher = createDecipheriv("aes-256-gcm", oldKey, sealed.subarray(start, start + 12));
      decipher.setAAD(aad(streamId, itemId));
      decipher.setAuthTag(sealed.subarray(start + 12, start + 28));
      try { return Buffer.concat([decipher.update(sealed.subarray(start + 28)), decipher.final()]).toString("utf8"); }
      catch { throw new Error("Claim.MD protected payload authentication failed"); }
    },
  };
}
