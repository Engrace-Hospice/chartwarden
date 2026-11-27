// CW-DS-01 — the object destruction tombstones as the copy and restore tools read them: newline-delimited JSON, one
// `{"bucket": "...", "objectKey": "..."}` per destroyed object, then ONE trailer line `{"tombstones": N, "sha256": "<hex>"}` with the
// number of record lines and a SHA-256 over them. Produced by scripts/storage/object-tombstones.ts from the
// `object_destruction_tombstone` table.
//
// The file is applied to a store by DESTROYING objects, and on a restore a list that is silently short resurrects documents. So the
// load fails closed: a line it cannot read fails the whole load (skipping one would let exactly that object come back), a bucket
// that is not a tenant's own (`tenant-<uuid>`, what the table's CHECK allows) is refused, an object key that does not have the form
// the document store produces is refused (a hand-edited or corrupted list cannot name `..`, an absolute path, an encoded slash or a
// prefix the store never writes), and the trailer is REQUIRED and must match the count of the lines actually read, so an empty file,
// a truncated one, or an export that failed halfway is rejected, never read as "nothing to apply". The applied set is built from the
// lines only: the trailer's count is a check against them, never a source. The SHA-256 is optional on load (a list exported before it
// existed still loads) and refused when present and wrong: it catches corruption and accidental edits, NOT a forger who recomputes it
// (the file's authenticity is that of its custody: the operator's directory, mode 0700).
import { createHash } from "node:crypto";

const TOMBSTONED_BUCKET = /^tenant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The key forms the document store writes (apps/backend/src/modules/22-documents): `documents/<patient|unbound>/<aggregate>/<document>/<file>`
 * (lifecycle/storage.ts), `intake/<batch>/<file>` and `uploads/<id>/<aggregate>-<short id>` (the upload routes). Every segment starts with a
 * letter or digit, so `.` and `..` cannot appear; there is no empty segment, no leading slash, no `%`, no space and no control character.
 */
const OBJECT_KEY_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const OBJECT_KEY_SHAPE = new RegExp(
  `^(?:documents|intake|uploads)(?:/${OBJECT_KEY_SEGMENT}){2,6}$`,
);
export const MAX_OBJECT_KEY_LENGTH = 512;

export function isObjectKeyShape(key: string): boolean {
  return key.length <= MAX_OBJECT_KEY_LENGTH && OBJECT_KEY_SHAPE.test(key);
}

/** bucket -> the object keys destroyed in it. */
export type TombstoneIndex = ReadonlyMap<string, ReadonlySet<string>>;

export const NO_TOMBSTONES: TombstoneIndex = new Map();

export interface TombstoneRecord {
  readonly bucket: string;
  readonly objectKey: string;
}

export function tombstoneLine(record: TombstoneRecord): string {
  return JSON.stringify({ bucket: record.bucket, objectKey: record.objectKey });
}

/** SHA-256 (hex) over the record lines, each followed by a newline: what the trailer's `sha256` holds. */
export function tombstoneDigest(recordLines: readonly string[]): string {
  return createHash("sha256")
    .update(recordLines.map((line) => `${line}\n`).join(""))
    .digest("hex");
}

export function tombstoneTrailer(count: number, sha256?: string): string {
  return JSON.stringify(
    sha256 === undefined ? { tombstones: count } : { tombstones: count, sha256 },
  );
}

/**
 * The records as the NDJSON file the tools read: one line each, then the trailer with the count and the digest. Refuses a record
 * the loaders would refuse (naming the line, never the key), so an export never writes a file that cannot be applied.
 */
