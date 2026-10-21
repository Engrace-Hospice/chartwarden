// @chartwarden/subscription-billing — the M35-private `patient_pseudonym_key` envelope (§3.3, D6). F-172
// (#248): `PseudonymKeyProvider.activeKey()` had zero implementations anywhere in the platform — the
// standing finding this file resolves. Two prior passes (F-142, F-167) declined to build it, reasoning
// that M34's per-tenant DEK-wrap mechanism (`apps/backend/src/bootstrap/tenant-kek.ts`) "does not
// transfer" because `patient_pseudonym_key` is platform-wide rather than per-org. That is true of the
// SHAPE — there is no `organizationId` to bind the AAD to — but it does not mean a new cryptographic
// SCHEME is needed: it is the identical, already-ratified pattern (ADR-0038 "application-layer AES-256-GCM
// envelope encryption... KEK custody is a port... binding a production KMS is integration work, not a
// mechanism change") applied to a PLATFORM-SINGLETON secret instead of a per-tenant one — the same custody
// model as `TWO_FACTOR_ENCRYPTION_KEY` / `M24_CREDENTIAL_ENCRYPTION_KEY` / `MESSAGING_ENCRYPTION_KEY` /
// `M34_TENANT_KEK`, all four already required-in-production, fail-closed env-sourced master keys
// (`apps/backend/src/bootstrap/env.ts`). The module's own spec (§4.11 D15, §14.3) independently commits to
// exactly this: "Envelope-encrypted via the standard ChartWarden KMS-wrapped DEK pattern."
//
// WHAT THIS WRAPS. Not a per-tenant DEK — the platform's ONE active HMAC-SHA256 key MATERIAL (32 random
// bytes, hex-encoded to a string the hasher's `createHmac("sha256", keyMaterial)` accepts directly), used
// by `computeBillingPseudonym` to pseudonymize every `patient_id`/`membership_id` M35 ever sees (D6). The
// bytes never touch application logs or Postgres in plaintext — only the AES-256-GCM ciphertext (this
// file's output) is ever written to `patient_pseudonym_key.key_material_ciphertext`.
//
// AT-REST FORMAT (`key_material_ciphertext`, base64 of):
//     version(1) ‖ nonce(12) ‖ ciphertext(32) ‖ tag(16)      — AES-256-GCM, 61 bytes
// identical to `tenant-kek.ts`'s wrapped-DEK format (the repo's house shape, ADR-0034 §2 / M24 / M36 /
// M34), because the two ciphers agree on nothing BUT the shape — the KEK rings are separate secrets
// (`M35_PSEUDONYM_KEY_KEK`, never `M34_TENANT_KEK`), so a wrapped tenant DEK and a wrapped pseudonym key
// can never be confused for one another even though both decode to 32 bytes.
//
// THE AAD BINDS THE KEK ID AND THE KEY EPOCH — not an organization id, because there is no tenant here.
// Binding the epoch is the platform-singleton analogue of `tenant-kek.ts`'s tenant-binding AAD: it stops a
// wrapped ciphertext minted for one epoch row from being silently accepted if copied onto a DIFFERENT
// epoch row (a database restore, an operator error, or a future rotation bug that reuses an old row) —
// `openPseudonymKeyMaterial` is handed the row's OWN `key_epoch` and refuses to open a ciphertext sealed
// under a different one, exactly as `tenant-kek.ts#unwrap` refuses a wrapped DEK sealed for another org.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const WRAPPED_LEN = 1 + NONCE_LEN + KEY_LEN + TAG_LEN;

/** The env var holding the ACTIVE platform KEK for `patient_pseudonym_key` — `<kekId>:<base64 32 bytes>`,
 *  the identical shape `M34_TENANT_KEK` already uses (`apps/backend/src/bootstrap/tenant-kek.ts`). */
export const PSEUDONYM_KEY_ACTIVE_KEK_ENV = "M35_PSEUDONYM_KEY_KEK";
/** RETIRED KEKs — unwrap-only, comma-separated `<kekId>:<base64>` entries, so a KEK rotation leaves
 *  ciphertext sealed under an earlier KEK still openable. */
export const PSEUDONYM_KEY_RETIRED_KEK_ENV = "M35_PSEUDONYM_KEY_KEK_RETIRED";

export interface PlatformPseudonymKek {
  readonly kekId: string;
  readonly key: Buffer;
}

export interface PseudonymKekRing {
  readonly active: PlatformPseudonymKek;
  readonly byId: ReadonlyMap<string, Buffer>;
}

/** Raised for any pseudonym-KEK configuration or unwrap failure. Never carries key material or ciphertext. */
export class PseudonymKekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PseudonymKekError";
  }
}

function parseKek(raw: string, envKey: string): PlatformPseudonymKek {
  const sep = raw.indexOf(":");
  if (sep <= 0) {
    throw new PseudonymKekError(`${envKey}: each entry must be '<kekId>:<base64 32-byte key>'`);
  }
  const kekId = raw.slice(0, sep).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(kekId)) {
    throw new PseudonymKekError(
      `${envKey}: kekId '${kekId}' must be 1-64 chars of [A-Za-z0-9._-] (it is stored in patient_pseudonym_key.key_kms_ref)`,
    );
  }
  const key = Buffer.from(raw.slice(sep + 1).trim(), "base64");
  if (key.length !== KEY_LEN) {
    throw new PseudonymKekError(
      `${envKey}: key for '${kekId}' must decode to ${KEY_LEN} base64 bytes (got ${key.length})`,
    );
  }
  return { kekId, key };
}

