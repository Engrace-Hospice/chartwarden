// apps/backend/src/modules/13-emar/jobs/extend-schedule.ts — the §2.3 mode-2 / §4.8 `m13.extend-schedule`
// per-org worker (GAP-038).
//
// THE FINDING. `scheduled_dose` rows were materialized ONCE at order activation for
// `materialization_window_days` (default 7) and never extended, so any order outliving its first window —
// every hospice maintenance medication — had no doses after day 7: an empty eMAR "today" and, downstream, an
// empty missed-dose denominator.
//
// WHAT A TICK DOES, per org:
//   1. Find the orders that already have a materialized schedule and are not cancelled by a discontinue /
//      discharge cascade (those leave `cancellation_reason IN ('order_discontinued','admission_discharged')`
//      rows behind), activity within {@link EXTEND_SCHEDULE_RECENT_DAYS}.
//   2. For each, read the order through M12's org-explicit seam; only `status = 'active'` orders extend (a
//      completed / discontinued-but-not-yet-cascaded order is skipped).
//   3. Re-run the SAME pure DST-exact stepper the activation consumer uses (`materializeForOrder`), over
//      `[order-local today, today + windowDays)` with `notBeforeInstant = now` — the past is NEVER
//      materialized (a back-filled slot would be swept as "missed" on the very next 15-minute tick).
//   4. Insert with `ON CONFLICT (organization_id, medication_order_id, due_at) DO NOTHING` — the unique
//      index IS the de-duplication against the reactive pass and against a rerun of this cron — stamping
//      `materialization_sequence = max(existing) + 1`, and publish `m13.scheduled_dose.materialized` for the
//      rows that actually landed.
//
// Siting (provider_entity_id / location_id) and patient/admission are copied from the order's existing
// `scheduled_dose` rows, which the activation consumer resolved through M6 — no new cross-module read.
//
// One order's failure (e.g. an unrecognizable frequency code → `FrequencyParseError`) does NOT abort the
// others; failures are collected and thrown together at the end of the org's pass.
import { type DbClient, schema } from "@chartwarden/db";
import { DEFAULT_ORDER_TIME_ZONE, materializeForOrder, orderLocalDate } from "@chartwarden/emar";
import { withOrgContext } from "@chartwarden/tenancy";
import type { SigStructuredDto } from "@chartwarden/types";
import { asc, gte, sql } from "drizzle-orm";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const SD = schema.scheduledDoses;
const POL = schema.administrationPolicy;

export const EXTEND_SCHEDULE_DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_GRACE_WINDOW_MINUTES = 60;
const DEFAULT_CONTROLLED_GRACE_WINDOW_MINUTES = 30;
/** An order whose newest non-cancelled dose is older than this is treated as finished, not stalled. */
export const EXTEND_SCHEDULE_RECENT_DAYS = 30;
/** Orders processed per org per tick. */
export const EXTEND_SCHEDULE_MAX_ORDERS = 1000;
const MS_PER_DAY = 86_400_000;

/** The M12 order facts the extension needs (org-explicit, injected — a cron tick is not a request). */
export interface ExtendScheduleOrderContext {
  readonly status: string;
  readonly isControlledSubstance: boolean;
  readonly route: string;
  readonly activatedAt: string | null;
  readonly sigStructured: SigStructuredDto;
}

