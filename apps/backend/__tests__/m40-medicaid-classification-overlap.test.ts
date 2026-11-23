// The M40 DB store hands M24 only the Medicaid payer classifications that overlap the service window (inclusive
// ends, a null end is open), exactly as the in-memory store does; M24 still re-filters in
// qualifyMedicaidProgramClassification. The SQL's shape is asserted here; execution is covered by the live suites.
import type { DbClient } from "@chartwarden/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { createDbMdmStore } from "../src/modules/40-mdm/mdm-store-db";

const PAYER = "d1000000-0000-4000-8000-000000000001";

function storeCapturingWhere(rows: readonly unknown[] = []) {
  const captured: { where?: SQL } = {};
  const db = {
    select: () => ({
      from: () => ({
        where: async (condition: SQL) => {
          captured.where = condition;
          return rows;
        },
      }),
    }),
  } as unknown as DbClient;
  return { store: createDbMdmStore(db), captured };
}

describe("createDbMdmStore.medicaidPayerProgramClassifications", () => {
  it("filters by payer, state and overlap with the service window in SQL", async () => {
    const { store, captured } = storeCapturingWhere();
    await store.medicaidPayerProgramClassifications(PAYER, "OR", "2026-02-01", "2026-02-28");
    const { sql, params } = new PgDialect().sqlToQuery(captured.where!);
    expect(sql).toMatch(/"canonical_payer_id" = \$1/);
    expect(sql).toMatch(/"state_code" = \$2/);
    expect(sql).toMatch(/"effective_from" <= \$3/);
    expect(sql).toMatch(/"effective_to" is null or .*"effective_to" >= \$4/);
    expect(params).toEqual([PAYER, "OR", "2026-02-28", "2026-02-01"]);
  });

  it("maps the rows it returns", async () => {
    const { store } = storeCapturingWhere([
      {
        id: "d2000000-0000-4000-8000-000000000001",
        canonicalPayerId: PAYER,
        stateCode: "OR",
        classification: "oregon_ffs",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        verificationStatus: "verified",
        sourceKind: "state_registry",
        sourceReference: "registry:synthetic-source",
        supersedesId: null,
      },
    ]);
    await expect(
      store.medicaidPayerProgramClassifications(PAYER, "OR", "2026-02-01", "2026-02-28"),
    ).resolves.toMatchObject([{ classification: "oregon_ffs", verificationStatus: "verified" }]);
  });
});
