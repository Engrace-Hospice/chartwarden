// apps/backend/src/modules/37-ipu/consumers/m12-medication-order-iv-overlay.ts — the WRITER of
// `ipu_iv_safety_overlay` (M37 §2.6 / D7, GAP-107). Until this file the table had a reader (the
// `IpuIvSafetyOverlayProvider` seam) and an eraser and nothing that ever inserted a row, so every IPU patient on
// a continuous IV infusion — palliative-sedation midazolam included — ran with none of the four §2.6 checks.
//
// SPEC RECONCILIATION (the spec's trigger does not exist). §2.6 / §4.5 name `m11.order.signed` with
// `kind='medication_iv_continuous'`. M11 has no such order kind (its `order_kind` union is lab / dme /
// level_of_care_change / ...): medication orders belong to M12 (`medication_order`), and M12's own spec
// (forward-seam checklist) says M37 "consumes `MedicationOrderProvider` for `administration_route =
// 'iv_continuous'`". So the writer binds to M12's `m12.medication_order.signed` and filters to continuous IV
// infusions (`isIvContinuousOrder`). The overlay's `order_id` is therefore the M12 `medication_order.id` — the
// very id M13's `administration_record.medication_order_id` carries, which is what lets M13 find the overlay.
//
// ORG-EXPLICIT: the tenant is `event.organizationId` (the envelope), never the payload. The M12 order facts
// come through M12's org-explicit `medicationOrderScheduleContextForOrg` (injected as a port: M37 must not read
// M12's tables and M12's published seam needs an ambient request). Every write runs under that org's
// `withOrgContext` as the NOBYPASSRLS app role.
//
// IDEMPOTENT: `iv_overlay_one_per_order` (UNIQUE order_id) + `ON CONFLICT DO NOTHING`; the
// `m37.iv_safety_overlay.required` event is published in the SAME transaction only by the delivery that won the
// insert, so a redelivery re-emits nothing.
//
// FAIL LOUD: a signed order M12 cannot resolve, or a malformed payload, throws so the delivery dead-letters for a
// human — never a silently skipped safety overlay. A signed order that is simply not an IV infusion, or whose
// patient is not on an open IPU admission, is a legitimate no-op.
//
// KNOWN LIMIT (see the spec changelog): the overlay is created when the order is SIGNED, per §2.6. An infusion
// signed while the patient was still at home and continued after an IPU admission is NOT retro-fitted with an
// overlay; M13 then runs with its own order-policy bounds only.
import { type DbClient, schema } from "@chartwarden/db";
import { buildIvSafetyOverlay, isIvContinuousOrder } from "@chartwarden/inpatient";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, notInArray } from "drizzle-orm";
import type { WriteOutboxPort } from "../routes/service-drizzle";

const O = schema.ipuIvSafetyOverlay;
const A = schema.ipuAdmission;

/** F-102's convention: a consumer-driven `withOrgContext` carries no human actor. */
const CONSUMER_USER_ID = "";

/** Admission states in which the patient is no longer on the unit — no overlay is owed. */
const ENDED_ADMISSION_STATES = ["transferred", "discharged", "deceased", "closed"] as const;

/** The M12 order facts the writer needs (M12's `medicationOrderScheduleContextForOrg`, structurally). */
export interface IvOverlayOrderFacts {
  readonly orderId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly route: string;
  readonly drugName: string;
  readonly rxnormRxcui: string | null;
  readonly sigStructured: {
    readonly ivContinuousPolicy?: {
      readonly minRate: number;
      readonly maxRate: number;
      readonly rateUnit?: string;
    };
  };
}

export interface IvOverlayConsumerDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  /** M12's org-explicit order facts; `null` = the order does not resolve in that org. */
  readonly orderContext: (
    organizationId: string,
    orderId: string,
  ) => Promise<IvOverlayOrderFacts | null>;
}

export const M37_IV_OVERLAY_SIGNED_CONSUMER = {
  eventName: "m12.medication_order.signed",
  consumerName: "m37.iv-overlay-on-order-signed",
} as const;

export const M37_IV_OVERLAY_DEACTIVATE_CONSUMER = {
  eventNames: ["m12.medication_order.discontinued", "m12.medication_order.completed"],
  consumerName: "m37.iv-overlay-on-order-ended",
} as const;

/** `rxnorm` is NOT NULL on the row ("M38-validated"); an order with no code is recorded as such, not invented. */
const UNMAPPED_RXNORM = "unmapped";

function orderIdOf(consumerName: string, payload: unknown): string {
  const orderId = ((payload ?? {}) as Record<string, unknown>).orderId;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error(`${consumerName}: payload has no orderId`);
  }
  return orderId;
}