export interface ExtendScheduleDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
  readonly orderContext: (
    organizationId: string,
    orderId: string,
  ) => Promise<ExtendScheduleOrderContext | null>;
  /** M1 `FoundationSiteReader.locationTimezone`, injected org-explicit. */
  readonly locationTimezone: (organizationId: string, locationId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

export interface ExtendScheduleResult {
  readonly ordersConsidered: number;
  readonly ordersExtended: number;
  readonly dosesInserted: number;
}

interface ExtensionCandidate {
  readonly orderId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly lastSequence: number;
}

async function readWindowDays(tx: DbClient): Promise<number> {
  const [policy] = await tx
    .select({ windowDays: POL.materializationWindowDays })
    .from(POL)
    .limit(1);
  return policy?.windowDays ?? EXTEND_SCHEDULE_DEFAULT_WINDOW_DAYS;
}

async function readGraceMinutes(tx: DbClient, controlled: boolean): Promise<number> {
  const [policy] = await tx
    .select({
      standard: POL.defaultGraceWindowMinutes,
      controlled: POL.controlledGraceWindowMinutes,
    })
    .from(POL)
    .limit(1);
  return controlled
    ? (policy?.controlled ?? DEFAULT_CONTROLLED_GRACE_WINDOW_MINUTES)
    : (policy?.standard ?? DEFAULT_GRACE_WINDOW_MINUTES);
}

async function findCandidates(tx: DbClient, now: Date): Promise<readonly ExtensionCandidate[]> {
  const recentCutoff = new Date(now.getTime() - EXTEND_SCHEDULE_RECENT_DAYS * MS_PER_DAY);
  const rows = await tx
    .select({
      orderId: SD.medicationOrderId,
      patientId: SD.patientId,
      admissionId: SD.admissionId,
      providerEntityId: SD.providerEntityId,
      locationId: SD.locationId,
      lastSequence: sql<number>`max(${SD.materializationSequence})::int`,
    })
    .from(SD)
    .where(gte(SD.dueAt, recentCutoff))
    .groupBy(SD.medicationOrderId, SD.patientId, SD.admissionId, SD.providerEntityId, SD.locationId)
    // Never extend an order the discontinue / discharge cascade has cut off.
    .having(
      sql`count(*) filter (where ${SD.status} = 'cancelled'
        and ${SD.cancellationReason} in ('order_discontinued', 'admission_discharged')) = 0
        and count(*) filter (where ${SD.status} <> 'cancelled') > 0`,
    )
    .orderBy(asc(SD.medicationOrderId))
    .limit(EXTEND_SCHEDULE_MAX_ORDERS);
  return rows.map((r) => ({ ...r, lastSequence: Number(r.lastSequence) }));
}

async function extendOneOrder(
  deps: ExtendScheduleDeps,
  organizationId: string,
  candidate: ExtensionCandidate,
  now: Date,
  windowDays: number,
): Promise<number> {
  const order = await deps.orderContext(organizationId, candidate.orderId);
  if (!order || order.status !== "active" || !order.activatedAt) return 0;

  const timeZone =
    (await deps.locationTimezone(organizationId, candidate.locationId)) ?? DEFAULT_ORDER_TIME_ZONE;
  const nowIso = now.toISOString();
  const tuples = materializeForOrder(
    { route: order.route, sigStructured: order.sigStructured, activatedAt: order.activatedAt },
    {
      timeZone,
      windowStartDate: orderLocalDate(nowIso, timeZone),
      windowDays,
      notBeforeInstant: nowIso,
    },
  );
  if (tuples.length === 0) return 0; // PRN / nothing in the window

  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const graceWindowMinutes = await readGraceMinutes(tx, order.isControlledSubstance);
    const inserted = await tx
      .insert(SD)
      .values(
        tuples.map((t) => ({
          organizationId,
          providerEntityId: candidate.providerEntityId,
          locationId: candidate.locationId,
          patientId: candidate.patientId,
          admissionId: candidate.admissionId,
          medicationOrderId: candidate.orderId,
          dueAt: new Date(t.dueAt),
          graceWindowMinutes,
          expectedDoseAmount: String(t.expectedDoseAmount ?? 0),
          expectedDoseUnit: t.expectedDoseUnit ?? "",
          expectedRoute: t.expectedRoute,
          materializationSequence: candidate.lastSequence + 1,
        })),
      )
      .onConflictDoNothing({ target: [SD.organizationId, SD.medicationOrderId, SD.dueAt] })
      .returning({ id: SD.id });
    if (inserted.length === 0) return 0;

    await deps.outbox.publish(tx, {
      eventName: "m13.scheduled_dose.materialized",
      organizationId,
      aggregateKind: "medication_order",
      aggregateId: candidate.orderId,
      payload: {
        scheduledDoseIds: inserted.map((r) => r.id),
        medicationOrderId: candidate.orderId,
        materializationWindowDays: windowDays,
      },
    });
    return inserted.length;
  });
}

/** One org's schedule-extension pass. Throws an `AggregateError` AFTER attempting every order if any failed. */
export async function runExtendScheduleForOrg(
  deps: ExtendScheduleDeps,
  organizationId: string,
): Promise<ExtendScheduleResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { windowDays, candidates } = await withOrgContext(
    deps.db,
    { organizationId, userId: "" },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      return { windowDays: await readWindowDays(tx), candidates: await findCandidates(tx, now) };
    },
  );

  let ordersExtended = 0;
  let dosesInserted = 0;
  const failures: { orderId: string; error: unknown }[] = [];
  for (const candidate of candidates) {
    try {
      const n = await extendOneOrder(deps, organizationId, candidate, now, windowDays);
      if (n > 0) {
        ordersExtended += 1;
        dosesInserted += n;
      }
    } catch (error) {
      failures.push({ orderId: candidate.orderId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M13_EXTEND_SCHEDULE: ${failures.length} of ${candidates.length} order(s) failed in org ${organizationId} — ${failures
        .map((f) => f.orderId)
        .join(", ")}`,
    );
  }
  return { ordersConsidered: candidates.length, ordersExtended, dosesInserted };
}
