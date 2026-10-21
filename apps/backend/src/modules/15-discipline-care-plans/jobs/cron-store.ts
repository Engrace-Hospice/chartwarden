// apps/backend/src/modules/15-discipline-care-plans/jobs/cron-store.ts — GAP-044.
//
// The Drizzle reads/writes the five M15 crons run INSIDE a `withOrgContext` transaction (RLS scopes by
// app.org_id; every predicate still carries the explicit organization_id as the second wall). Dumb on
// purpose: no business rule lives here — the decisions are the pure planners in `./index`.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { GateStatusFlip } from "./types";

const PLAN = schema.disciplineCarePlan;
const GATE = schema.volunteerComplianceGate;
const ASSIGN = schema.volunteerAssignment;
const LEDGER = schema.volunteerHourLedger;
const ENTRY = schema.volunteerHourEntry;

const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** §7.1 — live aide plans whose `next_supervisory_due_at` has passed (the partial index hot path). */
export async function overdueSupervisoryPlansForOrg(
  t: DbClient,
  organizationId: string,
  now: Date,
): Promise<
  ReadonlyArray<{
    planId: string;
    nextSupervisoryDueAt: string;
    cadenceDaysOverride: number | null;
  }>
> {
  const rows = await t
    .select({
      planId: PLAN.id,
      nextSupervisoryDueAt: PLAN.nextSupervisoryDueAt,
      cadenceDaysOverride: PLAN.supervisoryCadenceDaysOverride,
    })
    .from(PLAN)
    .where(
      and(
        eq(PLAN.organizationId, organizationId),
        eq(PLAN.kind, "aide_poc"),
        inArray(PLAN.status, ["active", "draft_revising"]),
        lte(PLAN.nextSupervisoryDueAt, now),
      ),
    );
  return rows.flatMap((r) =>
    r.nextSupervisoryDueAt === null
      ? []
      : [
          {
            planId: r.planId,
            nextSupervisoryDueAt: r.nextSupervisoryDueAt.toISOString(),
            cadenceDaysOverride: r.cadenceDaysOverride,
          },
        ],
  );
}

/** §7.2 / §7.3 — non-discharged plans of one kind with an armed, unsigned initial-assessment clock. */
export async function unsatisfiedInitialClockPlansForOrg(
  t: DbClient,
  organizationId: string,
  kind: "msw_plan" | "spiritual_plan",
) {
  const rows = await t
    .select({
      planId: PLAN.id,
      admissionId: PLAN.admissionId,
      clockStartedAt: PLAN.initialAssessmentClockStartedAt,
      initialAssessmentSignedAt: PLAN.initialAssessmentSignedAt,
      spiritualCareDeclinedAt: PLAN.spiritualCareDeclinedAt,
    })
    .from(PLAN)
    .where(
      and(
        eq(PLAN.organizationId, organizationId),
        eq(PLAN.kind, kind),
        ne(PLAN.status, "discharged"),
        isNull(PLAN.initialAssessmentSignedAt),
      ),
    );
  return rows.map((r) => ({
    kind,
    planId: r.planId,
    admissionId: r.admissionId,
    clockStartedAt: isoOrNull(r.clockStartedAt),
    initialAssessmentSignedAt: isoOrNull(r.initialAssessmentSignedAt),
    spiritualCareDeclinedAt: isoOrNull(r.spiritualCareDeclinedAt),
  }));
}

/** §7.5 — every gate the watcher can still act on (not revoked, not already expired). */
export async function liveGatesForOrg(t: DbClient, organizationId: string) {
  const rows = await t
    .select({
      gateId: GATE.id,
      volunteerMembershipId: GATE.volunteerMembershipId,
      gateKind: GATE.gateKind,
      status: GATE.status,
      validFrom: GATE.validFrom,
      validUntil: GATE.validUntil,
      revokedAt: GATE.revokedAt,
      lastNoticeDaysOut: GATE.lastExpiryNoticeDaysOut,
    })
    .from(GATE)
    .where(
      and(
        eq(GATE.organizationId, organizationId),
        isNull(GATE.revokedAt),
        inArray(GATE.status, ["satisfied", "expiring_soon"]),
      ),
    );
  return rows.map((r) => ({
    gateId: r.gateId,
    volunteerMembershipId: r.volunteerMembershipId,
    gateKind: r.gateKind,
    status: r.status,
    validFrom: r.validFrom.toISOString(),
    validUntil: isoOrNull(r.validUntil),
    revokedAt: isoOrNull(r.revokedAt),
    lastNoticeDaysOut: r.lastNoticeDaysOut,
  }));
}

