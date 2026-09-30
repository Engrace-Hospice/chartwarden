// apps/backend/src/modules/30-quality/outbox-consumers/m18-evv-visit-verified.ts — F-194 (#248).
//
// The `OutboxConsumerBinding` for M30's previously-declared-but-unbound `m18.evv.visit_verified` topic —
// calls the real, already-built `handleEvvVisitVerified` (`packages/quality/src/consumers/handlers.ts`),
// which enqueues an HVLDL measure recompute when the verified visit sits within ±3 days of a death
// (`subscription-map.ts`'s `hvldl_near_death_recompute` effect). This binding was the only missing piece:
// the pure handler and the subscription-map effect both already existed, unwired.
//
// PROVIDER-ENTITY RESOLUTION: the catalogued wire payload (`events-by-m18.ts`) carries only
// `{visitId, patientId, organizationId, verifiedAt}` — no `providerEntityId` — while
// `measure_recompute_queue.provider_entity_id` is NOT NULL. Resolved via the NEW org-explicit
// `evvVisitProviderEntityForOrg` read (`../../18-evv/seams/evv-visit-provider-entity-for-org.ts`), the
// `restraintAdmissionSitingForOrg`/`bereavementPlanSitingForOrg` shape reused a third time. M30's manifest
// `dependsOn` is `[1, 2, 3, 4, 10, 23, 27, 36, 38]` — it does NOT include 18 — so this cannot be imported
// directly across the boundary; injected as a PORT, the F-160 `CapConsumerStore` shape.
//
// DEATH-PROXIMITY RESOLUTION: deliberately NOT resolved here. `handleEvvVisitVerified`'s own doc comment
// treats `nearestDeathWithinDays` as an optional refinement a binding MAY supply — when omitted, the
// handler enqueues unconditionally ("the ±3-day debounce is the storm backstop, so it never silently
// drops"). Building a per-patient nearest-death-date lookup (a new M6 discharge-disposition read, scoped
// to a window around `verifiedAt`) is real additional infrastructure the handler's own contract does not
// require for a correct, if less precise, binding — out of scope for this wiring round. A future round MAY
// add it to cut the false-positive enqueue rate; this binding is correct without it.
//
// A `visitId` this org does not recognise (cross-tenant, or a stale redelivery) is a NO-OP, not a
// dead-letter — the same null-on-miss contract this arc's other M30 upstream consumers already establish.
import type { DbClient } from "@wardenx/db";
import { handleEvvVisitVerified } from "@wardenx/quality";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { buildM30UpstreamConsumerPorts } from "./upstream-consumer-ports";

/** The M18 seam, injected as a port — see the file header for why this cannot be a direct import. */
export type EvvVisitProviderEntityForOrg = (
  db: DbClient,
  organizationId: string,
  visitId: string,
) => Promise<{ readonly providerEntityId: string } | null>;

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m30.m18-evv-visit-verified: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m30.m18-evv-visit-verified: '${key}' must be a non-empty string`);
  }
  return value;
}

export function buildM30VisitVerifiedConsumer(deps: {
  readonly db: DbClient;
  /** M18's org-explicit `evvVisitProviderEntityForOrg` seam, injected as a port — M30's manifest
   *  `dependsOn` excludes 18 (see the file header). */
  readonly evvVisitProviderEntityForOrg: EvvVisitProviderEntityForOrg;
}): OutboxConsumerBinding {
  const ports = buildM30UpstreamConsumerPorts(deps.db);
  return {
    consumerName: "m30.m18-evv-visit-verified",
    consumerModule: "m30",
    eventTypes: ["m18.evv.visit_verified"],
    async handle(event) {
      const payload = objectOf(event.payload, "event payload");
      const visitId = stringOf(payload, "visitId");
      const patientId = stringOf(payload, "patientId");
      const verifiedAt = stringOf(payload, "verifiedAt");

      const siting = await deps.evvVisitProviderEntityForOrg(deps.db, event.organizationId, visitId);
      if (siting === null) return; // no visit this org recognises — see file header.

      await handleEvvVisitVerified(
        {
          eventId: event.id,
          organizationId: event.organizationId,
          providerEntityId: siting.providerEntityId,
          patientId,
          visitId,
          verifiedAt: new Date(verifiedAt),
        },
        ports,
      );
    },
  };
}
