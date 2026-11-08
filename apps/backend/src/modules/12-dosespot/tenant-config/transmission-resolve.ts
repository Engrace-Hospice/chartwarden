// apps/backend/src/modules/12-dosespot/tenant-config/transmission-resolve.ts — an organization administrator's resolution of an order HELD for an
// unconfirmed DoseSpot outcome (review of slice 4, MEDIUM-1).
//
// THE PROBLEM. When DoseSpot accepted a NewRx call but its answer is unknown, the transmit worker holds the order (`queued_for_transmission` /
// `in_flight`, its transmission row marked `unconfirmed_outcome`): it must neither fail it (it may exist at the pharmacy) nor re-send it (a second
// send could dispense twice). Nothing in the order machine could take such an order anywhere, so the hold had no way out.
//
// THE RESOLUTION. An administrator checks the prescriber's DoseSpot account and says which it was:
//   sent      the prescription is there: enter its DoseSpot prescription id. The order becomes `transmitted` with the vendor id recorded, the
//             `m12.medication_order.transmitted` event goes out as for a worker success, and the status poll follows it as for any transmitted order.
//   not_sent  it is not there: the order becomes `transmission_failed` (and `m12.medication_order.transmission_failed` goes out), whose only way on
//             is the existing retransmit, where the prescriber signs a replacement. It is NEVER put back on the queue, so it is never sent again.
// Both are one transaction under `FOR UPDATE` on the order row and are accepted ONLY while the hold marker is still on the transmission row, so two
// resolutions, or a resolution racing the recovery drain (which never touches a held order), cannot both win: the loser answers 409
// `DOSESPOT_TRANSMISSION_NOT_HELD`. The administrator's free-text reason is stored on the transmission row's `last_error_detail`, which the write-audit
// trigger denylists (it can hold PHI fragments); the audit entry written here carries ids and the outcome only.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { transitionMedicationOrder } from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import {
  RESOLVED_NOT_SENT_CLASS,
  RESOLVED_SENT_CLASS,
  UNCONFIRMED_OUTCOME_CLASS,
} from "../jobs/hold";
import { CLINIC_AUDIT_EVENTS, type ClinicAuditPort } from "./audit-port";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;

export type HeldResolution = "sent" | "not_sent";

