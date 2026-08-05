// M16's live M14 bereavement-risk consumer. The signal enters a durable counselor work queue;
// it does not override M16's evidence-derived risk score or tier.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";

const FLAG = schema.bereavementIdgRiskFlags;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m16.idg-risk-intake: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m16.idg-risk-intake: '${key}' must be a non-empty string`);
  }
  return value;
}

function instantOf(record: Record<string, unknown>, key: string): Date {
  const raw = stringOf(record, key);
  const value = new Date(raw);
  if (Number.isNaN(value.valueOf())) {
    throw new Error(`m16.idg-risk-intake: '${key}' must be an ISO instant`);
  }
  return value;
}

export const M16_IDG_DECISION_CONSUMER = {
  eventName: "idg.decision_recorded",
  consumerName: "m16.idg-risk-intake",
} as const;

export function buildM16IdgDecisionConsumer(deps: { readonly db: DbClient }) {
  return {
    consumerName: "m16.idg-risk-intake" as const,
    consumerModule: "m16" as const,
    eventTypes: ["idg.decision_recorded"] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const envelope = recordOf(event.payload, "payload");
      if (stringOf(envelope, "organizationId") !== event.organizationId) {
        throw new Error("m16.idg-risk-intake: payload organization does not match tenant");
      }
      if (stringOf(envelope, "payloadSchemaVersion") !== "2026-01-v1") {
        throw new Error("m16.idg-risk-intake: unsupported payload schema version");
      }
      const payload = recordOf(envelope.payload, "decision payload");
      if (stringOf(payload, "kind") !== "bereavement_risk_flag") return;
      const riskLevel = stringOf(payload, "riskLevel");
      if (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high") {
        throw new Error(`m16.idg-risk-intake: unsupported risk level '${riskLevel}'`);
      }

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (rawTx) => {
          const tx = rawTx as DbClient;
          await tx
            .insert(FLAG)
            .values({
              organizationId: event.organizationId,
              idgDecisionId: stringOf(envelope, "decisionId"),
              idgMeetingId: stringOf(envelope, "meetingId"),
              patientId: stringOf(envelope, "patientId"),
              riskLevel,
              rationaleText: stringOf(payload, "rationaleText"),
              recordedByMembershipId: stringOf(envelope, "recordedByMembershipId"),
              recordedAt: instantOf(envelope, "recordedAt"),
              status: "pending_assessment",
            })
            .onConflictDoNothing();
        },
      );
    },
  };
}
