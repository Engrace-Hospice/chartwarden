// apps/backend/src/modules/13-emar/jobs/missed-dose-sweep.ts — the §2.5 D4 / §4.8 `m13.missed-dose-sweep`
// per-org worker (GAP-039).
//
// THE FINDING. Nothing ever wrote `missed_dose`, set `scheduled_dose.status = 'missed'` or emitted
// `m13.scheduled_dose.missed`, so `getMissedDoseSummary`, the M14 packet flagged-event feed and M30's
// `missed_dose_rate` (numerator = scheduled doses with a `missed_dose` row) were structurally 0 — M30 divided
// a real denominator by a numerator that could never move and passed its threshold.
//
// WHAT A TICK DOES (one `withOrgContext` tx per batch, so a thrown outbox validation error rolls the batch
// back and the next tick retries it cleanly):
//   1. Claim `scheduled_dose` rows that are still `pending`, whose `due_at + grace_window_minutes` has
//      passed, and that have NO live administration (`committed` / `pending_caregiver_review`) naming them.
//      `FOR UPDATE SKIP LOCKED` — a clinician recording the dose RIGHT NOW holds the row; the sweep skips it
//      rather than racing it, and once that tx commits the row is `administered` and no longer a candidate.
//   2. Insert exactly one `missed_dose` row per claimed dose (`missed_kind = 'detected_by_sweep'`, unique on
//      `scheduled_dose_id`), flip the dose to `missed`, back-reference `missed_dose_id`, and publish
//      `m13.scheduled_dose.missed` through the outbox publisher in the same tx.
//
// IDEMPOTENCY. A second tick finds nothing: the claimed rows are no longer `pending`, and
// `missed_dose_scheduled_dose_uk` + `onConflictDoNothing` makes a half-applied earlier state converge instead
// of duplicating or throwing.
//
// LATE ADMINISTRATIONS. A dose recorded after the sweep flagged it flips the dose to `administered` (the
// existing write path) but the `missed_dose` row STAYS — the dose genuinely was not given inside its grace
// window, and that fact is the survey-defensible trail (§2.3: past rows are immutable history). A dose
// recorded INSIDE the grace window is never swept (it is no longer `pending`).
//
// GRACE. Each row carries the grace window frozen at materialization (default 60 min, 30 controlled), so the
// sweep reads `grace_window_minutes` off the row — never a re-resolved policy that could retroactively
// change what counted as missed.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const SD = schema.scheduledDoses;
const MD = schema.missedDoses;
const ADM = schema.administrationRecords;
const DRAWDOWN = schema.comfortKitDrawdowns;

/**
 * Only doses due within this many hours before the tick are swept (the spec states no look-back; 48h is the
 * chosen bound). Older pending doses are left UNTOUCHED — flagging the pre-existing backlog on the first tick
 * would page every care team at once; backfilling it is an explicit decision, not a side effect of a cron.
 */
export const MISSED_DOSE_SWEEP_LOOKBACK_HOURS = 48;

/** Rows claimed per batch (bounds the tx, the outbox burst and the lock set). */
export const MISSED_DOSE_SWEEP_BATCH_SIZE = 200;
/** Batches per org per tick — a backlog beyond this drains over the following 15-minute ticks. */
export const MISSED_DOSE_SWEEP_MAX_BATCHES = 10;

export interface MissedDoseOrderFacts {
  readonly isControlledSubstance: boolean;
}

export interface MissedDoseSweepDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
  /** M12's org-explicit order facts (`medicationOrderScheduleContextForOrg`, injected). `null` = unresolvable. */
  readonly orderFacts: (
    organizationId: string,
    orderId: string,
  ) => Promise<MissedDoseOrderFacts | null>;
  readonly now?: () => Date;
}

export interface MissedDoseSweepResult {
  readonly missed: number;
}

type Tx = DbClient;

/** `pending`, past `due_at + grace`, no live administration naming it. */
function overduePredicate(now: Date) {
  return and(
    eq(SD.status, "pending"),
    gte(SD.dueAt, new Date(now.getTime() - MISSED_DOSE_SWEEP_LOOKBACK_HOURS * 3_600_000)),
    lte(sql`${SD.dueAt} + (${SD.graceWindowMinutes} * interval '1 minute')`, now),
    sql`not exists (
      select 1 from ${ADM}
      where ${ADM.scheduledDoseId} = ${SD.id}
        and ${ADM.organizationId} = ${SD.organizationId}
        and ${ADM.status} in ('committed', 'pending_caregiver_review')
    )`,
  );
}

