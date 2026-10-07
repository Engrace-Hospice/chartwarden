// apps/backend/src/modules/11-orders/order-sweeps.ts — GAP-032: the three M11 §4.8 workers that were never
// built — `verbal-pre-expiry-alert` (quarter-hourly), `lab-results-overdue-sweep` (daily 04:00 UTC, D18 / §4.11)
// and `completion-watcher` (daily, one-shot kinds).
//
// Each is an org-explicit method (a worker tick is not a request): the caller fans out over active orgs and each
// sweep opens its own `withOrgContext` transaction. The state write, the catalogued event
// (`m11.order.verbal_expiring_soon` / `m11.order.results_overdue` / `m11.order.completed`) and the durable alert
// intent (`m11.order.recovery_alert_requested`, delivered to M36 by the existing `m11.recovery-alert` consumer) are
// all published on the SAME transaction, so an alert can never describe a write that rolled back and a committed
// write can never lose its alert. Every sweep is idempotent: a tier marker (migration 0405), a status-guarded UPDATE.
//
// NO PHI in events or alerts: ids, tiers, hour counts and enum tokens only.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { OrderKind } from "@wardenx/types";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { OrderWriteOutboxPort } from "./orders-route-service-db";

const OR = schema.orderRecords;
const VO = schema.verbalOrders;

const HOUR_MS = 3_600_000;
/** §2.3 — the pre-expiry alert tiers, most urgent last. */
export const VERBAL_PRE_EXPIRY_TIERS = [
  { tier: "12h", hours: 12, severity: "medium" },
  { tier: "2h", hours: 2, severity: "high" },
] as const;
export type VerbalPreExpiryTier = (typeof VERBAL_PRE_EXPIRY_TIERS)[number]["tier"];

/** D18 — per-priority results expected-by offsets, in hours after signature. */
const EXPECTED_BY_HOURS: Readonly<Record<string, number>> = { stat: 1, asap: 4, routine: 24 };
const DEFAULT_EXPECTED_BY_HOURS = 24;
const SWEEP_BATCH = 500;

const ALERT_SEVERITY = { medium: "warn", high: "critical" } as const;

export interface VerbalPreExpiryPlan {
  readonly tier: VerbalPreExpiryTier;
  readonly severity: "medium" | "high";
  /** Every crossed tier — recorded so a lower tier never fires after a higher one. */
  readonly markTiers: readonly VerbalPreExpiryTier[];
}

/** Pure: which pre-expiry tier (if any) a pending verbal order newly reached. Idempotent on `alreadyAlerted`. */
export function planVerbalPreExpiry(
  deadlineAt: Date,
  now: Date,
  alreadyAlerted: readonly string[],
): VerbalPreExpiryPlan | null {
  const remainingMs = deadlineAt.getTime() - now.getTime();
  if (remainingMs <= 0) return null; // the hourly expiry worker owns a lapsed window
  const crossed = VERBAL_PRE_EXPIRY_TIERS.filter((t) => remainingMs <= t.hours * HOUR_MS);
  const fresh = crossed.filter((t) => !alreadyAlerted.includes(t.tier));
  const highest = fresh[fresh.length - 1];
  if (!highest) return null;
  return {
    tier: highest.tier,
    severity: highest.severity,
    markTiers: fresh.map((t) => t.tier),
  };
}

/** Whole-tenth hours from `now` until `deadline`, never negative. */
export function hoursUntil(deadline: Date, now: Date): number {
  return Math.max(0, Math.round(((deadline.getTime() - now.getTime()) / HOUR_MS) * 10) / 10);
}

/** D18 — when results are due for an order signed at `signedAt` with the given priority. */
export function expectedResultsBy(priority: string, signedAt: Date): Date {
  const hours = EXPECTED_BY_HOURS[priority] ?? DEFAULT_EXPECTED_BY_HOURS;
  return new Date(signedAt.getTime() + hours * HOUR_MS);
}

/** Facts the completion criterion reads from the modules that own the downstream effect. */
export interface CompletionFacts {
  readonly supplyDelivered: boolean;
  readonly recertPeriodLive: boolean;
  readonly locPeriodExists: boolean;
}

/**
 * Pure: has this active order's clinical intent been discharged (§2.2 `completed`)? Labs are deliberately absent
 * (D17: a clinician reviews the results) and so is `dme` (completes on the monthly-rental close-out).
 */
