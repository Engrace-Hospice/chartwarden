// apps/backend/src/modules/32-ai-platform/events.ts - the M32 outbox emitter (GAP-161).
//
// One small port the Drizzle stores share, built over the real catalog-validating publisher
// (`bindCallerModule(txOutboxPublisher, "m32")`). Every emit is SAME-TRANSACTION: it rides the store
// method's own `withOrgContext` / `withPlatformContext` tx, so the event commits (or rolls back) with the row
// it describes - a validation failure throws and rolls the write back, which is the guarantee the
// transactional outbox exists to give. Platform-scoped events (capability lifecycle, platform kill switch,
// evaluations) publish with `organizationId = null`; their payloads carry `orgId: null` so "this stopped every
// tenant" and "we did not record which tenant" stay different values (events-by-m32.ts decision 5).
import { type DbClient, schema } from "@wardenx/db";
import { eq } from "drizzle-orm";
import type { M32EventName } from "./event-names";

/** The catalog-validating tx publisher slice (`bindCallerModule(txOutboxPublisher, "m32")`). */
export interface M32OutboxPublisher {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string | null;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface M32EmitSpec {
  readonly name: M32EventName;
  /** null => platform-scoped event. */
  readonly organizationId: string | null;
  readonly aggregate: { readonly kind: string; readonly id: string };
  /** Event-specific fields (the emitter adds `orgId` and, unless supplied, `occurredAt`). */
  readonly payload: Record<string, unknown>;
}

export interface M32EventEmitter {
  emitInTx(tx: unknown, spec: M32EmitSpec): Promise<void>;
}

export function createM32EventEmitter(publisher: M32OutboxPublisher): M32EventEmitter {
  return {
    async emitInTx(tx, spec) {
      await publisher.publish(tx as DbClient, {
        eventName: spec.name,
        organizationId: spec.organizationId,
        aggregateKind: spec.aggregate.kind,
        aggregateId: spec.aggregate.id,
        payload: {
          orgId: spec.organizationId,
          occurredAt: new Date().toISOString(),
          ...spec.payload,
        },
      });
    },
  };
}

/** The capability identity every event names (id for joins, key for humans), resolved inside the emit's tx. */
export async function capabilityIdentity(
  tx: unknown,
  by: { readonly id: string } | { readonly key: string },
): Promise<{ capabilityId: string; capabilityKey: string }> {
  const db = tx as DbClient;
  const [row] = await db
    .select({ id: schema.aiCapability.id, key: schema.aiCapability.capabilityKey })
    .from(schema.aiCapability)
    .where(
      "id" in by
        ? eq(schema.aiCapability.id, by.id)
        : eq(schema.aiCapability.capabilityKey, by.key),
    )
    .limit(1);
  if (!row) throw new Error("m32 event: capability not found for the emitted row");
  return { capabilityId: row.id, capabilityKey: row.key };
}