export interface ResolveHeldActor {
  readonly organizationId: string;
  /** The session's user id (declared as `app.user_id` for the transaction). */
  readonly userId: string;
  readonly membershipId: string;
  readonly request?: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

export interface ResolveHeldInput {
  readonly outcome: HeldResolution;
  /** Why the administrator concluded that: kept on the transmission row (denylisted from the audit image), never in an event or an audit entry. */
  readonly reason: string;
  /** The DoseSpot prescription id the administrator found: required for `sent`, refused for `not_sent`. */
  readonly dosespotPrescriptionId?: string;
}

export interface ResolveHeldResult {
  readonly orderId: string;
  readonly outcome: HeldResolution;
  readonly status: "transmitted" | "transmission_failed";
}

export interface TransmissionResolveService {
  resolve(
    actor: ResolveHeldActor,
    orderId: string,
    input: ResolveHeldInput,
  ): Promise<ResolveHeldResult>;
}

export interface TransmissionResolveDeps {
  readonly db: DbClient;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly audit: ClinicAuditPort;
  readonly now?: () => Date;
}

const notHeld = (): ChartWardenError =>
  new ChartWardenError(
    "DOSESPOT_TRANSMISSION_NOT_HELD",
    "this order is not held for an unconfirmed DoseSpot outcome (it may already have been resolved)",
    409,
  );

export function createTransmissionResolveService(
  deps: TransmissionResolveDeps,
): TransmissionResolveService {
  const now = deps.now ?? (() => new Date());

  async function resolve(
    actor: ResolveHeldActor,
    orderId: string,
    input: ResolveHeldInput,
  ): Promise<ResolveHeldResult> {
    const { organizationId } = actor;
    const prescriptionId = input.dosespotPrescriptionId?.trim() ?? "";
    if (input.outcome === "sent" && prescriptionId === "") {
      throw new ChartWardenError(
        "DOSESPOT_PRESCRIPTION_ID_REQUIRED",
        "resolving a held order as sent needs the DoseSpot prescription id",
        422,
      );
    }
    if (input.outcome === "not_sent" && prescriptionId !== "") {
      throw new ChartWardenError(
        "DOSESPOT_PRESCRIPTION_ID_UNEXPECTED",
        "a DoseSpot prescription id belongs to a held order that WAS sent, not to one that was not",
        422,
      );
    }
    return withOrgContext(
      deps.db,
      { organizationId, userId: actor.userId },
      async (rawTx): Promise<ResolveHeldResult> => {
        const tx = rawTx as DbClient;
        const at = now();
        // the order row is the lock every other writer of this order (the worker, the drain, another resolution) also takes
        const [order] = await tx.select().from(MO).where(eq(MO.id, orderId)).limit(1).for("update");
        if (!order) throw new NotFoundError(`medication order ${orderId} not found`);
        const [t] = await tx
          .select()
          .from(MOT)
          .where(eq(MOT.medicationOrderId, orderId))
          .orderBy(desc(MOT.queuedAt))
          .limit(1)
          .for("update");
        const held =
          order.status === "queued_for_transmission" &&
          order.dosespotSendState === "in_flight" &&
          t !== undefined &&
          t.lastErrorClass === UNCONFIRMED_OUTCOME_CLASS &&
          t.transmissionSucceededAt === null &&
          t.transmissionFailedAt === null;
        if (!held) throw notHeld();

        const emit = (eventName: string, payload: Record<string, unknown>) =>
          deps.outbox.publish(tx, {
            eventName,
            payload,
            organizationId,
            aggregateKind: "medication_order",
            aggregateId: orderId,
          });

        let result: ResolveHeldResult;
        if (input.outcome === "sent") {
          transitionMedicationOrder("queued_for_transmission", {
            type: "resolveHeldSent",
            actorIsAdministrator: true,
            dosespotPrescriptionId: prescriptionId,
          });
          const digest = createHash("sha256")
            .update(`${prescriptionId}|${at.toISOString()}`)
            .digest("hex");
          const moved = await tx
            .update(MO)
            .set({
              status: "transmitted",
              dosespotSendState: "transmitted",
              dosespotPrescriptionId: prescriptionId,
              transmittedAt: at,
              version: sql`${MO.version} + 1`,
              updatedAt: at,
            })
            .where(and(eq(MO.id, orderId), eq(MO.dosespotSendState, "in_flight")))
            .returning({ id: MO.id });
          if (moved.length !== 1) throw notHeld();
          await tx
            .update(MOT)
            .set({
              transmissionSucceededAt: at,
              dosespotPrescriptionId: prescriptionId,
              dosespotResponseDigest: digest,
              lastErrorClass: RESOLVED_SENT_CLASS,
              lastErrorDetail: input.reason,
            })
            .where(eq(MOT.id, t.id));
          await emit("m12.medication_order.transmitted", {
            orderId,
            dosespotPrescriptionId: prescriptionId,
            transmittedAt: at.toISOString(),
            dispensingPharmacyMdmId: order.dispensingPharmacyMdmId ?? null,
          });
          result = { orderId, outcome: "sent", status: "transmitted" };
        } else {
          transitionMedicationOrder("queued_for_transmission", {
            type: "resolveHeldNotSent",
            actorIsAdministrator: true,
          });
          const moved = await tx
            .update(MO)
            .set({
              status: "transmission_failed",
              dosespotSendState: "failed",
              version: sql`${MO.version} + 1`,
              updatedAt: at,
            })
            .where(and(eq(MO.id, orderId), eq(MO.dosespotSendState, "in_flight")))
            .returning({ id: MO.id });
          if (moved.length !== 1) throw notHeld();
          await tx
            .update(MOT)
            .set({
              transmissionFailedAt: at,
              lastErrorClass: RESOLVED_NOT_SENT_CLASS,
              lastErrorDetail: input.reason,
            })
            .where(eq(MOT.id, t.id));
          await emit("m12.medication_order.transmission_failed", {
            orderId,
            lastErrorClass: RESOLVED_NOT_SENT_CLASS,
            retryCount: t.retryCount,
          });
          result = { orderId, outcome: "not_sent", status: "transmission_failed" };
        }
        await deps.audit.record(tx, {
          organizationId,
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId,
          eventType: CLINIC_AUDIT_EVENTS.transmissionResolved,
          resourceKind: "medication_order",
          resourceId: orderId,
          changedFields: ["status", "dosespotSendState"],
          // ids and the outcome only: the reason is on the transmission row (denylisted), the prescription id on the order itself
          detail: { transmissionId: t.id, outcome: input.outcome },
          ...(actor.request ? { request: actor.request } : {}),
        });
        return result;
      },
    );
  }

  return { resolve };
}
