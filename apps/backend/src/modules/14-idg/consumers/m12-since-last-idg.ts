// apps/backend/src/modules/14-idg/consumers/m12-since-last-idg.ts — the §4.5 "since last IDG" projection
// cache, M12 half (F-164, #248). See `./since-last-idg-cache.ts` for the scope decision (this event is the
// deliberate departure from the seam-vs-push rule, not the redundant-with-a-seam case) and key scheme.
//
// `m12.medication_order.discontinued`'s payload carries no `patientId` or drug label — both resolved via
// M12's org-explicit `medicationOrderPatientAndDrugForOrg` seam (`12-dosespot/seams/drizzle-store.ts`),
// injected as a port rather than read off M12's schema directly (M14's `dependsOn` is `[1, 7, 8, 36]` — no
// edge to 12; `arch:tables` refuses a direct cross-module Drizzle import regardless). The same "a relay
// tick is not a request" reasoning `./m10-since-last-idg.ts` / `./m11-since-last-idg.ts` document applies
// here too — M12's published `MedicationOrderProvider.getMedicationOrder` seam opens every read under
// `withOrgContextFromRequest` and cannot be called from here.
import type Redis from "ioredis";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { appendSinceLastIdgEntry } from "./since-last-idg-cache";

export interface SinceLastIdgMedicationDeps {
  readonly redis: Redis;
  /** M12's org-explicit `medicationOrderPatientAndDrugForOrg` seam, injected as a port. */
  readonly medicationOrderPatientAndDrug: (
    organizationId: string,
    orderId: string,
  ) => Promise<{ readonly patientId: string; readonly drugName: string } | null>;
}

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `m12.medication_order.discontinued` → the shared `medicationChanges` slot. */
export function buildM14MedicationOrderDiscontinuedConsumer(
  deps: SinceLastIdgMedicationDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m14.m12-medication-order-discontinued",
    consumerModule: "m14",
    eventTypes: ["m12.medication_order.discontinued"],
    async handle(event): Promise<void> {
      const orderId = stringField(event.payload, "orderId");
      const effectiveAt = stringField(event.payload, "effectiveAt");
      if (orderId === null || effectiveAt === null) {
        throw new Error("m14.m12-medication-order-discontinued: payload missing a required field");
      }
      const order = await deps.medicationOrderPatientAndDrug(event.organizationId, orderId);
      if (order === null) return; // no matching medication_order in this org — nothing to cache
      await appendSinceLastIdgEntry(deps.redis, order.patientId, "medicationChanges", event.id, {
        _digestId: event.id,
        medicationOrderId: orderId,
        drugLabel: order.drugName,
        changeKind: "discontinued",
        changedAt: effectiveAt,
      });
    },
  };
}
