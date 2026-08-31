// M7 consumers for M6 admission lifecycle events. These consume only M6's public outbox payloads and
// call M7's route service, so M7 does not import M6 internals.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import {
  type CarePlanWriteOutboxPort,
  createDbCarePlanRouteService,
} from "../care-plan-route-service-db";
import { CarePlanAlreadyExistsError } from "../routes/service";

const CP = schema.carePlans;
const CPV = schema.carePlanVersions;

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m7.m6-admission-lifecycle: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m7.m6-admission-lifecycle: '${key}' must be a non-empty string`);
  }
  return value;
}

async function existingPlanForAdmission(
  db: DbClient,
  organizationId: string,
  admissionId: string,
): Promise<{ planId: string; initialVersionCount: number } | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const t = tx as DbClient;
    const [plan] = await t
      .select({ id: CP.id })
      .from(CP)
      .where(eq(CP.admissionId, admissionId))
      .limit(1);
    if (!plan) return null;
    const [count] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(CPV)
      .where(and(eq(CPV.carePlanId, plan.id), eq(CPV.kind, "initial")))
      .limit(1);
    return { planId: plan.id, initialVersionCount: Number(count?.n ?? 0) };
  });
}

export function buildM7AdmissionActivatedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: CarePlanWriteOutboxPort;
}): OutboxConsumerBinding {
  const service = createDbCarePlanRouteService(deps.db, deps.outbox);
  return {
    consumerName: "m7.m6-admission-activated",
    consumerModule: "m7",
    eventTypes: ["m6.admission.activated"],
    async handle(event) {
      const payload = objectOf(event.payload, "event payload");
      const admissionId = stringOf(payload, "admissionId");
      const patientId = stringOf(payload, "patientId");
      const activatedAt = stringOf(payload, "activatedAt");
      try {
        await service.bootstrapCarePlan(event.organizationId, patientId, admissionId, activatedAt);
      } catch (err) {
        if (!(err instanceof CarePlanAlreadyExistsError)) throw err;
        const existing = await existingPlanForAdmission(deps.db, event.organizationId, admissionId);
        if (existing && existing.initialVersionCount === 1) return;
        throw err;
      }
    },
  };
}

export function buildM7AdmissionDischargedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: CarePlanWriteOutboxPort;
}): OutboxConsumerBinding {
  const service = createDbCarePlanRouteService(deps.db, deps.outbox);
  return {
    consumerName: "m7.m6-admission-discharged",
    consumerModule: "m7",
    eventTypes: ["m6.admission.discharged"],
    async handle(event) {
      const payload = objectOf(event.payload, "event payload");
      await service.closeCarePlanForAdmission(
        event.organizationId,
        stringOf(payload, "admissionId"),
        stringOf(payload, "reason"),
        stringOf(payload, "dischargeDate"),
      );
    },
  };
}
