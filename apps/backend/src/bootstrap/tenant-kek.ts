// apps/backend/src/bootstrap/tenant-kek.ts — the platform KEK: the root of M34's per-tenant DEK
// envelope (§3.5 / D5, ADR-0038 §3, ADR-0045).
//
// This is the one dependency four modules' encryption chains terminated at (#105). `tenant_key_ring`
// stores each tenant's DEK *wrapped* under a platform key; every consumer of per-tenant envelope
// encryption — M8's HearthNote narrative, M27's raw payload ciphers, M29's stored HL7 payloads, M31's
// portal contact ciphers, M39's consent notes — resolves that DEK through M34's `TenantKeyProvider`,
// which composes over the KEK-unwrap port. Nothing bound the port, so the port's fail-closed stub was
// what ran, and `dekForOrg` refused for every org in every deployment.
//
// WRAP, NEVER DERIVE — the one thing this file must not copy from its neighbours. M24's
// `credential-crypto.ts` and M36's `body-crypto.ts` HKDF-DERIVE a tenant DEK from (KEK, orgId), which is
// correct for them and would be a silent catastrophe here. A derived DEK is a pure function of the KEK
// and the org id, so it can always be recomputed: nulling `current_dek_kek_wrapped_ciphertext` would
// destroy NOTHING, and M34's cryptographic shred — the mechanism behind every destruction certificate
// this platform issues, and the control a BAA termination clause is written against — would become a
// ceremony that deletes a row while the key it claims to have destroyed remains derivable from an env
// var. So the DEK here is 32 RANDOM bytes, minted once, and the wrapped ciphertext is the ONLY copy.
// Destroying that ciphertext is what makes the tenant's PHI unreadable, which is exactly the property
// §7.2 step 6 claims. (Both neighbours' headers describe their own crypto-erase as "modelled by
// forgetting the org's derived key" — an honest description of something weaker than this.)
//
// AT-REST FORMAT (`tenant_key_ring.current_dek_kek_wrapped_ciphertext`, bytea; and base64 of the same
// bytes in the `prior_dek_versions` jsonb):
//     version(1) ‖ nonce(12) ‖ ciphertext(32) ‖ tag(16)      — AES-256-GCM, 61 bytes
// The version byte is the repo's house format (ADR-0034 §2 / M24 / M36), kept so the three readers look
// alike; KEK ROTATION is carried by the `kekId` column beside the ciphertext, not by this byte.
//
// THE AAD BINDS THE TENANT. `unwrap` takes an `organizationId` and mixes it into the AAD, so a wrapped
// DEK is only openable in the key ring it was minted for. Without that, an attacker holding write access
// to `tenant_key_ring` — the platform credential, or a restored backup — could copy tenant B's wrapped
// ciphertext into tenant A's row and read B's PHI through A's request path WITHOUT ever holding the KEK.
// The KEK is the thing a database compromise is not supposed to yield; binding the org is what stops a
// database compromise from being enough on its own.
//
// KEK CUSTODY, AND WHY IT IS HERE. ADR-0038 §3 says key management is a port and "binding a production
// KMS is integration work, not a mechanism change". The port stays. What changes is that its production
// binding is now a key this process holds (from the environment / the deployment's secret manager),
// the same custody model as `M24_CREDENTIAL_ENCRYPTION_KEY`, `MESSAGING_ENCRYPTION_KEY` and
// `TWO_FACTOR_ENCRYPTION_KEY` — rather than an HTTP call to a service that is unspecified and undeployed
// (#115). ADR-0045 records the trade-off and the exit to a KMS/HSM: replace this adapter at the
// composition root; no module and no schema changes.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;
const WRAPPED_LEN = 1 + NONCE_LEN + DEK_LEN + TAG_LEN;

/** The env var holding the ACTIVE platform KEK — the one new DEKs are wrapped under. */
export const ACTIVE_KEK_ENV = "M34_TENANT_KEK";
/** The env var holding RETIRED KEKs — unwrap-only, so a KEK rotation leaves old key rings readable. */
export const RETIRED_KEK_ENV = "M34_TENANT_KEK_RETIRED";

/** One platform key-encryption key: the id that travels in `tenant_key_ring.current_dek_kek_id`, + 32 bytes. */
export interface PlatformKek {
  readonly kekId: string;
  readonly key: Buffer;
}

/** The active KEK plus every KEK this deployment can still unwrap with (active included). */
export interface PlatformKekRing {
  readonly active: PlatformKek;
  readonly byId: ReadonlyMap<string, Buffer>;
}

/** Raised for any KEK configuration or unwrap failure. Never carries key material or ciphertext. */
export class PlatformKekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformKekError";
  }
}

/**
 * Parse one `<kekId>:<base64-32-bytes>` entry. The id travels WITH the key rather than being positional,
 * because `tenant_key_ring.current_dek_kek_id` is what a stored ciphertext names — an operator who
 * reorders the retired list must not silently change which key an old row resolves to.
 */
function parseKek(raw: string, envKey: string): PlatformKek {
  const sep = raw.indexOf(":");
  if (sep <= 0) {
    throw new PlatformKekError(`${envKey}: each entry must be '<kekId>:<base64 32-byte key>'`);
  }
  const kekId = raw.slice(0, sep).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(kekId)) {
    throw new PlatformKekError(
      `${envKey}: kekId '${kekId}' must be 1-64 chars of [A-Za-z0-9._-] (it is stored in tenant_key_ring.current_dek_kek_id)`,
    );
  }
  const key = Buffer.from(raw.slice(sep + 1).trim(), "base64");
  if (key.length !== DEK_LEN) {
    throw new PlatformKekError(
      `${envKey}: key for '${kekId}' must decode to ${DEK_LEN} base64 bytes (got ${key.length})`,
    );
  }
  return { kekId, key };
}

