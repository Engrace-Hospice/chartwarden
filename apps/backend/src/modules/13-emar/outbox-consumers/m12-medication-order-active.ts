import { type DbClient, schema } from "@chartwarden/db";
// apps/backend/src/modules/13-emar/outbox-consumers/m12-medication-order-active.ts — the §2.3 D2
// scheduled-dose materializer, live for the first time (F-166, #248).
//
// `materializeForOrder` (`@chartwarden/emar`, `schedule/schedule-parser.ts`) has been a complete, pure,
// IO-free DST-exact schedule stepper since M13-T03 with NO caller anywhere in this repository —
// `M13_OUTBOX_SUBSCRIPTIONS` (`consumers/index.ts`) has named `m12.medication_order.active` with a real
// consumer (`m13.materialize-schedule`) since the list was written; nothing has ever bound it. One layer
// down: no INSERT into `scheduled_dose` exists anywhere in this repository — the only prior writer of
// that table was the admission-discharge cascade's UPDATE (F-155), which can cancel a row but never
// create one. Every activated medication order therefore had NO administration schedule at all: the
// eMAR "today's doses" read and the missed-dose sweep it feeds have always operated over an empty set.
//
// TENANCY. `medication_order.provider_entity_id`/`location_id` are nullable and NEVER written by M12's
// write path (confirmed — no assignment site exists anywhere in `dosespot-route-service-db.ts`), so
// siting is resolved through M6's org-explicit `admissionSchedulingContextForOrg` seam instead (the
// F-152/F-155 precedent for this exact module boundary — M13's manifest `dependsOn` has no edge to 6). A
// resolved admission with no provider/location siting REFUSES rather than materializes an untenanted row
// — `scheduled_dose.provider_entity_id`/`location_id` are NOT NULL (the three-column tenancy rule).
//
// TIMEZONE. Administration instants are DST-exact in the order's LOCATION timezone
// (`schedule-parser.ts`'s own header). `location.timezone` resolves through M1's `FoundationSiteReader`
// (the sanctioned direct-import path — M13's manifest already depends on module 1, the same precedent
// M6's `admission-route-service-db.ts` uses). An unresolvable location falls back to `@chartwarden/emar`'s
// own documented `DEFAULT_ORDER_TIME_ZONE` — the same fallback M10's `m6-admission-workflow.ts` consumer
// already uses for the identical "location timezone unknown" case.
//
// WINDOW. `windowStartDate` anchors on the ORDER-LOCAL calendar day of `activatedAt`, never "today" at
// consumer-processing time — a redelivery years later still computes the identical window, and
// `materializeForOrder`'s own `notBeforeInstant` (defaulting to `activatedAt`) drops every slot at/before
// activation regardless of when the consumer runs. `windowDays` reads the org's real
// `administration_policy.materialization_window_days` (NOT NULL DEFAULT 7); no policy row falls back to
// the identical literal.
//
// IDEMPOTENCY. `sched_dose_order_due_uk` (organization_id, medication_order_id, due_at) is the redelivery
// guard: `.onConflictDoNothing()` targets it directly, so a second delivery of the same event — or a
// second delivery that happens to compute the same window a first delivery already materialized —
// inserts nothing new. `materializationSequence` is left at its literal `1`: this is the FIRST (and, absent
// a future rolling-window cron, only) materialization pass for a given order; the column exists (per its
// own schema comment) to de-duplicate a REACTIVE pass against a future CRON pass extending the window
// further out, which this change does not add.
import { DEFAULT_ORDER_TIME_ZONE, materializeForOrder, orderLocalDate } from "@chartwarden/emar";
import { withOrgContext } from "@chartwarden/tenancy";
import type { SigStructuredDto } from "@chartwarden/types";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const SD = schema.scheduledDoses;
const POL = schema.administrationPolicy;

export const M13_MATERIALIZE_SCHEDULE_CONSUMER = {
  eventName: "m12.medication_order.active",
  consumerName: "m13.materialize-schedule",
} as const;

const DEFAULT_MATERIALIZATION_WINDOW_DAYS = 7;
const DEFAULT_GRACE_WINDOW_MINUTES = 60;
const DEFAULT_CONTROLLED_GRACE_WINDOW_MINUTES = 30;

/** The admission facts M6 supplies (org-explicit read, injected — M13 does not depend on M6). Mirrors
 *  `m6-reconciliation-triggers.ts`'s `AdmissionAnchor`. */
