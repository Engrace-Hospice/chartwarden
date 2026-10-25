import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_AUTHORIZATION_STATUS_VALUES,
  COMMERCIAL_CLAIM_STATE_VALUES,
  COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH,
  COMMERCIAL_SECONDARY_PAYER_KIND_VALUES,
  COMMERCIAL_VALIDATION_OUTCOME_VALUES,
  COMMERCIAL_VALIDATION_SEVERITY_VALUES,
  COMMERCIAL_VALIDATION_TRIGGER_VALUES,
} from "./commercial-claim";

const MIGRATION = readFileSync(
  join(__dirname, "../../db/migrations/1261_m41_commercial_claim.sql"),
  "utf8",
);

/** The values of `"column" ... IN ('a','b',...)` for each occurrence of the column in the migration, as sorted unique lists. */
function checkLists(column: string): string[][] {
  const out: string[][] = [];
  for (const m of MIGRATION.matchAll(new RegExp(`"${column}"[^\\n]*? IN \\(([^)]*)\\)`, "g"))) {
    out.push([...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort());
  }
  return out;
}

describe("M41 claim code-side mirrors", () => {
  it("mirror the migration CHECK lists exactly", () => {
    const sorted = (xs: readonly string[]) => [...xs].sort();
    for (const list of checkLists("state"))
      expect(list).toEqual(sorted(COMMERCIAL_CLAIM_STATE_VALUES));
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
