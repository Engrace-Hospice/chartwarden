// apps/backend/src/modules/13-emar/jobs/deadline-sweeps.ts — the three §4.8 deadline crons M13 owns besides
// the schedule/missed-dose pair (GAP-038 `reconciliation-due-warning` + `kit-return-overdue`, GAP-040
// `prn-reassessment-overdue`). Each one is "read the rows whose deadline just passed, publish one event per
// row": the producer half the specs described and nothing built.
//
// DE-DUPLICATION (migration 0345). The reconciliation and PRN sweeps are catch-up safe: they select every row
// whose deadline has passed (bounded lookback) with its "already warned" marker NULL, and stamp the marker in the
// SAME tx as the publish. A missed tick is caught up by the next; overlapping ticks cannot double-alert.
// The daily kit sweep is a deliberate daily nag (`daysOverdue` rises every day; M36 correlates on
// `deploymentId:daysOverdue`, so a double-run the same day cannot page twice).
//
// PRN OWNERSHIP (GAP-040). M13's spec §2.4 assigned the overdue sweep to M9 (`m9.prn_reassessment_overdue`),
// but M9's spec never mentions PRN and M9 has no PRN linkage, so nobody could ever emit it (F-143). M13 owns
// the trigger rows (`prn_administration.reassessment_due_at`) and already answers "was a scale captured?"
// through M9's published `ScaleSeriesProvider` (the `prn_effectiveness_documented_rate` read). The sweep
// therefore lives HERE and emits `m13.prn_reassessment.overdue`; M36 consumes that.
import { type DbClient, schema } from "@wardenx/db";
import { evaluateReturnOverdue } from "@wardenx/emar";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const WS = schema.medicationReconciliationWorksheets;
const CKD = schema.comfortKitDeployments;
const PRN = schema.prnAdministrations;

const MS_PER_HOUR = 3_600_000;
export const RECONCILIATION_WARNING_LEAD_HOURS = 24;
/** Catch-up bound: a deadline older than this is not alerted (same 48h as the missed-dose sweep). */
export const DEADLINE_SWEEP_LOOKBACK_HOURS = 48;
/** Rows read per org per tick (a window is one period wide, so this is a safety bound, not a pager). */
export const DEADLINE_SWEEP_MAX_ROWS = 500;

export interface DeadlineSweepDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
  readonly now?: () => Date;
}

export interface PrnReassessmentSweepDeps extends DeadlineSweepDeps {
  /**
   * Was a reassessment of `scaleType` captured for `patientId` in `[fromIso, toIso]`? Bound at the composition
   * root to M9's `ScaleSeriesProvider` under `runWithRequestContext` (M13 has no schema edge to M9).
   */
  readonly reassessmentCaptured: (
    organizationId: string,
    patientId: string,
    scaleType: string,
    fromIso: string,
    toIso: string,
  ) => Promise<boolean>;
}

export interface DeadlineSweepResult {
  readonly emitted: number;
}

interface PendingEmission {
  readonly eventName: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

function nowOf(deps: DeadlineSweepDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/** Publish every emission in ONE org tx (all-or-nothing; a thrown catalog validation error rolls it back). */
async function publishAll(
  deps: DeadlineSweepDeps,
  organizationId: string,
  emissions: readonly PendingEmission[],
): Promise<void> {
  if (emissions.length === 0) return;
  await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    for (const e of emissions) {
      await deps.outbox.publish(scoped, { ...e, organizationId });
    }
  });
}

/** Earliest deadline a catch-up sweep still alerts on: `now - DEADLINE_SWEEP_LOOKBACK_HOURS`. Pure. */
export function deadlineLookbackFloor(now: Date): Date {
  return new Date(now.getTime() - DEADLINE_SWEEP_LOOKBACK_HOURS * MS_PER_HOUR);
}

/**
 * §2.8 — `m13.reconciliation.due_at_warning` (deadline within 24h, still ahead) and `.overdue` (deadline passed)
 * for open worksheets. Each is announced once: the candidate must have its marker NULL, and the marker is
 * stamped (`UPDATE ... WHERE marker IS NULL RETURNING`) in the SAME org tx as the publish, so a worker that was
 * down catches up on the next tick and two overlapping ticks cannot both alert.
 */
