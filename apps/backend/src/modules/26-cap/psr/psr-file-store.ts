// apps/backend/src/modules/26-cap/psr/psr-file-store.ts — the DEK-encrypted PS&R raw-file store (M26 §3.3,
// GAP-078). The CSV carries MBIs + per-beneficiary payment detail, so the object-store bytes are an
// AES-256-GCM envelope under the M34 tenant DEK (the `TenantKeyProvider` the M12/M22/M31 ciphers use), AAD
// bound to (module, table, org) so a ciphertext copied into another tenant's key cannot be opened. The DEK
// VERSION travels in the envelope so a rotated key ring still decrypts. The raw object client (MinIO) and the
// key provider are injected structurally — M26 has no M22/M34 import edge; the composition root binds both.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PsrFileStorePort } from "./psr-reconcile";

/** The slice of M34's `TenantKeyProvider` this store needs. */
export interface PsrKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

/** The raw tenant-bucket object client (MinIO in production). */
export interface PsrObjectClient {
  putObject(args: {
    organizationId: string;
    objectKey: string;
    bytes: Uint8Array;
  }): Promise<void>;
  getObject(args: { organizationId: string; objectKey: string }): Promise<Uint8Array>;
}

const ENVELOPE_VERSION = "v1";
const aad = (organizationId: string): Buffer =>
  Buffer.from(`m26:cap_psr_import:file:${organizationId}`, "utf8");

export function createPsrFileStore(deps: {
  readonly keys: PsrKeyProvider;
  readonly objects: PsrObjectClient;
}): PsrFileStorePort {
  return {
    async put(organizationId, storageKey, bytes) {
      const { version, key } = await deps.keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(organizationId));
      const ct = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const envelope = [
        ENVELOPE_VERSION,
        Buffer.from(version, "utf8").toString("base64url"),
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ct.toString("base64url"),
      ].join(".");
      await deps.objects.putObject({
        organizationId,
        objectKey: storageKey,
        bytes: Buffer.from(envelope, "utf8"),
      });
    },
    async get(organizationId, storageKey) {
      const raw = await deps.objects.getObject({ organizationId, objectKey: storageKey });
      const [v, versionB64, nonce, tag, ct] = Buffer.from(raw).toString("utf8").split(".");
      if (v !== ENVELOPE_VERSION || !versionB64 || !nonce || !tag || ct === undefined)
        throw new Error("unrecognised PS&R file envelope");
      const version = Buffer.from(versionB64, "base64url").toString("utf8");
      const { key } = await deps.keys.dekForOrgVersion(organizationId, version);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      decipher.setAAD(aad(organizationId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]);
    },
  };
}
