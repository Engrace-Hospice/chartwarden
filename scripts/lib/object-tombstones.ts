// CW-DS-01 — the object destruction tombstones as the copy and restore tools read them: newline-delimited JSON, one
// `{"bucket": "...", "objectKey": "..."}` per destroyed object, then ONE trailer line `{"tombstones": N}` with the number of
// record lines. Produced by scripts/storage/object-tombstones.ts from the `object_destruction_tombstone` table.
//
// The file is applied to a store by DESTROYING objects, and on a restore a list that is silently short resurrects documents. So the
// load fails closed: a line it cannot read fails the whole load (skipping one would let exactly that object come back), a bucket
// that is not a tenant's own (`tenant-<uuid>`, what the table's CHECK allows) is refused, and the trailer is REQUIRED and must match
// the count, so an empty file, a truncated one, or an export that failed halfway is rejected, never read as "nothing to apply".
const TOMBSTONED_BUCKET = /^tenant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export function tombstoneTrailer(count: number): string {
  return JSON.stringify({ tombstones: count });
}

/** The records as the NDJSON file the tools read: one line each, then the trailer. */
export function exportText(records: readonly TombstoneRecord[]): string {
  return `${[...records.map(tombstoneLine), tombstoneTrailer(records.length)].join("\n")}\n`;
}

/** Parse the NDJSON text; throws naming the 1-based line of the first line that is not valid, or the trailer problem. */
export function parseTombstones(text: string): TombstoneIndex {
  const index = new Map<string, Set<string>>();
  const lines = text.split("\n");
  let records = 0;
  let trailer: { readonly line: number; readonly count: number } | null = null;
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
    const fields = (parsed ?? {}) as Partial<Record<keyof TombstoneRecord | "tombstones", unknown>>;
    if (typeof fields.tombstones === "number") {
      if (!Number.isInteger(fields.tombstones) || fields.tombstones < 0)
        throw new Error(`tombstones: line ${i + 1} has a bad trailer count`);
      trailer = { line: i + 1, count: fields.tombstones };
      continue;
    }
    const { bucket, objectKey } = fields;
    if (typeof bucket !== "string" || !TOMBSTONED_BUCKET.test(bucket))
      throw new Error(`tombstones: line ${i + 1} has no tenant-<uuid> bucket`);
    if (typeof objectKey !== "string" || objectKey === "")
      throw new Error(`tombstones: line ${i + 1} has no objectKey`);
    const keys = index.get(bucket) ?? new Set<string>();
    keys.add(objectKey);
    index.set(bucket, keys);
    records++;
  }
  if (trailer === null)
    throw new Error(
      "tombstones: no trailer line (an empty, truncated or half-written file is refused)",
    );
  if (trailer.count !== records)
    throw new Error(
      `tombstones: the trailer on line ${trailer.line} says ${trailer.count} but the file holds ${records}`,
    );
  return index;
}

export function tombstoneCount(index: TombstoneIndex): number {
  let n = 0;
  for (const keys of index.values()) n += keys.size;
  return n;
}
