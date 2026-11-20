// apps/backend/src/modules/06-admission/seams/admission-loc-periods-reader.ts — M6's read of one admission's
// level-of-care periods, for M24's per-LOC-period claim-line walk (the composition root binds it onto M24's
// `LevelOfCarePeriodReaderPort`, so neither module imports the other).
//
// The read used to live inline in `apps/backend/src/index.ts` as a bare `db.select` with no org context.
// `level_of_care_period` is RLS-scoped on `app.org_id`, and M24's `assembleClaim` calls this OUTSIDE its own
// org-context transaction, so the unset GUC made the policy's `::uuid` cast fail and every Medicaid claim
// assembly 500'd. Like `level-of-care-period-reader.ts`, each call opens its own `withOrgContext`.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, ne } from "drizzle-orm";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";
import { claimStayEndFactsForAdmissionInTransaction } from "./claim-stay-end-store";

const LOC = schema.levelOfCarePeriods;
const ADM = schema.admissions;

/** Same empty-acting-user sentinel `level-of-care-period-reader.ts` uses for a system read. */
const SYSTEM_USER_ID = "";

export interface AdmissionLocPeriod {
  readonly id: string;
  readonly levelOfCare: (typeof LOC.$inferSelect)["levelOfCare"];
  readonly effectiveAt: Date;
  readonly endedAt: Date | null;
  readonly facilityId: string | null;
  readonly ipuBedAssignmentId: string | null;
}

export interface AdmissionLocPeriodsReader {
  periodsForAdmission(organizationId: string, admissionId: string): Promise<AdmissionLocPeriod[]>;
  /** Read-only admission identity and stay-end facts for advisory previews; does not lock the admission. */
  previewSnapshotInTransaction(
    transaction: unknown,
    organizationId: string,
    admissionId: string,
  ): Promise<{
    patientId: string;
    providerEntityId: string | null;
    dischargedAt: Date | null;
    status: (typeof ADM.$inferSelect)["status"];
    stayEndFacts: {
      dischargeDate: string | null;
      dischargeReason: string | null;
      deceasedDate: string | null;
      pendingDischargeDates: readonly string[];
      transferOut: { effectiveDate: string } | null;
      revocationDate: string | null;
    };
  } | null>;
  /**
   * Lock the M6 admission row on the caller's transaction. M24 uses this as the serialization point for
   * discharge state, original-claim cadence and the LOC snapshot. M6 LOC writers lock the same row before
   * changing periods, so concurrent clinical updates cannot invalidate an R&B assembly snapshot.
   */
  cadenceSnapshotInTransaction(
    transaction: unknown,
    organizationId: string,
    admissionId: string,
  ): Promise<{
    patientId: string;
    providerEntityId: string | null;
    dischargedAt: Date | null;
    status: (typeof ADM.$inferSelect)["status"];
    stayEndFacts: {
      dischargeDate: string | null;
      dischargeReason: string | null;
      deceasedDate: string | null;
      pendingDischargeDates: readonly string[];
      transferOut: { effectiveDate: string } | null;
      revocationDate: string | null;
    };
  } | null>;
  /** Read the current LOC evidence on the same transaction after cadenceSnapshotInTransaction locks M6. */
  periodsForAdmissionInTransaction(
    transaction: unknown,
    organizationId: string,
    admissionId: string,
  ): Promise<AdmissionLocPeriod[]>;
}

/**
 * An admission's level-of-care periods in effective order. Excludes `status='assigning'`
 * (confirm-handshake fix, 2026-08-05): an IRC/GIP period awaiting M37 bed confirmation is not yet a real
 * period of care and must never generate a billable claim line.
 */
