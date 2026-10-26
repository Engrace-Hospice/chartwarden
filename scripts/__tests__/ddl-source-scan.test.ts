import { describe, expect, it } from "vitest";
import { findPartitionKeyViolations, stripCommentsForScan } from "../ddl-source-scan";

const BAD_TABLE = `pgTable("t", {}, (t) => ({ u: uniqueIndex("u").on(t.otherCol) }))`;
const PARTITIONED = ".partitionedBy('organization_id')";

describe("ddl-source-scan", () => {
  it("ignores PARTITION BY prose in // comments", () => {
    const src = `// PARTITION BY LIST(organization_id)\n${BAD_TABLE}`;
    expect(findPartitionKeyViolations(src, "x.ts")).toEqual([]);
  });

  it("a block comment containing // does not swallow the DDL after it", () => {
    const src = `/* note: // old */\n${PARTITIONED}\n${BAD_TABLE}`;
    expect(stripCommentsForScan(src, "x.ts")).toContain("partitionedBy");
    expect(findPartitionKeyViolations(src, "x.ts")).toHaveLength(1);
  });

  it("a // inside a string literal is not a comment", () => {
    const src = `const u = "http://x"; ${PARTITIONED}; ${BAD_TABLE}`;
    expect(findPartitionKeyViolations(src, "x.ts")).toHaveLength(1);
  });

  it("still catches real SQL DDL after -- and block comments", () => {
    const sql =
      "-- PARTITION BY RANGE(a)\n/* x -- y */\nCREATE TABLE t (id int, UNIQUE (id)) PARTITION BY LIST (organization_id);";
    expect(findPartitionKeyViolations(sql, "0001_x.sql")).toHaveLength(1);
  });

  it("passes when the unique index includes the partition column", () => {
    const src = `${PARTITIONED}\npgTable("t", {}, (t) => ({ u: uniqueIndex("u").on(t.organization_id, t.id) }))`;
    expect(findPartitionKeyViolations(src, "x.ts")).toEqual([]);
  });
});
