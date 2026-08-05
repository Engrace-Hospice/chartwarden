import { createCipheriv, randomBytes } from "node:crypto";
import type { ConsentInternalNotesCipher } from "./consent-store-db";

export interface ConsentTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
}

/** AES-256-GCM envelope. The DEK version is embedded so rotation retains decryptability. */
export function createConsentInternalNotesCipher(
  keys: ConsentTenantKeyProvider,
): ConsentInternalNotesCipher {
  return {
    async encrypt(organizationId, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`m39:consent_record:internal_notes:${organizationId}`, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        "v1",
        version,
        nonce.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
  };
}