export function createAdmissionLocPeriodsReader(db: DbClient): AdmissionLocPeriodsReader {
  return {
    async previewSnapshotInTransaction(transaction, organizationId, admissionId) {
      const tx = transaction as DbClient;
      await assertTxScopedToOrg(tx, organizationId);
      const rows = await tx
        .select({
          patientId: ADM.patientId,
          providerEntityId: ADM.providerEntityId,
          dischargedAt: ADM.dischargedAt,
          status: ADM.status,
        })
        .from(ADM)
        .where(and(eq(ADM.organizationId, organizationId), eq(ADM.id, admissionId)))
        .limit(1);
      const admission = rows[0];
      if (!admission) return null;
      const stayEndFacts = await claimStayEndFactsForAdmissionInTransaction(
        tx,
        organizationId,
        admissionId,
      );
      if (!stayEndFacts) return null;
      return {
        ...admission,
        stayEndFacts: {
          dischargeDate: stayEndFacts.dischargeDate,
          dischargeReason: stayEndFacts.dischargeReason,
          deceasedDate: stayEndFacts.deceasedDate,
          pendingDischargeDates: stayEndFacts.pendingDischargeDates,
          transferOut: stayEndFacts.transferOut
            ? { effectiveDate: stayEndFacts.transferOut.effectiveDate }
            : null,
          revocationDate: stayEndFacts.revocationDate,
        },
      };
    },
    async cadenceSnapshotInTransaction(transaction, organizationId, admissionId) {
      const tx = transaction as DbClient;
      await assertTxScopedToOrg(tx, organizationId);
      const rows = await tx
        .select({
          patientId: ADM.patientId,
          providerEntityId: ADM.providerEntityId,
          dischargedAt: ADM.dischargedAt,
          status: ADM.status,
        })
        .from(ADM)
        .where(and(eq(ADM.organizationId, organizationId), eq(ADM.id, admissionId)))
        .limit(1)
        .for("update");
      const admission = rows[0];
      if (!admission) return null;
      const stayEndFacts = await claimStayEndFactsForAdmissionInTransaction(
        tx,
        organizationId,
        admissionId,
      );
      return {
        ...admission,
        stayEndFacts: {
          dischargeDate: stayEndFacts?.dischargeDate ?? null,
          dischargeReason: stayEndFacts?.dischargeReason ?? null,
          deceasedDate: stayEndFacts?.deceasedDate ?? null,
          pendingDischargeDates: stayEndFacts?.pendingDischargeDates ?? [],
          transferOut: stayEndFacts?.transferOut
            ? { effectiveDate: stayEndFacts.transferOut.effectiveDate }
            : null,
          revocationDate: stayEndFacts?.revocationDate ?? null,
        },
      };
    },
    async periodsForAdmissionInTransaction(transaction, organizationId, admissionId) {
      const tx = transaction as DbClient;
      await assertTxScopedToOrg(tx, organizationId);
      return tx
        .select({
          id: LOC.id,
          levelOfCare: LOC.levelOfCare,
          effectiveAt: LOC.effectiveAt,
          endedAt: LOC.endedAt,
          facilityId: LOC.facilityId,
          ipuBedAssignmentId: LOC.ipuBedAssignmentId,
        })
        .from(LOC)
        .where(
          and(
            eq(LOC.organizationId, organizationId),
            eq(LOC.admissionId, admissionId),
            ne(LOC.status, "assigning"),
          ),
        )
        .orderBy(LOC.effectiveAt);
    },
    periodsForAdmission(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
        (tx as unknown as DbClient)
          .select({
            id: LOC.id,
            levelOfCare: LOC.levelOfCare,
            effectiveAt: LOC.effectiveAt,
            endedAt: LOC.endedAt,
            facilityId: LOC.facilityId,
            ipuBedAssignmentId: LOC.ipuBedAssignmentId,
          })
          .from(LOC)
          .where(
            and(
              eq(LOC.organizationId, organizationId),
              eq(LOC.admissionId, admissionId),
              ne(LOC.status, "assigning"),
            ),
          )
          .orderBy(LOC.effectiveAt),
      );
    },
  };
}