/**
 * Load the KEK ring from the environment, or `null` when {@link ACTIVE_KEK_ENV} is unset (a local/dev boot
 * that does no tenant crypto). A PRESENT-but-malformed value THROWS rather than returning null — a typo in
 * the platform's root key must stop the boot, not quietly degrade it back to the unbound stub this file
 * exists to replace. `assertProductionEnv` requires the var in production, so "unset" is a dev-only state.
 */
export function loadPlatformKekRing(env: NodeJS.ProcessEnv = process.env): PlatformKekRing | null {
  const activeRaw = env[ACTIVE_KEK_ENV]?.trim();
  if (!activeRaw) return null;
  const active = parseKek(activeRaw, ACTIVE_KEK_ENV);
  const byId = new Map<string, Buffer>([[active.kekId, active.key]]);
  for (const entry of (env[RETIRED_KEK_ENV] ?? "").split(",").map((s) => s.trim())) {
    if (!entry) continue;
    const retired = parseKek(entry, RETIRED_KEK_ENV);
    const existing = byId.get(retired.kekId);
    if (existing) {
      // Two different keys under one id would make an unwrap silently depend on map order; identical
      // ones are a harmless copy-paste (the active key re-listed as retired).
      if (existing.length !== retired.key.length || !timingSafeEqual(existing, retired.key)) {
        throw new PlatformKekError(
          `${RETIRED_KEK_ENV}: kekId '${retired.kekId}' is declared twice with different key material`,
        );
      }
      continue;
    }
    byId.set(retired.kekId, retired.key);
  }
  return { active, byId };
}

/** The AAD every wrap/unwrap binds: the format version, the wrapping KEK, and the OWNING TENANT. */
function aad(kekId: string, organizationId: string): Buffer {
  return Buffer.from(`wardenx-m34-tenant-dek:v${VERSION}:${kekId}:${organizationId}`, "utf8");
}

/**
 * The composition root's KEK adapter: the two halves of M34's key envelope. `mintAndWrapDek` is the
 * `provision.keyMaterial` / `DekRotateKeyMaterialPort` shape (tenant provisioning + `tenant.dek_rotate`);
 * `unwrap` is the `KekUnwrapPort` M34's `TenantKeyProvider` composes over. They are one object because a
 * DEK wrapped by one and opened by the other must agree on the format and the AAD — splitting them across
 * two adapters is how a wrap/unwrap pair drifts.
 */
export interface PlatformKekAdapter {
  /** Mint 32 random bytes, wrap them under the ACTIVE KEK, and zeroize the plaintext DEK before returning. */
  mintAndWrapDek(input: {
    readonly organizationId: string;
  }): Promise<{ readonly wrappedCiphertextB64: string; readonly kekId: string }>;
  /** Open a wrapped DEK for the tenant it was minted for. Throws — never returns a wrong or zero key. */
  unwrap(input: {
    readonly organizationId: string;
    readonly kekWrappedCiphertext: Buffer;
    readonly kekId: string;
  }): Promise<Buffer>;
}

export function createPlatformKekAdapter(ring: PlatformKekRing): PlatformKekAdapter {
  return {
    async mintAndWrapDek({ organizationId }) {
      if (!organizationId) throw new PlatformKekError("mintAndWrapDek requires an organizationId");
      const dek = randomBytes(DEK_LEN);
      try {
        const nonce = randomBytes(NONCE_LEN);
        const cipher = createCipheriv("aes-256-gcm", ring.active.key, nonce);
        cipher.setAAD(aad(ring.active.kekId, organizationId));
        const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
        const wrapped = Buffer.concat([Buffer.from([VERSION]), nonce, ct, cipher.getAuthTag()]);
        return { wrappedCiphertextB64: wrapped.toString("base64"), kekId: ring.active.kekId };
      } finally {
        // The raw DEK never leaves this function (§WrappedDek: "minted, wrapped, and zeroized inside the port").
        dek.fill(0);
      }
    },
    async unwrap({ organizationId, kekWrappedCiphertext, kekId }) {
      if (!organizationId) throw new PlatformKekError("unwrap requires an organizationId");
      const key = ring.byId.get(kekId);
      if (!key) {
        // Named explicitly rather than trying every key: an unknown id means this deployment is missing a
        // retired KEK, and silently succeeding under a different one would be worse than refusing.
        throw new PlatformKekError(
          `no platform KEK '${kekId}' is configured (set it in ${RETIRED_KEK_ENV} if it has been rotated out)`,
        );
      }
      if (kekWrappedCiphertext.length !== WRAPPED_LEN) {
        throw new PlatformKekError(
          `wrapped DEK is ${kekWrappedCiphertext.length} bytes, expected ${WRAPPED_LEN}`,
        );
      }
      if (kekWrappedCiphertext[0] !== VERSION) {
        throw new PlatformKekError(`unsupported wrapped-DEK version ${kekWrappedCiphertext[0]}`);
      }
      const nonce = kekWrappedCiphertext.subarray(1, 1 + NONCE_LEN);
      const ct = kekWrappedCiphertext.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + DEK_LEN);
      const tag = kekWrappedCiphertext.subarray(1 + NONCE_LEN + DEK_LEN);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(aad(kekId, organizationId));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(ct), decipher.final()]);
      } catch {
        // GCM authentication failed: a tampered ciphertext, the wrong KEK, or — the case the AAD exists
        // for — a wrapped DEK lifted from ANOTHER tenant's key ring. All three are the same refusal.
        throw new PlatformKekError(
          `wrapped DEK for org ${organizationId} failed authentication under KEK '${kekId}'`,
        );
      }
    },
  };
}
