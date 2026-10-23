// apps/backend/src/modules/20-field-safety/safety-crypto.ts — GAP-060: the per-tenant DEK envelope over M20's
// `_cipher` bytea columns (SOS / check-in coordinates, incident narrative, witnesses, action plan, resolution).
//
// Mirrors M8's `hearthnote-crypto.ts`: the key provider is INJECTED (no edge on M34; the composition root binds
// `getTenantKeyProvider()`), AES-256-GCM, the DEK version travels in the envelope so a rotation leaves historical
// rows openable, and the AAD binds the blob to (module, tenant) so a blob lifted into another tenant fails to
// open rather than decrypting into the wrong record. The stored value is the UTF-8 bytes of
// `v1.<dekVersion>.<nonce>.<tag>.<ciphertext>` (base64url parts), which is what the bytea columns hold.
//
// `decrypt` THROWS on anything it cannot authenticate, including M20-F16's no-coordinate sentinel — callers
// (`openCipher`, the §8.6 coordinate decipher) turn that into "unavailable", never into text.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import { decodeCoordinates } from "./routes/coordinates";
import type { SafetyDecipherPort } from "./routes/read-service-drizzle";
import type { SafetyCipherPort } from "./routes/write-service";

/** The M34 key-ring slice this module needs. `dekForOrgVersion` is what makes rotation survivable. */
export interface SafetyTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ version: string; key: Buffer }>;
}

const SCHEME = "v1";
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
/** GCM tag length, pinned on decrypt: without it Node accepts a truncated (4-15 byte) tag. */
const TAG_BYTES = 16;

const aadFor = (organizationId: string): Buffer =>
  Buffer.from(`m20:field_safety:cipher:${organizationId}`, "utf8");

/** Build the write-side cipher and read-side decipher over one tenant key provider. */
/**
 * A tenant with no key ring (`TenantKeyMissing`), a destroyed one, or an unbound KEK adapter threw a plain Error from
 * deep inside M34, which the error handler renders as a generic 500 "An unexpected error occurred" (#596, F-039). All
 * are the same operational statement - this deployment cannot key this tenant's PHI right now - and 503 says it.
 */
async function resolveDek(
  keys: SafetyTenantKeyProvider,
  organizationId: string,
): Promise<{ version: string; key: Buffer }> {
  try {
    return await keys.dekForOrg(organizationId);
  } catch (cause) {
    const refusal = new ChartWardenError(
      "SAFETY_CIPHER_UNBOUND",
      "this organization's encryption key is not available, so this record cannot be stored encrypted; nothing was recorded",
      503,
    );
    refusal.cause = cause; // logged with the handled error; never sent to the client
    throw refusal;
  }
}

export function createSafetyCiphers(keys: SafetyTenantKeyProvider): {
  readonly cipher: SafetyCipherPort;
  readonly decipher: SafetyDecipherPort;
} {
  const cipher: SafetyCipherPort = {
    async encrypt({ organizationId, plaintext }) {
      const { version, key } = await resolveDek(keys, organizationId);
      if (key.byteLength !== DEK_BYTES) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(NONCE_BYTES);
      const c = createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(aadFor(organizationId));
      const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      const envelope = [
        SCHEME,
        version,
        nonce.toString("base64url"),
        c.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
      return Buffer.from(envelope, "utf8");
    },
  };

  const decipher: SafetyDecipherPort = {
    async decrypt({ organizationId, cipher: stored }) {
      const [scheme, version, nonce, tag, ciphertext] = Buffer.from(stored)
        .toString("utf8")
        .split(".");
      if (scheme !== SCHEME || !version || !nonce || !tag || ciphertext === undefined) {
        throw new Error("M20 cipher envelope is malformed");
      }
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"), {
        authTagLength: TAG_BYTES,
      });
      d.setAAD(aadFor(organizationId));
      const authTag = Buffer.from(tag, "base64url");
      if (authTag.byteLength !== TAG_BYTES) throw new Error("M20 cipher envelope is malformed");
      d.setAuthTag(authTag);
      return Buffer.concat([d.update(Buffer.from(ciphertext, "base64url")), d.final()]).toString(
        "utf8",
      );
    },
  };

  return { cipher, decipher };
}

/**
 * §8.6 — the `SafetyCoordinateDecipher` M32's incident projection needs: open one `posted_coordinates_cipher`
 * inside M20's boundary and answer a coordinate, or `null` for the no-consent sentinel / an unreadable blob
 * (never `0,0`). The org comes from the ambient request scope, which is what RLS pinned the read to.
 */
export function createCoordinateDecipher(
  decipher: SafetyDecipherPort,
  orgOf: () => string | undefined,
): (cipher: Uint8Array) => Promise<{ readonly lat: number; readonly lng: number } | null> {
  return async (cipher) => {
    const organizationId = orgOf();
    if (organizationId === undefined || organizationId === "") return null;
    try {
      const decoded = decodeCoordinates(await decipher.decrypt({ organizationId, cipher }));
      return decoded === null ? null : { lat: decoded.lat, lng: decoded.lng };
    } catch {
      return null;
    }
  };
}

/** Resolves `getTenantKeyProvider()` lazily (M34 registers it during boot, after the seams are wired). */
export function lazyTenantKeys(resolve: () => SafetyTenantKeyProvider): SafetyTenantKeyProvider {
  return {
    dekForOrg: (organizationId) => resolve().dekForOrg(organizationId),
    dekForOrgVersion: (organizationId, version) =>
      resolve().dekForOrgVersion(organizationId, version),
  };
}
