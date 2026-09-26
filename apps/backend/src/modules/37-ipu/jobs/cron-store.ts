// apps/backend/src/modules/37-ipu/jobs/cron-store.ts — F-071 (#174): the `ipu.rn-coverage-watchdog`
// cron's Drizzle reader + upsert over `ipu_shift` / `ipu_staff_assignment` / `ipu_rn_coverage_window`
// (the M9/M14 `jobs/cron-store.ts` shape). ORG-scoped, caller-owned `withOrgContext` tx — this file never
// opens its own tenancy envelope; `cron-workers.ts`'s per-org fan-out owns that.
import { type DbClient, schema } from "@wardenx/db";
import type { StaffAssignmentFact } from "@wardenx/inpatient";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { CoverageWindowRow } from "./index";

const UNIT = schema.inpatientUnit;
const SHIFT = schema.ipuShift;
const ASSIGN = schema.ipuStaffAssignment;
const WINDOW = schema.ipuRnCoverageWindow;
const MEMBERSHIP = schema.memberships;

// `excluded.<col>` is the row Postgres would have inserted. Drizzle has no typed helper for it on an
// array column, so it is expressed as raw SQL against the column name.
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

/** One active unit the watchdog rebuilds a grid for. */
export interface WatchdogUnit {
  readonly unitId: string;
  /** `inpatient_unit.rn_coverage_horizon_hours` — the per-tenant alert horizon, tighten-only (§2.3). */
  readonly rnCoverageHorizonHours: number | null;
}

/** Active units in the org. A deactivated unit takes no admissions, so its grid is not worth rebuilding —
 *  and its historical rows stay exactly as they were, which is what the compliance record needs. */
export async function activeUnitsForOrg(
  tx: DbClient,
  _organizationId: string,
): Promise<WatchdogUnit[]> {
  const rows = await tx
    .select({ unitId: UNIT.id, horizon: UNIT.rnCoverageHorizonHours })
    .from(UNIT)
    .where(eq(UNIT.isActive, true));
  return rows.map((r) => ({ unitId: r.unitId, rnCoverageHorizonHours: r.horizon ?? null }));
}

/**
 * The staff-assignment facts for one unit, over the shifts that OVERLAP the rebuild window.
 *
 * `membershipEligible` is resolved here rather than in the pure builder, which takes it as an injected
 * fact. It is `membership.status = 'active'`: a nurse whose membership was terminated does not cover an
 * hour, even where a `confirmed` assignment row survives them.
 *
 * WHAT IT IS NOT, stated rather than implied. §2.3 D3's own wording is "M2 membership active AND
 * unexpired RN license", and the licence half is NOT applied here. M17 publishes the fact
 * (`CredentialReader.activeCredentialsAsOf`, the seam the F-030 `licensure` work established as the
 * platform's one licence answer) and M37 already `dependsOn` 17, so the wiring is available — but
 * requiring an active credential row makes an org that has never populated `membership_credential`
 * report every hour uncovered, which is bit-for-bit the outage this cron exists to end. Turning it on is
 * a deliberate follow-up once credentials are populated, not a default to slip in behind a bug fix. The
 * ROLE filter still applies in the pure builder (`RN_EQUIVALENT_ROLES`), which is the repo's settled
 * authority derivation (F-030 `disciplines`: role keys decide authority, the credential answers the
 * orthogonal question of whether a licence is currently live).
 */
export async function assignmentFactsForUnit(
  tx: DbClient,
  unitId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<StaffAssignmentFact[]> {
  // A shift covers an hour in [windowStart, windowEnd) when its own interval overlaps that range:
  // `shift_start_at < windowEnd AND shift_end_at > windowStart`. Selecting only shifts that START in the
  // range would drop a night shift that began before the lookback boundary and is still running.
  const rows = await tx
    .select({
      assignmentId: ASSIGN.id,
      role: ASSIGN.role,
      state: ASSIGN.state,
      shiftStartAt: SHIFT.shiftStartAt,
      shiftEndAt: SHIFT.shiftEndAt,
      membershipId: ASSIGN.membershipId,
    })
    .from(ASSIGN)
    .innerJoin(SHIFT, eq(ASSIGN.shiftId, SHIFT.id))
    .where(
      and(
        eq(SHIFT.unitId, unitId),
        lt(SHIFT.shiftStartAt, windowEnd),
        gte(SHIFT.shiftEndAt, windowStart),
      ),
    );
  if (rows.length === 0) return [];

  const membershipIds = [...new Set(rows.map((r) => r.membershipId))];
  const active = await tx
    .select({ id: MEMBERSHIP.id })
    .from(MEMBERSHIP)
    .where(and(inArray(MEMBERSHIP.id, membershipIds), eq(MEMBERSHIP.status, "active")));
  const activeIds = new Set(active.map((m) => m.id));

  return rows.map((r) => ({
    assignmentId: r.assignmentId,
    role: r.role,
    state: r.state,
    shiftStartMs: r.shiftStartAt.getTime(),
    shiftEndMs: r.shiftEndAt.getTime(),
    membershipEligible: activeIds.has(r.membershipId),
  }));
}

/**
 * Upsert one unit's rebuilt grid onto the `(unit_id, hour_start_at)` unique index.
 *
 * An UPSERT rather than delete-then-insert on purpose: the delete half of a rebuild leaves a window —
 * however brief — in which the coverage table says a unit is uncovered because its rows are mid-flight,
 * and four write paths read this table on every request. Under `withOrgContext` the whole rebuild is one
 * transaction, so a reader never sees the gap; the upsert means it would not see one even if that
 * changed.
 */
export async function upsertCoverageWindows(
  tx: DbClient,
  organizationId: string,
  rows: readonly CoverageWindowRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  // Chunked so one unit's 216-hour grid does not become a single statement with thousands of parameters
  // when several units are rebuilt in one tick.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await tx
      .insert(WINDOW)
      .values(
        chunk.map((r) => ({
          organizationId,
          unitId: r.unitId,
          hourStartAt: r.hourStartAt,
          isCovered: r.isCovered,
          rnAssignmentIds: [...r.rnAssignmentIds],
          computedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [WINDOW.unitId, WINDOW.hourStartAt],
        set: {
          isCovered: sqlExcluded("is_covered"),
          rnAssignmentIds: sqlExcluded("rn_assignment_ids"),
          computedAt: sqlExcluded("computed_at"),
        },
      });
    written += chunk.length;
  }
  return written;
}