export interface MaterializeScheduleAdmissionAnchor {
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

/** The M12 order facts M13's materializer needs (org-explicit read, injected — a relay tick is not a
 *  request, so M12's published `MedicationOrderProvider` seam cannot be called from here). Mirrors
 *  `medicationOrderScheduleContextForOrg`'s return shape structurally, not by cross-module type import. */
export interface MaterializeScheduleOrderContext {
  readonly patientId: string;
  readonly admissionId: string;
  readonly isControlledSubstance: boolean;
  readonly route: string;
  readonly activatedAt: string | null;
  readonly sigStructured: SigStructuredDto;
}

export interface MaterializeScheduleConsumerDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
  readonly resolveAdmission: (
    organizationId: string,
    admissionId: string,
  ) => Promise<MaterializeScheduleAdmissionAnchor | null>;
  readonly orderContext: (
    organizationId: string,
    orderId: string,
  ) => Promise<MaterializeScheduleOrderContext | null>;
  /** M1's `FoundationSiteReader.locationTimezone`, injected as a plain function (org-explicit — opens its
   *  own read; no ambient request scope reaches a relay tick). */
  readonly locationTimezone: (organizationId: string, locationId: string) => Promise<string | null>;
}

function orderIdOf(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const orderId = p.orderId;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error(`${M13_MATERIALIZE_SCHEDULE_CONSUMER.consumerName}: payload has no orderId`);
  }
  return orderId;
}

/**
 * M13's live `m12.medication_order.active` binding (§2.3 D2). Materializes `scheduled_dose` rows for the
 * order's DST-exact administration window. A PRN order (or one with no recognizable frequency-code
 * pattern) yields no rows and is a no-op; an unrecognizable frequency code throws `FrequencyParseError`
 * (422) and dead-letters for manual review — the pure parser's own documented refusal.
 */
export function buildM13MaterializeScheduleConsumer(deps: MaterializeScheduleConsumerDeps) {
  return {
    consumerName: M13_MATERIALIZE_SCHEDULE_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: [M13_MATERIALIZE_SCHEDULE_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const orderId = orderIdOf(event.payload);
      const organizationId = event.organizationId;

      const order = await deps.orderContext(organizationId, orderId);
      if (!order) {
        throw new Error(
          `${M13_MATERIALIZE_SCHEDULE_CONSUMER.consumerName}: no M12 order ${orderId} in org ${organizationId}`,
        );
      }
      if (!order.activatedAt) {
        throw new Error(
          `${M13_MATERIALIZE_SCHEDULE_CONSUMER.consumerName}: order ${orderId} has no activatedAt`,
        );
      }

      const anchor = await deps.resolveAdmission(organizationId, order.admissionId);
      if (!anchor || !anchor.providerEntityId || !anchor.locationId) {
        throw new Error(
          `${M13_MATERIALIZE_SCHEDULE_CONSUMER.consumerName}: order ${orderId}'s admission ${order.admissionId} has no provider/location siting`,
        );
      }
      const providerEntityId = anchor.providerEntityId;
      const locationId = anchor.locationId;

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const [policy] = await tx
          .select({
            materializationWindowDays: POL.materializationWindowDays,
            defaultGraceWindowMinutes: POL.defaultGraceWindowMinutes,
            controlledGraceWindowMinutes: POL.controlledGraceWindowMinutes,
          })
          .from(POL)
          .limit(1);
        const windowDays = policy?.materializationWindowDays ?? DEFAULT_MATERIALIZATION_WINDOW_DAYS;
        const graceWindowMinutes = order.isControlledSubstance
          ? (policy?.controlledGraceWindowMinutes ?? DEFAULT_CONTROLLED_GRACE_WINDOW_MINUTES)
          : (policy?.defaultGraceWindowMinutes ?? DEFAULT_GRACE_WINDOW_MINUTES);

        const timeZone =
          (await deps.locationTimezone(organizationId, locationId)) ?? DEFAULT_ORDER_TIME_ZONE;
        const windowStartDate = orderLocalDate(order.activatedAt as string, timeZone);

        const tuples = materializeForOrder(
          {
            route: order.route,
            sigStructured: order.sigStructured,
            activatedAt: order.activatedAt,
          },
          { timeZone, windowStartDate, windowDays },
        );
        if (tuples.length === 0) return; // PRN — no scheduled rows materialize (§2.3)

        const inserted = await tx
          .insert(SD)
          .values(
            tuples.map((t) => ({
              organizationId,
              providerEntityId,
              locationId,
              patientId: order.patientId,
              admissionId: order.admissionId,
              medicationOrderId: orderId,
              dueAt: new Date(t.dueAt),
              graceWindowMinutes,
              expectedDoseAmount: String(t.expectedDoseAmount ?? 0),
              expectedDoseUnit: t.expectedDoseUnit ?? "",
              expectedRoute: t.expectedRoute,
              materializationSequence: 1,
            })),
          )
          .onConflictDoNothing({ target: [SD.organizationId, SD.medicationOrderId, SD.dueAt] })
          .returning({ id: SD.id });

        if (inserted.length === 0) return; // full redelivery — every slot already materialized

        await deps.outbox.publish(tx, {
          eventName: "m13.scheduled_dose.materialized",
          organizationId,
          aggregateKind: "medication_order",
          aggregateId: orderId,
          payload: {
            scheduledDoseIds: inserted.map((r) => r.id),
            medicationOrderId: orderId,
            materializationWindowDays: windowDays,
          },
        });
      });
    },
  };
}
