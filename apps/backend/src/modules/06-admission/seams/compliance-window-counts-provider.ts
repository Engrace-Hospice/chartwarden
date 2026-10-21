// apps/backend/src/modules/06-admission/seams/compliance-window-counts-provider.ts — the DEDICATED
// Drizzle reader backing M6's `ComplianceWindowCountsProvider` seam (F-178, #248; M30's nightly
// measure-recompute batch pull for the F2F on-time rate + the override count). Mirrors
// `level-of-care-period-reader.ts` / `discharge-reader.ts`'s shape: a SEPARATE org-scoped aggregate port,
// self-scoping its own `withOrgContext` envelope (HARD RULE 3 — the M30 worker's envelope is on a
// different connection and does not reach here).
//
// This seam is a REAL replacement for the never-built `ComplianceWindowReader` M30's own spec has long
// claimed to consume (§7.5, W-OVR-02) — verified nowhere in the codebase as a real type or registered seam
// name before this file. It is a table-state PULL, not a consumer of M6's six `m6.compliance.window.*` /
// `m6.f2f.window_*` outbox events (those stay `isOutboxOnly` with `seamConsumers: ["m30"]` on the two
// F2F-window entries — see `events-by-m6.ts`); `compliance_window` has no `providerEntityId` column, so an
// optional provider-entity filter joins to `admissions`, which does.
//
// `compliance_window` write paths (verified by direct read, not inferred):
//  - `close_window` (admission-route-service-db.ts's F2F `attest` transition): status:'closed',
//    closedAt:now() — never touches overrideReason. This is the "closed on time" / "closed late, no
//    override" path.
//  - `overrideComplianceWindow` (route 46, the ONLY write site that ever sets overrideReason): status:
//    'closed', closedAt:now(), overrideReason:reason.
//  - `admission.window_alert` job (every 15 min): flips open/closing_soon windows past mustCompleteBy to
//    status:'overdue'. A window can still close (attest or override) AFTER passing through 'overdue' —
//    closedAt/status reflect the final resolution regardless of the overdue detour, which is why the
//    denominator below is DUE-DATE-scoped, not status-scoped.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, lt } from "drizzle-orm";

const CW = schema.complianceWindows;
const ADM = schema.admissions;

/** The single window kind this seam's two methods scope to (F2F recertification, §3.2). */
const F2F_WINDOW_KIND = "f2f_recert_30d_prior" as const;

/** Same empty-acting-user sentinel `level-of-care-period-reader.ts` / `discharge-reader.ts` use for an
 *  aggregate, non-patient-identifying read. */
const SYSTEM_USER_ID = "";

/** A numerator/denominator tally — the local mirror of `ComplianceWindowRateCounts`
 *  (packages/quality/src/seams/consumed/m6-compliance-window.ts). Duplicated, not imported: this seam is
 *  OPAQUE in the M1 registry (`unknown`) and M6 does not depend on `@chartwarden/quality` (leaves-stay-leaves) —
 *  the two shapes are kept structurally identical by convention, not a type import. */
export interface ComplianceWindowRateCounts {
  readonly numerator: number;
  readonly denominator: number;
}

/** The local mirror of `ComplianceWindowScope` (see the file header above for why this is a duplicate, not
 *  an import). */
export interface ComplianceWindowScope {
  readonly orgId: string;
  readonly providerEntityId?: string;
  readonly fromIso: string;
  readonly toIso: string;
}

/** The local mirror of `ComplianceWindowCountsView` — the M6-side implementation surface this file builds. */
export interface ComplianceWindowCountsProvider {
  f2fWindowOnTimeCounts(scope: ComplianceWindowScope): Promise<ComplianceWindowRateCounts>;
  f2fWindowOverrideCounts(scope: ComplianceWindowScope): Promise<ComplianceWindowRateCounts>;
}

/** The shared "F2F windows due in the scope window" query both counters run — same WHERE, different
 *  numerator predicate, so one query function backs both methods (mirrors `f2fWindowOnTimeCounts`'s and
 *  `f2fWindowOverrideCounts`'s SAME-denominator contract by construction rather than by two independent
 *  queries that could drift). */
async function dueF2fWindows(
  t: DbClient,
  scope: ComplianceWindowScope,
): Promise<Array<{ closedAt: Date | null; mustCompleteBy: Date; overrideReason: string | null }>> {
  const conditions = [
    eq(CW.organizationId, scope.orgId),
    eq(CW.windowKind, F2F_WINDOW_KIND),
    gte(CW.mustCompleteBy, new Date(scope.fromIso)),
    lt(CW.mustCompleteBy, new Date(scope.toIso)),
  ];
  if (scope.providerEntityId === undefined) {
    return t
      .select({
        closedAt: CW.closedAt,
        mustCompleteBy: CW.mustCompleteBy,
        overrideReason: CW.overrideReason,
      })
      .from(CW)
      .where(and(...conditions));
  }
  return t
    .select({
      closedAt: CW.closedAt,
      mustCompleteBy: CW.mustCompleteBy,
      overrideReason: CW.overrideReason,
    })
    .from(CW)
    .innerJoin(ADM, eq(CW.admissionId, ADM.id))
    .where(and(...conditions, eq(ADM.providerEntityId, scope.providerEntityId)));
}

/**
 * The production {@link ComplianceWindowCountsProvider} over M6's `compliance_window` (joined to
 * `admission` only when `providerEntityId` narrows the scope). Closes over the pooled `DbClient`; each call
 * opens its OWN per-org `withOrgContext` envelope with a belt-and-suspenders `organization_id = $org`
 * predicate (mirrors `createLevelOfCarePeriodReader` / `createDischargeReader`).
 */
export function createComplianceWindowCountsProvider(db: DbClient): ComplianceWindowCountsProvider {
  return {
    f2fWindowOnTimeCounts(scope) {
      return withOrgContext(
        db,
        { organizationId: scope.orgId, userId: SYSTEM_USER_ID },
        async (tx) => {
          const rows = await dueF2fWindows(tx as unknown as DbClient, scope);
          let numerator = 0;
          for (const r of rows) {
            if (
              r.closedAt !== null &&
              r.closedAt <= r.mustCompleteBy &&
              r.overrideReason === null
            ) {
              numerator += 1;
            }
          }
          return { numerator, denominator: rows.length };
        },
      );
    },

    f2fWindowOverrideCounts(scope) {
      return withOrgContext(
        db,
        { organizationId: scope.orgId, userId: SYSTEM_USER_ID },
        async (tx) => {
          const rows = await dueF2fWindows(tx as unknown as DbClient, scope);
          let numerator = 0;
          for (const r of rows) {
            if (r.overrideReason !== null) numerator += 1;
          }
          return { numerator, denominator: rows.length };
        },
      );
    },
  };
}
