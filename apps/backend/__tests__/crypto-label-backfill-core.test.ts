// The scan loop of the crypto label backfill (scripts/db/crypto-label-backfill/core.ts), without a database: what each mode may
// call, how rows are tallied, that a re-seal that fails or is skipped is still counted as legacy-only, and the stop conditions.
import { describe, expect, it } from "vitest";
import {
  type RowClass,
  type Scan,
  type WriteResult,
  runScan,
} from "../../../scripts/db/crypto-label-backfill/core";

interface Row {
  readonly id: string;
  readonly klass: RowClass;
  readonly write?: WriteResult;
}

function scanOf(rows: readonly Row[]) {
  const log = { resealed: [] as string[], pages: 0 };
  const scan: Scan<Row> = {
    module: "t",
    table: "t",
    organizationId: null,
    idOf: (r) => r.id,
    async page(after, limit) {
      log.pages += 1;
      return rows.filter((r) => after === null || r.id > after).slice(0, limit);
    },
    async classify(r) {
      return r.klass;
    },
    async reseal(r) {
      log.resealed.push(r.id);
      return r.write ?? "resealed";
    },
  };
  return { scan, log };
}

const rows: Row[] = [
  { id: "01", klass: "current" },
  { id: "02", klass: "legacy" },
  { id: "03", klass: "legacy", write: "skipped" },
  { id: "04", klass: "legacy", write: "failed" },
  { id: "05", klass: "unreadable" },
  { id: "06", klass: "ignore" },
  { id: "07", klass: "legacy" },
];

describe("runScan", () => {
  it("--verify never calls reseal and reports every legacy-only row", async () => {
    const t = scanOf(rows);
    const report = await runScan(t.scan, { mode: "verify", batchSize: 3 });
    expect(t.log.resealed).toEqual([]);
    expect(report.counts).toMatchObject({
      scanned: 7,
      current: 1,
      legacyOnly: 4,
      unreadable: 1,
      ignored: 1,
      resealed: 0,
    });
    expect(report.problemIds).toEqual(["05"]);
  });

  it("--dry-run never calls reseal and says what it would do", async () => {
    const t = scanOf(rows);
    const report = await runScan(t.scan, { mode: "dry-run", batchSize: 2 });
    expect(t.log.resealed).toEqual([]);
    expect(report.counts).toMatchObject({ legacyOnly: 4, wouldReseal: 4, resealed: 0 });
  });

  it("--apply re-seals only legacy rows; skipped and failed rows stay counted as legacy-only", async () => {
    const t = scanOf(rows);
    const report = await runScan(t.scan, { mode: "apply", batchSize: 2 });
    expect(t.log.resealed).toEqual(["02", "03", "04", "07"]);
    expect(report.counts).toMatchObject({
      resealed: 2,
      skipped: 1,
      failed: 1,
      legacyOnly: 2,
      unreadable: 1,
    });
    expect(report.problemIds).toEqual(["04", "05"]);
    expect(report.stoppedBy).toBe("exhausted");
  });

  it("pages with a keyset (each page starts after the last id), not by offset", async () => {
    const t = scanOf(rows);
    await runScan(t.scan, { mode: "verify", batchSize: 3 });
    expect(t.log.pages).toBe(4); // 3 + 3 + 1 rows, then an empty page ends the scan
  });

  it("stops at the row cap and reports it, so the next run resumes", async () => {
    const t = scanOf(rows);
    const report = await runScan(t.scan, { mode: "verify", batchSize: 2, maxRows: 3 });
    expect(report.counts.scanned).toBe(3);
    expect(report.stoppedBy).toBe("max_rows");
  });

  it("stops cleanly when interrupted, before touching the next row", async () => {
    const t = scanOf(rows);
    let seen = 0;
    const report = await runScan(t.scan, {
      mode: "apply",
      batchSize: 10,
      interrupted: () => seen++ >= 2,
    });
    expect(report.stoppedBy).toBe("interrupted");
    expect(report.counts.scanned).toBe(2);
    expect(t.log.resealed).toEqual(["02"]);
  });

  it("caps the list of problem ids", async () => {
    const many: Row[] = Array.from({ length: 50 }, (_, i) => ({
      id: String(i).padStart(3, "0"),
      klass: "unreadable" as const,
    }));
    const report = await runScan(scanOf(many).scan, { mode: "verify", batchSize: 25 });
    expect(report.counts.unreadable).toBe(50);
    expect(report.problemIds).toHaveLength(20);
  });
});
