// apps/backend/src/modules/10-hope/hope-uuid.ts — an id a caller typed, read the way Postgres reads a uuid.
// A route id or body id is only length-checked, and Postgres's uuid input accepts upper case, one pair of braces around
// the whole value and hyphens after any group of four digits. Wherever a JavaScript comparison or a Map lookup stands in
// for the database's own equality, the caller's spelling must not become a second key for the same record.
import { NotFoundError } from "@chartwarden/types";

const HEX_DIGITS = /^[0-9a-f]{32}$/;

/**
 * The canonical text of a uuid (lower-case, hyphenated: what `::text` writes), or `null` when `value` is none. It never
 * throws, so a caller can answer "matches nothing" where a `::uuid` cast would have been a 500 (22P02). It is a little
 * more lenient than Postgres about where the hyphens sit; the result is only ever compared with, or sent as, a canonical
 * id, so a stray hyphen can name no record that the real id does not.
 */
export function canonicalUuidOrNull(value: string): string | null {
  const bare = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  const hex = bare.replace(/-/g, "").toLowerCase();
  if (!HEX_DIGITS.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True when both texts are uuids and name the same one. Two values that are not uuids are NOT "the same id". */
export function sameUuid(a: string, b: string): boolean {
  const canonical = canonicalUuidOrNull(a);
  return canonical !== null && canonical === canonicalUuidOrNull(b);
}

/**
 * A record id from a URL, as Postgres writes it, or a 404 when it is no uuid. A route id is only length-checked, and
 * sent to a uuid column as `= 'not-a-uuid'` it raises 22P02: a 500 the in-memory twin never answers (it answers 404). An
 * id that is no uuid names no record, so it is the same 404 as an absent one. The canonical text is what the query
 * gets, never the caller's spelling (the helper is a little more lenient than Postgres about hyphens). Call it BEFORE
 * the first statement of a method that takes an id from a URL: the `hope.scope` gate answers 404 for such an id today,
 * but the service is also called directly, and a route added or reordered without that gate must not become a 500.
 */
export function uuidOrNotFound(id: string, notFoundMessage: string): string {
  const canonical = canonicalUuidOrNull(id);
  if (canonical === null) throw new NotFoundError(notFoundMessage);
  return canonical;
}
