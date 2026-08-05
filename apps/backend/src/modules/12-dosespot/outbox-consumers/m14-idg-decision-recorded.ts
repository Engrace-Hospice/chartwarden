// M12's live M14 medication-recommendation consumer. Recommendations remain unsigned drafts and
// deliberately never infer controlled-substance status or execute a discontinue/change automatically.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { MedicationRecommendationInput } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

const ORDER = schema.medicationOrders;
const APPLICATION = schema.medicationOrderIdgDecisionApplications;

export interface M12IdgAdmissionContext {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly orderingPhysicianMdmId: string;
}

export interface M12IdgConsumerOutboxPort {
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

export const M12_IDG_DECISION_CONSUMER = {
  eventName: "idg.decision_recorded",
  consumerName: "m12.idg-decision-intake",
} as const;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m12.idg-decision-intake: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m12.idg-decision-intake: '${key}' must be a non-empty string`);
  }
  return value;
}

function nullableStringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`m12.idg-decision-intake: '${key}' must be a string or null`);
  }
  return value;
}

function recommendationOf(value: unknown): MedicationRecommendationInput {
  const row = recordOf(value, "medication recommendation");
  const recommendationKind = stringOf(row, "recommendationKind");
  if (
    !["add", "discontinue", "change_dose", "change_route", "change_frequency"].includes(
      recommendationKind,
    )
  ) {
    throw new Error(
      `m12.idg-decision-intake: unsupported recommendationKind '${recommendationKind}'`,
    );
  }
  return {
    recommendationKind: recommendationKind as MedicationRecommendationInput["recommendationKind"],
    drugLabel: stringOf(row, "drugLabel"),
    proposedStrength: nullableStringOf(row, "proposedStrength"),
    proposedRoute: nullableStringOf(row, "proposedRoute"),
    proposedFrequency: nullableStringOf(row, "proposedFrequency"),
    triggeringProblemId: nullableStringOf(row, "triggeringProblemId"),
    rationaleText: stringOf(row, "rationaleText"),
  };
}

export function buildM12IdgDecisionConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M12IdgConsumerOutboxPort;
  resolveAdmissionContext(
    organizationId: string,
    patientId: string,
  ): Promise<M12IdgAdmissionContext | null>;
}) {
  return {
    consumerName: "m12.idg-decision-intake" as const,
    consumerModule: "m12" as const,
    eventTypes: ["idg.decision_recorded"] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const envelope = recordOf(event.payload, "payload");
      if (stringOf(envelope, "organizationId") !== event.organizationId) {
        throw new Error("m12.idg-decision-intake: payload organization does not match tenant");
      }
      if (stringOf(envelope, "payloadSchemaVersion") !== "2026-01-v1") {
        throw new Error("m12.idg-decision-intake: unsupported payload schema version");
      }
      const payload = recordOf(envelope.payload, "decision payload");
      if (stringOf(payload, "kind") !== "medication_recommendation") return;
      if (!Array.isArray(payload.recommendations) || payload.recommendations.length === 0) {
        throw new Error("m12.idg-decision-intake: recommendations must be a non-empty array");
      }
      const recommendations = payload.recommendations.map(recommendationOf);
      const decisionId = stringOf(envelope, "decisionId");
      const patientId = stringOf(envelope, "patientId");
      const actorMembershipId = stringOf(envelope, "recordedByMembershipId");
      const context = await deps.resolveAdmissionContext(event.organizationId, patientId);
      if (!context) {
        throw new Error(
          `m12.idg-decision-intake: patient '${patientId}' has no active admission; preserving event`,
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

          const medicationOrderIds: string[] = [];
          for (const recommendation of recommendations) {
            const [order] = await tx
              .insert(ORDER)
              .values({
                organizationId: event.organizationId,
                providerEntityId: context.providerEntityId,
                locationId: context.locationId,
                patientId,
                admissionId: context.admissionId,
                medClass: "standard",
                isControlledSubstance: false,
                deaSchedule: null,
                drugName: recommendation.drugLabel,
                strength: recommendation.proposedStrength ?? "pending prescriber review",
                doseForm: "pending prescriber review",
                route: recommendation.proposedRoute ?? "pending prescriber review",
                data: {
                  source: "idg_decision",
                  recommendationKind: recommendation.recommendationKind,
                  proposedFrequency: recommendation.proposedFrequency,
                  triggeringProblemId: recommendation.triggeringProblemId,
                  rationaleText: recommendation.rationaleText,
                },
                prescriberMembershipId: actorMembershipId,
                prescribingPhysicianMdmId: context.orderingPhysicianMdmId,
                refillsAuthorized: 0,
                refillsRemaining: 0,
                status: "draft",
                triggeringIdgDecisionId: decisionId,
              })
              .returning({ id: ORDER.id });
            if (!order) {
              throw new Error("m12.idg-decision-intake: medication order insert returned no row");
            }
            medicationOrderIds.push(order.id);
            await deps.outbox.publish(tx, {
              eventName: "m12.medication_order.draft_created",
              organizationId: event.organizationId,
              aggregateKind: "medication_order",
              aggregateId: order.id,
              payload: {
                orderId: order.id,
                patientId,
                medClass: "standard",
                isControlledSubstance: false,
              },
            });
          }
          await tx.insert(APPLICATION).values({
            organizationId: event.organizationId,
            idgDecisionId: decisionId,
            medicationOrderIds,
          });
        },
      );
    },
  };
}
