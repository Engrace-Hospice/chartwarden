// apps/backend/src/modules/05-patient/care-team-physician-reader.ts — M5's answer to "who is the physician
// member of this patient's IDG right now?" for M6's 42 CFR 418.25(a) / 418.26(b) signer check.
//
// The patient's care team is M5's `patient_assignment`; the IDG physician seat is the OPEN `md` assignment
// (the attending physician is the separate `attending_clinician` role and never qualifies). M6 depends on
// M5, so it imports this owner-side reader instead of touching M5's schema (scripts/check-table-ownership.ts).
// Ids only — no clinical content. Runs under `withOrgContext` so RLS scopes it to the org.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull } from "drizzle-orm";

/** The care-team role that seats a physician on the patient's IDG. */
export const IDG_PHYSICIAN_ASSIGNMENT_ROLE = "md";

/** A read with no acting human (the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

export interface CareTeamPhysicianReader {
  /** User ids holding an open `md` assignment on `patientId` (empty when none / unknown patient). */
  openIdgPhysicianUserIds(organizationId: string, patientId: string): Promise<readonly string[]>;
}

export function buildCareTeamPhysicianReader(db: DbClient): CareTeamPhysicianReader {
  const PA = schema.patientAssignments;
  return {
    async openIdgPhysicianUserIds(organizationId, patientId) {
      const rows = await withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
        tx
          .select({ userId: PA.clinicianUserId })
          .from(PA)
          .where(
            and(
              eq(PA.organizationId, organizationId),
              eq(PA.patientId, patientId),
              eq(PA.role, IDG_PHYSICIAN_ASSIGNMENT_ROLE),
              isNull(PA.unassignedAt),
            ),
          ),
      );
      return [...new Set(rows.map((r) => r.userId))];
    },
  };
}
