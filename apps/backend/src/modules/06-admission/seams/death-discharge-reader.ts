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
// §4.11 KNOWN LIMITATION: M6's frozen `discharge_event` models only the death fact — it has no source / cosign
// columns — so this reader returns `source='internal_clinician_recorded'` with an undefined `cosignStatus` for
// every decedent. The HVLDL calculator's external-source subset therefore stays empty and no Risk-Register flag
// fires; HVLDL still computes correctly (the numerator/denominator are unaffected). The contract carries the
// fields so the impl can populate them once M6 models HL7-external death intake.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DeathDischargeReader, DeathDischargeRow } from "@wardenx/types";
import { and, eq, gte, lt } from "drizzle-orm";

const DE = schema.dischargeEvents;
const ADM = schema.admissions;

/** The constant `source` every decedent carries (§4.11 limitation: no external-source column on `discharge_event`). */
const INTERNAL_SOURCE = "internal_clinician_recorded" as const;

/**
 * The `app.user_id` the reader's `withOrgContext` envelope carries — the empty-string system sentinel the M4
 * audit trigger NULLIFs (an aggregate census read has no acting user). The read emits no audited row, but
 * withOrgContext requires a userId. (Prose, not the literal GUC expression, so the tenancy string-scan stays quiet.)
 */
const DEATH_DISCHARGE_SYSTEM_USER_ID = "";

/** Project a Drizzle timestamp (Date) — or a defensive string — to an ISO-8601 instant. */
const iso = (d: Date | string): string => (typeof d === "string" ? new Date(d).toISOString() : d.toISOString());

/**
 * The production {@link DeathDischargeReader} over M6's `discharge_event` / `admission` tables. Closes over the
 * pooled `DbClient`; the read opens its OWN per-org `withOrgContext` envelope (sets `app.org_id` for RLS on this
 * connection) with a belt-and-suspenders `organization_id = $org` predicate. Maps each death row to a
 * {@link DeathDischargeRow} with the §4.11-limited constant source and an undefined cosign status.
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
              source: INTERNAL_SOURCE,
            });
          }
          return out;
        },
      );
    },
  };
}
