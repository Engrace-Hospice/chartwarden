// apps/backend/src/modules/06-admission/seams/cap-election-context.ts — org-explicit "first election
// overlapping a date range" read for BACKGROUND consumers (F-131, #248 — the
// `admissionSchedulingContextForOrg` / `electionPeriodContextForOrg` precedent in `./drizzle-store.ts`,
// and the F-121 range-shaped sibling `claimAssemblyRangeContextForOrg` in that same file).
//
// M26's cap-accrual outbox consumer needs `cap_beneficiary_accrual.first_election_in_period` (NOT
// NULL) the first time it opens a roll-up row for a patient within one cap period's [starts_on,
// ends_on] window. M6's published §4.7 `ElectionPeriodReader` answers only a single
// active-as-of-one-date lookup (`findActivePeriodForPatient`) or a single admission's period list
// (`listPeriodsForAdmission`) — never "every period for this PATIENT overlapping this RANGE" across
// possibly-several admissions, the exact gap F-121 already named for M23's five M6 seams. M26 does not
// list `6` in its manifest `dependsOn` ([1, 23, 36]) and cannot import this module's code directly
// either way — the composition root injects this function as a typed port instead.
//
// "First election IN [the cap] period" is read literally as the earliest OVERLAP with the range, never
// a value clamped to the range's own start: a patient whose election began before the cap year opened
// and continued into it is recorded by their REAL election date, not a fabricated later one — the same
// "never clamp a real fact to make it fit" rule `admissionSchedulingContextForOrg`'s own header states
// for `admissionAt`. Nothing in this codebase currently computes FROM this fact — `packages/cap-management`
// has no reader of it, and the existing M26 routes (`routes/read-service-drizzle.ts`) only echo the
// stored column back on read — so this records an honest, once-written fact, not a value derived for a
// downstream calculation this change does not also own.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";

const EP = schema.electionPeriods;
const ADM = schema.admissions;

/** The seam envelope's actor id — a cross-module identity read has no acting membership. */
const CAP_ELECTION_READER_SYSTEM_USER_ID = "";

/** Org-local `yyyy-mm-dd` for a Date/date-typed column value. */
function localDateOf(d: Date | string): string {
  return (d instanceof Date ? d.toISOString() : new Date(d).toISOString()).slice(0, 10);
}

/**
 * The earliest ACTIVATED election period's `effective_at` for this patient (across every admission
 * they have) that overlaps `[rangeStart, rangeEnd]` (inclusive, org-local `yyyy-mm-dd`). A period's
 * effective end is `coalesce(actual_end_at, scheduled_end_at)`; a still-open period (both null) is
 * treated as overlapping everything from its `effective_at` onward. A period with no `effective_at`
 * (not yet activated — F-042: written only by the `setActive` transition) cannot overlap anything and
 * is excluded, the same rule `admissionSchedulingContextForOrg`'s header documents for an undated
 * period. `null` when the patient has no such period — a real, unremarkable case (e.g. a patient with
 * no Medicare election active during this cap-year window) — never fabricated. `null` also when the
 * patient id is unknown in `organizationId`, indistinguishable from another tenant's, which is the
 * point.
 */
export function firstElectionEffectiveDateInRangeForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<string | null> {
  return withOrgContext(
    db,
    { organizationId, userId: CAP_ELECTION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const rows = await tx
        .select({ effectiveAt: EP.effectiveAt })
        .from(EP)
        .innerJoin(ADM, eq(ADM.id, EP.admissionId))
        .where(
          and(
            eq(EP.organizationId, organizationId),
            eq(ADM.patientId, patientId),
            isNotNull(EP.effectiveAt),
            lte(EP.effectiveAt, rangeEnd),
            // Effective end = coalesce(actual_end_at, scheduled_end_at); a still-open period (both
            // null) overlaps everything from its effective_at onward.
            sql`coalesce(${EP.actualEndAt}, ${EP.scheduledEndAt}) IS NULL OR coalesce(${EP.actualEndAt}, ${EP.scheduledEndAt}) >= ${rangeStart}`,
          ),
        )
        .orderBy(asc(EP.effectiveAt))
        .limit(1);
      const first = rows[0]?.effectiveAt;
      return first ? localDateOf(first) : null;
    },
  );
}