export function completionCriterionMet(kind: OrderKind, facts: CompletionFacts): boolean {
  switch (kind) {
    case "supply":
    case "comfort_kit":
      return facts.supplyDelivered;
    case "recertification":
      return facts.recertPeriodLive;
    case "level_of_care_change":
      return facts.locPeriodExists;
    default:
      return false;
  }
}

/** The durable alert intent, in the shape `recoveryAlertEventPayload` / the `m11.recovery-alert` consumer expect. */
function alertIntent(
  alertType: string,
  severity: "info" | "warn" | "critical",
  correlationId: string,
  alertPayload: Record<string, unknown>,
): Record<string, unknown> {
  return { alertType, severity, correlationId, alertPayload };
}

export interface OrderSweepSummary {
  readonly examined: number;
  readonly acted: number;
}

export interface OrderSweepDeps {
  readonly db: DbClient;
  readonly outbox: OrderWriteOutboxPort;
  readonly now?: () => Date;
}

async function emit(
  deps: OrderSweepDeps,
  tx: DbClient,
  organizationId: string,
  eventName: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await deps.outbox.publish(tx, {
    eventName,
    payload,
    organizationId,
    aggregateKind: "order",
    aggregateId,
  });
}

/**
 * `orders.verbal_pre_expiry` — emit `m11.order.verbal_expiring_soon` (+ a care-team alert) once per
 * (verbal order, tier) for pending verbals within 12h / 2h of their deadline.
 */
export async function sweepVerbalPreExpiry(
  deps: OrderSweepDeps,
  organizationId: string,
): Promise<OrderSweepSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const horizon = new Date(now.getTime() + VERBAL_PRE_EXPIRY_TIERS[0].hours * HOUR_MS);
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    const rows = await tx
      .select({
        id: VO.id,
        targetKind: VO.targetKind,
        targetId: VO.targetId,
        deadlineAt: VO.deadlineAt,
        tiers: VO.preExpiryTiersAlerted,
      })
      .from(VO)
      .where(and(eq(VO.status, "pending"), gt(VO.deadlineAt, now), lte(VO.deadlineAt, horizon)))
      .orderBy(asc(VO.deadlineAt))
      .limit(SWEEP_BATCH);
    let acted = 0;
    for (const v of rows) {
      const plan = planVerbalPreExpiry(v.deadlineAt, now, v.tiers);
      if (!plan) continue;
      let patientId: string | null = null;
      if (v.targetKind === "order") {
        const [o] = await tx
          .select({ status: OR.status, patientId: OR.patientId })
          .from(OR)
          .where(eq(OR.id, v.targetId))
          .limit(1);
        if (!o || o.status !== "verbal_pending") continue; // resolved elsewhere; the expiry worker settles it
        patientId = o.patientId;
      }
      const marked = await tx
        .update(VO)
        .set({ preExpiryTiersAlerted: [...new Set([...v.tiers, ...plan.markTiers])] })
        .where(and(eq(VO.id, v.id), eq(VO.status, "pending")))
        .returning({ id: VO.id });
      if (marked.length === 0) continue; // lost the race: the winner emitted
      const hoursUntilDeadline = hoursUntil(v.deadlineAt, now);
      await emit(deps, tx, organizationId, "m11.order.verbal_expiring_soon", v.targetId, {
        orderId: v.targetId,
        verbalOrderId: v.id,
        hoursUntilDeadline,
        severity: plan.severity,
      });
      if (patientId) {
        await emit(
          deps,
          tx,
          organizationId,
          "m11.order.recovery_alert_requested",
          v.targetId,
          alertIntent(
            "m11.order.verbal_expiring_soon",
            ALERT_SEVERITY[plan.severity],
            `m11.order.verbal_expiring_soon:${v.id}:${plan.tier}`,
            {
              orderId: v.targetId,
              verbalOrderId: v.id,
              patientId,
              tier: plan.tier,
              hoursUntilDeadline,
              deepLink: `/orders/${v.targetId}`,
            },
          ),
        );
      }
      acted += 1;
    }
    return { examined: rows.length, acted };
  });
}

/**
 * `lab-results-overdue-sweep` (D18 / §4.11) — flip lab orders still awaiting results past their per-priority
 * expected-by instant to `results_overdue`, emitting `m11.order.results_overdue` + a care-team alert once.
 * The status-guarded UPDATE is the idempotency: a flipped order is never selected again.
 */
