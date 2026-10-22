// The scan loop of the read-only crypto label verifier (scripts/db/crypto-label-backfill/core.ts), without a database: how rows are
// tallied, that nothing is ever written (a Scan has no write method), and the stop conditions.
import { describe, expect, it } from "vitest";
import { type RowClass, type Scan, runScan } from "../../../scripts/db/crypto-label-backfill/core";

interface Row {
  readonly id: string;
  readonly klass: RowClass;
}

function scanOf(rows: readonly Row[]) {
  const log = { pages: 0 };
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
  };
  return { scan, log };
}

const rows: Row[] = [
  { id: "01", klass: "current" },
  { id: "02", klass: "unreadable" },
  { id: "03", klass: "ignore" },
  { id: "04", klass: "current" },
  { id: "05", klass: "unreadable" },
];

describe("runScan (read-only)", () => {
  it("tallies current, unreadable and ignored rows and names the unreadable ones", async () => {
    const report = await runScan(scanOf(rows).scan, { batchSize: 2 });
    expect(report.counts).toEqual({ scanned: 5, current: 2, unreadable: 2, ignored: 1 });
    expect(report.problemIds).toEqual(["02", "05"]);
    expect(report.stoppedBy).toBe("exhausted");
  });

  it("pages with a keyset (each page starts after the last id), not by offset", async () => {
    const t = scanOf(rows);
    await runScan(t.scan, { batchSize: 2 });
    expect(t.log.pages).toBe(4); // 2 + 2 + 1 rows, then an empty page ends the scan
  });

  it("stops at the row cap and reports it, so a capped run is never read as complete", async () => {
    const report = await runScan(scanOf(rows).scan, { batchSize: 2, maxRows: 3 });
    expect(report.counts.scanned).toBe(3);
    expect(report.stoppedBy).toBe("max_rows");
  });

  it("stops cleanly when interrupted, before touching the next row", async () => {
    let seen = 0;
    const report = await runScan(scanOf(rows).scan, {
      batchSize: 10,
      interrupted: () => seen++ >= 2,
    });
    expect(report.stoppedBy).toBe("interrupted");
    expect(report.counts.scanned).toBe(2);
  });

  it("caps the list of problem ids", async () => {
    const many: Row[] = Array.from({ length: 50 }, (_, i) => ({
      id: String(i).padStart(3, "0"),
      klass: "unreadable" as const,
    }));
    const report = await runScan(scanOf(many).scan, { batchSize: 25 });
    expect(report.counts.unreadable).toBe(50);
    expect(report.problemIds).toHaveLength(20);
  });
});
