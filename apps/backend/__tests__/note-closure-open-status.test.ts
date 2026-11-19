// ADR-0113 — "an open visit note" has ONE definition (closure/open-status.ts). The partial index `encounter_open_clock_idx` carries the
// same predicate in two places (migration 1514 and the Drizzle schema), and the planner only uses the index for a literal list, so a
// drift between the constant and either copy would silently turn the gate's and the sweep's query into a sequential scan. These tests
// parse both predicates and fail when they disagree with the constant.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPEN_NOTE_STATUSES,
  OPEN_NOTE_STATUS_LIST_SQL,
  isOpenNoteStatus,
} from "../src/modules/08-encounters/closure/open-status";

const MIGRATION = readFileSync(
  join(__dirname, "../../../packages/db/migrations/1514_m8_note_closure_clock.sql"),
  "utf8",
);
const SCHEMA = readFileSync(
  join(__dirname, "../../../packages/db/src/schema/encounter/encounters.ts"),
  "utf8",
);

/** The quoted statuses in the first `status IN (...)` list at or after `marker`. */
function statusesAfter(source: string, marker: string): readonly string[] {
  const from = source.indexOf(marker);
  expect(from, `${marker} must be present`).toBeGreaterThanOrEqual(0);
  const match = /status IN \(([^)]*)\)/.exec(source.slice(from));
  expect(match, `${marker} must be followed by a status IN (...) predicate`).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
}

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();

describe("OPEN_NOTE_STATUSES against the partial index predicate", () => {
  it("equals the status list in migration 1514's CREATE INDEX encounter_open_clock_idx", () => {
    const predicate = statusesAfter(MIGRATION, 'CREATE INDEX "encounter_open_clock_idx"');
    expect(sorted(predicate)).toEqual(sorted(OPEN_NOTE_STATUSES));
  });

  it("equals the status list in the Drizzle schema's openClockIdx", () => {
    const predicate = statusesAfter(SCHEMA, 'index("encounter_open_clock_idx")');
    expect(sorted(predicate)).toEqual(sorted(OPEN_NOTE_STATUSES));
  });
});

describe("the open-status helpers", () => {
  it("OPEN_NOTE_STATUS_LIST_SQL is a literal list of exactly the constant's statuses", () => {
    const rendered = (
      OPEN_NOTE_STATUS_LIST_SQL as unknown as { queryChunks: { value: string[] }[] }
    ).queryChunks
      .flatMap((chunk) => chunk.value)
      .join("");
    expect(rendered).toBe("('draft', 'finalized')");
  });

  it("isOpenNoteStatus is true for draft and finalized only", () => {
    for (const status of ["draft", "finalized"]) expect(isOpenNoteStatus(status)).toBe(true);
    for (const status of ["signed", "cosign_pending", "cosigned", "voided", ""]) {
      expect(isOpenNoteStatus(status)).toBe(false);
    }
  });
});
