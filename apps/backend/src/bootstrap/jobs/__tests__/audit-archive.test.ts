// GAP-113 — audit.archive: cut a closed partition into verified gzip parts + a manifest; detach only after every
// object is verified and only when opted in; a failure leaves the partition attached; unconfigured is a skip.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type ArchiveCandidate,
  type ArchiveCatalogPort,
  type ArchiveConfig,
  type ArchiveObjectPort,
  ArchiveVerificationError,
  archivePartition,
  auditArchiveConfigFromEnv,
  encodePart,
  manifestKey,
  partKey,
  runAuditArchive,
} from "../audit-archive";

const rowsOf = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(5, "0")}`,
    event_type: "x.y",
    n: i,
  }));

function fakeCatalog(partitionRows: Record<string, Array<Record<string, unknown>>>) {
  const detached: Array<[string, number]> = [];
  const attested: boolean[] = [];
  const catalog: ArchiveCatalogPort = {
    async candidates() {
      return Object.entries(partitionRows).map(([partitionName, rows]) => ({
        partitionName,
        rangeFrom: "2025-01-01",
        rangeTo: "2025-02-01",
        rowCount: rows.length,
      }));
    },
    async readBatch(partition, afterId, limit) {
      const all = partitionRows[partition] ?? [];
      const start = afterId === null ? 0 : all.findIndex((r) => r.id === afterId) + 1;
      return all.slice(start, start + limit);
    },
    async detach(partition, expected, manifestVerified) {
      detached.push([partition, expected]);
      attested.push(manifestVerified);
    },
  };
  return { catalog, detached, attested };
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function fakeStore(opts: { corrupt?: boolean; missing?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const store: ArchiveObjectPort = {
    async putObject({ objectKey, bytes }) {
      objects.set(objectKey, bytes);
      return { sha256Hex: sha(bytes) };
    },
    async inspectObject({ objectKey }) {
      if (opts.missing) return null;
      const bytes = objects.get(objectKey);
      if (!bytes) return null;
      return {
        byteSize: bytes.byteLength,
        sha256Hex: opts.corrupt ? "0".repeat(64) : sha(bytes),
      };
    },
  };
  return { store, objects };
}

const CONFIG: ArchiveConfig = {
  bucket: "audit-cold",
  prefix: "audit-archive",
  rowsPerPart: 250,
  detach: false,
  now: () => new Date("2026-10-06T03:30:00.000Z"),
};
const candidate = (rows: number): ArchiveCandidate => ({
  partitionName: "audit_event_2025_01",
  rangeFrom: "2025-01-01",
  rangeTo: "2025-02-01",
  rowCount: rows,
});

describe("encodePart", () => {
  it("is deterministic gzip'd NDJSON", () => {
    const a = encodePart(rowsOf(3));
    expect(Buffer.from(a).equals(Buffer.from(encodePart(rowsOf(3))))).toBe(true);
    const lines = gunzipSync(a).toString("utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).n)).toEqual([0, 1, 2]);
  });
});

describe("archivePartition", () => {
  it("cuts the partition into parts + a manifest whose counts and checksums are the stored ones", async () => {
    const { catalog } = fakeCatalog({ audit_event_2025_01: rowsOf(600) });
    const { store, objects } = fakeStore();
    const done = await archivePartition(candidate(600), catalog, store, CONFIG);
    expect(done).toMatchObject({ rows: 600, parts: 3, detached: false });
    expect([...objects.keys()].sort()).toEqual([
      manifestKey("audit-archive", "audit_event_2025_01"),
      partKey("audit-archive", "audit_event_2025_01", 1),
      partKey("audit-archive", "audit_event_2025_01", 2),
      partKey("audit-archive", "audit_event_2025_01", 3),
    ]);
    const manifest = JSON.parse(
      Buffer.from(
        objects.get(manifestKey("audit-archive", "audit_event_2025_01")) as Uint8Array,
      ).toString(),
    );
    expect(manifest).toMatchObject({
      partition: "audit_event_2025_01",
      rowCount: 600,
      schemaVersion: 1,
    });
    expect(manifest.parts.map((p: { rows: number }) => p.rows)).toEqual([250, 250, 100]);
    expect(manifest.parts[0].firstId).toBe("id-00000");
    expect(manifest.parts[2].lastId).toBe("id-00599");
    const stored1 = objects.get(partKey("audit-archive", "audit_event_2025_01", 1)) as Uint8Array;
    expect(manifest.parts[0].sha256).toBe(sha(stored1));
    expect(gunzipSync(stored1).toString().trim().split("\n")).toHaveLength(250);
  });

  it("detaches only after the manifest is verified, and only when opted in", async () => {
    const { catalog, detached, attested } = fakeCatalog({ audit_event_2025_01: rowsOf(10) });
    const off = await archivePartition(candidate(10), catalog, fakeStore().store, CONFIG);
    expect(off.detached).toBe(false);
    expect(detached).toEqual([]);
    const on = await archivePartition(candidate(10), catalog, fakeStore().store, {
      ...CONFIG,
      detach: true,
    });
    expect(on.detached).toBe(true);
    expect(detached).toEqual([["audit_event_2025_01", 10]]);
    // GAP-008: the SQL function refuses a partition holding actively-held rows without this attestation, and the job gives
    // it only after the manifest PUT was read back verified.
    expect(attested).toEqual([true]);
  });

  it("a corrupt or missing stored object fails verification and the partition is NOT detached", async () => {
    for (const s of [fakeStore({ corrupt: true }), fakeStore({ missing: true })]) {
      const { catalog, detached } = fakeCatalog({ audit_event_2025_01: rowsOf(10) });
      await expect(
        archivePartition(candidate(10), catalog, s.store, { ...CONFIG, detach: true }),
      ).rejects.toBeInstanceOf(ArchiveVerificationError);
      expect(detached).toEqual([]);
    }
  });

  it("a short read (fewer rows than the partition held) is a failure", async () => {
    const { catalog, detached } = fakeCatalog({ audit_event_2025_01: rowsOf(8) });
    await expect(
      archivePartition(candidate(10), catalog, fakeStore().store, { ...CONFIG, detach: true }),
    ).rejects.toThrow(/read 8 rows, partition held 10/);
    expect(detached).toEqual([]);
  });
});

describe("runAuditArchive", () => {
  const run = (
    parts: Record<string, Array<Record<string, unknown>>>,
    store: ArchiveObjectPort,
    over: { maxPartitions?: number } = {},
  ) => {
    const { catalog, detached } = fakeCatalog(parts);
    return {
      detached,
      result: runAuditArchive({
        withCatalog: (fn) => fn(catalog),
        store,
        config: { ...CONFIG, detach: true },
        hotMonths: 13,
        ...over,
      }),
    };
  };

  it("archives up to the per-run cap, oldest first, and reports the rest as deferred", async () => {
    const { result, detached } = run(
      { p1: rowsOf(5), p2: rowsOf(5), p3: rowsOf(5) },
      fakeStore().store,
      { maxPartitions: 2 },
    );
    const out = await result;
    expect(out.archived.map((a) => a.partitionName)).toEqual(["p1", "p2"]);
    expect(out.deferred).toBe(1);
    expect(detached.map(([p]) => p)).toEqual(["p1", "p2"]);
  });

  it("skips empty partitions", async () => {
    const out = await run({ p1: [], p2: rowsOf(2) }, fakeStore().store).result;
    expect(out.archived.map((a) => a.partitionName)).toEqual(["p2"]);
  });

  it("one partition failing does not stop the others, but the pass rejects and detaches nothing for it", async () => {
    const inner = fakeStore();
    const store: ArchiveObjectPort = {
      putObject: (a) => {
        if (a.objectKey.includes("/p1/")) throw new Error("minio down");
        return inner.store.putObject(a);
      },
      inspectObject: (a) => inner.store.inspectObject(a),
    };
    const { result, detached } = run({ p1: rowsOf(3), p2: rowsOf(3) }, store);
    await expect(result).rejects.toThrow(/1 partition\(s\) failed; none of them was detached/);
    expect(detached.map(([p]) => p)).toEqual(["p2"]);
  });
});

describe("auditArchiveConfigFromEnv", () => {
  it("is null (skip) without a bucket", () => {
    expect(auditArchiveConfigFromEnv({})).toBeNull();
  });

  it("defaults: 13 hot months, detach OFF", () => {
    const c = auditArchiveConfigFromEnv({ AUDIT_ARCHIVE_BUCKET: "b" });
    expect(c?.hotMonths).toBe(13);
    expect(c?.config.detach).toBe(false);
    expect(c?.config.prefix).toBe("audit-archive");
  });

  it("detach only for the literal 'true'; prefix slashes trimmed; junk numbers fall back", () => {
    const c = auditArchiveConfigFromEnv({
      AUDIT_ARCHIVE_BUCKET: "b",
      AUDIT_ARCHIVE_DETACH: "yes",
      AUDIT_ARCHIVE_PREFIX: "/cold/",
      AUDIT_ARCHIVE_HOT_MONTHS: "abc",
    });
    expect(c?.config.detach).toBe(false);
    expect(c?.config.prefix).toBe("cold");
    expect(c?.hotMonths).toBe(13);
    expect(
      auditArchiveConfigFromEnv({ AUDIT_ARCHIVE_BUCKET: "b", AUDIT_ARCHIVE_DETACH: "true" })?.config
        .detach,
    ).toBe(true);
  });
});
