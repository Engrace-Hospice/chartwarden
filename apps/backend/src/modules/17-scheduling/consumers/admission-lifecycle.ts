import type { DbClient } from "@chartwarden/db";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import {
  type SchedulingAutomationService,
  type SchedulingWriteOutboxPort,
  createDbSchedulingBackend,
} from "../scheduling-route-service-db";

import { M17_SYSTEM_USER_ID } from "../system-actor";

function stringOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m17 admission lifecycle consumer missing payload.${key}`);
  }
  return value;
}

export function buildM17AdmissionLifecycleConsumer(deps: {
  db: DbClient;
  outbox: SchedulingWriteOutboxPort;
}): OutboxConsumerBinding {
  const service = createDbSchedulingBackend(deps.db, deps.outbox) as SchedulingAutomationService;
  return {
    consumerName: "m17.m6-admission-lifecycle",
    consumerModule: "m17",
    eventTypes: ["m6.admission.on_hold", "m6.admission.resumed", "m6.admission.discharged"],
    async handle(event) {
      const payload = event.payload as Record<string, unknown>;
      if (event.eventType === "m6.admission.on_hold") {
        await service.handleAdmissionHold(event.organizationId, M17_SYSTEM_USER_ID, {
          admissionId: stringOf(payload, "admissionId"),
          heldAt: stringOf(payload, "heldAt"),
          reason: stringOf(payload, "reason"),
        });
        return;
      }
      if (event.eventType === "m6.admission.resumed") {
        await service.handleAdmissionResume(event.organizationId, M17_SYSTEM_USER_ID, {
          admissionId: stringOf(payload, "admissionId"),
          resumedAt: stringOf(payload, "resumedAt"),
        });
        return;
      }
      await service.handleAdmissionDischarge(event.organizationId, M17_SYSTEM_USER_ID, {
        admissionId: stringOf(payload, "admissionId"),
        dischargeDate: stringOf(payload, "dischargeDate"),
        reason: stringOf(payload, "reason"),
      });
    },
  };
}
