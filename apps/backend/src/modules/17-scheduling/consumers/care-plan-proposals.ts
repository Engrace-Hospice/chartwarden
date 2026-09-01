import type { DbClient } from "@wardenx/db";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import {
  type SchedulingAutomationService,
  type SchedulingWriteOutboxPort,
  createDbSchedulingBackend,
} from "../scheduling-route-service-db";

const M17_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000017";

function stringOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m17 care-plan proposal consumer missing payload.${key}`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildM17CarePlanProposalConsumer(deps: {
  db: DbClient;
  outbox: SchedulingWriteOutboxPort;
}): OutboxConsumerBinding {
  const service = createDbSchedulingBackend(deps.db, deps.outbox) as SchedulingAutomationService;
  return {
    consumerName: "m17.m7-care-plan-proposals",
    consumerModule: "m17",
    eventTypes: ["m7.care_plan.version_signed"],
    async handle(event) {
      const payload = event.payload as Record<string, unknown>;
      const patientId = optionalString(payload, "patientId");
      const admissionId = optionalString(payload, "admissionId");
      if (!patientId || !admissionId) return;
      await service.generateCarePlanVisitProposals(event.organizationId, M17_SYSTEM_USER_ID, {
        planId: stringOf(payload, "planId"),
        versionId: stringOf(payload, "versionId"),
        patientId,
        admissionId,
      });
    },
  };
}
