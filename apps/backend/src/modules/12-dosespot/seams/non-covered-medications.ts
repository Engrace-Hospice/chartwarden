// apps/backend/src/modules/12-dosespot/seams/non-covered-medications.ts — COP27 workstream B (42 CFR 418.24(c)).
//
// The M12-owned answer to "which drugs did the hospice determine are NOT covered for this admission?" — the
// drug rows of the "Patient Notification of Hospice Non-Covered Items, Services, and Drugs" addendum M6
// composes. Registered as the `NonCoveredMedicationsReader` seam (`registerDoseSpotSeams`) so M6 reads it
// without importing M12's schema (architecture §25.15).
//
// ORG-EXPLICIT: the caller passes the org and the read runs under `withOrgContext`, so it is correct from a
// relay tick / worker (no ambient request context) and RLS still scopes every row by `app.org_id`.
//
// "Active" = every status except the ones where the drug is no longer part of the plan of care: `draft`
// (not yet an order), `completed`, `discontinued`, `expired_unsigned`. A `transmission_failed` order is still
// the clinician's intended therapy, so it stays listed.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { NonCoveredItemSnapshot, NonCoveredItemsReader } from "@wardenx/types";
import { and, asc, eq, ne, notInArray } from "drizzle-orm";

const MO = schema.medicationOrders;

/** The statuses whose orders are no longer (or not yet) part of the patient's plan of care. */
export const NON_COVERED_EXCLUDED_MEDICATION_STATUSES = [
  "draft",
  "completed",
  "discontinued",
  "expired_unsigned",
] as const;

type NonCoveredMedicationRow = {
  readonly id: string;
  readonly drugName: string;
  readonly strength: string;
  readonly doseForm: string;
  readonly route: string;
  readonly coverageReason: string | null;
  readonly coverageDeterminedAt: Date | null;
  readonly coverageDeterminedByMembershipId: string | null;
  readonly updatedAt: Date;
};

/** Pure projection of one not-covered medication row to the addendum snapshot. */
export function medicationSnapshotOf(row: NonCoveredMedicationRow): NonCoveredItemSnapshot {
  const description = [row.drugName, row.strength, row.doseForm, row.route]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    source: "medication",
    sourceId: row.id,
    category: "drug",
    description,
    // The CHECK guarantees a non-blank reason + instant on every not-covered row; the fallbacks only keep
    // the type total.
    reason: row.coverageReason ?? "",
    determinedAt: (row.coverageDeterminedAt ?? row.updatedAt).toISOString(),
    determinedByUserId: row.coverageDeterminedByMembershipId,
  };
}

/** Every active medication order on `admissionId` determined NOT hospice-covered, oldest first. */
export async function listNonCoveredMedicationsForAdmission(
  db: DbClient,
  organizationId: string,
  admissionId: string,
): Promise<NonCoveredItemSnapshot[]> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const rows = await (tx as unknown as DbClient)
      .select({
        id: MO.id,
        drugName: MO.drugName,
        strength: MO.strength,
        doseForm: MO.doseForm,
        route: MO.route,
        coverageReason: MO.coverageReason,
        coverageDeterminedAt: MO.coverageDeterminedAt,
        coverageDeterminedByMembershipId: MO.coverageDeterminedByMembershipId,
        updatedAt: MO.updatedAt,
      })
      .from(MO)
      .where(
        and(
          eq(MO.organizationId, organizationId),
          eq(MO.admissionId, admissionId),
          ne(MO.hospiceCoverage, "covered_related"),
          notInArray(MO.status, [...NON_COVERED_EXCLUDED_MEDICATION_STATUSES]),
        ),
      )
      .orderBy(asc(MO.coverageDeterminedAt), asc(MO.id));
    return rows.map(medicationSnapshotOf);
  });
}

/** The `NonCoveredMedicationsReader` seam implementation over the production DB client. */
export function createNonCoveredMedicationsReader(db: DbClient): NonCoveredItemsReader {
  return {
    listForAdmission: (orgId, admissionId) =>
      listNonCoveredMedicationsForAdmission(db, orgId, admissionId),
  };
}
