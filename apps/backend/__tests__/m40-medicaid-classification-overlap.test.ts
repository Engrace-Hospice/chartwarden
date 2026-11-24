// The M40 stores hand M24 EVERY classification row for the (payer, state) and M24's
// qualifyMedicaidProgramClassification decides which ones speak for the service window. The table is append-only, so
// the only way to end-date a classification is a superseding row, and that superseder can start before the claim
// window while the row it supersedes is still open. A period predicate in the store drops the superseder, the
// superseded row then looks current and an end-dated classification qualifies (fail-open). These tests run the REAL
// qualify function over each store's output; the Drizzle-shaped fake applies whatever predicates the store put in its
// where clause, so a re-introduced period filter turns them red.
import type { DbClient } from "@chartwarden/db";
import {
  type MdmStore,
  type MedicaidPayerProgramClassification,
  createInMemoryMdmStore,
} from "@chartwarden/mdm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { qualifyMedicaidProgramClassification } from "../src/modules/24-billing-medicaid/medicaid-payer-classification";
import { createDbMdmStore } from "../src/modules/40-mdm/mdm-store-db";

const PAYER = "d1000000-0000-4000-8000-000000000001";
const OTHER_PAYER = "d1000000-0000-4000-8000-000000000002";

function row(
  overrides: Partial<MedicaidPayerProgramClassification> & { id: string },
): MedicaidPayerProgramClassification {
  return {
    canonicalPayerId: PAYER,
    stateCode: "OR",
    classification: "oregon_ffs",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    verificationStatus: "verified",
    sourceKind: "state_registry",
    sourceReference: "registry:synthetic-source",
    supersedesId: null,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verifiedBy: "synthetic-reviewer",
    recordedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** What Postgres would return for the recorded where clause: payer + state, plus the overlap predicate only if present. */
function executeWhere(
  rows: readonly MedicaidPayerProgramClassification[],
  where: SQL,
): readonly MedicaidPayerProgramClassification[] {
  const { sql, params } = new PgDialect().sqlToQuery(where);
  const [payer, state, ...rest] = params as string[];
  const overlap = /"effective_from" <=/.test(sql);
  const [serviceTo, serviceFrom] = rest;
  return rows.filter(
    (r) =>
      r.canonicalPayerId === payer &&
      r.stateCode === state &&
      (!overlap ||
        (r.effectiveFrom <= serviceTo! &&
          (r.effectiveTo === null || r.effectiveTo >= serviceFrom!))),
  );
}

function dbStore(rows: readonly MedicaidPayerProgramClassification[]) {
  const captured: { where?: SQL } = {};
  const db = {
    select: () => ({
      from: () => ({
        where: async (condition: SQL) => {
          captured.where = condition;
          return executeWhere(rows, condition);
        },
      }),
    }),
  } as unknown as DbClient;
  return { store: createDbMdmStore(db), captured };
}

function memoryStore(rows: readonly MedicaidPayerProgramClassification[]): MdmStore {
  return createInMemoryMdmStore({ medicaidPayerProgramClassifications: rows }).store;
}

const STORES: readonly {
  readonly name: string;
  readonly build: (rows: readonly MedicaidPayerProgramClassification[]) => MdmStore;
}[] = [
  { name: "database store", build: (rows) => dbStore(rows).store },
  { name: "in-memory store", build: memoryStore },
];

async function decide(
  store: MdmStore,
  requestedKind: string,
  serviceFrom: string,
  serviceTo: string,
) {
  const rows = await store.medicaidPayerProgramClassifications(PAYER, "OR", serviceFrom, serviceTo);
  return qualifyMedicaidProgramClassification(
    rows,
    requestedKind,
    PAYER,
    "OR",
    serviceFrom,
    serviceTo,
  );
}

// X is open since January; X2 end-dates it on 2026-03-31 by superseding it.
const X = row({ id: "d2000000-0000-4000-8000-0000000000a1" });
const X2 = row({
  id: "d2000000-0000-4000-8000-0000000000a2",
  effectiveTo: "2026-03-31",
  supersedesId: X.id,
});
const Y_CCO = row({
  id: "d2000000-0000-4000-8000-0000000000b1",
  classification: "medicaid_cco",
  effectiveFrom: "2026-04-01",
});

describe.each(STORES)("$name feeding qualifyMedicaidProgramClassification", ({ build }) => {
  it("does not qualify a classification that a superseding row end-dated before the window", async () => {
    const decision = await decide(build([X, X2]), "ffs_open_card", "2026-05-01", "2026-05-31");
    expect(decision).toEqual({
      qualified: false,
      reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_EXPIRED",
    });
  });

  it("qualifies the successor program, not the open row the superseder end-dated", async () => {
    const rows = [X, X2, Y_CCO];
    await expect(decide(build(rows), "managed_care", "2026-07-01", "2026-07-31")).resolves.toEqual({
      qualified: true,
      classification: Y_CCO,
    });
    await expect(decide(build(rows), "ffs_open_card", "2026-07-01", "2026-07-31")).resolves.toEqual(
      {
        qualified: false,
        reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_MISMATCH",
      },
    );
  });

  it("still qualifies a window the superseder covers and nothing later contradicts", async () => {
    const decision = await decide(build([X, X2]), "ffs_open_card", "2026-02-01", "2026-02-28");
    expect(decision).toEqual({ qualified: true, classification: X2 });
  });

  it("calls a window straddling a contradicting verified row ambiguous", async () => {
    const decision = await decide(build([X, Y_CCO]), "ffs_open_card", "2026-03-15", "2026-04-15");
    expect(decision).toEqual({
      qualified: false,
      reasonCode: "MEDICAID_PROGRAM_CLASSIFICATION_AMBIGUOUS",
    });
  });

  it("returns nothing for another payer or state", async () => {
    const store = build([
      row({ id: "d2000000-0000-4000-8000-0000000000c1", canonicalPayerId: OTHER_PAYER }),
      row({ id: "d2000000-0000-4000-8000-0000000000c2", stateCode: "WA" }),
    ]);
    await expect(
      store.medicaidPayerProgramClassifications(PAYER, "OR", "2026-02-01", "2026-02-28"),
    ).resolves.toEqual([]);
  });
});

describe("the two stores agree", () => {
  it("return the same rows for the same payer and state whatever the window", async () => {
    const rows = [
      X,
      X2,
      Y_CCO,
      row({ id: "d2000000-0000-4000-8000-0000000000c1", canonicalPayerId: OTHER_PAYER }),
    ];
    for (const [from, to] of [
      ["2026-02-01", "2026-02-28"],
      ["2026-05-01", "2026-05-31"],
      ["2027-01-01", "2027-01-31"],
    ] as const) {
      const fromDb = await dbStore(rows).store.medicaidPayerProgramClassifications(
        PAYER,
        "OR",
        from,
        to,
      );
      const fromMemory = await memoryStore(rows).medicaidPayerProgramClassifications(
        PAYER,
        "OR",
        from,
        to,
      );
      expect(fromDb).toEqual(fromMemory);
      expect(fromDb.map((r) => r.id)).toEqual([X.id, X2.id, Y_CCO.id]);
    }
  });
});

describe("createDbMdmStore.medicaidPayerProgramClassifications where clause", () => {
  it("filters by payer and state only: no period predicate, so superseders outside the window still arrive", async () => {
    const { store, captured } = dbStore([]);
    await store.medicaidPayerProgramClassifications(PAYER, "OR", "2026-05-01", "2026-05-31");
    const { sql, params } = new PgDialect().sqlToQuery(captured.where!);
    expect(sql).toMatch(/"canonical_payer_id" = \$1/);
    expect(sql).toMatch(/"state_code" = \$2/);
    expect(sql).not.toMatch(/effective_from|effective_to/);
    expect(params).toEqual([PAYER, "OR"]);
  });

  it("maps the rows it returns", async () => {
    const { store } = dbStore([X]);
    await expect(
      store.medicaidPayerProgramClassifications(PAYER, "OR", "2026-02-01", "2026-02-28"),
    ).resolves.toMatchObject([{ classification: "oregon_ffs", verificationStatus: "verified" }]);
  });
});
