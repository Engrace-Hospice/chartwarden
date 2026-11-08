// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/secret-cipher.ts — seals a tenant's clearinghouse
// credential (the Stedi API key, the Claim.MD account key) in `tenant_clearinghouse_config.secret_cipher`.
//
// The SAME envelope convention as the MAC-portal client secret (`routes/secret-cipher.ts`, ADR-0045 KEK custody): one master
// KEK from the environment (`M24_CREDENTIAL_ENCRYPTION_KEY`, already required in production, so no new deploy secret), a
// per-tenant DEK = HKDF-SHA256(KEK, info = LABELS.dekInfoPrefix + orgId), AES-256-GCM under a fresh random 96-bit nonce,
// base64( version(1) | nonce(12) | ciphertext | tag(16) ). The labels are this table's own, so a MAC-credential envelope can
// never be opened as a clearinghouse secret (or the reverse) even though the KEK is shared.
//   AAD   LABELS.aadPrefix + version + orgId + vendor + mode. The envelope is bound to the row it was sealed for: a ciphertext
//         copied to another tenant, another vendor (a Stedi key pasted into a Claim.MD row) or the other mode (a test key
//         read as a production key) fails authentication.
// Fail-closed: an unopenable envelope throws one generic error and never yields an empty secret; plaintext is never put in
// an error, a log line or an audit row.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { TenantClearinghouseMode, TransmittingClearinghouseVendor } from "@chartwarden/types";
import { MAC_SECRET_KEK_ENV, loadMacSecretKek } from "../routes/secret-cipher";

export const CLEARINGHOUSE_SECRET_CIPHER_VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MIN_ENVELOPE_LEN = 1 + NONCE_LEN + TAG_LEN;
const LABELS = {
  dekInfoPrefix: "chartwarden-m23-clearinghouse-credential-dek:",
  aadPrefix: "chartwarden-m23-clearinghouse-credential:v",
} as const;

/** What a sealed secret is bound to besides the tenant. */
export interface ClearinghouseSecretContext {
  readonly vendor: TransmittingClearinghouseVendor;
  readonly mode: TenantClearinghouseMode;
}

export interface ClearinghouseSecretCipher {
  encrypt(
    organizationId: string,
    plaintext: string,
    context: ClearinghouseSecretContext,
  ): Promise<{ readonly cipher: string; readonly dekVersion: number }>;
  decrypt(
    organizationId: string,
    context: ClearinghouseSecretContext,
    sealed: string,
  ): Promise<string>;
}

const deriveDek = (kek: Buffer, organizationId: string): Buffer =>
  Buffer.from(
    hkdfSync(
      "sha256",
      kek,
      Buffer.alloc(0),
      `${LABELS.dekInfoPrefix}${organizationId.toLowerCase()}`,
      KEY_LEN,
    ),
  );

const aadFor = (organizationId: string, context: ClearinghouseSecretContext): Buffer =>
  Buffer.from(
    [
      `${LABELS.aadPrefix}${CLEARINGHOUSE_SECRET_CIPHER_VERSION}`,
      organizationId.toLowerCase(),
      context.vendor,
      context.mode,
    ].join("|"),
    "utf8",
  );

/** Build the cipher over a validated KEK (copied, so the caller may zero its own buffer). */
export function buildClearinghouseSecretCipher(kek: Buffer): ClearinghouseSecretCipher {
  if (kek.length !== KEY_LEN) throw new Error(`clearinghouse secret KEK must be ${KEY_LEN} bytes`);
  const root = Buffer.from(kek);
  return {
    async encrypt(organizationId, plaintext, context) {
      const nonce = randomBytes(NONCE_LEN);
      const cipher = createCipheriv("aes-256-gcm", deriveDek(root, organizationId), nonce);
      cipher.setAAD(aadFor(organizationId, context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const envelope = Buffer.concat([
        Buffer.from([CLEARINGHOUSE_SECRET_CIPHER_VERSION]),
        nonce,
        ciphertext,
        cipher.getAuthTag(),
      ]);
      return {
        cipher: envelope.toString("base64"),
        dekVersion: CLEARINGHOUSE_SECRET_CIPHER_VERSION,
      };
    },
    async decrypt(organizationId, context, sealed) {
      const raw = Buffer.from(sealed, "base64");
      if (raw.length < MIN_ENVELOPE_LEN || raw[0] !== CLEARINGHOUSE_SECRET_CIPHER_VERSION) {
        throw new Error("clearinghouse secret cipher: ciphertext did not open");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        deriveDek(root, organizationId),
        raw.subarray(1, 1 + NONCE_LEN),
      );
      decipher.setAAD(aadFor(organizationId, context));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_LEN));
      try {
        return Buffer.concat([
          decipher.update(raw.subarray(1 + NONCE_LEN, raw.length - TAG_LEN)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // one generic refusal: the node error text is not an oracle
        throw new Error("clearinghouse secret cipher: ciphertext did not open");
      }
    },
  };
}

/** The production binding over the shared KEK; undefined when unset (credential writes then answer 503). */
export function buildClearinghouseSecretCipherFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ClearinghouseSecretCipher | undefined {
  if (!env[MAC_SECRET_KEK_ENV]?.trim()) return undefined;
  return buildClearinghouseSecretCipher(loadMacSecretKek(env[MAC_SECRET_KEK_ENV]));
}