export function exportText(records: readonly TombstoneRecord[]): string {
  records.forEach((record, i) => {
    if (!TOMBSTONED_BUCKET.test(record.bucket))
      throw new Error(`tombstones: record ${i + 1} has no tenant-<uuid> bucket`);
    if (!isObjectKeyShape(record.objectKey))
      throw new Error(
        `tombstones: record ${i + 1} has an objectKey that is not an object-key form the document store writes`,
      );
  });
  const lines = records.map(tombstoneLine);
  return `${[...lines, tombstoneTrailer(records.length, tombstoneDigest(lines))].join("\n")}\n`;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Parse the NDJSON text; throws naming the 1-based line of the first line that is not valid, or the trailer problem. */
export function parseTombstones(text: string): TombstoneIndex {
  const index = new Map<string, Set<string>>();
  const lines = text.split("\n");
  const recordLines: string[] = [];
  let trailer: {
    readonly line: number;
    readonly count: number;
    readonly sha256: string | null;
  } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (trailer !== null) throw new Error(`tombstones: line ${i + 1} follows the trailer`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`tombstones: line ${i + 1} is not JSON`);
    }
    const fields = (parsed ?? {}) as Partial<
      Record<keyof TombstoneRecord | "tombstones" | "sha256", unknown>
    >;
    if (typeof fields.tombstones === "number") {
      if (fields.bucket !== undefined || fields.objectKey !== undefined)
        throw new Error(`tombstones: line ${i + 1} is both a trailer and a record`);
      if (!Number.isInteger(fields.tombstones) || fields.tombstones < 0)
        throw new Error(`tombstones: line ${i + 1} has a bad trailer count`);
      if (
        fields.sha256 !== undefined &&
        (typeof fields.sha256 !== "string" || !SHA256_HEX.test(fields.sha256))
      )
        throw new Error(`tombstones: line ${i + 1} has a bad trailer checksum`);
      trailer = {
        line: i + 1,
        count: fields.tombstones,
        sha256: (fields.sha256 as string | undefined) ?? null,
      };
      continue;
    }
    const { bucket, objectKey } = fields;
    if (typeof bucket !== "string" || !TOMBSTONED_BUCKET.test(bucket))
      throw new Error(`tombstones: line ${i + 1} has no tenant-<uuid> bucket`);
    if (typeof objectKey !== "string" || objectKey === "")
      throw new Error(`tombstones: line ${i + 1} has no objectKey`);
    if (!isObjectKeyShape(objectKey))
      throw new Error(
        `tombstones: line ${i + 1} has an objectKey that is not an object-key form the document store writes`,
      );
    const keys = index.get(bucket) ?? new Set<string>();
    keys.add(objectKey);
    index.set(bucket, keys);
    recordLines.push(line);
  }
  if (trailer === null)
    throw new Error(
      "tombstones: no trailer line (an empty, truncated or half-written file is refused)",
    );
  if (trailer.count !== recordLines.length)
    throw new Error(
      `tombstones: the trailer on line ${trailer.line} says ${trailer.count} but the file holds ${recordLines.length}`,
    );
  if (trailer.sha256 !== null && trailer.sha256 !== tombstoneDigest(recordLines))
    throw new Error(
      `tombstones: the checksum on line ${trailer.line} does not match the records (the file changed after it was exported)`,
    );
  return index;
}

export function tombstoneCount(index: TombstoneIndex): number {
  let n = 0;
  for (const keys of index.values()) n += keys.size;
  return n;
}

/** Path segments shorter than this are not scrubbed on their own (`unbound`, a filename stem): they carry no identifier. */
const MIN_SCRUBBED_SEGMENT = 8;
/** The hash prefix the copy tool prints as a key's label (`sha256:<16 hex>`): scrubbed from the TEXT of an error, which has no use for it. */
export const SCRUBBED_HASH_PREFIX = 16;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An error text with every form of `key` taken out, whatever the letter case. The key embeds a patient's opaque id, and an adapter or a
 * fetch layer may echo it back in other shapes than the one it was given: raw, URL-encoded (component, whole-URI, doubly; percent
 * escapes in either hex case), as a single path segment (the patient id, the document id) with or without its hyphens, and as the key's
 * SHA-256 or its printed 16-character prefix. Replaced by `<key>`. Over-scrubbing is fine; under-scrubbing puts an erased patient's id
 * on stdout and in the alert webhook. NOT covered: a truncated id or key, base64 or hex of the key, a segment shorter than
 * MIN_SCRUBBED_SEGMENT.
 */
export function scrubObjectKey(text: string, key: string): string {
  const forms = (value: string): string[] => {
    const once = encodeURIComponent(value);
    return [value, once, encodeURI(value), encodeURIComponent(once)];
  };
  const segments = key
    .split("/")
    .slice(1)
    .filter((segment) => segment.length >= MIN_SCRUBBED_SEGMENT);
  const unhyphenated = segments
    .map((segment) => segment.replace(/-/g, ""))
    .filter((segment) => segment.length >= MIN_SCRUBBED_SEGMENT);
  const digest = createHash("sha256").update(key).digest("hex");
  const needles = new Set([
    ...forms(key),
    ...[...segments, ...unhyphenated].flatMap(forms),
    digest,
    digest.slice(0, SCRUBBED_HASH_PREFIX),
  ]);
  needles.delete("");
  const pattern = [...needles]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return text.replace(new RegExp(pattern, "gi"), "<key>");
}
