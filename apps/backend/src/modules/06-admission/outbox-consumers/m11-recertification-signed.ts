// apps/backend/src/modules/06-admission/outbox-consumers/m11-recertification-signed.ts — the live
// `m11.order.recertification_signed` → "open the next PENDING election period" binding (F-223, #248).
//
// M11 D10 (WARDENX_MODULE_11_ORDERS_SPEC §11): "Recertification orders are advisory; M6 owns CTI / F2F
// enforcement, period sequencing, and benefit-period state. M11 emits `m11.order.recertification_signed`;
// M6 subscribes and ... transitions the next period." The user APPROVED the reading that a signed recert
// order auto-opens the next pending period (F-217 had reduced the blocker from a design gap to that one
// decision).
//
// WHAT THIS DOES NOT DO — and why it cannot bypass the CoP gate. It opens a PENDING shell only, through the
// SAME `openNextElectionPeriodInTx` the `POST /election-periods` route uses. The F2F + CTI adequacy gate
// (`evaluatePeriodAdequacy`, 06-admission/certification/adequacy.ts) is enforced at ACTIVATION
// (`signCtiHospiceMd`), which this consumer never calls; the CTI / F2F rows reference the period
// (`election_period_id` NOT NULL), so they cannot exist before it. Nothing is activated, signed or certified
// here.
//
// IDEMPOTENCY. Migration 0297 adds `election_period.source_order_id` (logical uuid — M6's dependsOn
// excludes M11 — plus plain UNIQUE(organization_id, source_order_id), the F-159 / 0250 precedent). The
// consumer (a) skips when a period already carries the order id, (b) skips when a period with a higher
// sequence than the matched active one already exists (staff opened it manually — no duplicate pending
// period), and (c) inserts `ON CONFLICT DO NOTHING` so a concurrent delivery or a racing manual open loses
// quietly rather than aborting the tx.
//
// SETTLE vs RETRY. Deterministic no-ops (unknown / cross-tenant admission, admission not active or on hold,
// no ACTIVE period whose `scheduled_end_at` equals the payload's `periodEndDate`, malformed payload) RETURN
// — the dispatcher records a delivery, nothing retries. Only transient/infrastructure errors (db failure,
// publisher failure) propagate so the dispatcher retries. Consumers are not requests: everything runs under
// an explicit `withOrgContext` for the event's org.
//
// `periodEndDate` is the CURRENT period's end (M11 spec §2282: `data.periodEndDate=<curr period end>`),
// `scheduled_end_at` being the INCLUSIVE last covered day (state-machines/election-period.ts).
//
// The event name is a STRING literal and no M11 schema is imported — M6 reads M11 solely through the
// foundation outbox (the `m11-level-of-care-change-signed.ts` precedent), so no `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  type AdmissionWriteOutboxPort,
  openNextElectionPeriodInTx,
} from "../admission-route-service-db";

export const M6_RECERTIFICATION_SIGNED_CONSUMER = {
  eventName: "m11.order.recertification_signed",
  consumerName: "m6.recertification-signed",
} as const;

/** Structural binding (matches the dispatcher's `OutboxConsumerBinding` without importing bootstrap). */
export interface M6RecertificationSignedConsumerBinding {
  readonly consumerName: typeof M6_RECERTIFICATION_SIGNED_CONSUMER.consumerName;
  readonly consumerModule: "m6";
  readonly eventTypes: readonly [typeof M6_RECERTIFICATION_SIGNED_CONSUMER.eventName];
  handle(event: { readonly organizationId: string; readonly payload: unknown }): Promise<void>;
}

export interface M6RecertificationSignedConsumerDeps {
  readonly db: DbClient;
  readonly outbox: AdmissionWriteOutboxPort;
}

/** What one delivery resolved to — `opened` is the only state-changing outcome; every other is a settle. */
export type RecertificationSignedOutcome =
  | { readonly kind: "opened"; readonly electionPeriodId: string; readonly sequence: number }
  | {
      readonly kind: "settled";
      readonly reason:
        | "invalid_payload"
        | "already_applied"
        | "next_period_exists"
        | "admission_not_found"
        | "admission_not_open"
        | "no_matching_active_period";
    };