function requireOrganization(consumerName: string, organizationId: unknown): string {
  if (typeof organizationId !== "string" || organizationId.length === 0) {
    throw new Error(`${consumerName}: the event carries no organization`);
  }
  return organizationId;
}

/** The finite bound to persist, or null (numeric(10,4) cannot hold Infinity; null reads back as unbounded). */
const finiteOrNull = (n: number): string | null => (Number.isFinite(n) ? String(n) : null);

/**
 * M37's live `m12.medication_order.signed` binding: a continuous-IV order signed for a patient with an open IPU
 * admission gets its `ipu_iv_safety_overlay` row, and M13's pre-administration gate then enforces it.
 */
export function buildM37IvOverlayOnOrderSignedConsumer(deps: IvOverlayConsumerDeps) {
  const name = M37_IV_OVERLAY_SIGNED_CONSUMER.consumerName;
  return {
    consumerName: name,
    consumerModule: "m37" as const,
    eventTypes: [M37_IV_OVERLAY_SIGNED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const organizationId = requireOrganization(name, event.organizationId);
      const orderId = orderIdOf(name, event.payload);

      const order = await deps.orderContext(organizationId, orderId);
      if (!order) throw new Error(`${name}: medication order ${orderId} does not resolve`);
      const policy = order.sigStructured.ivContinuousPolicy;
      if (!isIvContinuousOrder({ route: order.route, hasIvContinuousPolicy: policy !== undefined }))
        return;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [admission] = await tx
            .select({ id: A.id })
            .from(A)
            .where(
              and(
                eq(A.organizationId, organizationId),
                eq(A.admissionId, order.admissionId),
                notInArray(A.state, [...ENDED_ADMISSION_STATES]),
              ),
            )
            .orderBy(desc(A.openedAt))
            .limit(1);
          if (!admission) return; // not on an IPU: §2.6 owes no overlay

          const fields = buildIvSafetyOverlay({
            medicationDisplayName: order.drugName,
            ...(policy ? { orderPolicy: policy } : {}),
          });
          const [inserted] = await tx
            .insert(O)
            .values({
              organizationId,
              ipuAdmissionId: admission.id,
              orderId,
              medicationRxNormCode: order.rxnormRxcui ?? UNMAPPED_RXNORM,
              titrationMinRate: finiteOrNull(fields.titrationMinRate),
              titrationMaxRate: finiteOrNull(fields.titrationMaxRate),
              rateUnit: fields.rateUnit,
              dualWitnessRequired: fields.dualWitnessRequired,
              maxContinuousDurationHours: fields.maxContinuousDurationHours,
              bedsideCheckIntervalMinutes: fields.bedsideCheckIntervalMinutes,
              isSedationClass: fields.isSedationClass,
            })
            .onConflictDoNothing({ target: O.orderId })
            .returning({ id: O.id });
          if (!inserted) return; // a redelivery: the overlay (and its event) already exist

          await deps.outbox.publish(tx, {
            eventName: "m37.iv_safety_overlay.required",
            payload: {
              ipuAdmissionId: admission.id,
              organizationId,
              orderId,
              isSedationClass: fields.isSedationClass,
            },
            organizationId,
            aggregateKind: "ipu_iv_safety_overlay",
            aggregateId: inserted.id,
          });
        },
      );
    },
  };
}

/**
 * M37's live `m12.medication_order.discontinued` / `.completed` binding (the M12 equivalent of §4.5's
 * `m11.order.discontinued` row): the order's overlay stops gating. Idempotent — a second delivery matches no
 * active row.
 */
export function buildM37IvOverlayOnOrderEndedConsumer(deps: Pick<IvOverlayConsumerDeps, "db">) {
  const name = M37_IV_OVERLAY_DEACTIVATE_CONSUMER.consumerName;
  return {
    consumerName: name,
    consumerModule: "m37" as const,
    eventTypes: M37_IV_OVERLAY_DEACTIVATE_CONSUMER.eventNames,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const organizationId = requireOrganization(name, event.organizationId);
      const orderId = orderIdOf(name, event.payload);
      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [row] = await tx
            .select({ version: O.version })
            .from(O)
            .where(
              and(
                eq(O.organizationId, organizationId),
                eq(O.orderId, orderId),
                eq(O.overlayActive, true),
              ),
            )
            .limit(1);
          if (!row) return;
          await tx
            .update(O)
            .set({ overlayActive: false, updatedAt: new Date(), version: row.version + 1 })
            .where(and(eq(O.orderId, orderId), eq(O.version, row.version)));
        },
      );
    },
  };
}
