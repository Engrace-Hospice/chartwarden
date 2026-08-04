// apps/backend/src/modules/07-care-plan/jobs/cron-store.ts — the TASK-040D `care-plan.gates` cron's
// Drizzle reader/writer over `care_plan` (mig 0161's four gate-scan columns). Mirrors the ORG-scoped
// shape of `../seams/drizzle-store.ts`'s `fifteenDayCycleCountsForOrg` (explicit `organizationId`,
// caller-owned `withOrgContext` tx — this file never opens its own tenancy envelope; `cron-workers.ts`'s
// per-org fan-out owns that so the read, the outbox publish, and the marker writes commit atomically).
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { CarePlanGateSnapshot, PlannedCarePlanEvent } from "./index";

const CP = schema.carePlans;

/** Coerce a Drizzle timestamp to an ISO instant. */
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));

/**
 * The org's gate-scan snapshots (TASK-040D): every non-`discharged` care plan — a discharged plan's
 * §7.1/§7.2 clocks are moot (mirrors `../seams/drizzle-store.ts`'s `loadActivePlan` terminal-status
 * filter; `care_plan_status` has exactly one terminal value, `discharged`). `admissionActivatedAt` is
 * nullable on pre-mig-0161 rows (backfilled going forward by the route service's bootstrap stamp) —
 * falls back to `createdAt`, the closest available proxy, so a legacy row still scans instead of being
 * silently skipped.
 */
export async function carePlanGateSnapshotsForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<CarePlanGateSnapshot[]> {
  const rows = await tx
    .select()
    .from(CP)
    .where(and(eq(CP.organizationId, organizationId), ne(CP.status, "discharged")));
  return rows.map((row) => ({
    planId: row.id,
    patientId: row.patientId,
    admissionActivatedAt: iso(row.admissionActivatedAt ?? row.createdAt),
    hasSignedInitialVersion: row.initialSignedAt !== null,
    initialDueAt: iso(row.initialDueAt),
    nextReviewDueAt: isoN(row.nextReviewDueAt),
    initialWarningEmitted: row.initialWarningEmitted,
    reviewDueEmitted: row.reviewDueEmitted,
    reviewOverdueEmitted: row.reviewOverdueEmitted,
  }));
}

/** §7.1 marker: flip `initial_warning_emitted` for every plan {@link planInitialGateScan} just emitted. */
export async function markInitialWarningEmitted(
  tx: DbClient,
  planIds: readonly string[],
): Promise<void> {
  if (planIds.length === 0) return;
  await tx.update(CP).set({ initialWarningEmitted: true }).where(inArray(CP.id, [...planIds]));
}

/**
 * §7.2 markers: {@link planReviewGateScan}'s `markedPlanIds` doesn't distinguish which of the two
 * review columns to flip — inspect the returned events instead, since `review_due` and
 * `review_overdue` are mutually exclusive per plan per tick (the scan emits `review_overdue` OR
 * `review_due`, never both for the same plan in one pass) but map to DIFFERENT columns.
 */
export async function applyReviewGateMarkers(
  tx: DbClient,
  events: readonly PlannedCarePlanEvent[],
): Promise<void> {
  const dueIds = events
    .filter((e) => e.eventName === "m7.care_plan.review_due")
    .map((e) => String(e.payload.planId));
  const overdueIds = events
    .filter((e) => e.eventName === "m7.care_plan.review_overdue")
    .map((e) => String(e.payload.planId));
  if (dueIds.length > 0) {
    await tx.update(CP).set({ reviewDueEmitted: true }).where(inArray(CP.id, dueIds));
  }
  if (overdueIds.length > 0) {
    await tx.update(CP).set({ reviewOverdueEmitted: true }).where(inArray(CP.id, overdueIds));
  }
}
