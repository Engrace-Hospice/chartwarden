import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_AUTHORIZATION_STATUS_VALUES,
  COMMERCIAL_CLAIM_STATE_VALUES,
  COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH,
  COMMERCIAL_SECONDARY_PAYER_KIND_VALUES,
  COMMERCIAL_SUBMISSION_STATUS_VALUES,
  COMMERCIAL_VALIDATION_OUTCOME_VALUES,
  COMMERCIAL_VALIDATION_SEVERITY_VALUES,
  COMMERCIAL_VALIDATION_TRIGGER_VALUES,
} from "./commercial-claim";

const MIGRATION = readFileSync(
  join(__dirname, "../../db/migrations/1261_m41_commercial_claim.sql"),
  "utf8",
);

/** 1274 widens the claim state sets to the submission lifecycle (the 1261 sets are the original draft / ready / void). */
const SUBMISSION_MIGRATION = readFileSync(
  join(__dirname, "../../db/migrations/1274_m41_commercial_submission.sql"),
  "utf8",
);

/** 1283 widens the claim state sets once more, with the adjudication states (#835): it is the migration the mirror must equal. */
const ADJUDICATION_MIGRATION = readFileSync(
  join(__dirname, "../../db/migrations/1283_m41_commercial_claim_adjudication_state.sql"),
  "utf8",
);

/** The values of `"column" ... IN ('a','b',...)` for each occurrence of the column in the migration, as sorted unique lists. */
function checkLists(column: string, source: string = MIGRATION): string[][] {
  const out: string[][] = [];
  for (const m of source.matchAll(new RegExp(`"${column}"[^\\n]*? IN \\(([^)]*)\\)`, "g"))) {
    out.push([...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort());
  }
  return out;
}

describe("M41 claim code-side mirrors", () => {
  it("mirror the migration CHECK lists exactly", () => {
    const sorted = (xs: readonly string[]) => [...xs].sort();
    for (const list of checkLists("state")) expect(list).toEqual(["draft", "ready", "void"]);
    for (const column of ["state", "from_state", "to_state"]) {
      const lists = checkLists(column, ADJUDICATION_MIGRATION);
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) expect(list).toEqual(sorted(COMMERCIAL_CLAIM_STATE_VALUES));
    }
    expect(checkLists("status", SUBMISSION_MIGRATION)).toContainEqual(
      sorted(COMMERCIAL_SUBMISSION_STATUS_VALUES),
    );
    expect(checkLists("status")).toContainEqual(sorted(COMMERCIAL_AUTHORIZATION_STATUS_VALUES));
    expect(checkLists("secondary_payer_kind")[0]).toEqual(
      sorted(COMMERCIAL_SECONDARY_PAYER_KIND_VALUES),
    );
    expect(checkLists("trigger")[0]).toEqual(sorted(COMMERCIAL_VALIDATION_TRIGGER_VALUES));
    expect(checkLists("severity")[0]).toEqual(sorted(COMMERCIAL_VALIDATION_SEVERITY_VALUES));
    expect(checkLists("outcome")).toContainEqual(sorted(COMMERCIAL_VALIDATION_OUTCOME_VALUES));
  });

  it("keeps the override reason floor equal to the database CHECK", () => {
    expect(MIGRATION).toContain(
      `char_length(btrim("reason")) >= ${COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH}`,
    );
  });
});
