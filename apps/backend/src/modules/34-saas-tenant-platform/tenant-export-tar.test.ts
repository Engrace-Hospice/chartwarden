// GAP-094 — proves `buildUstarTarball` produces a REAL, extractable tar archive, not merely bytes this
// module's own (potentially wrong) understanding of the format agrees with. Shells out to the system `tar`
// binary (the same trust boundary this repo already accepts for its live-Postgres tests) to list and
// extract the archive and assert the recovered files match byte-for-byte.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildUstarTarball } from "./tenant-export-tar";

const MTIME = 1_735_000_000; // fixed for determinism — 2024-12-24T00:26:40Z

describe("buildUstarTarball", () => {
  it("is byte-for-byte deterministic for the same entries + mtime", () => {
    const entries = [
      { path: "manifest.json", content: Buffer.from('{"ok":true}', "utf8") },
      { path: "modules/m5/patient.ndjson", content: Buffer.from("a\nb\nc\n", "utf8") },
    ];
    const a = buildUstarTarball(entries, MTIME);
    const b = buildUstarTarball(entries, MTIME);
    expect(a.equals(b)).toBe(true);
  });

  it("pads every entry to a 512-byte boundary and ends with two zero blocks", () => {
    const tar = buildUstarTarball([{ path: "x.txt", content: Buffer.from("hi", "utf8") }], MTIME);
    expect(tar.byteLength % 512).toBe(0);
    const tail = tar.subarray(tar.byteLength - 1024);
    expect(tail.every((byte) => byte === 0)).toBe(true);
  });

  it("is extractable by the real system tar binary with exact content round-tripping", () => {
    const entries = [
      {
        path: "manifest.json",
        content: Buffer.from(JSON.stringify({ bundleId: "job-1" }), "utf8"),
      },
      // deliberately not a multiple of 512 bytes, to exercise the padding path for real
      { path: "modules/m5/patient.ndjson", content: Buffer.from("row-1\nrow-2\nrow-3\n", "utf8") },
      { path: "modules/m6/admission.ndjson", content: Buffer.alloc(600, 0x41) }, // spans >1 block
    ];
    const tarball = buildUstarTarball(entries, MTIME);
    const gz = gzipSync(tarball);

    const dir = mkdtempSync(join(tmpdir(), "wx-gap094-tar-"));
    try {
      const archivePath = join(dir, "bundle.tar.gz");
      writeFileSync(archivePath, gz);

      const listing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
      const listedPaths = listing.trim().split("\n").sort();
      expect(listedPaths).toEqual([...entries.map((e) => e.path)].sort());

      const extractDir = join(dir, "out");
      execFileSync("mkdir", ["-p", extractDir]);
      execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);

      for (const entry of entries) {
        const extracted = readFileSync(join(extractDir, entry.path));
        expect(extracted.equals(entry.content)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an entry path over the ustar 100-byte name limit", () => {
    const longPath = `modules/${"m".repeat(100)}/table.ndjson`;
    expect(() => buildUstarTarball([{ path: longPath, content: Buffer.alloc(1) }], MTIME)).toThrow(
      /100-byte name limit/,
    );
  });
});
