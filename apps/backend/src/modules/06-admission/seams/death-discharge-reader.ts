// apps/backend/src/modules/06-admission/seams/death-discharge-reader.ts — the DEDICATED Drizzle reader
// backing M6's §4.11 `DeathDischargeReader` seam. M6's six §4.7 reader seams run on the in-memory
// `AdmissionReaderStore` (admission/period keyed); this is a SEPARATE org-scoped census port the M30
// `m30.measure_recompute` worker consumes to compute the HVLDL measure denominator (all decedents in a
// reporting period) WITHOUT importing M6's schema (architecture §11 blocks the cross-module schema import).
//
// M6 owns the death fact: `discharge_event.dischargeType='death'` joined to `admission` for the patient id
// (the discharge row carries no direct patient identifier — tenancy rides the admission FK). Aggregate-but-
// patient-linked WITHIN one org — M30 computes its OWN org's measure, so nothing crosses a tenant boundary.
//
// Per HARD RULE 3 each call opens its OWN per-org `withOrgContext` envelope so the per-request org GUC is set
// for RLS on THIS connection — the M30 worker's envelope is on a DIFFERENT (M30) connection and does not reach
// here. The query ALSO pins a belt-and-suspenders `organization_id = $org` predicate on top of the RLS
// envelope (the org param is the authoritative scope; RLS is the second wall).
//
// F-227 (#248) — `discharge_event` now models the HL7-external intake (migration 0300: `source`,
// `source_proposal_id`, `cosign_required`, `cosigned_at`, `medical_director_membership_id`), so the reader
// projects REAL provenance: `source='hl7_external'` for an M29-accepted death, with `cosignStatus` `pending`
// until the medical director attests (`cosigned` after). Internal deaths keep `source='internal_clinician_recorded'`
// and an undefined `cosignStatus`. Consequence for M30: the HVLDL external-source subset is no longer always
// empty and its pending-cosign Risk-Register flag can now fire.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DeathDischargeReader, DeathDischargeRow } from "@wardenx/types";
import { and, eq, gte, lt } from "drizzle-orm";

const DE = schema.dischargeEvents;
const ADM = schema.admissions;

/**
 * The `app.user_id` the reader's `withOrgContext` envelope carries — the empty-string system sentinel the M4
 * audit trigger NULLIFs (an aggregate census read has no acting user). The read emits no audited row, but
 * withOrgContext requires a userId. (Prose, not the literal GUC expression, so the tenancy string-scan stays quiet.)
 */
const DEATH_DISCHARGE_SYSTEM_USER_ID = "";

/** Project a Drizzle timestamp (Date) — or a defensive string — to an ISO-8601 instant. */
const iso = (d: Date | string): string =>
  typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

/**
 * The production {@link DeathDischargeReader} over M6's `discharge_event` / `admission` tables. Closes over the
 * pooled `DbClient`; the read opens its OWN per-org `withOrgContext` envelope (sets `app.org_id` for RLS on this
 * connection) with a belt-and-suspenders `organization_id = $org` predicate. Maps each death row to a
 * {@link DeathDischargeRow} carrying the real source + cosign provenance (F-227).
 */
export function createDeathDischargeReader(db: DbClient): DeathDischargeReader {
  return {
    listDeathDischargesInPeriod(organizationId, period) {
      return withOrgContext(
        db,
        { organizationId, userId: DEATH_DISCHARGE_SYSTEM_USER_ID },
        async (tx) => {
          const rows = await (tx as unknown as DbClient)
            .select({
              patientId: ADM.patientId,
              admissionId: DE.admissionId,
              deathAt: DE.deathAt,
              source: DE.source,
              sourceProposalId: DE.sourceProposalId,
              cosignedAt: DE.cosignedAt,
              medicalDirectorMembershipId: DE.medicalDirectorMembershipId,
            })
            .from(DE)
            .innerJoin(ADM, eq(DE.admissionId, ADM.id))
            .where(
              and(
                eq(DE.organizationId, organizationId),
                eq(DE.dischargeType, "death"),
                gte(DE.deathAt, new Date(period.from)),
                lt(DE.deathAt, new Date(period.to)),
              ),
            );
          const out: DeathDischargeRow[] = [];
          for (const r of rows) {
            // `death_at` is non-null for every row the `discharge_type='death'` + range filter returns; skip a
            // defensively-null timestamp rather than fabricate an instant.
            if (r.deathAt === null) continue;
            out.push({
              patientId: r.patientId,
              admissionId: r.admissionId,
              deathAt: iso(r.deathAt),
              source: r.source,
              ...(r.source === "hl7_external"
                ? {
                    cosignStatus: r.cosignedAt !== null ? ("cosigned" as const) : ("pending" as const),
                    ...(r.sourceProposalId !== null ? { sourceProposalId: r.sourceProposalId } : {}),
                    ...(r.cosignedAt !== null ? { cosignedAt: iso(r.cosignedAt) } : {}),
                    ...(r.medicalDirectorMembershipId !== null
                      ? { medicalDirectorMembershipId: r.medicalDirectorMembershipId }
                      : {}),
                  }
                : {}),
            });
          }
          return out;
        },
      );
    },
  };
}
