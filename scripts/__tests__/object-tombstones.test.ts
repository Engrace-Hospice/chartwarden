// CW-DS-01 — the tombstone list the copy and restore tools read: parsing is strict (a line that cannot be read fails the load, because
// skipping it would let the object it names come back), the bucket must be a tenant's own, and the trailer is REQUIRED and must match the
// count, so an empty, truncated or half-written file is refused instead of read as "nothing to apply". The copy tool's loader fails closed
// on a file it cannot read. Synthetic bucket names and keys only. The end-to-end behaviour on real stores is in
// object-store-resilience.live.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  NO_TOMBSTONES,
  exportText,
  parseTombstones,
  tombstoneCount,
  tombstoneLine,
  tombstoneTrailer,
} from "../lib/object-tombstones";
import { loadTombstones } from "../object-store-copy";

const BUCKET = "tenant-00000000-0000-4000-8000-000000000001";
const OTHER = "tenant-00000000-0000-4000-8000-000000000002";
const scratch = mkdtempSync(join(tmpdir(), "tombstones-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("parseTombstones", () => {
  it("indexes keys by bucket, ignoring blank lines", () => {
    const text = exportText([
      { bucket: BUCKET, objectKey: "documents/p1/a.pdf" },
      { bucket: BUCKET, objectKey: "documents/p1/b.pdf" },
      { bucket: OTHER, objectKey: "documents/p2/c.pdf" },
    ]).replace("\n", "\n\n");
    const index = parseTombstones(text);
    expect([...(index.get(BUCKET) ?? [])]).toEqual(["documents/p1/a.pdf", "documents/p1/b.pdf"]);
    expect([...(index.get(OTHER) ?? [])]).toEqual(["documents/p2/c.pdf"]);
    expect(tombstoneCount(index)).toBe(3);
  });

  it("reads an export of no tombstones (only the trailer) as an empty list, and de-duplicates a key listed twice", () => {
    expect(tombstoneCount(parseTombstones(exportText([])))).toBe(0);
    const line = tombstoneLine({ bucket: BUCKET, objectKey: "documents/p1/a.pdf" });
    expect(tombstoneCount(parseTombstones(`${line}\n${line}\n${tombstoneTrailer(2)}\n`))).toBe(1);
  });

  it("refuses a file without its trailer: empty, truncated or half-written is never 'nothing to apply'", () => {
    const line = tombstoneLine({ bucket: BUCKET, objectKey: "documents/p1/a.pdf" });
    expect(() => parseTombstones("")).toThrow(/no trailer line/);
    expect(() => parseTombstones("\n\n")).toThrow(/no trailer line/);
    expect(() => parseTombstones(`${line}\n`)).toThrow(/no trailer line/);
    // an export cut off after two of three records
    const full = exportText([
      { bucket: BUCKET, objectKey: "a" },
      { bucket: BUCKET, objectKey: "b" },
      { bucket: BUCKET, objectKey: "c" },
    ]);
    expect(() => parseTombstones(full.split("\n").slice(0, 2).join("\n"))).toThrow(
      /no trailer line/,
    );
  });

  it("refuses a trailer that does not match the records, a bad count, and anything after the trailer", () => {
    const line = tombstoneLine({ bucket: BUCKET, objectKey: "documents/p1/a.pdf" });
    expect(() => parseTombstones(`${line}\n${tombstoneTrailer(2)}\n`)).toThrow(
      /says 2 but the file holds 1/,
    );
    expect(() => parseTombstones(`${line}\n${tombstoneTrailer(0)}\n`)).toThrow(
      /says 0 but the file holds 1/,
    );
    expect(() => parseTombstones(`{"tombstones":-1}\n`)).toThrow(/bad trailer count/);
    expect(() => parseTombstones(`{"tombstones":1.5}\n`)).toThrow(/bad trailer count/);
    expect(() => parseTombstones(`${tombstoneTrailer(0)}\n${line}\n`)).toThrow(
      /follows the trailer/,
    );
  });

  it("fails the whole load on a line it cannot read, naming the line (never skips one)", () => {
    const good = tombstoneLine({ bucket: BUCKET, objectKey: "documents/p1/a.pdf" });
    const end = tombstoneTrailer(1);
    expect(() => parseTombstones(`${good}\nnot json\n${end}\n`)).toThrow(/line 2 is not JSON/);
    expect(() => parseTombstones(`{"bucket":"${BUCKET}"}\n${end}\n`)).toThrow(
      /line 1 has no objectKey/,
    );
    expect(() => parseTombstones(`{"bucket":"${BUCKET}","objectKey":""}\n${end}\n`)).toThrow(
      /no objectKey/,
    );
    expect(() => parseTombstones(`null\n${end}\n`)).toThrow(/no tenant-<uuid> bucket/);
  });

  it("refuses any bucket that is not a tenant's own tenant-<uuid> (what the table's CHECK allows)", () => {
    for (const bucket of [
      "somebody-elses",
      "chartwarden-platform-objects",
      "tenant-not-a-uuid",
      `${BUCKET}-extra`,
      `x${BUCKET}`,
      BUCKET.toUpperCase(),
    ]) {
      expect(() =>
        parseTombstones(`${tombstoneLine({ bucket, objectKey: "k" })}\n${tombstoneTrailer(1)}\n`),
      ).toThrow(/no tenant-<uuid> bucket/);
    }
  });
});

describe("loadTombstones (the copy tool's loader)", () => {
  const file = (name: string, body: string): string => {
    const path = join(scratch, name);
    writeFileSync(path, body);
    return path;
  };

  it("is empty when no file is named", async () => {
    expect(await loadTombstones({}, [])).toBe(NO_TOMBSTONES);
    expect(await loadTombstones({ OBJECT_COPY_TOMBSTONES_FILE: "  " }, [])).toBe(NO_TOMBSTONES);
  });

  it("reads the file named by --tombstones, or by OBJECT_COPY_TOMBSTONES_FILE for the scheduled copy", async () => {
    const path = file(
      "a.ndjson",
      exportText([{ bucket: BUCKET, objectKey: "documents/p1/a.pdf" }]),
    );
    expect(tombstoneCount(await loadTombstones({}, ["--restore", "--tombstones", path]))).toBe(1);
    expect(tombstoneCount(await loadTombstones({ OBJECT_COPY_TOMBSTONES_FILE: path }, []))).toBe(1);
  });

  it("fails closed: a named file that is missing, empty or malformed stops the run before any object is touched", async () => {
    await expect(
      loadTombstones({}, ["--tombstones", join(scratch, "missing.ndjson")]),
    ).rejects.toThrow();
    await expect(
      loadTombstones({}, ["--tombstones", file("bad.ndjson", "oops\n")]),
    ).rejects.toThrow(/line 1/);
    await expect(loadTombstones({}, ["--tombstones", file("empty.ndjson", "")])).rejects.toThrow(
      /no trailer line/,
    );
    await expect(loadTombstones({}, ["--tombstones"])).rejects.toThrow(/needs a file path/);
  });
});
