// apps/backend/src/modules/06-admission/seams/admission-onset-reader.ts — the DEDICATED Drizzle reader
// backing M6's `AdmissionOnsetReader` seam (M30's `opioid_on_admission_rate` denominator). Mirrors
// `death-discharge-reader.ts`'s shape exactly: a SEPARATE org-scoped census port the M30
// `m30.measure_recompute` worker consumes, self-scoping its own `withOrgContext` envelope (HARD RULE 3).
//
// The list-of-admissions shape (not a bare count) mirrors `DeathDischargeReader.listDeathDischargesInPeriod`
// deliberately: M30's resolver loops it and calls M12's EXISTING per-admission `MedicationOrderProvider.
// listForAdmission` read (the HVLDL/HCI-10 precedent — a per-item cross-module loop at the RESOLVER, never a
// bulk join inside one producer), so no new M12 seam surface is needed for the opioid classification.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { AdmissionOnsetReader, AdmissionOnsetRow } from "@chartwarden/types";
import { and, eq, gte, lt } from "drizzle-orm";

const ADM = schema.admissions;

/** Same empty-acting-user sentinel {@link createDeathDischargeReader} uses for an aggregate census read. */
const SYSTEM_USER_ID = "";

/** Project a Drizzle timestamp (Date) to an ISO-8601 instant. */
const iso = (d: Date): string => d.toISOString();

/**
 * The production {@link AdmissionOnsetReader} over M6's `admission` table. Closes over the pooled
 * `DbClient`; each call opens its OWN per-org `withOrgContext` envelope with a belt-and-suspenders
 * `organization_id = $org` predicate (mirrors `createDeathDischargeReader`).
 */
export function createAdmissionOnsetReader(db: DbClient): AdmissionOnsetReader {
  return {
    listAdmissionsStartedInPeriod(organizationId, period) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
        const rows = await (tx as unknown as DbClient)
          .select({ id: ADM.id, admissionAt: ADM.admissionAt })
          .from(ADM)
          .where(
            and(
              eq(ADM.organizationId, organizationId),
              gte(ADM.admissionAt, new Date(period.from)),
              lt(ADM.admissionAt, new Date(period.to)),
            ),
          );
        const out: AdmissionOnsetRow[] = [];
        for (const r of rows) {
          // `admission_at` is nullable at the schema level (a draft/pre-activation admission); the range
          // filter above already excludes nulls at the SQL level, but stay defensive rather than assume.
          if (r.admissionAt === null) continue;
          out.push({ admissionId: r.id, admissionAt: iso(r.admissionAt) });
        }
        return out;
      });
    },
  };
}