const OPEN_ADMISSION_STATUSES: readonly string[] = ["active", "on_hold"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The dispatcher's own system-attribution convention (F-102) for a consumer-driven write. */
const CONSUMER_USER_ID = "";

/** Run one delivery; exported so tests can assert the exact settle reason. */
export async function applyRecertificationSigned(
  deps: M6RecertificationSignedConsumerDeps,
  event: { readonly organizationId: string; readonly payload: unknown },
): Promise<RecertificationSignedOutcome> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const { orderId, admissionId, periodEndDate } = p;
  if (
    typeof orderId !== "string" ||
    orderId.length === 0 ||
    typeof admissionId !== "string" ||
    admissionId.length === 0 ||
    typeof periodEndDate !== "string" ||
    !ISO_DATE.test(periodEndDate)
  ) {
    return { kind: "settled", reason: "invalid_payload" };
  }
  const organizationId = event.organizationId;
  const EP = schema.electionPeriods;
  const ADM = schema.admissions;

  return withOrgContext(
    deps.db,
    { organizationId, userId: CONSUMER_USER_ID },
    async (tx): Promise<RecertificationSignedOutcome> => {
      // (a) redelivery of an already-applied order.
      const [already] = await tx
        .select({ id: EP.id })
        .from(EP)
        .where(and(eq(EP.organizationId, organizationId), eq(EP.sourceOrderId, orderId)))
        .limit(1);
      if (already) return { kind: "settled", reason: "already_applied" };

      // RLS scopes this to the event's org: a cross-tenant admission id resolves to no row.
      const [adm] = await tx
        .select({ status: ADM.status })
        .from(ADM)
        .where(and(eq(ADM.id, admissionId), eq(ADM.organizationId, organizationId)))
        .limit(1);
      if (!adm) return { kind: "settled", reason: "admission_not_found" };
      if (!OPEN_ADMISSION_STATUSES.includes(adm.status)) {
        return { kind: "settled", reason: "admission_not_open" };
      }

      const [current] = await tx
        .select({ id: EP.id, sequence: EP.sequenceNumber })
        .from(EP)
        .where(
          and(
            eq(EP.admissionId, admissionId),
            eq(EP.status, "active"),
            eq(EP.scheduledEndAt, periodEndDate),
          ),
        )
        // Highest sequence wins: a superseded period can still read `active` (activation of period N+1
        // does not flip N) and two periods can share an end date — the latest one is the current one.
        .orderBy(desc(EP.sequenceNumber))
        .limit(1);
      if (!current) return { kind: "settled", reason: "no_matching_active_period" };

      // (b) a later period (manual open, or a prior order) already exists — never a duplicate pending one.
      const [later] = await tx
        .select({ id: EP.id })
        .from(EP)
        .where(
          and(eq(EP.admissionId, admissionId), gt(EP.sequenceNumber, Number(current.sequence))),
        )
        .limit(1);
      if (later) return { kind: "settled", reason: "next_period_exists" };

      // (c) the shared, route-identical PENDING insert on this same tx (`m6.election.period_started` fires
      //     later, when the period actually starts on its start date — recert-period-activation.ts).
      const opened = await openNextElectionPeriodInTx(tx, {
        organizationId,
        admissionId,
        sourceOrderId: orderId,
      });
      if (!opened) return { kind: "settled", reason: "next_period_exists" };
      return { kind: "opened", electionPeriodId: opened.id, sequence: opened.sequence };
    },
  );
}

/** Build the live `m11.order.recertification_signed` consumer the composition root registers. */
export function buildM6RecertificationSignedConsumer(
  deps: M6RecertificationSignedConsumerDeps,
): M6RecertificationSignedConsumerBinding {
  return {
    consumerName: M6_RECERTIFICATION_SIGNED_CONSUMER.consumerName,
    consumerModule: "m6" as const,
    eventTypes: [M6_RECERTIFICATION_SIGNED_CONSUMER.eventName] as const,
    async handle(event) {
      await applyRecertificationSigned(deps, event);
    },
  };
}
