// apps/backend/src/modules/05-patient/seams/payer-programs-for-patients.ts — GAP-080.
//
// The coverage PROGRAM (medicare / medicaid / other) of a set of patients, for M27's Worksheet S-3 patient-day census
// (which is broken out by program). `patient_payer` is M5's table, so the read lives here and M27 receives it as a
// locally-declared PORT at the composition root. It answers ONE coarse fact per patient — the program of the rank-1
// (primary) payer in force on `asOf` — and nothing else: no subscriber id, no payer name.
//
//   medicare_ffs | medicare_advantage → "medicare"      medicaid → "medicaid"      anything else / no payer → "other"
//
// One query for the whole id set (chunked), never N+1. Not a request: opens its own `withOrgContext` envelope (empty
// acting user) with an explicit `organization_id` predicate behind RLS.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

const PP = schema.patientPayers;

const SEAM_READER_SYSTEM_USER_ID = "";
const ID_CHUNK = 500;

export type PayerProgram = "medicare" | "medicaid" | "other";

/** Pure: the program a coverage kind belongs to. */
export function programOfCoverageKind(kind: string): PayerProgram {
  if (kind === "medicare_ffs" || kind === "medicare_advantage") return "medicare";
  if (kind === "medicaid") return "medicaid";
  return "other";
}

/** `patientId → program` for every id given; a patient with no payer in force on `asOf` reads "other". */
export function payerProgramsForPatientsForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: ReadonlyArray<string>,
  asOf: string,
): Promise<ReadonlyMap<string, PayerProgram>> {
  return withOrgContext(db, { organizationId, userId: SEAM_READER_SYSTEM_USER_ID }, async (tx) => {
    const programs = new Map<string, PayerProgram>(patientIds.map((id) => [id, "other"]));
    const unique = [...new Set(patientIds)];
    for (let i = 0; i < unique.length; i += ID_CHUNK) {
      const chunk = unique.slice(i, i + ID_CHUNK);
      const rows = await (tx as DbClient)
        .select({ patientId: PP.patientId, coverageKind: PP.coverageKind })
        .from(PP)
        .where(
          and(
            eq(PP.organizationId, organizationId),
            inArray(PP.patientId, chunk),
            eq(PP.rank, 1),
            lte(PP.effectiveFrom, asOf),
            or(isNull(PP.effectiveTo), gte(PP.effectiveTo, asOf)),
          ),
        );
      for (const r of rows) programs.set(r.patientId, programOfCoverageKind(r.coverageKind));
    }
    return programs;
  });
}
