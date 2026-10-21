// apps/backend/src/modules/20-field-safety/jobs/overdue-detector.ts — M20 §4.8 `m20.overdue-detector.cron`
// (GAP-061; D4, §7.3). The lone-worker safety control: every 30 seconds, find every
// `safety_check_in_schedule` row whose fulfilment window has closed unanswered, flip it to `overdue`, and
// walk the D4 ladder (`gentle_reminder` → `supervisor_alert` → `escalation` → `sos_equivalent`).
//
// THE DECIDER (`../lifecycle/check-in-overdue.ts`'s `decideOverdueCheckIn`) WAS COMPLETE AND HAD NO PRODUCTION
// CALLER. Nothing flipped a schedule to `overdue` and nothing cascaded a tier; the only `check_in_overdue`
// emitter was the M17 no-show consumer. This file is everything the decider could not do: the scan, the
// pinned-policy read, the after-hours input, and the write back.
//
// THE POST-VISIT CLOSER IS THIS SAME SCAN. §4.8's `m20.post-visit-window-closer.cron` ("EVV check-out >
// postVisitWindowMinutes ago without a post-visit check-in → flip schedule overdue") is already a row in this
// table: `consumers/m18-evv-brackets.ts` materializes a `post_visit` schedule at the check-out instant with
// the policy's post-visit window, so once the window closes unanswered it is a `proposed` row past its
// window like any other, and this scan flips it. A second queue would be a second writer of the same flip.
//
// LOCKING. Each schedule gets its own tx and is read `FOR UPDATE`, so two workers (or a tick racing a
// clinician's own fulfilment flip in `write-service-drizzle.ts`) serialize on the row; the decision is made
// against the row AS LOCKED, never against the scan's stale copy. A row that left an actionable state in the
// gap decides `none` (the decider's own `not_actionable` branch) — an ordinary race, not a fault.
//
// AFTER-HOURS (D14). `isAfterHours` needs an IANA zone and the policy row carries none. The schedule's own
// location carries one (read through M1's `FoundationSiteReader` via the injected `locationTimezone` port); a schedule with no location (`between_visits`,
// `ad_hoc`) has no zone to resolve, and in that case the decision is `afterHours = true`: the flag only widens
// the recipient set (the M19 on-call union), so the failure direction is "page one more person", never fewer.
//
// EVENTS GO THROUGH THE REAL CATALOG-VALIDATING OUTBOX. The `outbox` effect publishes in the SAME tx as the
// row write; `check_in_escalated` is keyed `[scheduleId, tier]` so each rung is its own event. The §4.9
// `alert` effects are skipped on purpose (no `AlertPort` is bound for M20 — M36 resolves the OUTBOX event
// through its own seam; see the index.ts composition-root note).
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type {
  IsoInstant,
  MembershipId,
  OrgId,
  SafetyCheckInKind,
  SafetyCheckInScheduleId,
  SafetyCheckInState,
  VisitId,
} from "@chartwarden/types";
import { SAFETY_SCHEDULE_ACTIONABLE_STATES } from "@chartwarden/types";
import { and, eq, inArray, lte } from "drizzle-orm";
import {
  type SafetyCheckInScheduleFacts,
  type SafetyOverdueDecision,
  decideOverdueCheckIn,
} from "../lifecycle/check-in-overdue";
import { isAfterHours } from "../lifecycle/policy";
import { runEffects } from "../routes/effects-runner";
import {
  type M20WorkerDeps,
  M20_WORKER_SYSTEM_USER_ID,
  activeOrgsOf,
  logM20Cron,
} from "./worker-support";

const SCHEDULE = schema.safetyCheckInSchedule;

type AdvanceDecision = Extract<SafetyOverdueDecision, { kind: "advance" }>;

/** The outcome of one tick, for the delivery log and the live suite. */
export interface OverdueDetectorTickSummary {
  readonly organizations: number;
  readonly scanned: number;
  readonly advanced: number;
  readonly failed: number;
}

function iso(d: Date): IsoInstant {
  return d.toISOString() as IsoInstant;
}

/** The scan: rows that could have a rung due — actionable state, `expected_at` already passed. Uses
 *  `scis_overdue_scan_idx` (organization_id, state, expected_at). */
