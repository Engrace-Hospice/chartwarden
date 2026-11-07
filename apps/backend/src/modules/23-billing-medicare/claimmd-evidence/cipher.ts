import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface ClaimMdEvidenceKeys {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
  dekForOrgVersion(organizationId: string, version: string): Promise<{ version: string; key: Buffer }>;
}

const aad = (input: { evidenceId: string; organizationId: string; providerEntityId: string; attemptKey: string; recordKind?: "claim" | "notice" }) =>
  Buffer.from(JSON.stringify(["chartwarden", input.recordKind === "notice" ? "claimmd_notice_submission_evidence" : "claimmd_submission_evidence", "billing_tin", 1, input.evidenceId,
    input.organizationId, input.providerEntityId, input.attemptKey]), "utf8");

/** Tenant-DEK envelope with evidence-row-bound AAD; provider-row ciphertext cannot be replayed here. */
export function createClaimMdEvidenceCipher(keys: ClaimMdEvidenceKeys) {
  return {
    async seal(input: { evidenceId: string; organizationId: string; providerEntityId: string; attemptKey: string; tin: string; recordKind?: "claim" | "notice" }) {
      const { version, key } = await keys.dekForOrg(input.organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(input));
      const ciphertext = Buffer.concat([cipher.update(input.tin, "utf8"), cipher.final()]);
      return ["v1", Buffer.from(version, "utf8").toString("base64url"), nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
    },
    async open(input: { evidenceId: string; organizationId: string; providerEntityId: string; attemptKey: string; sealed: string; recordKind?: "claim" | "notice" }) {
      const [versionTag, versionEncoded, nonce, tag, ciphertext] = input.sealed.split(".");
      if (versionTag !== "v1" || !versionEncoded || !nonce || !tag || ciphertext === undefined) throw new Error("evidence cipher envelope is malformed");
      const version = Buffer.from(versionEncoded, "base64url").toString("utf8");
      const { key } = await keys.dekForOrgVersion(input.organizationId, version);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      decipher.setAAD(aad(input));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}
