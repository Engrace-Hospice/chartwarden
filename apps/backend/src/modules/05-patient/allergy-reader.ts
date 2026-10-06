// apps/backend/src/modules/05-patient/allergy-reader.ts — M5 `PatientAllergyReader` seam impl (GAP-036).
//
// The patient's CURRENT allergy list, read by M12's `requestSignature` allergy gate. A seam, not a shared
// import, so M12 gains no schema edge into M5 (ADR-0005). Every row that is not `entered_in_error` crosses —
// `unverified` rows included (a DocLens referral line is shown to prescribers, labelled; hiding it is the
// unsafe failure). Only the allergen text, verification status and severity cross: no reaction narrative,
// provenance or reporter ids.
//
// Fail-closed shape: a patient that is not readable under the caller's org (unknown / cross-tenant) yields
// `null`, NOT `[]` — "cannot check" must not read as "no allergies". Reads run under `withOrgContext`, so RLS
// scopes them; the explicit `organization_id` predicate is the belt behind it.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientAllergyEntry, PatientAllergyReader } from "@wardenx/types";
import { and, eq, ne } from "drizzle-orm";

/** The empty-acting-user sentinel the other seam readers use (the M4 audit trigger maps "" to NULL). */
const ALLERGY_READER_SYSTEM_USER_ID = "";

/** Pure projection of one `patient_allergy` row (unit-testable without a DB). */
export function toPatientAllergyEntry(row: {
  readonly allergenText: string;
  readonly verificationStatus: "unverified" | "verified" | "entered_in_error";
  readonly severity: PatientAllergyEntry["severity"];
}): PatientAllergyEntry | null {
  if (row.verificationStatus === "entered_in_error") return null;
  return {
    allergenText: row.allergenText,
    verificationStatus: row.verificationStatus,
    severity: row.severity ?? null,
  };
}

export function buildPatientAllergyReader(db: DbClient): PatientAllergyReader {
  const P = schema.patients;
  const A = schema.patientAllergies;
  return {
    async activeAllergies({ organizationId, patientId }) {
      return withOrgContext(
        db,
        { organizationId, userId: ALLERGY_READER_SYSTEM_USER_ID },
        async (tx) => {
          const handle = tx as unknown as DbClient;
          const [patient] = await handle
            .select({ id: P.id })
            .from(P)
            .where(and(eq(P.organizationId, organizationId), eq(P.id, patientId)))
            .limit(1);
          if (!patient) return null;
          const rows = await handle
            .select({
              allergenText: A.allergenText,
              verificationStatus: A.verificationStatus,
              severity: A.severity,
            })
            .from(A)
            .where(
              and(
                eq(A.organizationId, organizationId),
                eq(A.patientId, patientId),
                ne(A.verificationStatus, "entered_in_error"),
              ),
            );
          return rows.flatMap((r) => {
            const entry = toPatientAllergyEntry(r);
            return entry ? [entry] : [];
          });
        },
      );
    },
  };
}
