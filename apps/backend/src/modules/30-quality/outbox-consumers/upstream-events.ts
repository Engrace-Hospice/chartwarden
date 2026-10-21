// apps/backend/src/modules/30-quality/outbox-consumers/upstream-events.ts — F-150 (#248).
//
// The `OutboxConsumerBinding`s for M30's §4.10 upstream-event handlers that are fully ready to bind
// today: both consume ONLY `ports.enqueueRecompute` (packages/quality/src/consumers/handlers.ts), which
// `./upstream-consumer-ports.ts` implements for real. See that file's header for the two events this
// deliberately does NOT bind (`m6.discharge.death`, `m12.medication.error_reported`) and why.
//
// `m18.evv.visit_verified` is the third declared-but-unbound M30 topic and is ALSO not bound here: it is
// never emitted by any production code path in M18 at all — `domain/event-lifecycle.ts`'s `recordEvent`
// decider declares the `{kind:"outbox", event:"m18.evv.visit_verified"}` effect, but
// `evv-route-service-db.ts`'s real check-in/check-out write path calls `recordEvent` from NOWHERE and
// emits `check_in_recorded`/`check_out_recorded`/`at_patient_address`/`geofence_breach_recorded` inline
// instead — a producer-side gap in M18, reported (not fixed) in `scripts/outbox-deferred-consumers.ts`.
import type { DbClient } from "@chartwarden/db";
import { handleClaimAdjudicated, handleHopeSubmissionAccepted } from "@chartwarden/quality";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { buildM30UpstreamConsumerPorts } from "./upstream-consumer-ports";

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m30.upstream-events: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m30.upstream-events: '${key}' must be a non-empty string`);
  }
  return value;
}

/**
 * `m10.hope.submission_accepted` → `handleHopeSubmissionAccepted` → enqueue the `hope_derived` recompute
 * (M30's own spec §D4 — the HOPE-derived TFP measure family). `providerEntityId` is on the catalog
 * payload as of F-150; the F-141-era declared consumer finally has a real binding to reach.
 */
export function buildM30HopeSubmissionAcceptedConsumer(deps: {
  readonly db: DbClient;
}): OutboxConsumerBinding {
  const ports = buildM30UpstreamConsumerPorts(deps.db);
  return {
    consumerName: "m30.hope-submission-accepted",
    consumerModule: "m30",
    eventTypes: ["m10.hope.submission_accepted"],
    async handle(event) {
      const payload = objectOf(event.payload, "event payload");
      await handleHopeSubmissionAccepted(
        {
          eventId: event.id,
          organizationId: event.organizationId,
          providerEntityId: stringOf(payload, "providerEntityId"),
          submissionId: stringOf(payload, "submissionId"),
        },
        ports,
      );
    },
  };
}

/**
 * `m23.claim.adjudicated` → `handleClaimAdjudicated` → enqueue the `hci` recompute (M30's own spec §D2
 * — the claims-derived HCI 10-indicator computation). Fully ready as-is: M23's real
 * `claim-state-service.ts` already emits a complete payload (`claimId`, `providerEntityId`, …) on every
 * paid/partial-paid/denied adjudication.
 */
export function buildM30ClaimAdjudicatedConsumer(deps: {
  readonly db: DbClient;
}): OutboxConsumerBinding {
  const ports = buildM30UpstreamConsumerPorts(deps.db);
  return {
    consumerName: "m30.claim-adjudicated",
    consumerModule: "m30",
    eventTypes: ["m23.claim.adjudicated"],
    async handle(event) {
      const payload = objectOf(event.payload, "event payload");
      await handleClaimAdjudicated(
        {
          eventId: event.id,
          organizationId: event.organizationId,
          providerEntityId: stringOf(payload, "providerEntityId"),
          claimId: stringOf(payload, "claimId"),
        },
        ports,
      );
    },
  };
}
