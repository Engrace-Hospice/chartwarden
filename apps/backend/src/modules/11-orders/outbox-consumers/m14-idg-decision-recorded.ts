// M11's live M14 order-request consumer. IDG recommendations become reviewable draft orders;
// no signature, activation, transmission, or other privileged clinical action is automated.
import { type DbClient, schema } from "@chartwarden/db";
import { ORDER_KIND_VERSION, validateOrderData } from "@chartwarden/orders";
import { withOrgContext } from "@chartwarden/tenancy";
import type { RequestedOrderInput } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";

const ORDER = schema.orderRecords;
const APPLICATION = schema.orderIdgDecisionApplications;

export interface M11IdgAdmissionContext {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly orderingPhysicianMdmId: string;
}

export interface M11IdgConsumerOutboxPort {
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

export const M11_IDG_DECISION_CONSUMER = {
  eventName: "idg.decision_recorded",
  consumerName: "m11.idg-decision-intake",
} as const;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m11.idg-decision-intake: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m11.idg-decision-intake: '${key}' must be a non-empty string`);
  }
  return value;
}

function nullableStringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`m11.idg-decision-intake: '${key}' must be a string or null`);
  }
  return value;
}

function requestedOrderOf(value: unknown): RequestedOrderInput {
  const row = recordOf(value, "requested order");
  const kindHint = stringOf(row, "kindHint");
  if (
    ![
      "lab",
      "dme",
      "level_of_care_change",
      "recertification",
      "comfort_kit",
      "supply",
      "ancillary_service",
      "idg_requested",
    ].includes(kindHint)
  ) {
    throw new Error(`m11.idg-decision-intake: unsupported kindHint '${kindHint}'`);
  }
  return {
    kindHint: kindHint as RequestedOrderInput["kindHint"],
    narrative: stringOf(row, "narrative"),
    recommendedTimeframe: nullableStringOf(row, "recommendedTimeframe"),
    triggeringProblemId: nullableStringOf(row, "triggeringProblemId"),
  };
}

export function buildM11IdgDecisionConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M11IdgConsumerOutboxPort;
  resolveAdmissionContext(
    organizationId: string,
    patientId: string,
  ): Promise<M11IdgAdmissionContext | null>;
}) {
  return {
    consumerName: "m11.idg-decision-intake" as const,
    consumerModule: "m11" as const,
    eventTypes: ["idg.decision_recorded"] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const envelope = recordOf(event.payload, "payload");
      if (stringOf(envelope, "organizationId") !== event.organizationId) {
        throw new Error("m11.idg-decision-intake: payload organization does not match tenant");
      }
      if (stringOf(envelope, "payloadSchemaVersion") !== "2026-01-v1") {
        throw new Error("m11.idg-decision-intake: unsupported payload schema version");
      }
      const payload = recordOf(envelope.payload, "decision payload");
      if (stringOf(payload, "kind") !== "order_request") return;
      if (!Array.isArray(payload.requestedOrders) || payload.requestedOrders.length === 0) {
        throw new Error("m11.idg-decision-intake: requestedOrders must be a non-empty array");
      }
      const requests = payload.requestedOrders.map(requestedOrderOf);
      const decisionId = stringOf(envelope, "decisionId");
      const patientId = stringOf(envelope, "patientId");
      const actorMembershipId = stringOf(envelope, "recordedByMembershipId");
      const context = await deps.resolveAdmissionContext(event.organizationId, patientId);
      if (!context) {
        throw new Error(
          `m11.idg-decision-intake: patient '${patientId}' has no active admission; preserving event`,
        );
      }

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (rawTx) => {
          const tx = rawTx as DbClient;
          const [applied] = await tx
            .select({ id: APPLICATION.id })
            .from(APPLICATION)
            .where(
              and(
                eq(APPLICATION.organizationId, event.organizationId),
                eq(APPLICATION.idgDecisionId, decisionId),
              ),
            )
            .limit(1);
          if (applied) return;

          const orderIds: string[] = [];
          for (const request of requests) {
            // M14 sends `null` for an absent timeframe / triggering problem; the M11 registry types both as
            // optional (absent), not nullable, so a null is left out rather than stored.
            const data = {
              requestedKind: request.kindHint,
              narrative: request.narrative,
              ...(request.recommendedTimeframe !== null
                ? { recommendedTimeframe: request.recommendedTimeframe }
                : {}),
              ...(request.triggeringProblemId !== null
                ? { triggeringProblemId: request.triggeringProblemId }
                : {}),
            };
            const findings = validateOrderData(
              "idg_requested",
              ORDER_KIND_VERSION.idg_requested,
              data,
            );
            if (findings.length)
              throw new Error(
                `M14 idg_requested payload violates the M11 registry: ${findings.map((f) => `${f.field}: ${f.message}`).join("; ")}`,
              );
            const [order] = await tx
              .insert(ORDER)
              .values({
                organizationId: event.organizationId,
                providerEntityId: context.providerEntityId,
                locationId: context.locationId,
                patientId,
                admissionId: context.admissionId,
                kind: "idg_requested",
                kindVersion: "idg_requested.v1",
                data,
                priority: "routine",
                indicationText: request.narrative,
                status: "draft",
                version: 1,
                drafterMembershipId: actorMembershipId,
                drafterDiscipline: "rn",
                orderingPhysicianMdmId: context.orderingPhysicianMdmId,
                triggeringIdgDecisionId: decisionId,
                cosignRequired: false,
                cosignStatus: null,
                transmissionStatus: "not_required",
                resultsStatus: "not_expected",
              })
              .returning({ id: ORDER.id });
            if (!order) throw new Error("m11.idg-decision-intake: order insert returned no row");
            orderIds.push(order.id);
            await deps.outbox.publish(tx, {
              eventName: "m11.order.idg_drafted",
              organizationId: event.organizationId,
              aggregateKind: "order_record",
              aggregateId: order.id,
              payload: {
                orderId: order.id,
                triggeringIdgDecisionId: decisionId,
                kindHint: "idg_requested",
              },
            });
          }
          await tx.insert(APPLICATION).values({
            organizationId: event.organizationId,
            idgDecisionId: decisionId,
            orderIds,
          });
        },
      );
    },
  };
}
