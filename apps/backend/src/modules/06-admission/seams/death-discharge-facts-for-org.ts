// apps/backend/src/modules/06-admission/seams/death-discharge-facts-for-org.ts — GAP-089.
//
// An org-explicit, worker-callable read of the facts M30's mortality-review auto-creator needs for ONE
// death discharge, keyed by the `dischargeEventId` the `m6.discharge.death` payload carries. That payload
// names only `{dischargeEventId, admissionId, dischargeDate, source, deathCertifierId?}` — no patient, no
// provider entity, no instant of death — while `mortality_review` requires `deceased_patient_id`,
// `provider_entity_id` and `death_at` (the partition key), all of which live on M6's own
// `discharge_event` / `admission` rows. M30's manifest `dependsOn` excludes 6, so the composition root
// (`apps/backend/src/index.ts`) injects this function into M30's consumer as a PORT (the F-160 shape).
//
// Not a request: opens its own `withOrgContext` envelope (empty acting user, the seam-read convention)
// with an explicit `organization_id` predicate behind RLS. `null` when the discharge is unknown in the
// org (indistinguishable from another tenant's) or is not a death discharge.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const DE = schema.dischargeEvents;
const ADM = schema.admissions;

/** A consumer-driven read names no acting membership (the F-102 convention). */
const SEAM_READER_SYSTEM_USER_ID = "";

export interface DeathDischargeFactsForOrg {
  readonly dischargeEventId: string;
  readonly admissionId: string;
  readonly patientId: string;
  /** Null when the admission was never sited to a provider entity (the caller must not guess one). */
  readonly providerEntityId: string | null;
  /** The instant of death: `discharge_event.death_at`, else midnight UTC of `effective_at` (M6 models no
   *  time of death — the F-105 `deathCalendarDate` convention). */
  readonly deathAt: Date;
  readonly source: "internal_clinician_recorded" | "hl7_external";
}

export function deathDischargeFactsForOrg(
  db: DbClient,
  organizationId: string,
  dischargeEventId: string,
): Promise<DeathDischargeFactsForOrg | null> {
  return withOrgContext(db, { organizationId, userId: SEAM_READER_SYSTEM_USER_ID }, async (tx) => {
    const [row] = await (tx as DbClient)
      .select({
        dischargeEventId: DE.id,
        admissionId: DE.admissionId,
        deathAt: DE.deathAt,
        effectiveAt: DE.effectiveAt,
        source: DE.source,
        patientId: ADM.patientId,
        providerEntityId: ADM.providerEntityId,
      })
      .from(DE)
      .innerJoin(ADM, eq(ADM.id, DE.admissionId))
      .where(
        and(
          eq(DE.organizationId, organizationId),
          eq(DE.id, dischargeEventId),
          eq(DE.dischargeType, "death"),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      dischargeEventId: row.dischargeEventId,
      admissionId: row.admissionId,
      patientId: row.patientId,
      providerEntityId: row.providerEntityId,
      deathAt: row.deathAt ?? new Date(`${row.effectiveAt}T00:00:00.000Z`),
      source: row.source,
    };
  });
}
