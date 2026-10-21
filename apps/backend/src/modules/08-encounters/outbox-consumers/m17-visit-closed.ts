// M8 cleanup consumers for M17 visit terminal/superseded states. M17 owns scheduling lifecycle;
// M8 owns the seeded draft clinical record and may only close an unused draft through its own tables.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import type { DispatchableOutboxEvent } from "../../../bootstrap/outbox-dispatcher";

const ENC = schema.encounters;
const VITALS = schema.vitals;
const MILEAGE = schema.mileage;
const LINK = schema.encounterCarePlanLinks;
const SEL = schema.hearthnoteSelections;

export interface M8VisitClosedOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("m8.close-unused-visit-encounter: payload must be an object");
  }
  return value as Record<string, unknown>;
}

function visitIdOf(payload: unknown): string {
  const value = recordOf(payload).visitId;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("m8.close-unused-visit-encounter: visitId must be a non-empty string");
  }
  return value;
}

async function hasMeaningfulDocumentation(tx: DbClient, encounterId: string): Promise<boolean> {
  const [vitals] = await tx
    .select({ id: VITALS.id })
    .from(VITALS)
    .where(eq(VITALS.encounterId, encounterId))
    .limit(1);
  if (vitals) return true;
  const [mileage] = await tx
    .select({ id: MILEAGE.id })
    .from(MILEAGE)
    .where(eq(MILEAGE.encounterId, encounterId))
    .limit(1);
  if (mileage) return true;
  const [link] = await tx
    .select({ id: LINK.id })
    .from(LINK)
    .where(eq(LINK.encounterId, encounterId))
    .limit(1);
  if (link) return true;
  const [selection] = await tx
    .select({ id: SEL.id })
    .from(SEL)
    .where(eq(SEL.encounterId, encounterId))
    .limit(1);
  return Boolean(selection);
}

export function buildM8VisitClosedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M8VisitClosedOutboxPort;
}): {
  readonly consumerName: "m8.close-unused-visit-encounter";
  readonly consumerModule: "m8";
  readonly eventTypes: readonly [
    "m17.visit.cancelled",
    "m17.visit.no_show_detected",
    "m17.visit.rescheduled",
  ];
  handle(event: DispatchableOutboxEvent): Promise<void>;
} {
  return {
    consumerName: "m8.close-unused-visit-encounter",
    consumerModule: "m8",
    eventTypes: ["m17.visit.cancelled", "m17.visit.no_show_detected", "m17.visit.rescheduled"],
    async handle(event) {
      const visitId = visitIdOf(event.payload);
      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (txRaw) => {
          const tx = txRaw as DbClient;
          const [encounter] = await tx
            .select({
              id: ENC.id,
              status: ENC.status,
              authoredByMembershipId: ENC.authoredByMembershipId,
            })
            .from(ENC)
            .where(eq(ENC.visitId, visitId))
            .limit(1);
          if (!encounter || encounter.status === "voided") return;
          if (encounter.status !== "draft") return;
          if (await hasMeaningfulDocumentation(tx, encounter.id)) return;

          const reason =
            event.eventType === "m17.visit.rescheduled"
              ? "System voided unused draft encounter because the scheduled visit was rescheduled."
              : event.eventType === "m17.visit.no_show_detected"
                ? "System voided unused draft encounter because the scheduled visit was marked no-show."
                : "System voided unused draft encounter because the scheduled visit was cancelled.";
          const now = new Date();
          await tx
            .update(ENC)
            .set({
              status: "voided",
              vocabVersionId: "00000000-0000-4000-8000-0000000000d8",
              voidedAt: now,
              voidedBy: encounter.authoredByMembershipId,
              voidedReason: reason,
              updatedAt: now,
            })
            .where(eq(ENC.id, encounter.id));
          await deps.outbox.publish(tx, {
            eventName: "m8.encounter.voided",
            organizationId: event.organizationId,
            aggregateKind: "encounter",
            aggregateId: encounter.id,
            payload: {
              encounterId: encounter.id,
              voidedBy: encounter.authoredByMembershipId,
              voidedReason: reason,
            },
          });
        },
      );
    },
  };
}
