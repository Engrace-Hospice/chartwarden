import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface TenantClaimMdInboxKeys {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

export interface TenantClaimMdInboxAad {
  readonly organizationId: string;
  readonly accountId: string;
  readonly batchId: string;
  readonly usage: "test" | "production";
  readonly afterCursor: string;
}

const aad = (input: TenantClaimMdInboxAad, keyVersion: string) =>
  Buffer.from(
    JSON.stringify([
      "chartwarden",
      "m23_claimmd_tenant_response_batch",
      1,
      input.organizationId,
      input.accountId,
      input.usage,
      input.batchId,
      input.afterCursor,
      keyVersion,
    ]),
    "utf8",
  );

/** AES-256-GCM using the owning tenant DEK; key version and all identity coordinates are authenticated. */
export function createTenantClaimMdInboxCipher(keys: TenantClaimMdInboxKeys) {
  return {
    async seal(input: TenantClaimMdInboxAad & { readonly plaintext: string }) {
      if (Buffer.byteLength(input.plaintext, "utf8") > 8 * 1024 * 1024)
        throw new Error("CLAIMMD_RESPONSE_TOO_LARGE");
      const { version, key } = await keys.dekForOrg(input.organizationId);
      if (key.byteLength !== 32) throw new Error("TENANT_DEK_INVALID");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(input, version));
      const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
      return {
        keyVersion: version,
        ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
      };
    },
    async open(
      input: TenantClaimMdInboxAad & {
        readonly ciphertext: Buffer;
        readonly keyVersion: string;
      },
    ) {
      if (input.ciphertext.length < 29 || input.ciphertext.length > 8 * 1024 * 1024 + 28)
        throw new Error("CLAIMMD_RESPONSE_CIPHER_INVALID");
      const { key } = await keys.dekForOrgVersion(input.organizationId, input.keyVersion);
      if (key.byteLength !== 32) throw new Error("TENANT_DEK_INVALID");
      const decipher = createDecipheriv("aes-256-gcm", key, input.ciphertext.subarray(0, 12));
      decipher.setAAD(aad(input, input.keyVersion));
      decipher.setAuthTag(input.ciphertext.subarray(12, 28));
      return Buffer.concat([
        decipher.update(input.ciphertext.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

/** Versioned envelope retained inside ciphertext so JSON/XML source bytes remain exact and distinguishable. */
export function encodeTenantClaimMdSource(input: {
  readonly sourceFormat: "json" | "xml";
  readonly rawPayload: string;
}): string {
  return JSON.stringify({
    version: 1,
    sourceFormat: input.sourceFormat,
    rawPayload: input.rawPayload,
  });
}

export function decodeTenantClaimMdSource(plaintext: string): {
  readonly sourceFormat: "json" | "xml";
  readonly rawPayload: string;
} {
  const value: unknown = JSON.parse(plaintext);
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("sourceFormat" in value) ||
    (value.sourceFormat !== "json" && value.sourceFormat !== "xml") ||
    !("rawPayload" in value) ||
    typeof value.rawPayload !== "string"
  )
    throw new Error("CLAIMMD_RESPONSE_ENVELOPE_INVALID");
  return { sourceFormat: value.sourceFormat, rawPayload: value.rawPayload };
}