export async function sweepLabResultsOverdue(
  deps: OrderSweepDeps,
  organizationId: string,
): Promise<OrderSweepSummary> {
  const now = (deps.now ?? (() => new Date()))();
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    const rows = await tx
      .select({
        id: OR.id,
        patientId: OR.patientId,
        priority: OR.priority,
        signedAt: OR.signedAt,
        physician: OR.orderingPhysicianMdmId,
      })
      .from(OR)
      .where(
        and(
          eq(OR.kind, "lab"),
          inArray(OR.resultsStatus, ["awaiting_results", "partial_results_received"]),
          sql`${OR.signedAt} IS NOT NULL`,
        ),
      )
      .orderBy(asc(OR.signedAt))
      .limit(SWEEP_BATCH);
    let acted = 0;
    for (const r of rows) {
      if (!r.signedAt) continue;
      const expectedBy = expectedResultsBy(r.priority, r.signedAt);
      if (expectedBy.getTime() > now.getTime()) continue;
      const flipped = await tx
        .update(OR)
        .set({ resultsStatus: "results_overdue", updatedAt: now })
        .where(
          and(
            eq(OR.id, r.id),
            inArray(OR.resultsStatus, ["awaiting_results", "partial_results_received"]),
          ),
        )
        .returning({ id: OR.id });
      if (flipped.length === 0) continue;
      const hoursOverdue = Math.floor((now.getTime() - expectedBy.getTime()) / HOUR_MS);
      await emit(deps, tx, organizationId, "m11.order.results_overdue", r.id, {
        orderId: r.id,
        organizationId,
        expectedByAt: expectedBy.toISOString(),
        hoursOverdue,
        orderingPhysicianMdmId: r.physician,
      });
      await emit(
        deps,
        tx,
        organizationId,
        "m11.order.recovery_alert_requested",
        r.id,
        alertIntent("m11.order.results_overdue", "warn", `m11.order.results_overdue:${r.id}`, {
          orderId: r.id,
          patientId: r.patientId,
          expectedByAt: expectedBy.toISOString(),
          hoursOverdue,
          deepLink: `/orders/${r.id}`,
        }),
      );
      acted += 1;
    }
    return { examined: rows.length, acted };
  });
}

/** One active one-shot order the completion watcher is evaluating. */
export interface CompletionCandidate {
  readonly id: string;
  readonly kind: OrderKind;
}

/** Reads the downstream facts for a batch of candidates (bound to the owning modules' read surface). */
export interface CompletionFactsReader {
  factsFor(
    tx: DbClient,
    organizationId: string,
    candidates: readonly CompletionCandidate[],
  ): Promise<ReadonlyMap<string, CompletionFacts>>;
}

const COMPLETION_KINDS: readonly OrderKind[] = [
  "supply",
  "comfort_kit",
  "recertification",
  "level_of_care_change",
];

/**
 * `orders.completion_watcher` — daily net for the one-shot kinds whose criterion is met but whose event-driven
 * completion (the `m21-fulfillment-status` consumer, the order-triggered M6 applier) was missed. Same three effects as
 * `completeOrder`: status, `completed_at`, `m11.order.completed` (`kindAutoOrManual: 'auto'`).
 */
export async function sweepCompletionWatcher(
  deps: OrderSweepDeps & { readonly facts: CompletionFactsReader },
  organizationId: string,
): Promise<OrderSweepSummary> {
  const now = (deps.now ?? (() => new Date()))();
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (txRaw) => {
    const tx = txRaw as unknown as DbClient;
    const rows = await tx
      .select({ id: OR.id, kind: OR.kind })
      .from(OR)
      .where(and(eq(OR.status, "active"), inArray(OR.kind, [...COMPLETION_KINDS])))
      .orderBy(asc(OR.signedAt))
      .limit(SWEEP_BATCH);
    if (rows.length === 0) return { examined: 0, acted: 0 };
    const facts = await deps.facts.factsFor(tx, organizationId, rows);
    let acted = 0;
    for (const r of rows) {
      const f = facts.get(r.id);
      if (!f || !completionCriterionMet(r.kind, f)) continue;
      const done = await tx
        .update(OR)
        .set({ status: "completed", completedAt: now, updatedAt: now })
        .where(and(eq(OR.id, r.id), eq(OR.status, "active")))
        .returning({ id: OR.id });
      if (done.length === 0) continue; // raced a manual / event-driven completion
      await emit(deps, tx, organizationId, "m11.order.completed", r.id, {
        orderId: r.id,
        completedAt: now.toISOString(),
        kindAutoOrManual: "auto",
      });
      acted += 1;
    }
    return { examined: rows.length, acted };
  });
}
