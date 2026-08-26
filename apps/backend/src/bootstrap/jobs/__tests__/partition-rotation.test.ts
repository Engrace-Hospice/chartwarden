// Pure-logic tests for the `partition.rotate` job (F-033 / #93). The SQL half is proven in
// `partition-rotation.live.test.ts` against a real database; this half is the severity rule, which is
// where the judgement lives and which needs no database to be worth pinning.
import { describe, expect, it } from "vitest";
import {
  type PartitionCoverageRow,
  type PartitionRotationRow,
  classifyPartitionCoverage,
  summarizeRotation,
} from "../partition-rotation";

const row = (over: Partial<PartitionCoverageRow> = {}): PartitionCoverageRow => ({
  tableName: "visit",
  coveredThrough: "2027-09-01",
  monthsHeadroom: 13,
  defaultOccupied: false,
  hasCreator: true,
  ...over,
});

describe("classifyPartitionCoverage", () => {
  it("is ok when every table has headroom and no DEFAULT is collecting", () => {
    const v = classifyPartitionCoverage([
      row(),
      row({ tableName: "audit_event", monthsHeadroom: 4 }),
    ]);
    expect(v.severity).toBe("ok");
    expect(v.minHeadroomMonths).toBe(4);
    expect(v.summary).toContain("2 partitioned table(s)");
  });

  it("warns — not criticals — when headroom is running out, because the job self-heals that", () => {
    const v = classifyPartitionCoverage([
      row(),
      row({ tableName: "evv_event", monthsHeadroom: 1 }),
    ]);
    expect(v.severity).toBe("warn");
    expect(v.lowHeadroom).toEqual(["evv_event"]);
  });

  it("criticals an occupied DEFAULT even when every table still has headroom", () => {
    // The distinction the ladder exists for: this table is INSIDE its window and still broken. Rows are
    // already in DEFAULT, so `CREATE TABLE … PARTITION OF` for that month now refuses, and no amount of
    // rotation repairs it — it needs rows moved out under an ACCESS EXCLUSIVE lock.
    const v = classifyPartitionCoverage([
      row(),
      row({ tableName: "audit_event", monthsHeadroom: 13, defaultOccupied: true }),
    ]);
    expect(v.severity).toBe("critical");
    expect(v.occupiedDefaults).toEqual(["audit_event"]);
    expect(v.summary).toContain("already writing into DEFAULT");
  });

  it("criticals a time-partitioned table that no creator function can extend", () => {
    const v = classifyPartitionCoverage([row({ tableName: "orphan", hasCreator: false })]);
    expect(v.severity).toBe("critical");
    expect(v.missingCreators).toEqual(["orphan"]);
    expect(v.summary).toContain("no partition creator");
  });

  it("reports both critical causes together rather than only the first", () => {
    const v = classifyPartitionCoverage([
      row({ tableName: "a", defaultOccupied: true }),
      row({ tableName: "b", hasCreator: false }),
    ]);
    expect(v.severity).toBe("critical");
    expect(v.occupiedDefaults).toEqual(["a"]);
    expect(v.missingCreators).toEqual(["b"]);
    expect(v.summary).toContain("DEFAULT");
    expect(v.summary).toContain("creator");
  });

  it("treats an EMPTY read as critical, never as healthy", () => {
    // A probe that measured nothing and reported 'ok' is the exact failure a probe exists to prevent:
    // an unapplied migration or a dropped function would otherwise look identical to a healthy schema.
    const v = classifyPartitionCoverage([]);
    expect(v.severity).toBe("critical");
    expect(v.summary).toContain("measured nothing");
  });

  it("honours a caller-supplied warn threshold", () => {
    const rows = [row({ monthsHeadroom: 3 })];
    expect(classifyPartitionCoverage(rows, 1).severity).toBe("ok");
    expect(classifyPartitionCoverage(rows, 3).severity).toBe("warn");
  });
});

describe("summarizeRotation", () => {
  const r = (tableName: string, status: PartitionRotationRow["status"]): PartitionRotationRow => ({
    tableName,
    status,
    detail: "",
  });

  it("counts created and ok separately, and is healthy when neither failure status appears", () => {
    const s = summarizeRotation([r("a", "created"), r("b", "ok"), r("c", "ok")]);
    expect(s).toMatchObject({ created: 1, ok: 2, blocked: [], noCreator: [], healthy: true });
  });

  it("is unhealthy when any table is blocked or has no creator", () => {
    expect(summarizeRotation([r("a", "ok"), r("b", "blocked")]).healthy).toBe(false);
    expect(summarizeRotation([r("a", "ok"), r("b", "no_creator")]).healthy).toBe(false);
    expect(summarizeRotation([r("a", "blocked")]).blocked).toEqual(["a"]);
    expect(summarizeRotation([r("a", "no_creator")]).noCreator).toEqual(["a"]);
  });

  it("is unhealthy on an empty run — no tables scanned is not a clean run", () => {
    expect(summarizeRotation([]).healthy).toBe(false);
  });
});
