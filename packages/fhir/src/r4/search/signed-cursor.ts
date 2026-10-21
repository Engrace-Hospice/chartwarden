// @chartwarden/fhir — HMAC-SHA256-signed opaque search cursor (§4.5 D13, W-FHIR-10, M28-T07).
//
// T04 shipped the OPAQUE ENCODING (`encodeCursor`/`decodeCursor`). D13 mandates the wire cursor also be
// HMAC-SHA256-SIGNED with the PER-TENANT `cursor_signing_key` (decrypted from
// `tenant_fhir_config.cursor_signing_key_cipher`) so a `Bundle.link.relation='next'` token cannot be
// (a) FORGED by a consumer to walk past its authorization horizon, or (b) REPLAYED cross-tenant — tenant
// A's cursor presented to tenant B fails the HMAC because B signs with a different key (§2.3, §8.3).
//
// This file is the sign/verify wrapper the routes (T08) compose over the T04 encoding: `signCursor`
// wraps the opaque body with a keyed MAC; `verifyCursor` re-derives the MAC in CONSTANT TIME and returns
// the decoded `CursorPayload` only on a match — a forged/tampered/wrong-tenant cursor returns `null`, and
// per §2.3 the route answers `400 Bad Request` with `invalid_cursor`. The signing key is INJECTED (the
// T03 capability-signing / T05 idiom); this leaf never reads it from env or decrypts the cipher itself.

import { createHmac, timingSafeEqual } from "node:crypto";

import { type CursorPayload, decodeCursor, encodeCursor } from "./cursor";

/** The wire cursor: `<base64url(payload)>.<hmac-hex>`. The dot separates the opaque body from its MAC so
 *  `verifyCursor` can split, re-sign the body, and constant-time compare — neither half is secret, only
 *  the key is. */
const CURSOR_SEPARATOR = ".";

/** HMAC-SHA256 (hex) of the opaque cursor body, keyed by the per-tenant `cursor_signing_key`. */
function macFor(body: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(body, "utf8").digest("hex");
}

/**
 * §D13 — encode a cursor payload and sign it with the tenant's `cursor_signing_key`. The result is the
 * opaque token the `Bundle.link.relation='next'` href carries; it is meaningless to the consumer and
 * unforgeable without the tenant key.
 */
export function signCursor(payload: CursorPayload, signingKey: string): string {
  const body = encodeCursor(payload);
  return `${body}${CURSOR_SEPARATOR}${macFor(body, signingKey)}`;
}

/**
 * §D13 / §2.3 — verify a presented cursor against the tenant's `cursor_signing_key` and decode it. Returns
 * the `CursorPayload` ONLY when the MAC re-derives and matches in constant time; returns `null` on any
 * failure mode — absent cursor, malformed shape (no separator / not two parts), a body that no longer
 * base64url-decodes to a payload, or a MAC that does not match (forged, tampered, or signed by another
 * tenant's key). The route maps that `null` to `400 invalid_cursor`. Fails CLOSED.
 */
export function verifyCursor(cursor: string | undefined, signingKey: string): CursorPayload | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf(CURSOR_SEPARATOR);
  if (sep <= 0 || sep >= cursor.length - 1) return null;
  const body = cursor.slice(0, sep);
  const presentedMac = cursor.slice(sep + 1);
  const expectedMac = macFor(body, signingKey);
  const a = Buffer.from(expectedMac, "utf8");
  const b = Buffer.from(presentedMac, "utf8");
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return decodeCursor(body);
}
