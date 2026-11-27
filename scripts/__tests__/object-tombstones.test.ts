import { createHash } from "node:crypto";
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
  MAX_OBJECT_KEY_LENGTH,
  NO_TOMBSTONES,
  exportText,
  isObjectKeyShape,
  parseTombstones,
  scrubObjectKey,
  tombstoneCount,
  tombstoneDigest,
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
      { bucket: BUCKET, objectKey: "documents/p1/a.pdf" },
      { bucket: BUCKET, objectKey: "documents/p1/b.pdf" },
      { bucket: BUCKET, objectKey: "documents/p1/c.pdf" },
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

describe("the object-key shape", () => {
  const PATIENT = "11111111-2222-4333-8444-555555555555";
  const DOCUMENT = "66666666-7777-4888-8999-000000000000";

  it("accepts the forms the document store writes", () => {
    for (const key of [
      `documents/${PATIENT}/clinical_note/${DOCUMENT}/clinical_note-a1b2c3d4e5f6.pdf`,
      `documents/unbound/other/${DOCUMENT}/other-a1b2c3d4e5f6.pdf`,
      `intake/${DOCUMENT}/intake-a1b2c3d4e5f6.pdf`,
      `uploads/${DOCUMENT}/other-a1b2c3d4e5f6`,
      "documents/p1/a.pdf",
    ])
      expect(isObjectKeyShape(key), key).toBe(true);
  });

  it("refuses everything else: traversal, absolute, empty or encoded segments, odd prefixes, whitespace, control characters, length", () => {
    for (const key of [
      "",
      "a",
      "documents",
      "documents/",
      "documents/p1",
      "/documents/p1/a.pdf",
      "documents//a.pdf",
      "documents/../other/a.pdf",
      "documents/./p1/a.pdf",
      "documents/p1/..",
      "documents/p1/a.pdf/",
      "documents/p1/%2e%2e/a.pdf",
      "documents/p1%2Fx/a.pdf",
      "documents/p1/a b.pdf",
      "documents/p1/a\nb.pdf",
      "documents/p1/a\u0000b.pdf",
      "documents/p1/é.pdf",
      "backups/p1/a.pdf",
      "Documents/p1/a.pdf",
      "documents/-p1/a.pdf",
      `documents/${"a".repeat(MAX_OBJECT_KEY_LENGTH)}/b.pdf`,
      "documents/a/b/c/d/e/f/g/h.pdf",
    ])
      expect(isObjectKeyShape(key), JSON.stringify(key)).toBe(false);
  });

  it("makes the loader refuse a list that names such a key, by line and without echoing the key", () => {
    const end = tombstoneTrailer(1);
    for (const objectKey of [
      "documents/../etc/passwd",
      "/documents/p1/a.pdf",
      "loose-object-name",
      "documents/p1/a%2Fb",
    ]) {
      const text = `${tombstoneLine({ bucket: BUCKET, objectKey })}\n${end}\n`;
      expect(() => parseTombstones(text), objectKey).toThrow(
        /line 1 has an objectKey that is not an object-key form/,
      );
      expect(() => parseTombstones(text)).not.toThrow(objectKey);
    }
  });

  it("makes the exporter refuse a record the loader would refuse (the export never writes an unusable file)", () => {
    expect(() => exportText([{ bucket: BUCKET, objectKey: "documents/../x/y.pdf" }])).toThrow(
      /record 1 has an objectKey that is not an object-key form/,
    );
    expect(() => exportText([{ bucket: "tenant-x", objectKey: "documents/p1/a.pdf" }])).toThrow(
      /record 1 has no tenant-<uuid> bucket/,
    );
  });
});

