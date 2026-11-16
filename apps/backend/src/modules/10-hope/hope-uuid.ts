// apps/backend/src/modules/10-hope/hope-uuid.ts — an id a caller typed, read the way Postgres reads a uuid.
// A route id or body id is only length-checked, and Postgres's uuid input accepts upper case, one pair of braces around
// the whole value and hyphens after any group of four digits. Wherever a JavaScript comparison or a Map lookup stands in
// for the database's own equality, the caller's spelling must not become a second key for the same record.
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
