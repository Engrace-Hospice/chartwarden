// apps/backend/src/modules/18-evv/coords.ts — the ONE definition of how a captured GPS coordinate is
// stored in and recovered from `evv_event.coords_cipher` / `evv_geofence_evaluation.device_coords_cipher`.
//
// HISTORY. GAP-032: the write encoded the coordinate inline and both reads answered a hardcoded (0, 0), so
// this file was created to own both halves of the format. GAP-133: that format was `base64("lat,lng")`
// stamped `coords_dek_version = 1` — encoding, not encryption, in a column whose name and version stamp both
// claimed the M18 §D10 per-tenant DEK envelope. This file now IS that envelope.
//
// THE ENVELOPE (§D10). Mirrors M20's `safety-crypto.ts` (itself M8's `hearthnote-crypto.ts`): the key provider
// is INJECTED — M18 has no edge on M34; the composition root binds `getTenantKeyProvider()` — AES-256-GCM
// under the tenant's M34 DEK (32 random bytes, wrapped under the platform KEK in `tenant_key_ring`, so the
// M34 cryptographic shred really does make these rows unreadable). The AAD binds the blob to (module,
// tenant), so a ciphertext lifted into another tenant's row fails to open instead of decrypting into the
// wrong patient's record. The DEK version travels INSIDE the envelope, so a rotation leaves historical rows
// openable; `coords_dek_version` (text since migration 0491) is stamped with the SAME version the key ring
// returned for the seal — the real one, not a constant. Stored value (text column):
//     v1.<dekVersion>.<nonce b64url>.<tag b64url>.<ciphertext b64url>      plaintext = "<lat>,<lng>"
//
// FAIL CLOSED. With no key bound (`UNBOUND_EVV_COORDS_CIPHER`, or M34's own unbound-KEK stub refusing
// `dekForOrg`) a SEAL THROWS and the capture is refused — there is no fallback to the old encoding, because a
// coordinate written in the clear into a `_cipher` column makes D10 and the M34 crypto-shred a lie. On read,
// a key that is missing/destroyed/unknown-version, an envelope that fails GCM authentication, or a decrypted
// payload that is not a valid coordinate all THROW (M18 spec §3.4: "decryption fails-loud if the per-tenant
// DEK is missing at read time — no silent fallback").
//
// ROTATION. When M34 rotates the tenant DEK, the §4.8 `m18.dek-rotation` worker (`jobs/dek-rotation.ts`) opens
// each non-legacy row under the version its envelope names and seals it again under the current one, through
// migration 0494's SECURITY DEFINER `evv_reseal_coords` (the only path the append-only trigger allows to touch
// these columns); the geofence snapshot moves in the same call so the two `_cipher` columns stay identical.
//
// LEGACY ROWS (pre-GAP-133, `base64("lat,lng")`). Prod is demo data and is fixed by reseeding, so there is
// no backfill. Those rows are recognised by FORMAT — base64 has no '.', so it can never be mistaken for an
// envelope — and read as `null` ("coordinate unavailable"): they are never decoded, never crash a read, and
// never consult a key. Migration 0491 re-stamps their `coords_dek_version` from the misleading `1` to
// `LEGACY_COORDS_DEK_VERSION` so the schema stops claiming they are encrypted. Callers already surface
// `null` as `lat: null` / `lng: null` (GAP-032), never as a zero pair.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** A WGS-84 coordinate as captured by the device. */
export interface StoredCoordinate {
  readonly lat: number;
  readonly lng: number;
}

/** The M34 key-ring slice this module needs. `dekForOrgVersion` is what makes rotation survivable. */
export interface EvvCoordsKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ version: string; key: Buffer }>;
}

/** What the capture writes: the envelope for both `_cipher` columns + the DEK version it was sealed under. */
export interface SealedCoords {
  readonly cipher: string;
  readonly dekVersion: string;
}

/** The two halves of the D10 envelope. Both are org-explicit: the AAD needs the owning tenant. */
export interface EvvCoordsCipher {
  /** Encrypt a coordinate under the org's CURRENT DEK. Throws when no key is bound — never encodes in the clear. */
  seal(organizationId: string, coords: StoredCoordinate): Promise<SealedCoords>;
  /**
   * Recover a stored coordinate. `null` for an absent payload or a legacy pre-GAP-133 row; THROWS on a missing
   * key, a payload that fails authentication, or a decrypted value that is not a coordinate.
   */
  open(organizationId: string, stored: string | null | undefined): Promise<StoredCoordinate | null>;
}

/** The `coords_dek_version` migration 0491 stamps on every pre-GAP-133 (base64, unencrypted) row. */
export const LEGACY_COORDS_DEK_VERSION = "legacy-unencrypted";

/** Raised when a coordinate must be sealed or opened and no tenant key provider is bound. */
export class EvvCoordsKeyUnboundError extends Error {
  constructor(action: "seal" | "open") {
    super(
      `no per-tenant DEK is bound for M18 EVV coordinates, so the coordinate cannot be ${
        action === "seal"
          ? "stored encrypted (the capture is refused rather than written in the clear)"
          : "decrypted"
      }`,
    );
    this.name = "EvvCoordsKeyUnboundError";
  }
}

const SCHEME = "v1";
const ENVELOPE_PREFIX = `${SCHEME}.`;
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
/** GCM tag length, pinned on decrypt: without it Node accepts a truncated (4-15 byte) tag. */
const TAG_BYTES = 16;
const MAX_LAT = 90;
const MAX_LNG = 180;