/**
 * Flip a gate's materialized status. Guarded on the current status being still live, so a replayed tick —
 * or a coordinator revoking the gate between the read and this write — flips nothing. Returns whether THIS
 * call flipped the row (only the winner emits).
 */
export async function flipGateStatus(
  t: DbClient,
  organizationId: string,
  gateId: string,
  to: GateStatusFlip,
  now: Date,
): Promise<boolean> {
  const rows = await t
    .update(GATE)
    .set({ status: to, updatedAt: now, version: sql`${GATE.version} + 1` })
    .where(
      and(
        eq(GATE.id, gateId),
        eq(GATE.organizationId, organizationId),
        isNull(GATE.revokedAt),
        inArray(GATE.status, ["satisfied", "expiring_soon"]),
      ),
    )
    .returning({ id: GATE.id });
  return rows.length > 0;
}

/** §7.5 — record the ladder mark just notified (same tx as the `gate_expiring` publish). Guarded so a racing
 *  replica cannot move the mark backwards; returns whether THIS call advanced it (only the winner emits). */
export async function stampGateNotice(
  t: DbClient,
  organizationId: string,
  gateId: string,
  mark: number,
  now: Date,
): Promise<boolean> {
  const rows = await t
    .update(GATE)
    .set({ lastExpiryNoticeDaysOut: mark, updatedAt: now, version: sql`${GATE.version} + 1` })
    .where(
      and(
        eq(GATE.id, gateId),
        eq(GATE.organizationId, organizationId),
        isNull(GATE.revokedAt),
        sql`(${GATE.lastExpiryNoticeDaysOut} IS NULL OR ${GATE.lastExpiryNoticeDaysOut} > ${mark})`,
      ),
    )
    .returning({ id: GATE.id });
  return rows.length > 0;
}

/** §7.5 — the volunteer's open assignments (with the parent plan id the event payload names). */
export async function openAssignmentsForVolunteer(
  t: DbClient,
  organizationId: string,
  volunteerMembershipId: string,
) {
  const rows = await t
    .select({ assignmentId: ASSIGN.id, planId: ASSIGN.planId })
    .from(ASSIGN)
    .where(
      and(
        eq(ASSIGN.organizationId, organizationId),
        eq(ASSIGN.volunteerMembershipId, volunteerMembershipId),
        isNull(ASSIGN.inactivatedAt),
      ),
    );
  return rows.map((r) => ({
    assignmentId: r.assignmentId,
    planId: r.planId,
    volunteerMembershipId,
    inactivatedAt: null,
  }));
}

/** §7.5 — stamp the cascade. Only still-open rows are touched, so the FIRST cause stays the reason. */
export async function inactivateAssignments(
  t: DbClient,
  organizationId: string,
  assignmentIds: ReadonlyArray<string>,
  reason: string,
  now: Date,
): Promise<number> {
  if (assignmentIds.length === 0) return 0;
  const rows = await t
    .update(ASSIGN)
    .set({
      inactivatedAt: now,
      inactivationReason: reason,
      updatedAt: now,
      version: sql`${ASSIGN.version} + 1`,
    })
    .where(
      and(
        eq(ASSIGN.organizationId, organizationId),
        inArray(ASSIGN.id, [...assignmentIds]),
        isNull(ASSIGN.inactivatedAt),
      ),
    )
    .returning({ id: ASSIGN.id });
  return rows.length;
}

