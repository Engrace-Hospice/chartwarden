// apps/backend/src/modules/20-field-safety/routes/coordinates.ts — M20-T06 (D6 / D11 / M20-F16, §3.3).
//
// The one place a coordinate becomes bytes and back. Two facts about M20's schema make this a shared
// module rather than an inline helper in each service:
//
// ── `safety_sos_alert`'s COORDINATE COLUMNS ARE NOT NULL, AND M20-F16 STILL HAS TO WORK ───────────────
//
// §3.3 makes `posted_coordinates_cipher`, `posted_coordinates_accuracy_m` and `coordinates_consent_at`
// all NOT NULL on the SOS table (the location at the press is the single most useful fact a responder
// has), while M20-F16 requires that a clinician who declined `sos_coordinates` consent can still press the
// button and still get the full fan-out. M20-T02's header already names the resolution: the recorder
// writes a coordinate-free alert through the SAME path, "with the cipher holding a sentinel".
//
// {@link SAFETY_NO_COORDINATE_SENTINEL} is that sentinel, and it is a REAL, RECOGNISABLE VALUE rather
// than an empty buffer, for two reasons that both bite later:
//   • an empty `bytea` is what a failed encrypt also produces, so the two would be indistinguishable in a
//     forensic read — "she declined" and "the KMS was down" are different facts about the same press; and
//   • `accuracy_m >= 0` is a CHECK (`m20_ssa_accuracy`), so a negative sentinel is unwritable; the
//     accuracy therefore rides `0` and the CIPHER is what carries the meaning.
//
// {@link coordinatesCaptured} is the single reader of that decision. Every DTO, event payload and alert
// that says `coordinatesCaptured: false` goes through it, so the answer cannot drift between the SOS
// detail, the `sos_alert_raised` event and the §4.9 alert that tells a supervisor there is no location.
//
// ── THE PLAINTEXT SHAPE IS PINNED HERE, NOT AT EACH CALL SITE ────────────────────────────────────────
//
// What goes under the DEK is a JSON object, and the field names are part of the at-rest contract: a write
// path that spelled `latitude` where the read path expects `lat` would produce a stream of samples that
// decrypt cleanly and render nowhere. Both directions live in this file for that reason, and
// {@link decodeCoordinates} returns `null` for anything it cannot read rather than a `0,0` pair — which is
// a real place in the Gulf of Guinea and would put a clinician's marker there.
import type { CoordinateInput } from "./write-service";

/**
 * M20-F16 — the cipher value a press with no consented coordinate carries. ASCII, so it is legible in a
 * `bytea` dump during an incident review, and distinct from both an empty buffer and any AEAD ciphertext.
 */
export const SAFETY_NO_COORDINATE_SENTINEL = Buffer.from("m20:no-coordinate-consent", "utf8");

/** Does this stored cipher represent a REAL captured coordinate (vs. M20-F16's declined-consent press)? */
export function coordinatesCaptured(cipher: Uint8Array | null): boolean {
  if (cipher === null || cipher.byteLength === 0) return false;
  if (cipher.byteLength !== SAFETY_NO_COORDINATE_SENTINEL.byteLength) return true;
  return !Buffer.from(cipher).equals(SAFETY_NO_COORDINATE_SENTINEL);
}

/** The at-rest plaintext shape (see the module header on why the field names are pinned here). */
export interface StoredCoordinates {
  readonly lat: number;
  readonly lng: number;
  readonly acc: number;
}

/** Project a request coordinate into the at-rest plaintext, ready for the DEK envelope. */
export function encodeCoordinates(input: CoordinateInput): string {
  return JSON.stringify({
    lat: input.latitude,
    lng: input.longitude,
    acc: input.accuracyM,
  } satisfies StoredCoordinates);
}

/** Read an at-rest plaintext back, or `null` when it is unusable (never a `0,0` fallback). */
export function decodeCoordinates(plaintext: string | null): StoredCoordinates | null {
  if (plaintext === null) return null;
  try {
    const parsed = JSON.parse(plaintext) as Partial<StoredCoordinates>;
    const lat = Number(parsed.lat);
    const lng = Number(parsed.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    const acc = Number(parsed.acc);
    return { lat, lng, acc: Number.isFinite(acc) ? acc : 0 };
  } catch {
    return null;
  }
}