const aadFor = (organizationId: string): Buffer =>
  Buffer.from(`m18:evv:coords:${organizationId}`, "utf8");

/** True when the stored value is a legacy pre-GAP-133 base64 payload rather than a D10 envelope. */
export function isLegacyStoredCoords(stored: string | null | undefined): boolean {
  return !!stored && !stored.startsWith(ENVELOPE_PREFIX);
}

function isValidCoordinate(c: StoredCoordinate): boolean {
  return (
    Number.isFinite(c.lat) &&
    Number.isFinite(c.lng) &&
    Math.abs(c.lat) <= MAX_LAT &&
    Math.abs(c.lng) <= MAX_LNG
  );
}

/** Parse the authenticated plaintext. Throws — an authenticated non-coordinate is an integrity fault. */
function parsePlaintext(plaintext: string): StoredCoordinate {
  const parts = plaintext.split(",");
  const coords = { lat: Number(parts[0]), lng: Number(parts[1]) };
  if (parts.length !== 2 || !isValidCoordinate(coords)) {
    throw new Error("M18 coords envelope decrypted to a value that is not a coordinate");
  }
  return coords;
}

/** Build the D10 coordinate envelope over one tenant key provider. */
export function createEvvCoordsCipher(keys: EvvCoordsKeyProvider): EvvCoordsCipher {
  return {
    async seal(organizationId, coords) {
      if (!isValidCoordinate(coords)) {
        throw new Error("refusing to seal an out-of-range or non-finite coordinate");
      }
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== DEK_BYTES) throw new Error("tenant DEK must be 32 bytes");
      if (!version || version.includes(".")) {
        throw new Error("tenant DEK version must be non-empty and contain no '.'");
      }
      const nonce = randomBytes(NONCE_BYTES);
      const c = createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(aadFor(organizationId));
      const ciphertext = Buffer.concat([
        c.update(`${coords.lat},${coords.lng}`, "utf8"),
        c.final(),
      ]);
      const cipher = [
        SCHEME,
        version,
        nonce.toString("base64url"),
        c.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
      return { cipher, dekVersion: version };
    },

    async open(organizationId, stored) {
      if (!stored || isLegacyStoredCoords(stored)) return null;
      const [scheme, version, nonce, tag, ciphertext, ...rest] = stored.split(".");
      if (
        scheme !== SCHEME ||
        !version ||
        !nonce ||
        !tag ||
        ciphertext === undefined ||
        rest.length > 0
      ) {
        throw new Error("M18 coords envelope is malformed");
      }
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"), {
        authTagLength: TAG_BYTES,
      });
      d.setAAD(aadFor(organizationId));
      const authTag = Buffer.from(tag, "base64url");
      if (authTag.byteLength !== TAG_BYTES) throw new Error("M18 coords envelope is malformed");
      d.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        d.update(Buffer.from(ciphertext, "base64url")),
        d.final(),
      ]).toString("utf8");
      return parsePlaintext(plaintext);
    },
  };
}

/**
 * The fail-closed default when no key provider is injected: every seal throws (no capture is written with
 * clear coordinates), and opening a real envelope throws. Absent and legacy payloads still read as `null`,
 * because answering them needs no key.
 */
export const UNBOUND_EVV_COORDS_CIPHER: EvvCoordsCipher = {
  async seal() {
    throw new EvvCoordsKeyUnboundError("seal");
  },
  async open(_organizationId, stored) {
    if (!stored || isLegacyStoredCoords(stored)) return null;
    throw new EvvCoordsKeyUnboundError("open");
  },
};

/** One coordinate a list read could not open (unknown/destroyed DEK version, tampered or foreign blob). */
export interface EvvCoordsFault {
  readonly organizationId: string;
  readonly eventId: string;
  readonly error: unknown;
}
export type EvvCoordsFaultReporter = (fault: EvvCoordsFault) => void;

/** Default reporter: a process warning (stderr), so an integrity fault is never silent when no logger is bound. */
export const WARN_EVV_COORDS_FAULT: EvvCoordsFaultReporter = ({
  organizationId,
  eventId,
  error,
}) => {
  process.emitWarning(
    `M18 coords could not be opened (org ${organizationId}, event ${eventId}): ${
      error instanceof Error ? error.message : String(error)
    }`,
    { code: "WX_M18_COORDS_FAULT" },
  );
};

/**
 * Open one row of a multi-clinician list read. A single unreadable envelope must not take down every
 * clinician's location (one bad row would otherwise 500 the agency map): it reads as unavailable (null) and is
 * reported. Single-row reads keep calling `open` directly and fail loud.
 */
export async function openCoordsForList(
  cipher: EvvCoordsCipher,
  organizationId: string,
  eventId: string,
  stored: string | null | undefined,
  report: EvvCoordsFaultReporter,
): Promise<StoredCoordinate | null> {
  try {
    return await cipher.open(organizationId, stored);
  } catch (error) {
    report({ organizationId, eventId, error });
    return null;
  }
}

/** Resolves `getTenantKeyProvider()` lazily (M34 registers it during boot, after the seams are wired). */
export function lazyEvvCoordsKeys(resolve: () => EvvCoordsKeyProvider): EvvCoordsKeyProvider {
  return {
    dekForOrg: (organizationId) => resolve().dekForOrg(organizationId),
    dekForOrgVersion: (organizationId, version) =>
      resolve().dekForOrgVersion(organizationId, version),
  };
}