/**
 * Load the pseudonym-KEK ring from the environment, or `null` when {@link PSEUDONYM_KEY_ACTIVE_KEK_ENV}
 * is unset (a local/dev boot that never mints a real pseudonym key). A PRESENT-but-malformed value THROWS
 * — the `tenant-kek.ts#loadPlatformKekRing` precedent — so a typo'd root key stops the boot rather than
 * quietly degrading `activeKey()` to an unbound stub.
 */
export function loadPseudonymKekRing(
  env: NodeJS.ProcessEnv = process.env,
): PseudonymKekRing | null {
  const activeRaw = env[PSEUDONYM_KEY_ACTIVE_KEK_ENV]?.trim();
  if (!activeRaw) return null;
  const active = parseKek(activeRaw, PSEUDONYM_KEY_ACTIVE_KEK_ENV);
  const byId = new Map<string, Buffer>([[active.kekId, active.key]]);
  for (const entry of (env[PSEUDONYM_KEY_RETIRED_KEK_ENV] ?? "").split(",").map((s) => s.trim())) {
    if (!entry) continue;
    const retired = parseKek(entry, PSEUDONYM_KEY_RETIRED_KEK_ENV);
    const existing = byId.get(retired.kekId);
    if (existing) {
      if (existing.length !== retired.key.length || !timingSafeEqual(existing, retired.key)) {
        throw new PseudonymKekError(
          `${PSEUDONYM_KEY_RETIRED_KEK_ENV}: kekId '${retired.kekId}' is declared twice with different key material`,
        );
      }
      continue;
    }
    byId.set(retired.kekId, retired.key);
  }
  return { active, byId };
}

/** The AAD every seal/open binds: the format version, the wrapping KEK, and the OWNING KEY EPOCH. */
function aad(kekId: string, keyEpoch: string): Buffer {
  return Buffer.from(`wardenx-m35-pseudonym-key:v${VERSION}:${kekId}:${keyEpoch}`, "utf8");
}

/**
 * Seal 32 bytes of HMAC key material under the ring's ACTIVE KEK, bound to the epoch it is being minted
 * for. Returns the base64 ciphertext for `key_material_ciphertext` and the kekId for `key_kms_ref`.
 */
export function sealPseudonymKeyMaterial(
  ring: PseudonymKekRing,
  keyEpoch: string,
  plaintext: Buffer,
): { readonly ciphertextB64: string; readonly kekId: string } {
  if (plaintext.length !== KEY_LEN) {
    throw new PseudonymKekError(
      `plaintext key material must be ${KEY_LEN} bytes (got ${plaintext.length})`,
    );
  }
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", ring.active.key, nonce);
  cipher.setAAD(aad(ring.active.kekId, keyEpoch));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrapped = Buffer.concat([Buffer.from([VERSION]), nonce, ct, cipher.getAuthTag()]);
  return { ciphertextB64: wrapped.toString("base64"), kekId: ring.active.kekId };
}

/**
 * Open a sealed key-material ciphertext for the epoch it was minted for. Throws — never returns a wrong
 * or zero-length key — on an unknown kekId, a malformed envelope, or a GCM authentication failure (a
 * tampered ciphertext, the wrong KEK, or a ciphertext copied onto a DIFFERENT epoch's row).
 */
export function openPseudonymKeyMaterial(
  ring: PseudonymKekRing,
  kekId: string,
  keyEpoch: string,
  ciphertextB64: string,
): Buffer {
  const key = ring.byId.get(kekId);
  if (!key) {
    throw new PseudonymKekError(
      `no pseudonym KEK '${kekId}' is configured (set it in ${PSEUDONYM_KEY_RETIRED_KEK_ENV} if it has been rotated out)`,
    );
  }
  const wrapped = Buffer.from(ciphertextB64, "base64");
  if (wrapped.length !== WRAPPED_LEN) {
    throw new PseudonymKekError(
      `wrapped pseudonym key is ${wrapped.length} bytes, expected ${WRAPPED_LEN}`,
    );
  }
  if (wrapped[0] !== VERSION) {
    throw new PseudonymKekError(`unsupported wrapped pseudonym-key version ${wrapped[0]}`);
  }
  const nonce = wrapped.subarray(1, 1 + NONCE_LEN);
  const ct = wrapped.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + KEY_LEN);
  const tag = wrapped.subarray(1 + NONCE_LEN + KEY_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad(kekId, keyEpoch));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new PseudonymKekError(
      `wrapped pseudonym key for epoch '${keyEpoch}' failed authentication under KEK '${kekId}'`,
    );
  }
}

/** Mint 32 random bytes of fresh HMAC key material. CSPRNG — the same `randomBytes(32)` every DEK/KEK
 *  mint in this codebase uses (`tenant-kek.ts#mintAndWrapDek`); no human chooses or reviews the bytes. */
export function mintPseudonymKeyMaterial(): Buffer {
  return randomBytes(KEY_LEN);
}

/** Hex-encode raw key-material bytes into the string form {@link computeBillingPseudonym} (and the
 *  `PseudonymKeyProvider.activeKey()` contract) expects — an HMAC key may be any byte string; hex keeps
 *  it printable/loggable-safe-by-construction (never accidentally valid JSON, never containing control
 *  bytes) without weakening it (64 hex chars carries the full 256 bits of entropy). */
export function keyMaterialToString(raw: Buffer): string {
  return raw.toString("hex");
}
