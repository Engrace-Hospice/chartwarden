// apps/backend/src/modules/06-admission/seams/cahps-death-candidates-for-org.ts — GAP-087.
//
// The org-explicit, worker-callable census M30's monthly CAHPS sample classifies: every DEATH discharge whose
// date of death falls in `[from, to)`, with the stay facts the CMS exclusion rules need (admission start for the
// <48h-stay rule, the provider entity the sample row is stamped with, and where the death record came from).
// `DeathDischargeReader.listDeathDischargesInPeriod` names only patient / admission / death instant / source — no
// provider entity and no admission start — so this lives beside it in M6's own directory (the
// `deathDischargeFactsForOrg` shape) and is injected into M30 as a locally-declared PORT at the composition root;
// M30's manifest `dependsOn` excludes 6.
//
// Not a request: opens its own `withOrgContext` envelope (empty acting user, the seam-read convention) with an
// explicit `organization_id` predicate behind RLS, so a cross-tenant id is simply absent.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNotNull, sql } from "drizzle-orm";

const DE = schema.dischargeEvents;
const ADM = schema.admissions;

/** A consumer-driven read names no acting membership (the F-102 convention). */
const SEAM_READER_SYSTEM_USER_ID = "";

export interface CahpsDeathCandidateFacts {
  readonly patientId: string;
  readonly admissionId: string;
  /** Null when the admission was never sited to a provider entity (the caller must not guess one). */
  readonly providerEntityId: string | null;
  /** The instant the hospice stay began (`admission.admission_at`, else `activated_at`). */
  readonly admissionStartAt: Date;
  /** The instant of death: `discharge_event.death_at`, else midnight UTC of `effective_at`. */
  readonly deathAt: Date;
  readonly source: "internal_clinician_recorded" | "hl7_external";
}

/**
 * Deaths in `[period.from, period.to)` (ISO calendar dates; `to` exclusive), oldest first. A death whose
 * admission has neither `admission_at` nor `activated_at` is omitted: its stay length cannot be established,
 * and the sampler must not classify on a guess.
 */
export function cahpsDeathCandidatesForOrg(
  db: DbClient,
  organizationId: string,
  period: { readonly from: string; readonly to: string },
): Promise<ReadonlyArray<CahpsDeathCandidateFacts>> {
  return withOrgContext(db, { organizationId, userId: SEAM_READER_SYSTEM_USER_ID }, async (tx) => {
    const deathInstant = sql`coalesce(${DE.deathAt}, (${DE.effectiveAt}::timestamp AT TIME ZONE 'UTC'))`;
    const rows = await (tx as DbClient)
      .select({
        patientId: ADM.patientId,
        admissionId: DE.admissionId,
        providerEntityId: ADM.providerEntityId,
        admissionAt: ADM.admissionAt,
        activatedAt: ADM.activatedAt,
        deathAt: DE.deathAt,
        effectiveAt: DE.effectiveAt,
        source: DE.source,
      })
      .from(DE)
      .innerJoin(ADM, eq(ADM.id, DE.admissionId))
      .where(
        and(
          eq(DE.organizationId, organizationId),
          eq(DE.dischargeType, "death"),
          sql`${deathInstant} >= ${`${period.from}T00:00:00.000Z`}::timestamptz`,
          sql`${deathInstant} < ${`${period.to}T00:00:00.000Z`}::timestamptz`,
          // keep the planner honest about the NOT NULL join key
          isNotNull(DE.admissionId),
        ),
      )
      .orderBy(deathInstant);
    const out: CahpsDeathCandidateFacts[] = [];
    for (const r of rows) {
      const start = r.admissionAt ?? r.activatedAt;
      if (!start) continue;
      out.push({
        patientId: r.patientId,
        admissionId: r.admissionId,
        providerEntityId: r.providerEntityId,
        admissionStartAt: start,
        deathAt: r.deathAt ?? new Date(`${r.effectiveAt}T00:00:00.000Z`),
        source: r.source,
      });
    }
    return out;
  });
}
