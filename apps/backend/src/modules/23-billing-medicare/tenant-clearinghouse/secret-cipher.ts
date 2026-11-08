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
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { TenantClearinghouseMode, TransmittingClearinghouseVendor } from "@chartwarden/types";
import { STRICT_KEY_LIST_PROBLEM, parseStrictKeyList } from "../../../bootstrap/strict-key-base64";
import { MAC_SECRET_KEK_ENV, loadMacSecretKek } from "../routes/secret-cipher";

export const CLEARINGHOUSE_SECRET_CIPHER_VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MIN_ENVELOPE_LEN = 1 + NONCE_LEN + TAG_LEN;
const LABELS = {
  dekInfoPrefix: "chartwarden-m23-clearinghouse-credential-dek:",
  aadPrefix: "chartwarden-m23-clearinghouse-credential:v",
  fingerprintInfo: "chartwarden-m23-clearinghouse-credential-fingerprint:v1",
  fingerprintKeyIdInfo: "chartwarden-m23-clearinghouse-credential-fingerprint-key-id:v1",
} as const;
/** Hex characters of a fingerprint key's public id (migration 1405's CHECK). */
const KEY_ID_HEX = 16;

/**
 * The DERIVED fingerprint subkeys of previous credential KEKs, comma-separated padded base64 (32 bytes each): HKDF-SHA256(old KEK,
 * info = LABELS.fingerprintInfo), printed by `scripts/m23-derive-fingerprint-subkey.ts`. Never a KEK: a subkey only computes
 * fingerprints under the key an older reservation may have used (migration 1405); it cannot derive a DEK, so it opens nothing, and a
 * sealed credential still needs re-entry after a KEK change (ops runbook §8.3).
 */
export const RETIRED_FINGERPRINT_KEYS_ENV = "M23_CLEARINGHOUSE_RETIRED_FINGERPRINT_KEYS";

/** A credential's fingerprint under one fingerprint key, with that key's public id. */
export interface CredentialFingerprint {
  readonly keyId: string;
  readonly fingerprint: string;
}

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
  /**
   * The account's fingerprint (migration 1403): HMAC-SHA256, under a key derived from the KEK with this purpose's own label, of the
   * vendor and the trimmed account key, as 64 hex characters. The same for every organization (it names the CREDENTIAL, so a
   * second tenant sealing it is refused), never a plain hash (it cannot be checked against a guessed key without the KEK).
   */
  fingerprint(vendor: TransmittingClearinghouseVendor, accountKey: string): string;
  /** The public id of the current fingerprint key (one-way from the key; names it in a row, never reveals it). */
  readonly fingerprintKeyId: string;
  /** The public ids of every configured fingerprint key, current first, then each retired subkey's (boot logs them for ops). */
  readonly fingerprintKeyIds: readonly string[];
  /**
   * The credential's fingerprint under every configured fingerprint key: the current one first, then each retired subkey's (migration
   * 1405). A save reserves all of them, so a reservation recorded under a retired key still collides while that key is configured.
   */
  fingerprints(
    vendor: TransmittingClearinghouseVendor,
    accountKey: string,
  ): readonly CredentialFingerprint[];
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

interface FingerprintKey {
  readonly keyId: string;
  readonly mac: (vendor: TransmittingClearinghouseVendor, accountKey: string) => string;
}

/** The fingerprint subkey of a KEK: what `RETIRED_FINGERPRINT_KEYS_ENV` lists for an old KEK (never the KEK itself). */
export const deriveFingerprintSubkey = (kek: Buffer): Buffer =>
  Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), LABELS.fingerprintInfo, KEY_LEN));

/** The public id of a fingerprint subkey (the value reservations record in `credential_fingerprint_key_id`). */
export const fingerprintKeyIdOf = (subkey: Buffer): string =>
  createHmac("sha256", subkey)
    .update(LABELS.fingerprintKeyIdInfo, "utf8")
    .digest("hex")
    .slice(0, KEY_ID_HEX);

const fingerprintKeyOf = (key: Buffer): FingerprintKey => {
  return {
    keyId: fingerprintKeyIdOf(key),
    mac: (vendor, accountKey) =>
      createHmac("sha256", key).update(`${vendor}\n${accountKey.trim()}`, "utf8").digest("hex"),
  };
};

/**
 * Build the cipher over a validated KEK (copied, so the caller may zero its own buffer). `retiredSubkeys` are DERIVED fingerprint
 * subkeys (see `RETIRED_FINGERPRINT_KEYS_ENV`), used as-is and only to fingerprint; one equal to the current KEK's subkey is dropped.
 */
export function buildClearinghouseSecretCipher(
  kek: Buffer,
  retiredSubkeys: readonly Buffer[] = [],
): ClearinghouseSecretCipher {
  if (kek.length !== KEY_LEN) throw new Error(`clearinghouse secret KEK must be ${KEY_LEN} bytes`);
  const root = Buffer.from(kek);
  const current = fingerprintKeyOf(deriveFingerprintSubkey(root));
  const keys: FingerprintKey[] = [current];
  for (const retired of retiredSubkeys) {
    if (retired.length !== KEY_LEN)
      throw new Error(`${RETIRED_FINGERPRINT_KEYS_ENV} entries must be ${KEY_LEN} bytes`);
    const k = fingerprintKeyOf(Buffer.from(retired));
    if (!keys.some((x) => x.keyId === k.keyId)) keys.push(k);
  }
  return {
    fingerprintKeyId: current.keyId,
    fingerprintKeyIds: keys.map((k) => k.keyId),
    fingerprint: current.mac,
    fingerprints(vendor, accountKey) {
      return keys.map((k) => ({ keyId: k.keyId, fingerprint: k.mac(vendor, accountKey) }));
    },
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
  return buildClearinghouseSecretCipher(
    loadMacSecretKek(env[MAC_SECRET_KEK_ENV]),
    retiredFingerprintSubkeys(env),
  );
}

/** The retired fingerprint subkeys, fail-closed: a malformed entry throws at boot rather than silently dropping a key's protection. */
export function retiredFingerprintSubkeys(
  env: Readonly<Record<string, string | undefined>>,
): Buffer[] {
  const raw = env[RETIRED_FINGERPRINT_KEYS_ENV]?.trim();
  if (!raw) return [];
  const keys = parseStrictKeyList(raw);
  if (!keys) throw new Error(`${RETIRED_FINGERPRINT_KEYS_ENV} ${STRICT_KEY_LIST_PROBLEM}`);
  return keys;
}

/** The platform env binding's own account keys, by vendor (the names its transports read). */
const PLATFORM_ACCOUNT_KEY_ENV: ReadonlyArray<readonly [TransmittingClearinghouseVendor, string]> =
  [
    ["claimmd", "CLAIMMD_ACCOUNT_KEY"],
    ["stedi", "STEDI_API_KEY"],
  ];

/**
 * Fingerprints of the platform's own vendor account keys that are set, under every configured fingerprint key: a tenant may never
 * seal one of them.
 */
export function platformCredentialFingerprints(
  cipher: Pick<ClearinghouseSecretCipher, "fingerprints">,
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [vendor, key] of PLATFORM_ACCOUNT_KEY_ENV) {
    const value = env[key]?.trim();
    if (value) for (const f of cipher.fingerprints(vendor, value)) out.add(f.fingerprint);
  }
  return out;
}
