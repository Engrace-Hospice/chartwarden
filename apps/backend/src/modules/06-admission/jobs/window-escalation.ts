// apps/backend/src/modules/06-admission/jobs/window-escalation.ts — GAP-026: the every-15-min compliance
// window escalation for EVERY window kind, and the daily recert-due window opener.
//
// Before this, `admission.window_alert` only ran the F2F "prior-to" scan and the election-addendum scan, so a
// missed CTI / NOR / initial-assessment / care-plan window sat `open` forever and `planWindowAlert` /
// `promoteWindowStatus` (./index) had no caller. The planner below is that pure core; the in-tx runners
// persist it and publish the (now payload-rich) `m6.compliance.window.overdue` M36 pages on.
//
// Exclusions: the two election-addendum kinds (own scan + own dedicated event), `info` severity windows and
// `auto_acknowledge` windows (D15 external signals — informational, they must never page).
import { type DbClient, schema } from "@chartwarden/db";
import type { ComplianceWindowSeverity, ComplianceWindowStatusValue } from "@chartwarden/types";
import { and, eq, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { addCalendarDays } from "../certification/window-math";
import { ADDENDUM_WINDOW_KINDS } from "../election-addendum/store";
import { type ComplianceWindowSnapshot, planWindowAlert } from "./index";

const CW = schema.complianceWindows;
const ADM = schema.admissions;
const EP = schema.electionPeriods;

/** Open recert windows this many calendar days before the benefit period's scheduled end. */
export const RECERT_DUE_LEAD_DAYS = 14;
/** Bound on rows one tick handles per org (the scan is every 15 minutes; backlog drains over ticks). */
const ESCALATION_BATCH = 500;

const ESCALATION_EXCLUDED_KINDS: ReadonlySet<string> = new Set(ADDENDUM_WINDOW_KINDS);

export interface EscalationRow {
  readonly complianceWindowId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly windowKind: string;
  readonly status: ComplianceWindowStatusValue;
  readonly severity: ComplianceWindowSeverity;
  readonly autoAcknowledge: boolean;
  readonly dueAt: string;
}

export interface EscalationPlan {
  readonly toClosingSoon: readonly EscalationRow[];
  readonly toOverdue: readonly EscalationRow[];
}

/** Pure: which windows move to `closing_soon` / `overdue` at `now` (idempotent — moved windows aren't re-picked). */
export function planWindowEscalation(rows: readonly EscalationRow[], now: Date): EscalationPlan {
  const eligible = rows.filter(
    (r) =>
      !ESCALATION_EXCLUDED_KINDS.has(r.windowKind) && r.severity !== "info" && !r.autoAcknowledge,
  );
  const byId = new Map(eligible.map((r) => [r.complianceWindowId, r]));
  const snapshots: ComplianceWindowSnapshot[] = eligible.map((r) => ({
    complianceWindowId: r.complianceWindowId,
    admissionId: r.admissionId,
    windowType: r.windowKind,
    status: r.status,
    severity: r.severity,
    dueAt: r.dueAt,
  }));
  const { transitions } = planWindowAlert(snapshots, now);
  const toClosingSoon: EscalationRow[] = [];
  const toOverdue: EscalationRow[] = [];
  for (const t of transitions) {
    if (!t.changed) continue;
    const r = byId.get(t.complianceWindowId);
    if (!r) continue;
    if (t.toStatus === "overdue") toOverdue.push(r);
    else if (t.toStatus === "closing_soon") toClosingSoon.push(r);
  }
  return { toClosingSoon, toOverdue };
}

export interface RecertDueCandidate {
  readonly electionPeriodId: string;
  readonly admissionId: string;
  /** yyyy-mm-dd, the period's last covered day. */
  readonly scheduledEndAt: string;
  readonly hasOpenWindow: boolean;
}

export interface PlannedRecertWindow {
  readonly electionPeriodId: string;
  readonly admissionId: string;
  /** yyyy-mm-dd the recert must be complete by (the period end). */
  readonly mustCompleteBy: string;
}

/** Pure: active periods ending within the lead (and not already ended) that have no open recert window. */
export function planRecertDueWindows(
  candidates: readonly RecertDueCandidate[],
  today: string,
): PlannedRecertWindow[] {
  const horizon = addCalendarDays(today, RECERT_DUE_LEAD_DAYS);
  return candidates
    .filter((c) => !c.hasOpenWindow && c.scheduledEndAt >= today && c.scheduledEndAt <= horizon)
    .map((c) => ({
      electionPeriodId: c.electionPeriodId,
      admissionId: c.admissionId,
      mustCompleteBy: c.scheduledEndAt,
    }));
}

export interface WindowOutboxPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/**
 * Close recert-due windows whose benefit period is no longer active (next period activated / auto-ended /
 * discharge), so the escalation never pages a recert that was in fact completed.
 */
export async function closeStaleRecertWindowsInTx(
  tx: DbClient,
  organizationId: string,
  now: Date,
): Promise<number> {
  const open = await tx
    .select({ id: CW.id, payload: CW.payload })
    .from(CW)
    .where(
      and(
        eq(CW.organizationId, organizationId),
        eq(CW.windowKind, "recert_due_14d"),
        ne(CW.status, "closed"),
      ),
    );
  let closed = 0;
  for (const w of open) {
    const periodId = (w.payload as { electionPeriodId?: unknown } | null)?.electionPeriodId;
    if (typeof periodId !== "string") continue;
    const [period] = await tx
      .select({ status: EP.status })
      .from(EP)
      .where(eq(EP.id, periodId))
      .limit(1);
    if (period && period.status === "active") continue;
    await tx
      .update(CW)
      .set({ status: "closed", closedAt: now, closeReason: "period_ended", updatedAt: now })
      .where(and(eq(CW.id, w.id), ne(CW.status, "closed")));
    closed += 1;
  }
  return closed;
}

/**
 * Persist the escalation for one org (caller owns the org tx): close stale recert windows, move windows to
 * `closing_soon`, and move overdue ones to `overdue` + `alert`, publishing `m6.compliance.window.overdue`
 * once per window (the status-guarded UPDATE means a racing tick loses the edge and stays silent).
 */
export async function escalateComplianceWindowsInTx(
  tx: DbClient,
  outbox: WindowOutboxPort,
  organizationId: string,
  now: Date,
): Promise<number> {
  await closeStaleRecertWindowsInTx(tx, organizationId, now);
  const rows = await tx
    .select({
      id: CW.id,
      admissionId: CW.admissionId,
      patientId: ADM.patientId,
      windowKind: CW.windowKind,
      status: CW.status,
      severity: CW.severity,
      autoAcknowledge: CW.autoAcknowledge,
      mustCompleteBy: CW.mustCompleteBy,
    })
    .from(CW)
    .innerJoin(ADM, eq(ADM.id, CW.admissionId))
    .where(
      and(
        eq(CW.organizationId, organizationId),
        inArray(CW.status, ["open", "closing_soon"]),
        lte(CW.mustCompleteBy, new Date(now.getTime() + 24 * 3_600_000)),
      ),
    )
    .limit(ESCALATION_BATCH);
  const plan = planWindowEscalation(
    rows.map((r) => ({
      complianceWindowId: r.id,
      admissionId: r.admissionId,
      patientId: r.patientId,
      windowKind: r.windowKind,
      status: r.status,
      severity: r.severity,
      autoAcknowledge: r.autoAcknowledge,
      dueAt: r.mustCompleteBy.toISOString(),
    })),
    now,
  );

  for (const r of plan.toClosingSoon) {
    await tx
      .update(CW)
      .set({ status: "closing_soon", updatedAt: now })
      .where(and(eq(CW.id, r.complianceWindowId), eq(CW.status, "open")));
  }
  let escalated = 0;
  for (const r of plan.toOverdue) {
    const [moved] = await tx
      .update(CW)
      .set({ status: "overdue", severity: "alert", updatedAt: now })
      .where(
        and(
          eq(CW.id, r.complianceWindowId),
          inArray(CW.status, ["open", "closing_soon"]),
          isNotNull(CW.mustCompleteBy),
        ),
      )
      .returning({ id: CW.id });
    if (!moved) continue;
    await outbox.publish(tx, {
      eventName: "m6.compliance.window.overdue",
      payload: {
        complianceWindowId: r.complianceWindowId,
        severity: "alert",
        admissionId: r.admissionId,
        patientId: r.patientId,
        windowKind: r.windowKind,
        dueAt: r.dueAt,
      },
      organizationId,
      aggregateKind: "compliance_window",
      aggregateId: r.complianceWindowId,
    });
    escalated += 1;
  }
  return escalated;
}

/**
 * `admission.recert_due_notify` body for one org: open a `recert_due_14d` window (due at the period end) for
 * every active benefit period ending within {@link RECERT_DUE_LEAD_DAYS}, publishing
 * `m6.compliance.window.opened`. The window closes when the period leaves `active`
 * ({@link closeStaleRecertWindowsInTx}); if the recert is not completed by the period end the escalation
 * scan pages it. Idempotent on the open-window partial unique index.
 */
export async function openRecertDueWindowsInTx(
  tx: DbClient,
  outbox: WindowOutboxPort,
  organizationId: string,
  today: string,
  now: Date,
): Promise<number> {
  const periods = await tx
    .select({
      electionPeriodId: EP.id,
      admissionId: EP.admissionId,
      scheduledEndAt: EP.scheduledEndAt,
      admissionStatus: ADM.status,
    })
    .from(EP)
    .innerJoin(ADM, eq(ADM.id, EP.admissionId))
    .where(
      and(
        eq(EP.organizationId, organizationId),
        eq(EP.status, "active"),
        isNotNull(EP.scheduledEndAt),
        lte(EP.scheduledEndAt, addCalendarDays(today, RECERT_DUE_LEAD_DAYS)),
      ),
    );
  const live = periods.filter(
    (p) => !["discharged", "bereavement", "closed"].includes(p.admissionStatus),
  );
  if (live.length === 0) return 0;
  const open = await tx
    .select({ admissionId: CW.admissionId })
    .from(CW)
    .where(
      and(
        eq(CW.organizationId, organizationId),
        eq(CW.windowKind, "recert_due_14d"),
        ne(CW.status, "closed"),
        inArray(
          CW.admissionId,
          live.map((p) => p.admissionId),
        ),
      ),
    );
  const openAdmissions = new Set(open.map((o) => o.admissionId));
  const planned = planRecertDueWindows(
    live.flatMap((p) =>
      p.scheduledEndAt === null
        ? []
        : [
            {
              electionPeriodId: p.electionPeriodId,
              admissionId: p.admissionId,
              scheduledEndAt: p.scheduledEndAt,
              hasOpenWindow: openAdmissions.has(p.admissionId),
            },
          ],
    ),
    today,
  );
  let opened = 0;
  for (const p of planned) {
    const mustCompleteBy = new Date(`${p.mustCompleteBy}T23:59:59.000Z`);
    const [row] = await tx
      .insert(CW)
      .values({
        organizationId,
        admissionId: p.admissionId,
        windowKind: "recert_due_14d",
        severity: "warning",
        status: "open",
        startsAt: now,
        mustCompleteBy,
        payload: { electionPeriodId: p.electionPeriodId },
      })
      .onConflictDoNothing()
      .returning({ id: CW.id });
    if (!row) continue;
    await outbox.publish(tx, {
      eventName: "m6.compliance.window.opened",
      payload: {
        complianceWindowId: row.id,
        admissionId: p.admissionId,
        windowType: "recert_due_14d",
        dueAt: mustCompleteBy.toISOString(),
        severity: "warning",
      },
      organizationId,
      aggregateKind: "compliance_window",
      aggregateId: row.id,
    });
    opened += 1;
  }
  return opened;
}
