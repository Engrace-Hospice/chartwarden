// M5 admission-clearance seam. M6 receives only the high-level decision; privacy flag details stay in M5.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientAdmissionClearanceReader } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

export function buildPatientAdmissionClearanceReader(
  db: DbClient,
): PatientAdmissionClearanceReader {
  const P = schema.patients;
  const S = schema.patientPrivacyFlagSnapshots;

  return {
    async evaluatePatientAdmissionClearance({ organizationId, patientId }) {
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const [row] = await tx
          .select({
            patientId: P.id,
            flags: S.flags,
            invalidatedAt: S.invalidatedAt,
          })
          .from(P)
          .leftJoin(S, and(eq(S.patientId, P.id), eq(S.organizationId, organizationId)))
          .where(and(eq(P.organizationId, organizationId), eq(P.id, patientId)))
          .limit(1);
        if (!row) return { allowed: false, reason: "PATIENT_NOT_FOUND" };
        const flags = row.invalidatedAt === null ? (row.flags ?? []) : [];
        if (flags.length > 0) {
          return {
            allowed: false,
            reason: "PRIVACY_RESTRICTION",
            overrideAllowed: true,
          };
        }
        return { allowed: true };
      });
    },
  };
}