export async function runReconciliationDueWarningForOrg(
  deps: DeadlineSweepDeps,
  organizationId: string,
): Promise<DeadlineSweepResult> {
  const now = nowOf(deps);
  const floor = deadlineLookbackFloor(now);
  const warnUntil = new Date(now.getTime() + RECONCILIATION_WARNING_LEAD_HOURS * MS_PER_HOUR);
  const open = inArray(WS.status, ["pending", "in_progress"]);
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const db = scoped as unknown as DbClient;
    const overdueIds = (
      await db
        .select({ id: WS.id })
        .from(WS)
        .where(
          and(open, isNull(WS.deadlineOverdueWarnedAt), gt(WS.dueAt, floor), lte(WS.dueAt, now)),
        )
        .orderBy(asc(WS.dueAt), asc(WS.id))
        .limit(DEADLINE_SWEEP_MAX_ROWS)
    ).map((r) => r.id);
    const warnIds = (
      await db
        .select({ id: WS.id })
        .from(WS)
        .where(and(open, isNull(WS.deadlineWarnedAt), gt(WS.dueAt, now), lte(WS.dueAt, warnUntil)))
        .orderBy(asc(WS.dueAt), asc(WS.id))
        .limit(DEADLINE_SWEEP_MAX_ROWS)
    ).map((r) => r.id);

    const returning = {
      id: WS.id,
      patientId: WS.patientId,
      triggerKind: WS.triggerKind,
      dueAt: WS.dueAt,
    };
    const aggregateKind = "medication_reconciliation_worksheet";
    const claimedOverdue =
      overdueIds.length === 0
        ? []
        : await db
            .update(WS)
            .set({ deadlineOverdueWarnedAt: now })
            .where(and(inArray(WS.id, overdueIds), open, isNull(WS.deadlineOverdueWarnedAt)))
            .returning(returning);
    const claimedWarn =
      warnIds.length === 0
        ? []
        : await db
            .update(WS)
            .set({ deadlineWarnedAt: now })
            .where(and(inArray(WS.id, warnIds), open, isNull(WS.deadlineWarnedAt)))
            .returning(returning);

    let emitted = 0;
    for (const r of claimedWarn) {
      await deps.outbox.publish(scoped, {
        organizationId,
        eventName: "m13.reconciliation.due_at_warning",
        aggregateKind,
        aggregateId: r.id,
        payload: {
          worksheetId: r.id,
          patientId: r.patientId,
          dueAt: r.dueAt.toISOString(),
          hoursRemaining: RECONCILIATION_WARNING_LEAD_HOURS,
        },
      });
      emitted += 1;
    }
    for (const r of claimedOverdue) {
      await deps.outbox.publish(scoped, {
        organizationId,
        eventName: "m13.reconciliation.overdue",
        aggregateKind,
        aggregateId: r.id,
        payload: {
          worksheetId: r.id,
          patientId: r.patientId,
          dueAt: r.dueAt.toISOString(),
          triggerKind: r.triggerKind,
          overdueHours: (now.getTime() - r.dueAt.getTime()) / MS_PER_HOUR,
        },
      });
      emitted += 1;
    }
    return { emitted };
  });
}

/** §2.7 — `m13.comfort_kit.return_overdue` for kits still unreturned 30 days after `return_required_at`. */
export async function runKitReturnOverdueForOrg(
  deps: DeadlineSweepDeps,
  organizationId: string,
): Promise<DeadlineSweepResult> {
  const now = nowOf(deps);
  const nowIso = now.toISOString();
  const emissions = await withOrgContext(
    deps.db,
    { organizationId, userId: "" },
    async (scoped) => {
      const rows = await (scoped as unknown as DbClient)
        .select({
          id: CKD.id,
          patientId: CKD.patientId,
          returnRequiredAt: CKD.returnRequiredAt,
        })
        .from(CKD)
        .where(
          and(
            eq(CKD.disposalStatus, "return_required"),
            isNotNull(CKD.returnRequiredAt),
            isNull(CKD.returnedAt),
            lte(CKD.returnRequiredAt, now),
          ),
        )
        .orderBy(asc(CKD.returnRequiredAt), asc(CKD.id))
        .limit(DEADLINE_SWEEP_MAX_ROWS);
      const out: PendingEmission[] = [];
      for (const r of rows) {
        if (!r.returnRequiredAt) continue;
        const verdict = evaluateReturnOverdue(r.id, r.returnRequiredAt.toISOString(), nowIso);
        if (!verdict.signal) continue; // inside the 30-day compliance window
        out.push({
          eventName: "m13.comfort_kit.return_overdue",
          aggregateKind: "comfort_kit_deployment",
          aggregateId: r.id,
          payload: {
            deploymentId: r.id,
            patientId: r.patientId,
            daysOverdue: verdict.signal.daysOverdue,
          },
        });
      }
      return out;
    },
  );
  await publishAll(deps, organizationId, emissions);
  return { emitted: emissions.length };
}