/** §7.6 — every (provider entity, patient, volunteer) a volunteer plan has ever served, open or not. */
export async function servedPatientsByProviderEntity(t: DbClient, organizationId: string) {
  const rows = await t
    .selectDistinct({
      providerEntityId: ASSIGN.providerEntityId,
      patientId: PLAN.patientId,
      volunteerMembershipId: ASSIGN.volunteerMembershipId,
    })
    .from(ASSIGN)
    .innerJoin(PLAN, eq(PLAN.id, ASSIGN.planId))
    .where(and(eq(ASSIGN.organizationId, organizationId), eq(PLAN.kind, "volunteer_plan")));
  return rows;
}

/** §2.2.7 — get-or-create the (PE × FY) ledger row and lock it, serialising two replicas' passes. */
export async function lockLedger(
  t: DbClient,
  organizationId: string,
  providerEntityId: string,
  fiscalYear: number,
  now: Date,
): Promise<{ ledgerId: string; created: boolean }> {
  const inserted = await t
    .insert(LEDGER)
    .values({ organizationId, providerEntityId, fiscalYear, asOfAt: now })
    .onConflictDoNothing()
    .returning({ id: LEDGER.id });
  if (inserted[0]) return { ledgerId: inserted[0].id, created: true };
  const [row] = await t
    .select({ id: LEDGER.id })
    .from(LEDGER)
    .where(
      and(
        eq(LEDGER.organizationId, organizationId),
        eq(LEDGER.providerEntityId, providerEntityId),
        eq(LEDGER.fiscalYear, fiscalYear),
      ),
    )
    .for("update");
  if (!row) throw new Error("M15_LEDGER_MISSING: ledger row vanished after conflict");
  return { ledgerId: row.id, created: false };
}

export async function ledgerEntries(t: DbClient, organizationId: string, ledgerId: string) {
  const rows = await t
    .select({
      volunteerMembershipId: ENTRY.volunteerMembershipId,
      source: ENTRY.source,
      durationMinutes: ENTRY.durationMinutes,
      occurredAt: ENTRY.occurredAt,
      sourceEncounterId: ENTRY.sourceEncounterId,
      adjustmentReason: ENTRY.adjustmentReason,
      adjustedByMembershipId: ENTRY.adjustedByMembershipId,
    })
    .from(ENTRY)
    .where(and(eq(ENTRY.organizationId, organizationId), eq(ENTRY.ledgerId, ledgerId)));
  return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
}

export async function insertLedgerEntries(
  t: DbClient,
  organizationId: string,
  ledgerId: string,
  entries: ReadonlyArray<{
    volunteerMembershipId: string;
    durationMinutes: number;
    occurredAt: string;
    sourceEncounterId: string | null;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  await t.insert(ENTRY).values(
    entries.map((e) => ({
      organizationId,
      ledgerId,
      sourceEncounterId: e.sourceEncounterId,
      volunteerMembershipId: e.volunteerMembershipId,
      source: "encounter" as const,
      durationMinutes: e.durationMinutes,
      occurredAt: new Date(e.occurredAt),
    })),
  );
}

/**
 * M15-F04 / migration 0347 — persist the 418.78(e) denominator on the ledger row. `minutes` is `null` when no
 * qualifying visit resolved a duration (the read path then badges `unavailable`); `computedAt` always stamps.
 */
export async function setLedgerPatientCare(
  t: DbClient,
  organizationId: string,
  ledgerId: string,
  tally: { minutes: number | null; counted: number; unresolved: number },
  computedAt: Date,
): Promise<void> {
  await t
    .update(LEDGER)
    .set({
      patientCareMinutes: tally.minutes,
      patientCareVisitsCounted: tally.counted,
      patientCareVisitsUnresolved: tally.unresolved,
      patientCareComputedAt: computedAt,
    })
    .where(and(eq(LEDGER.organizationId, organizationId), eq(LEDGER.id, ledgerId)));
}

export async function setLedgerTotal(
  t: DbClient,
  organizationId: string,
  ledgerId: string,
  totalVolunteerHourMinutes: number,
  asOfAt: Date,
): Promise<void> {
  await t
    .update(LEDGER)
    .set({
      totalVolunteerHourMinutes,
      asOfAt,
      updatedAt: asOfAt,
      version: sql`${LEDGER.version} + 1`,
    })
    .where(and(eq(LEDGER.organizationId, organizationId), eq(LEDGER.id, ledgerId)));
}
