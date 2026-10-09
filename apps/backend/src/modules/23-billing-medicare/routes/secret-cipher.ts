// apps/backend/src/modules/23-billing-medicare/routes/secret-cipher.ts — the M23 MAC-portal client-secret cipher
// (the §4.4 `SecretCipherPort`, §3.6 `mac_submitter_credential.client_secret_cipher`).
//
// This follows the repo's existing envelope convention rather than inventing one (the M24 trading-partner
// `credential-crypto`, the M36 `body-crypto`, ADR-0045 KEK custody): one master KEK from the environment is the
// root, each tenant's DEK is HKDF-SHA256-derived from KEK + org id, and a secret is sealed with AES-256-GCM under a
// fresh random 96-bit nonce.
//   KEK    the SAME `M24_CREDENTIAL_ENCRYPTION_KEY` (32 bytes base64) the Medicaid credential cipher uses. It is already
//          required and shape-checked by `bootstrap/env.ts` in production, so no new deploy secret is introduced. M23 may
//          not import M24 (module boundary), hence this small independent implementation.
//   DEK    HKDF-SHA256(KEK, info = "wardenx-m23-mac-credential-dek:" + orgId). The label is M23-specific, so an M23
//          envelope can never be opened with an M24 or M36 key even though the KEK is shared (domain separation).
//   AAD    "wardenx-m23-mac-credential:" + orgId, so a ciphertext copied into another tenant's row fails to open even if
//          the HKDF were somehow reproduced.
//   FORMAT base64( version(1) ‖ nonce(12) ‖ ciphertext ‖ tag(16) ) in the `text` cipher column. The version byte is the
//          KEY/format version and is what is returned as `dekVersion` (persisted in `client_secret_dek_version`), so a
//          later KEK or scheme rotation can add version 2 and keep reading version 1 rows.
// Fail-closed: a missing or wrong-length KEK throws; an unopenable envelope (tamper, wrong org, wrong key, bad version,
// the eraser's shred marker) throws and never yields an empty secret. Plaintext is never logged or placed in an error.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { SecretCipherPort } from "./write-service";

/** The current key/format version stamped on every new envelope and into `client_secret_dek_version`. */
export const MAC_SECRET_CIPHER_VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MIN_ENVELOPE_LEN = 1 + NONCE_LEN + TAG_LEN;
const DEK_INFO_PREFIX = "wardenx-m23-mac-credential-dek:";
const AAD_PREFIX = "wardenx-m23-mac-credential:";
/** The env var carrying the master KEK (shared with M24; required in production by `bootstrap/env.ts`). */
export const MAC_SECRET_KEK_ENV = "M24_CREDENTIAL_ENCRYPTION_KEY";

/** A {@link SecretCipherPort} that can also open what it sealed (the MAC submit worker's side of the round trip). */
export interface MacSecretCipher extends SecretCipherPort {
  decrypt(organizationId: string, cipher: string): Promise<string>;
}

/** Parse the base64 KEK. Fail-closed: absent or not exactly 32 bytes throws (never a zero or truncated key). */
export function loadMacSecretKek(raw: string | undefined): Buffer {
  if (!raw?.trim()) {
    throw new Error(
      `${MAC_SECRET_KEK_ENV} is required to encrypt MAC portal credentials (fail-closed)`,
    );
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(`${MAC_SECRET_KEK_ENV} must decode to ${KEY_LEN} bytes (got ${key.length})`);
  }
  return key;
}

const deriveDek = (kek: Buffer, organizationId: string): Buffer =>
  Buffer.from(
    hkdfSync("sha256", kek, Buffer.alloc(0), `${DEK_INFO_PREFIX}${organizationId}`, KEY_LEN),
  );

const aadFor = (organizationId: string): Buffer =>
  Buffer.from(`${AAD_PREFIX}${organizationId}`, "utf8");

/** Build the cipher over a validated KEK. The KEK is copied, so the caller may zero its own buffer. */
export function buildMacSecretCipher(kek: Buffer): MacSecretCipher {
  if (kek.length !== KEY_LEN) throw new Error(`MAC secret KEK must be ${KEY_LEN} bytes`);
  const root = Buffer.from(kek);
  return {
    async encrypt(organizationId, plaintext) {
      const nonce = randomBytes(NONCE_LEN);
      const cipher = createCipheriv("aes-256-gcm", deriveDek(root, organizationId), nonce);
      cipher.setAAD(aadFor(organizationId));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const envelope = Buffer.concat([
        Buffer.from([MAC_SECRET_CIPHER_VERSION]),
        nonce,
        ciphertext,
        cipher.getAuthTag(),
      ]);
      return { cipher: envelope.toString("base64"), dekVersion: MAC_SECRET_CIPHER_VERSION };
    },
    async decrypt(organizationId, sealed) {
      const raw = Buffer.from(sealed, "base64");
      if (raw.length < MIN_ENVELOPE_LEN) throw new Error("MAC secret cipher: malformed ciphertext");
      if (raw[0] !== MAC_SECRET_CIPHER_VERSION) {
        throw new Error(`MAC secret cipher: unsupported version ${raw[0]}`);
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        deriveDek(root, organizationId),
        raw.subarray(1, 1 + NONCE_LEN),
      );
      decipher.setAAD(aadFor(organizationId));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_LEN));
      try {
        return Buffer.concat([
          decipher.update(raw.subarray(1 + NONCE_LEN, raw.length - TAG_LEN)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // The node error text is not interesting and must not become an oracle; say only that it did not open.
        throw new Error("MAC secret cipher: ciphertext failed authentication");
      }
    },
  };
}

/** The production binding: read the KEK once at boot. Returns undefined when unset (credential writes then 503). */
export function buildMacSecretCipherFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MacSecretCipher | undefined {
  if (!env[MAC_SECRET_KEK_ENV]?.trim()) return undefined;
  return buildMacSecretCipher(loadMacSecretKek(env[MAC_SECRET_KEK_ENV]));
}