describe("the trailer count and checksum", () => {
  const records = [
    { bucket: BUCKET, objectKey: "documents/p1/a.pdf" },
    { bucket: OTHER, objectKey: "documents/p2/b.pdf" },
  ];

  it("exports a count and a SHA-256 over the record lines, and loads it back", () => {
    const text = exportText(records);
    const lines = text.trimEnd().split("\n");
    const trailer = JSON.parse(lines[lines.length - 1] ?? "{}") as {
      tombstones: number;
      sha256: string;
    };
    expect(trailer.tombstones).toBe(2);
    expect(trailer.sha256).toBe(
      createHash("sha256")
        .update(`${lines.slice(0, 2).join("\n")}\n`)
        .digest("hex"),
    );
    expect(tombstoneCount(parseTombstones(text))).toBe(2);
  });

  it("refuses a file whose records changed after the export, even with the right count", () => {
    const text = exportText(records);
    const swapped = text.replace("documents/p2/b.pdf", "documents/p2/c.pdf");
    expect(() => parseTombstones(swapped)).toThrow(/checksum on line 3 does not match the records/);
    // a record dropped and another added keeps the count and still fails
    const lines = text.trimEnd().split("\n");
    const reordered = [lines[1], lines[0], lines[2]].join("\n");
    expect(() => parseTombstones(reordered)).toThrow(/checksum/);
  });

  it("refuses a line that is both a trailer and a record, and a second trailer", () => {
    const [first] = exportText(records).split("\n");
    const hybrid = `{"tombstones":1,"bucket":"${BUCKET}","objectKey":"documents/p1/a.pdf"}`;
    expect(() => parseTombstones(`${hybrid}\n`)).toThrow(/both a trailer and a record/);
    expect(() =>
      parseTombstones(`${first}\n${tombstoneTrailer(1)}\n${tombstoneTrailer(1)}\n`),
    ).toThrow(/follows the trailer/);
  });

  it("a forged count never widens what is applied: the set comes from the lines, a mismatch is refused", () => {
    const [first, second] = exportText(records).split("\n");
    expect(() => parseTombstones(`${first}\n${second}\n${tombstoneTrailer(1)}\n`)).toThrow(
      /says 1 but the file holds 2/,
    );
    expect(() => parseTombstones(`${first}\n${tombstoneTrailer(2)}\n`)).toThrow(
      /says 2 but the file holds 1/,
    );
  });

  it("the checksum is optional on load (a list exported before it existed still loads) but refused when malformed", () => {
    const [first, second] = exportText(records).split("\n");
    expect(tombstoneCount(parseTombstones(`${first}\n${second}\n${tombstoneTrailer(2)}\n`))).toBe(
      2,
    );
    expect(() =>
      parseTombstones(`${first}\n${second}\n${tombstoneTrailer(2, "nothex")}\n`),
    ).toThrow(/bad trailer checksum/);
    expect(() => parseTombstones(`${first}\n${second}\n{"tombstones":2,"sha256":7}\n`)).toThrow(
      /bad trailer checksum/,
    );
    expect(tombstoneDigest([])).toBe(createHash("sha256").update("").digest("hex"));
  });
});

describe("scrubObjectKey", () => {
  const PATIENT = "11111111-2222-4333-8444-555555555555";
  const KEY = `documents/${PATIENT}/clinical_note/66666666-7777-4888-8999-000000000000/clinical_note-a1b2c3d4e5f6.pdf`;
  const label = createHash("sha256").update(KEY).digest("hex");

  it("removes the raw key, every URL-encoded form of it, and a path segment on its own", () => {
    const texts = [
      `HTTP 500 for ${KEY}`,
      `GET /${encodeURIComponent(KEY)} failed`,
      `GET /${encodeURI(KEY)} failed`,
      `GET /${encodeURIComponent(encodeURIComponent(KEY))} failed`,
      `GET /${encodeURIComponent(KEY).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())} failed`,
      `no such patient ${PATIENT}`,
      `prefix documents%2F${PATIENT}%2Fclinical_note`,
    ];
    for (const text of texts) {
      const out = scrubObjectKey(text, KEY);
      expect(out, text).not.toContain(PATIENT);
      expect(out, text).not.toContain("66666666-7777-4888-8999-000000000000");
      expect(out, text).not.toMatch(/a1b2c3d4e5f6/);
      expect(out, text).toContain("<key>");
    }
  });

  it("removes an id in upper case, without its hyphens, and a lower-case double-encoded key", () => {
    const hyphenless = PATIENT.replace(/-/g, "");
    const doubleLower = encodeURIComponent(encodeURIComponent(KEY)).replace(
      /%25[0-9A-F]{2}/g,
      (m) => m.toLowerCase(),
    );
    for (const text of [
      `no such patient ${PATIENT.toUpperCase()}`,
      `no such patient ${hyphenless}`,
      `no such patient ${hyphenless.toUpperCase()}`,
      `GET /${doubleLower} failed`,
    ]) {
      const out = scrubObjectKey(text, KEY);
      expect(out, text).not.toMatch(
        new RegExp(`${PATIENT.slice(0, 8)}|${PATIENT.slice(-12)}`, "i"),
      );
      expect(out, text).toContain("<key>");
    }
  });

  it("removes the key's SHA-256 and its 16-character prefix, in either case", () => {
    for (const hash of [
      label,
      label.slice(0, 16),
      label.toUpperCase(),
      label.slice(0, 16).toUpperCase(),
    ])
      expect(scrubObjectKey(`object ${hash} unreadable`, KEY)).toBe("object <key> unreadable");
  });

  it("leaves unrelated text alone, and does not scrub the fixed prefix or short segments on their own", () => {
    expect(scrubObjectKey("HTTP 500 from the target for bucket tenant-x", KEY)).toBe(
      "HTTP 500 from the target for bucket tenant-x",
    );
    const keyWithShortSegments = "documents/unbound/other/doc1/f.pdf";
    expect(scrubObjectKey("documents are listed under unbound", keyWithShortSegments)).toBe(
      "documents are listed under unbound",
    );
    expect(scrubObjectKey("", KEY)).toBe("");
  });
});
