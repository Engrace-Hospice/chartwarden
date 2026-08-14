// apps/backend/src/modules/18-evv/coords.ts — the ONE definition of how a captured GPS coordinate is
// stored in and recovered from `evv_event.coords_cipher` (GAP-032).
//
// WHY THIS FILE EXISTS. The write path encoded the coordinate inline and both read paths returned a
// hardcoded `lat: 0, lng: 0` behind a `TODO(D10): decrypt coords_cipher`. So
// `GET /api/v1/evv/clinician-current-location` — a live, permission-gated, audited route — answered
// (0, 0) for every clinician in every tenant, and `LocationView.lat/lng` being non-nullable `number`
// meant a caller could not tell that apart from a real coordinate off the Gulf of Guinea. M20's safety
// board is unaffected (it deliberately projects the coordinates away before rendering — see
// `20-field-safety/consumers/seam-context.ts`), but any direct API consumer received a plausible lie.
//
// ⚠️ `coords_cipher` IS NOT ENCRYPTED TODAY, AND ITS NAME SAYS OTHERWISE. The column stores
// `base64("<lat>,<lng>")` and `coords_dek_version` is stamped `1` beside it, which together read as
// "envelope-encrypted with DEK v1" to anyone auditing the schema. The M18 §D10 per-tenant DEK pipeline is
// genuinely deferred (the route service's own header has said so since it was written), and this change
// does NOT implement it — decoding base64 is not decryption and this file must never be read as closing
// that gap. What it does close is the smaller, entirely separate defect: the read did not recover what the
// write actually stored. When the DEK pipeline lands, it replaces the bodies of these two functions and
// nothing else, which is the point of putting both halves in one file.
//
// The codec is deliberately symmetric and total: `decodeStoredCoords` returns null for anything it cannot
// parse, and the callers surface that as `lat: null` rather than substituting a coordinate.

/** Encode a captured coordinate for `evv_event.coords_cipher` / `geofence_evaluation.device_coords_cipher`. */
export function encodeStoredCoords(coords: { lat: number; lng: number }): string {
  return Buffer.from(`${coords.lat},${coords.lng}`).toString("base64");
}

/**
 * Recover a stored coordinate, or null when the payload is absent, malformed, or out of range.
 *
 * Range-checks rather than trusting the round-trip: a truncated or re-encoded value can still parse as
 * two finite numbers, and a silently wrong coordinate on a supervisor's live-awareness board is worse
 * than an explicit "unavailable" — the whole reason this returns null instead of a zero pair.
 */
export function decodeStoredCoords(cipher: string | null | undefined): {
  lat: number;
  lng: number;
} | null {
  if (!cipher) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cipher, "base64").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
