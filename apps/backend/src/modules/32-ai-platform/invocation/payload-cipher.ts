// apps/backend/src/modules/32-ai-platform/invocation/payload-cipher.ts — the per-tenant DEK envelope for
// `ai_invocation.prompt_payload_cipher` / `response_payload_cipher` / `chart_context_cipher` (§3.6;
// F-236).
//
// The pipeline was never constructed because this binding did not exist (index.ts's M32 note: "a pipeline
// built without one could write plaintext PHI into a column named `prompt_payload_cipher`"). It is the
// M34 `TenantKeyProvider` envelope every other PHI cipher on the platform uses: AES-256-GCM under the
// org's DEK, AAD bound to (module, table, org) so a ciphertext copied into another tenant's row cannot be
// opened, and the DEK version inside the envelope so a rotated key ring still decrypts.
//
// Wire format (bytea): 0x01 | u8 versionLength | version (utf8) | nonce (12) | tag (16) | ciphertext.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AiPayloadCipher } from "./service";

export interface AiPayloadKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

const FORMAT = 0x01;
const aad = (organizationId: string): Buffer =>
  Buffer.from(`m32:ai_invocation:payload:${organizationId}`, "utf8");

export function createAiPayloadCipher(keys: AiPayloadKeyProvider): AiPayloadCipher & {
  decrypt(organizationId: string, envelope: Buffer): Promise<string>;
} {
  return {
    async encrypt(organizationId, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const v = Buffer.from(version, "utf8");
      if (v.byteLength > 255) throw new Error("DEK version label too long");
      const nonce = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(aad(organizationId));
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return Buffer.concat([Buffer.from([FORMAT, v.byteLength]), v, nonce, c.getAuthTag(), ct]);
    },
    async decrypt(organizationId, envelope) {
      if (envelope.byteLength < 2 || envelope[0] !== FORMAT)
        throw new Error("unrecognised AI payload envelope");
      const vLen = envelope[1] as number;
      const version = envelope.subarray(2, 2 + vLen).toString("utf8");
      const nonce = envelope.subarray(2 + vLen, 14 + vLen);
      const tag = envelope.subarray(14 + vLen, 30 + vLen);
      const ct = envelope.subarray(30 + vLen);
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const d = createDecipheriv("aes-256-gcm", key, nonce);
      d.setAAD(aad(organizationId));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    },
  };
}
