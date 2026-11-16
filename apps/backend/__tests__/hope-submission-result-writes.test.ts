import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_RESULTS,
  SETTLED_ITEM_STATUSES,
  isSettledItemStatus,
  nonBlankRecordId,
} from "../src/modules/10-hope/hope-submission-result";
import {
  BULK_CHUNK_ROWS,
  type ItemOutcome,
  type ResultEventRow,
  insertResultEvents,
  stampAssessmentRecordIds,
  writeItemOutcomes,
} from "../src/modules/10-hope/hope-submission-result-writes";
import { renderSql } from "./_hope-g3-fake-db";

// importSubmissionResult's three writes are bulk statements (database review, pre-PR): the submission row lock is held for a
// handful of statements, not one per item, per assessment and per report row. Behaviour against a real Postgres (every row
// lands, nothing else changes) is the live suite's; here, the shape: one statement per chunk, every bind count far below
// Postgres' 65535, and the predicates the review asked for.
const ORG = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-06-10T12:00:00.000Z");
const MAX_BINDS = 65_535;
const uuid = (n: number): string => `90000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** A database that records every `execute` (rendered) and every `insert().values(chunk)`. */
function recordingDb() {
  const executed: { sql: string; params: readonly unknown[] }[] = [];
  const inserted: unknown[][] = [];
  const db = {
    execute: async (statement: unknown) => {
      executed.push(renderSql(statement));
    },
    insert: () => ({
      values: (chunk: unknown[]) => {
        inserted.push(chunk);
        return { onConflictDoNothing: async () => undefined };
      },
    }),
  };
  return { db: db as unknown as DbClient, executed, inserted };
}

const outcome = (n: number): ItemOutcome => ({
  itemId: uuid(n),
  status: "accepted",
  iqiesRecordId: `REC-${n}`,
  result: { assessmentId: uuid(n), status: "accepted" },
});

describe("writeItemOutcomes — one UPDATE per chunk, scoped to the organization, the batch and the unsettled items", () => {
  it("writes a whole report in ceil(rows / chunk) statements, none binding more than a fraction of the limit", async () => {
    const { db, executed } = recordingDb();
    const rows = Array.from({ length: MAX_RETAINED_RESULTS }, (_, i) => outcome(i + 1));

    await writeItemOutcomes(db, ORG, SUBMISSION, rows, NOW);

    expect(executed).toHaveLength(Math.ceil(MAX_RETAINED_RESULTS / BULK_CHUNK_ROWS));
    for (const statement of executed) {
      expect(statement.params.length).toBeLessThan(MAX_BINDS / 10);
    }
  });

  it("carries the explicit organization_id, hope_submission_id and item_status predicates, and the settled list as its values", async () => {
    const { db, executed } = recordingDb();

    await writeItemOutcomes(db, ORG, SUBMISSION, [outcome(1)], NOW);

    const [statement] = executed;
    expect(statement?.sql).toContain('UPDATE "hope_submission_item" AS i');
    expect(statement?.sql).toContain("i.organization_id = ");
    expect(statement?.sql).toContain("i.hope_submission_id = ");
    expect(statement?.sql).toContain("i.item_status NOT IN (");
    expect(statement?.params).toEqual(
      expect.arrayContaining([
        ORG,
        SUBMISSION,
        uuid(1),
        "accepted",
        "REC-1",
        ...SETTLED_ITEM_STATUSES,
      ]),
    );
    // the raw report row is the stored result, as JSON
    expect(statement?.params).toContain(JSON.stringify(outcome(1).result));
  });

  it("is no statement for an import that settles no item", async () => {
    const { db, executed } = recordingDb();

    await writeItemOutcomes(db, ORG, SUBMISSION, [], NOW);

    expect(executed).toEqual([]);
  });
});

describe("stampAssessmentRecordIds — one UPDATE per chunk of assessments, touching only the record id", () => {
  it("scopes to the organization and sets only iqies_record_id and updated_at", async () => {
    const { db, executed } = recordingDb();

    await stampAssessmentRecordIds(db, ORG, new Map([[uuid(7), "REC-7"]]), NOW);

    const [statement] = executed;
    expect(statement?.sql).toContain('UPDATE "hope_assessment" AS a');
    expect(statement?.sql).toContain("a.organization_id = ");
    expect(statement?.sql).toMatch(/SET iqies_record_id = v\.iqies_record_id,\s+updated_at = /);
    expect(statement?.sql).not.toMatch(/status|data|version/i);
    expect(statement?.params).toEqual(expect.arrayContaining([ORG, uuid(7), "REC-7"]));
  });

  it("chunks a large stamp list and is no statement when nothing is stamped", async () => {
    const { db, executed } = recordingDb();
    const stamps = new Map(
      Array.from({ length: BULK_CHUNK_ROWS + 1 }, (_, i) => [uuid(i + 1), `R${i}`]),
    );

    await stampAssessmentRecordIds(db, ORG, stamps, NOW);
    await stampAssessmentRecordIds(db, ORG, new Map(), NOW);

    expect(executed).toHaveLength(2);
  });
});

describe("insertResultEvents — one multi-row INSERT per chunk", () => {
  const row = (n: number): ResultEventRow => ({
    organizationId: ORG,
    hopeSubmissionId: SUBMISSION,
    hopeSubmissionItemId: uuid(n),
    reportHash: "h".repeat(64),
    reportReference: "FVR-1",
    resultScope: "record",
    resultStatus: "accepted",
    cmsSeverity: null,
    cmsEditCode: null,
    itemCode: null,
    message: null,
    rawResult: { n },
    processedAt: NOW,
  });

  it("writes every row, in order, 500 at a time: four statements for a full 2000-row report", async () => {
    const { db, inserted } = recordingDb();
    const rows = Array.from({ length: MAX_RETAINED_RESULTS }, (_, i) => row(i + 1));

    await insertResultEvents(db, rows);

    expect(inserted.map((chunk) => chunk.length)).toEqual([500, 500, 500, 500]);
    expect(inserted.flat()).toEqual(rows);
    // 13 bound values per row: even a full chunk binds a tenth of the limit
    expect(BULK_CHUNK_ROWS * 13).toBeLessThan(MAX_BINDS / 5);
  });
});

describe("a blank iQIES record id is none", () => {
  it.each([
    ["an empty string", ""],
    ["spaces", "   "],
    ["a tab and a newline", "\t\n"],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
  ])("%s names no record id", (_label, value) => {
    expect(nonBlankRecordId(value)).toBeNull();
  });

  it("returns an id as the report wrote it (not trimmed)", () => {
    expect(nonBlankRecordId("IQ-123")).toBe("IQ-123");
    expect(nonBlankRecordId(" IQ-123 ")).toBe(" IQ-123 ");
  });

  it("the settled item statuses are the three CMS verdicts, and only those", () => {
    expect([...SETTLED_ITEM_STATUSES]).toEqual(["accepted", "accepted_with_warnings", "rejected"]);
    expect(isSettledItemStatus("pending")).toBe(false);
    expect(isSettledItemStatus("cancelled")).toBe(false);
    for (const status of SETTLED_ITEM_STATUSES) expect(isSettledItemStatus(status)).toBe(true);
  });
});