async function scanDueScheduleIds(
  deps: M20WorkerDeps,
  organizationId: string,
  now: Date,
): Promise<readonly string[]> {
  return withOrgContext(
    deps.db,
    { organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
    async (handle) => {
      const rows = await (handle as DbClient)
        .select({ id: SCHEDULE.id })
        .from(SCHEDULE)
        .where(
          and(
            eq(SCHEDULE.organizationId, organizationId),
            inArray(SCHEDULE.state, [...SAFETY_SCHEDULE_ACTIONABLE_STATES]),
            lte(SCHEDULE.expectedAt, now),
          ),
        )
        .orderBy(SCHEDULE.expectedAt);
      return rows.map((r) => r.id);
    },
  );
}

function eventBody(
  decision: AdvanceDecision,
  row: {
    organizationId: string;
    providerEntityId: string;
    clinicianMembershipId: string;
    visitId: string | null;
    kind: string;
    expectedAt: Date;
  },
  scheduleId: string,
  atIso: IsoInstant,
): Record<string, unknown> {
  const common = {
    orgId: row.organizationId,
    providerEntityId: row.providerEntityId,
    occurredAt: atIso,
    scheduleId,
    clinicianMembershipId: row.clinicianMembershipId,
    visitId: row.visitId,
    minutesOverdue: decision.minutesOverdue,
  };
  return decision.toState === "overdue"
    ? { ...common, kind: row.kind, expectedAt: iso(row.expectedAt) }
    : { ...common, afterHours: decision.afterHours, tier: decision.tier };
}

/** Decide-and-apply for one schedule inside its own transaction. Returns whether a rung fired. */
async function processOneSchedule(
  deps: M20WorkerDeps,
  organizationId: string,
  scheduleId: string,
  now: Date,
): Promise<boolean> {
  const atIso = iso(now);
  return withOrgContext(
    deps.db,
    { organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
    async (handle) => {
      const tx = handle as DbClient;
      const [row] = await tx
        .select()
        .from(SCHEDULE)
        .where(and(eq(SCHEDULE.id, scheduleId), eq(SCHEDULE.organizationId, organizationId)))
        .for("update")
        .limit(1);
      if (!row) return false;

      const policy = await deps.policy.policyAtTime(organizationId as OrgId, iso(row.createdAt));

      let timeZone: string | null = null;
      if (row.locationId !== null && deps.locationTimezone) {
        timeZone = await deps.locationTimezone(tx, row.locationId);
      }
      const afterHours = timeZone === null ? true : isAfterHours(policy, atIso, timeZone);

      const facts: SafetyCheckInScheduleFacts = {
        scheduleId: row.id as SafetyCheckInScheduleId,
        state: row.state as SafetyCheckInState,
        kind: row.kind as SafetyCheckInKind,
        expectedAt: iso(row.expectedAt),
        windowMinutes: row.windowMinutes,
        clinicianMembershipId: row.clinicianMembershipId as MembershipId,
        visitId: row.visitId as VisitId | null,
        overdueDetectedAt: row.overdueDetectedAt ? iso(row.overdueDetectedAt) : null,
        escalatedAt: row.escalatedAt ? iso(row.escalatedAt) : null,
      };
      const decision = decideOverdueCheckIn({ schedule: facts, policy, nowIso: atIso, afterHours });
      if (decision.kind !== "advance") return false;

      const event =
        decision.toState === "overdue"
          ? "m20.safety.check_in_overdue"
          : "m20.safety.check_in_escalated";
      const patch = await runEffects(tx, decision.effects, {
        organizationId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        sosAlertId: "",
        at: now,
        actorMembershipId: null,
        reason: "m20.overdue-detector.cron",
        outbox: deps.outbox,
        aggregateKind: "safety_check_in_schedule",
        aggregateId: scheduleId,
        payloads: { [event]: eventBody(decision, row, scheduleId, atIso) },
      });

      await tx
        .update(SCHEDULE)
        .set({
          ...(patch.state ? { state: patch.state as never } : {}),
          ...(patch.overdueDetectedAt ? { overdueDetectedAt: patch.overdueDetectedAt } : {}),
          ...(patch.escalatedAt ? { escalatedAt: patch.escalatedAt } : {}),
          updatedAt: now,
        })
        .where(and(eq(SCHEDULE.id, scheduleId), eq(SCHEDULE.organizationId, organizationId)));

      logM20Cron("m20.overdue-detector: rung fired", {
        organizationId,
        scheduleId,
        tier: decision.tier,
        sosEquivalent: decision.sosEquivalent,
      });
      return true;
    },
  );
}

/**
 * §4.8 `m20.overdue-detector.cron` — fan out over every active org, scan for schedules with a rung due, and
 * decide-and-apply each in its own tx. A failure on one schedule (or one org) is logged and does NOT stop the
 * others: a stuck row must never silence the detector for every other clinician in the field. The failures
 * are re-thrown at the end so BullMQ records the tick as failed (DLQ alert) after everything else ran.
 */
export async function runOverdueDetectorCron(
  deps: M20WorkerDeps,
): Promise<OverdueDetectorTickSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  let scanned = 0;
  let advanced = 0;
  const failures: unknown[] = [];

  for (const { organizationId } of orgs) {
    try {
      const ids = await scanDueScheduleIds(deps, organizationId, now);
      scanned += ids.length;
      for (const scheduleId of ids) {
        try {
          const fired = await runWithRequestContext(
            { organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
            () => processOneSchedule(deps, organizationId, scheduleId, now),
          );
          if (fired) advanced += 1;
        } catch (err) {
          failures.push(err);
          logM20Cron("m20.overdue-detector: schedule failed", {
            organizationId,
            scheduleId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      failures.push(err);
      logM20Cron("m20.overdue-detector: org scan failed", {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = {
    organizations: orgs.length,
    scanned,
    advanced,
    failed: failures.length,
  };
  if (failures.length > 0) {
    throw new Error(
      `M20_OVERDUE_DETECTOR_PARTIAL_FAILURE: ${failures.length} failure(s) in this tick (first: ${
        failures[0] instanceof Error ? failures[0].message : String(failures[0])
      })`,
    );
  }
  return summary;
}
