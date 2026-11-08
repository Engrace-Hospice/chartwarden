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
import { ChartWardenError, ForbiddenError, NotFoundError } from "@chartwarden/types";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import {
  RESOLVED_NOT_SENT_CLASS,
  RESOLVED_SENT_CLASS,
  UNCONFIRMED_OUTCOME_CLASS,
} from "../jobs/hold";
import { isPrescriptionIdTaken, lockPrescriptionId } from "../prescription-id";
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

/**
 * What the caller's authorization established, said explicitly by the ROUTE after its permission check (`prescribing.clinic.admin` + a fresh
 * step-up): the service does not assume it. The order machine refuses a resolution without it.
 */
export interface ResolveHeldAuthorization {
  readonly actorIsAdministrator: boolean;
}

export interface TransmissionResolveService {
  resolve(
    actor: ResolveHeldActor,
    orderId: string,
    input: ResolveHeldInput,
    authorization: ResolveHeldAuthorization,
  ): Promise<ResolveHeldResult>;
}

export interface TransmissionResolveDeps {
  readonly db: DbClient;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly audit: ClinicAuditPort;
  readonly now?: () => Date;
  /**
   * A structured warning (pino's `(fields, message)` shape): ids and the error's class only. REQUIRED: an unexpected fault of the resolve
   * transaction is rethrown WITHOUT its cause (a database error embeds the bound values, the administrator's free-text reason among them),
   * so this is the only place it is seen.
   */
  readonly warn: (fields: Record<string, string>, message: string) => void;
}

/** The shortest reason that can say what an administrator checked (the request schema's minimum, applied after trimming). */
const MIN_REASON_LENGTH = 10;

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
    authorization: ResolveHeldAuthorization,
  ): Promise<ResolveHeldResult> {
    const { organizationId } = actor;
    if (!authorization.actorIsAdministrator) {
      throw new ForbiddenError("only an organization administrator can resolve a held transmission");
    }
    const prescriptionId = input.dosespotPrescriptionId?.trim() ?? "";
    // the schema's length counts padding: a reason must say something once trimmed (and that is what is stored)
    const reason = input.reason.trim();
    if (reason.length < MIN_REASON_LENGTH) {
      throw new ChartWardenError(
        "DOSESPOT_REASON_REQUIRED",
        `a reason of at least ${MIN_REASON_LENGTH} characters is required (what you checked)`,
        422,
      );
    }
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
    try {
      return await resolveInTx(actor, orderId, input, authorization, prescriptionId, reason);
    } catch (error) {
      if (error instanceof ChartWardenError) throw error; // typed refusals carry fixed messages
      // anything else (a database fault, a deadlock) may carry the bound values, the reason among them: log ids and the class, rethrow bare
      deps.warn(
        {
          organizationId,
          orderId,
          outcome: input.outcome,
          cause: error instanceof Error ? error.name : "unknown",
        },
        "DoseSpot held-transmission resolution failed; nothing was changed",
      );
      throw new ChartWardenError(
        "DOSESPOT_RESOLVE_FAILED",
        "the held order could not be resolved; nothing was changed, try again",
        500,
      );
    }
  }

  function resolveInTx(
    actor: ResolveHeldActor,
    orderId: string,
    input: ResolveHeldInput,
    authorization: ResolveHeldAuthorization,
    prescriptionId: string,
    reason: string,
  ): Promise<ResolveHeldResult> {
    const { organizationId } = actor;
    return withOrgContext(
      deps.db,
      { organizationId, userId: actor.userId },
      async (rawTx): Promise<ResolveHeldResult> => {
        const tx = rawTx as DbClient;
        const at = now();
        // a "sent" resolution records an id webhooks will bind by: the per-(org, id) advisory lock comes FIRST (the lock order every writer of an
        // id follows), so two writers of one id are serialized and the check below cannot be raced
        if (input.outcome === "sent") await lockPrescriptionId(tx, organizationId, prescriptionId);
        // the order row is the lock every other writer of this order (the worker, the drain, another resolution) also takes
        // RLS scopes the session to its org; the explicit org predicate is defence in depth (a mis-set GUC must not reach another org's order)
        const [order] = await tx
          .select()
          .from(MO)
          .where(and(eq(MO.id, orderId), eq(MO.organizationId, organizationId)))
          .limit(1)
          .for("update");
        if (!order) throw new NotFoundError(`medication order ${orderId} not found`);
        const [t] = await tx
          .select()
          .from(MOT)
          .where(and(eq(MOT.medicationOrderId, orderId), eq(MOT.organizationId, organizationId)))
          .orderBy(desc(MOT.queuedAt))
          .limit(1)
          .for("update");
        const held =
          order.status === "queued_for_transmission" &&
          order.dosespotSendState === "in_flight" &&
          t !== undefined &&
          t.lastErrorClass === UNCONFIRMED_OUTCOME_CLASS &&
          // the MARKER says held: transmission_failed_at is not part of it (an earlier retryable failure set it and the backoff needs it kept)
          t.transmissionSucceededAt === null;
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
          if (await isPrescriptionIdTaken(tx, organizationId, prescriptionId, orderId)) {
            throw new ChartWardenError(
              "DOSESPOT_PRESCRIPTION_ID_IN_USE",
              "another order of this organization already carries that DoseSpot prescription id; check the id you entered",
              409,
            );
          }
          transitionMedicationOrder("queued_for_transmission", {
            type: "resolveHeldSent",
            actorIsAdministrator: authorization.actorIsAdministrator,
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
              lastErrorDetail: reason,
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
            actorIsAdministrator: authorization.actorIsAdministrator,
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
              lastErrorDetail: reason,
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