/**
 * §2.4 — `m13.prn_reassessment.overdue` for PRN doses whose reassessment deadline has passed uncaptured.
 * Candidates are every row past its deadline (bounded lookback) with the marker NULL. M9 is read OUTSIDE any
 * held tx; every row that was evaluated (captured or not) is then stamped, and the overdue event published for
 * the uncaptured ones, in ONE tx (`UPDATE ... WHERE marker IS NULL RETURNING` — a concurrent tick that already
 * claimed a row yields nothing here). A row whose M9 read failed is not stamped, so the next tick retries it.
 */
export async function runPrnReassessmentOverdueForOrg(
  deps: PrnReassessmentSweepDeps,
  organizationId: string,
): Promise<DeadlineSweepResult> {
  const now = nowOf(deps);
  const floor = deadlineLookbackFloor(now);
  const due = await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) =>
    (scoped as unknown as DbClient)
      .select({
        id: PRN.id,
        patientId: PRN.patientId,
        medicationOrderId: PRN.medicationOrderId,
        scaleType: PRN.recommendedReassessmentScale,
        administeredAt: PRN.createdAt,
        reassessmentDueAt: PRN.reassessmentDueAt,
      })
      .from(PRN)
      .where(
        and(
          isNotNull(PRN.recommendedReassessmentScale),
          isNull(PRN.reassessmentOverdueWarnedAt),
          gt(PRN.reassessmentDueAt, floor),
          lte(PRN.reassessmentDueAt, now),
        ),
      )
      .orderBy(asc(PRN.reassessmentDueAt), asc(PRN.id))
      .limit(DEADLINE_SWEEP_MAX_ROWS),
  );

  const evaluatedIds: string[] = [];
  const uncaptured = new Map<string, (typeof due)[number]>();
  const failures: { id: string; error: unknown }[] = [];
  for (const r of due) {
    if (!r.scaleType) continue;
    try {
      const captured = await deps.reassessmentCaptured(
        organizationId,
        r.patientId,
        r.scaleType,
        r.administeredAt.toISOString(),
        r.reassessmentDueAt.toISOString(),
      );
      evaluatedIds.push(r.id);
      if (!captured) uncaptured.set(r.id, r);
    } catch (error) {
      failures.push({ id: r.id, error });
    }
  }

  let emitted = 0;
  if (evaluatedIds.length > 0) {
    emitted = await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
      const claimed = await (scoped as unknown as DbClient)
        .update(PRN)
        .set({ reassessmentOverdueWarnedAt: now })
        .where(and(inArray(PRN.id, evaluatedIds), isNull(PRN.reassessmentOverdueWarnedAt)))
        .returning({ id: PRN.id });
      let n = 0;
      for (const { id } of claimed) {
        const r = uncaptured.get(id);
        if (!r || !r.scaleType) continue;
        await deps.outbox.publish(scoped, {
          organizationId,
          eventName: "m13.prn_reassessment.overdue",
          aggregateKind: "prn_administration",
          aggregateId: r.id,
          payload: {
            prnAdministrationId: r.id,
            patientId: r.patientId,
            medicationOrderId: r.medicationOrderId,
            recommendedReassessmentScale: r.scaleType,
            reassessmentDueAt: r.reassessmentDueAt.toISOString(),
          },
        });
        n += 1;
      }
      return n;
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M13_PRN_REASSESSMENT_OVERDUE: ${failures.length} of ${due.length} PRN row(s) could not be evaluated in org ${organizationId} — ${failures.map((f) => f.id).join(", ")}`,
    );
  }
  return { emitted };
}
