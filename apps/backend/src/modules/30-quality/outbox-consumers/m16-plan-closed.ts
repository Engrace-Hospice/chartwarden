// apps/backend/src/modules/30-quality/outbox-consumers/m16-plan-closed.ts — F-160-follow-up (#248).
//
// The `OutboxConsumerBinding` for M30's three real, previously-unbound §4.10 `m16.bereavement.plan_closed_*`
// topics (`plan_closed_completed` / `plan_closed_declined` / `plan_closed_early`) — all three call ONLY the
// real `ports.enqueueRecompute` (`packages/quality/src/consumers/handlers.ts` `handleBereavementPlanClosed`),
// which `./upstream-consumer-ports.ts` already implements. See that handler's own doc comment for WHY this
// binds (a plan closure's `cancel_future_outreach` effect measurably shrinks `bereavement_coverage_rate`'s
// denominator) and why it enqueues ONLY that one measure code rather than the whole `operational` family.
//
// ONE binding subscribes to all three topics (the `eventTypes: readonly string[]` shape already supports
// this — see `bootstrap/outbox-dispatcher.ts`'s `OutboxConsumerBinding`) and dispatches on `event.eventType`
// inside `handle`, since all three payloads share the one fact this consumer needs (`planId`) and differ
// only in which closure reason fired.
//
// PROVIDER-ENTITY RESOLUTION: none of the three catalogued wire payloads carries `providerEntityId` (each
// is `{planId, ...}` only), while `measure_recompute_queue.provider_entity_id` is NOT NULL. Resolved via the
// NEW org-explicit `bereavementPlanSitingForOrg` read (`../../16-bereavement/seams/plan-provider-entity-for-
// org.ts`) — the `admissionSchedulingContextForOrg` shape a module over, because M16's published
// `BereavementPlanProvider.planById` seam opens `withOrgContextFromRequest` and a relay tick is not a
// request. M30's manifest `dependsOn` is `[1, 2, 3, 4, 10, 23, 27, 36, 38]` — it does NOT include 16 — so
// this function cannot be imported directly across the boundary (`arch:boundaries` refuses it, correctly).
// It is injected as a PORT instead, the F-160 M26 `CapConsumerStore` shape: the composition root imports
// M16's seam function and passes it in as `deps.bereavementPlanSitingForOrg`.
//
// A planId this org does not recognise (already deleted / a stale redelivery against a plan this tenant
// never had) is a NO-OP, not a dead-letter: the recompute this consumer would enqueue is advisory (a
// measure-freshness nudge), not a write with its own integrity to protect, and a plan the org's own RLS
// cannot see is indistinguishable from one that never existed.
import type { DbClient } from "@chartwarden/db";
import { handleBereavementPlanClosed } from "@chartwarden/quality";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { buildM30UpstreamConsumerPorts } from "./upstream-consumer-ports";

/** The M16 seam, injected as a port — see the file header for why this cannot be a direct import. */
export type BereavementPlanSitingForOrg = (
  db: DbClient,
  organizationId: string,
  planId: string,
) => Promise<{ readonly providerEntityId: string } | null>;

const PLAN_CLOSED_EVENT_TYPES = [
  "m16.bereavement.plan_closed_completed",
  "m16.bereavement.plan_closed_declined",
  "m16.bereavement.plan_closed_early",
] as const;

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m30.m16-plan-closed: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m30.m16-plan-closed: '${key}' must be a non-empty string`);
  }
  return value;
}

export function buildM30BereavementPlanClosedConsumer(deps: {
  readonly db: DbClient;
  /** M16's org-explicit `bereavementPlanSitingForOrg` seam, injected as a port — M30's manifest
   *  `dependsOn` excludes 16, so this cannot be imported directly (see the file header). */
  readonly bereavementPlanSitingForOrg: BereavementPlanSitingForOrg;
}): OutboxConsumerBinding {
  const ports = buildM30UpstreamConsumerPorts(deps.db);
  return {
    consumerName: "m30.m16-plan-closed",
    consumerModule: "m30",
    eventTypes: [...PLAN_CLOSED_EVENT_TYPES],
    async handle(event) {
      const payload = objectOf(event.payload, "event payload");
      const planId = stringOf(payload, "planId");

      const siting = await deps.bereavementPlanSitingForOrg(deps.db, event.organizationId, planId);
      if (siting === null) return; // no plan this org recognises — see file header.

      await handleBereavementPlanClosed(
        {
          eventId: event.id,
          organizationId: event.organizationId,
          providerEntityId: siting.providerEntityId,
          planId,
          sourceEventName: event.eventType,
        },
        ports,
      );
    },
  };
}
