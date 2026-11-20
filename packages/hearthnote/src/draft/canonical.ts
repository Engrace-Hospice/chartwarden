// packages/hearthnote/src/draft/canonical.ts — the canonical serialization behind a drafted section's
// `contentHash` (VN-D12). Pure string work; no hashing happens here.
//
// THE RULE (version `hearthnote-draft-section/1`, written into every hashed payload):
//   1. The hashed value is one JSON document: { format, part2Derived, sectionId, sourceRefs, text }.
//   2. Object keys are sorted ascending by UTF-16 code unit (default string order, never locale order) at
//      every depth; a key whose value is `undefined` is omitted. Array order is kept as given.
//   3. Every string (keys included) is NFC-normalized and has CRLF / CR rewritten to LF before it is
//      written; it is then escaped exactly as `JSON.stringify` escapes a string.
//   4. Numbers must be finite; `-0` is written `0`. No whitespace anywhere in the document.
//   5. The digest is SHA-256 over the UTF-8 bytes of that document, as lowercase hex.
// Changing any step needs a new `format` value, so an old confirmation can never match a new hash.

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/** NFC-normalize and make every line break "\n". The one text rule shared by rendered text and hashing. */
export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n");
}

/** Serialize `value` by the rule above. Throws on a value the rule cannot carry. */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(normalizeText(value));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("canonicalJson: number is not finite");
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as { readonly [key: string]: CanonicalValue | undefined })
      .filter((entry): entry is [string, CanonicalValue] => entry[1] !== undefined)
      .map(([key, child]): [string, CanonicalValue] => [normalizeText(key), child])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: cannot serialize a ${typeof value}`);
}