/** The distinct orders with overdue doses — a lock-free read, so M12 facts resolve before any row is locked. */
async function overdueOrderIds(
  deps: MissedDoseSweepDeps,
  organizationId: string,
  now: Date,
): Promise<readonly string[]> {
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const rows = await (scoped as unknown as Tx)
      .selectDistinct({ orderId: SD.medicationOrderId })
      .from(SD)
      .where(overduePredicate(now))
      .limit(MISSED_DOSE_SWEEP_BATCH_SIZE * MISSED_DOSE_SWEEP_MAX_BATCHES);
    return rows.map((r) => r.orderId);
  });
}

async function controlledByOrder(
  deps: MissedDoseSweepDeps,
  organizationId: string,
  orderIds: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const orderId of orderIds) {
    const facts = await deps.orderFacts(organizationId, orderId);
    // An order that no longer resolves is swept as non-controlled: the dose still lapsed, and refusing to
    // record it would reproduce the very blind spot this sweep closes.
    out.set(orderId, facts?.isControlledSubstance ?? false);
  }
  return out;
}

async function comfortKitOrderIds(
  tx: Tx,
  orderIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ orderId: DRAWDOWN.medicationOrderId })
    .from(DRAWDOWN)
    .where(inArray(DRAWDOWN.medicationOrderId, [...orderIds]));
  return new Set(rows.map((r) => r.orderId));
}

async function sweepOneBatch(
  deps: MissedDoseSweepDeps,
  organizationId: string,
  now: Date,
  controlled: ReadonlyMap<string, boolean>,
): Promise<number> {
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const doses = await tx
      .select({
        id: SD.id,
        providerEntityId: SD.providerEntityId,
        locationId: SD.locationId,
        patientId: SD.patientId,
        admissionId: SD.admissionId,
        medicationOrderId: SD.medicationOrderId,
        dueAt: SD.dueAt,
      })
      .from(SD)
      .where(overduePredicate(now))
      .orderBy(SD.dueAt, SD.id)
      .limit(MISSED_DOSE_SWEEP_BATCH_SIZE)
      .for("update", { of: SD, skipLocked: true });
    if (doses.length === 0) return 0;

    const kitOrders = await comfortKitOrderIds(tx, [
      ...new Set(doses.map((d) => d.medicationOrderId)),
    ]);
    const existing = await tx
      .select({ id: MD.id, scheduledDoseId: MD.scheduledDoseId })
      .from(MD)
      .where(
        inArray(
          MD.scheduledDoseId,
          doses.map((d) => d.id),
        ),
      );
    const existingBySd = new Map(existing.map((r) => [r.scheduledDoseId, r.id]));

    for (const dose of doses) {
      const isControlled = controlled.get(dose.medicationOrderId) ?? false;
      const alreadyId = existingBySd.get(dose.id);
      const missedDoseId = alreadyId ?? randomUUID();
      if (!alreadyId) {
        await tx
          .insert(MD)
          .values({
            id: missedDoseId,
            organizationId,
            providerEntityId: dose.providerEntityId,
            locationId: dose.locationId,
            scheduledDoseId: dose.id,
            patientId: dose.patientId,
            admissionId: dose.admissionId,
            medicationOrderId: dose.medicationOrderId,
            detectedAt: now,
            missedKind: "detected_by_sweep",
            isControlledSubstance: isControlled,
          })
          .onConflictDoNothing({ target: [MD.scheduledDoseId] });
      }
      await tx
        .update(SD)
        .set({ status: "missed", missedDoseId })
        .where(and(eq(SD.id, dose.id), eq(SD.status, "pending")));
      if (alreadyId) continue; // converged a half-applied state — the event went out with the original write
      await deps.outbox.publish(tx, {
        eventName: "m13.scheduled_dose.missed",
        organizationId,
        aggregateKind: "scheduled_dose",
        aggregateId: dose.id,
        payload: {
          scheduledDoseId: dose.id,
          missedDoseId,
          patientId: dose.patientId,
          medicationOrderId: dose.medicationOrderId,
          dueAt: dose.dueAt.toISOString(),
          isControlled,
          isComfortKitMedication: kitOrders.has(dose.medicationOrderId),
        },
      });
    }
    return doses.length;
  });
}

/** One org's missed-dose sweep tick (drains up to {@link MISSED_DOSE_SWEEP_MAX_BATCHES} batches). */
export async function runMissedDoseSweepForOrg(
  deps: MissedDoseSweepDeps,
  organizationId: string,
): Promise<MissedDoseSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const orderIds = await overdueOrderIds(deps, organizationId, now);
  if (orderIds.length === 0) return { missed: 0 };
  const controlled = await controlledByOrder(deps, organizationId, orderIds);
  let missed = 0;
  for (let batch = 0; batch < MISSED_DOSE_SWEEP_MAX_BATCHES; batch += 1) {
    const n = await sweepOneBatch(deps, organizationId, now, controlled);
    missed += n;
    if (n < MISSED_DOSE_SWEEP_BATCH_SIZE) break;
  }
  return { missed };
}
