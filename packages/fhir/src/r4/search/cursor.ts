// @wardenx/fhir — opaque search cursor (§4.5 D13, M28-T04).
//
// Cursor-based pagination (D13): `Bundle.link.relation='next'` carries an opaque continuation token
// holding the last resource's id. Offset pagination is broken under concurrent writes; a cursor keyed on
// the last id is stable (W-FHIR-14).
//
// PHASE NOTE: D13 mandates the cursor be HMAC-SHA256-signed with the per-tenant `cursor_signing_key` so
// it cannot be forged or replayed cross-tenant. That signing (and its key injection) lands with the
// cursor + include-resolver task (spec task #3 / T07, W-FHIR-10). T04 ships the OPAQUE ENCODING the
// DiagnosticReport `?patient` search needs; the sign/verify wrapper composes over `encodeCursor` there.

export interface CursorPayload {
  /** The last resource id served on the previous page — the seam's `afterId`. */
  readonly lastId: string;
}

/** Base64url-encode a cursor payload. Opaque to the consumer; not yet signed (see the phase note). */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decode an opaque cursor. Returns `null` on any malformed/unparseable token (the route answers 400). */
export function decodeCursor(cursor: string | undefined): CursorPayload | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { lastId?: unknown }).lastId === "string"
    ) {
      return { lastId: (parsed as { lastId: string }).lastId };
    }
    return null;
  } catch {
    return null;
  }
}
