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

const aadFor = (organizationId: string): Buffer =>
  Buffer.from(`m20:field_safety:cipher:${organizationId}`, "utf8");

/** Build the write-side cipher and read-side decipher over one tenant key provider. */
export function createSafetyCiphers(keys: SafetyTenantKeyProvider): {
  readonly cipher: SafetyCipherPort;
  readonly decipher: SafetyDecipherPort;
} {
  const cipher: SafetyCipherPort = {
    async encrypt({ organizationId, plaintext }) {
      const { version, key } = await keys.dekForOrg(organizationId);
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
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      d.setAAD(aadFor(organizationId));
      d.setAuthTag(Buffer.from(tag, "base64url"));
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
