// apps/backend/src/modules/06-admission/seams/claim-stay-end-store.ts — M6's org-explicit, admission-keyed read of
// HOW and WHEN each stay ended, for M23's claim list / detail ("needs attention" flags: a missing place of death or
// receiving care setting, a Type of Bill the resolver now derives differently). The same facts
// `claimAssemblyRangeContextForOrg` hands claim assembly, but for MANY admissions at once and with no service-range
// filter (a claim list page spans many admissions; the caller compares each fact with each claim's own window).
//
// Only a COMPLETED discharge_event counts (a voided row never happened; a pending-cosign for-cause filing leaves
// the admission active, D11). A transfer-out is the latest `transfer_event` with direction `out`. A revocation is
// the earliest election period completed by cause `revocation`. Three set-based reads per call, RLS-scoped.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

const DE = schema.dischargeEvents;
const TE = schema.transferEvents;
const EP = schema.electionPeriods;

/** The largest admission batch one call reads (a claim page is far smaller; this bounds `IN (...)`). */
export const CLAIM_STAY_END_BATCH_MAX = 500;

export interface ClaimStayEndFacts {
  readonly admissionId: string;
  /** Completed `discharge_event.effective_at`, `null` when none. */
  readonly dischargeDate: string | null;
  readonly dischargeReason: string | null;
  readonly dischargeEventId: string | null;
  readonly deceasedDate: string | null;
  readonly placeOfDeath: string | null;
  readonly transferOut: {
    readonly transferEventId: string;
    readonly effectiveDate: string;
    readonly receivingCareSetting: string | null;
  } | null;
  /** The earliest revocation (`election_period.actual_end_at` of a period completed by revocation). */
  readonly revocationDate: string | null;
}

const day = (d: Date | string): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

export async function claimStayEndFactsForOrg(
  db: DbClient,
  organizationId: string,
  admissionIds: readonly string[],
): Promise<readonly ClaimStayEndFacts[]> {
  const ids = [...new Set(admissionIds)].slice(0, CLAIM_STAY_END_BATCH_MAX);
  if (ids.length === 0) return [];
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const discharges = await tx
      .select({
        id: DE.id,
        admissionId: DE.admissionId,
        effectiveAt: DE.effectiveAt,
        dischargeType: DE.dischargeType,
        deathAt: DE.deathAt,
        placeOfDeath: DE.placeOfDeath,
      })
      .from(DE)
      .where(
        and(
          eq(DE.organizationId, organizationId),
          inArray(DE.admissionId, ids),
          eq(DE.status, "completed"),
        ),
      );
    const transfers = await tx
      .select({
        id: TE.id,
        admissionId: TE.admissionId,
        effectiveAt: TE.effectiveAt,
        receivingCareSetting: TE.receivingCareSetting,
      })
      .from(TE)
      .where(
        and(
          eq(TE.organizationId, organizationId),
          inArray(TE.admissionId, ids),
          eq(TE.direction, "out"),
        ),
      )
      .orderBy(desc(TE.effectiveAt));
    const revocations = await tx
      .select({ admissionId: EP.admissionId, actualEndAt: EP.actualEndAt })
      .from(EP)
      .where(
        and(
          inArray(EP.admissionId, ids),
          eq(EP.completedByCause, "revocation"),
          isNotNull(EP.actualEndAt),
        ),
      );

    return ids.map((admissionId): ClaimStayEndFacts => {
      const de = discharges.find((r) => r.admissionId === admissionId);
      const te = transfers.find((r) => r.admissionId === admissionId); // latest first
      const revocationDate =
        revocations
          .filter((r) => r.admissionId === admissionId && r.actualEndAt !== null)
          .map((r) => day(r.actualEndAt as Date | string))
          .sort()[0] ?? null;
      return {
        admissionId,
        dischargeDate: de ? day(de.effectiveAt) : null,
        dischargeReason: de ? String(de.dischargeType) : null,
        dischargeEventId: de?.id ?? null,
        deceasedDate: de?.deathAt ? day(de.deathAt) : null,
        placeOfDeath: de?.placeOfDeath ?? null,
        transferOut: te
          ? {
              transferEventId: te.id,
              effectiveDate: day(te.effectiveAt),
              receivingCareSetting: te.receivingCareSetting ?? null,
            }
          : null,
        revocationDate,
      };
    });
  });
}
