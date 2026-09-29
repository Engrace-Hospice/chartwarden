// apps/backend/src/modules/23-billing-medicare/outbox-consumers/m18-late-check-resolved.ts — F-162 (#248):
// binds `m18.evv.late_check_resolved` onto the same `revalidate.consumer` producer path
// `m23-revalidate-triggers.ts` wires for its six sibling M6/M8/M5 topics. That pass deliberately left this
// event out (F-153, re-confirmed by F-159) because the catalogued payload carries only `visitId`, and
// `RevalidationTargetResolverPort`'s implementation (`m23-revalidation-target-resolver.ts`) matches a claim
// on `patientId` / `admissionId` / `encounterId` — never a visit id — so enqueueing the raw event the way
// the other six do would have resolved to an EMPTY target set on every single delivery, silently.
//
// ── WHY THIS NEEDED ONE NEW M8 SEAM FUNCTION FIRST ──────────────────────────────────────────────────────
//
// `encounter.visit_id` is M8-owned. M8 had already published the VISIT-FROM-ENCOUNTER direction
// (`encounterVisitIdsForOrg`, F-123/#251) but not the reverse. This pass adds the reverse
// (`encounterIdsForVisitsForOrg`, `08-encounters/seams/drizzle-store.ts`) — a genuinely 1:1 read, since
// `encounter_org_visit_unique` is a partial UNIQUE index on `(organization_id, visit_id) WHERE visit_id IS
// NOT NULL`, so a visit can never resolve to more than one encounter.
//
// M23's manifest `dependsOn` DOES list 8 (`architecture/module-manifest.ts`), but every other M8 bridge
// already built in this module (`buildM23BillableEncountersAdapter`, `buildM23EvvComplianceAdapter` in
// `services/claim-assembly-seam-adapters.ts`) deliberately does NOT import M8's module code directly — each
// duplicates the seam's shape locally and takes it as a composition-root-injected port instead. This
// follows that same established posture for consistency rather than taking the shortcut the manifest would
// technically permit.
//
// ── WHAT THE CONSUMER DOES ──────────────────────────────────────────────────────────────────────────────
//
// Resolves the event's `visitId` through the injected M8 port. A visit with NO attached encounter (an
// ad-hoc EVV correction on a visit that was never converted into a clinical encounter — a real, legal
// state, not an error) resolves to an empty map, and the delivery is a deliberate no-op: there is no claim
// fact to re-validate, the same "no encounter, no target" default the M18<->M23 evvCompliance bridge
// already uses (F-123) rather than a throw. A resolved visit enqueues onto the SAME `revalidate.consumer`
// queue the six sibling triggers use, with `encounterId` set on the outgoing payload — no change needed to
// `RevalidationTargetResolverPort`'s existing generic `encounterId` field read, which already finds the
// affected claim(s) exactly the way `m8.encounter.cosigned` does today.
//
// Idempotency is the SAME BullMQ `jobId = m23:revalidate.consumer:<eventId>` scheme
// `buildM23RevalidateEnqueuePort` already mints (`jobs/m23-jobs.ts`) — a redelivery of this event is a
// BullMQ-level no-op before the M8 lookup or the resolver ever runs a second time.
//
// Event name is a STRING literal; no M18 schema is imported.
import type { RevalidateConsumerJob } from "../jobs/m23-jobs";
import type { RevalidateEnqueuePort } from "./m23-revalidate-triggers";

/** The event this consumer binds. */
export const M23_LATE_CHECK_RESOLVED_EVENT = "m18.evv.late_check_resolved" as const;

/**
 * The exact shape of M8's `encounterIdsForVisitsForOrg` (`08-encounters/seams/drizzle-store.ts`),
 * duplicated locally per the `M8EncounterVisitIdsReader` / `M8BillableEncountersReader` no-package-import
 * posture the other M8 bridges in this module already use (`services/claim-assembly-seam-adapters.ts`).
 */
export interface M8EncounterIdsForVisitsReader {
  forVisits(orgId: string, visitIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface M23LateCheckResolvedConsumerDeps {
  readonly resolveEncounterForVisit: M8EncounterIdsForVisitsReader;
  /** The SAME `revalidate.consumer` producer port `m23-revalidate-triggers.ts`'s six bindings enqueue onto. */
  readonly enqueue: RevalidateEnqueuePort;
}

function stringField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * M23's live `m18.evv.late_check_resolved` → `revalidate.consumer` binding (F-162, #248) — the seventh of
 * the seven `m23`-side revalidation triggers M23's own `handlers-unbound` deferral group named.
 */
export function buildM23LateCheckResolvedConsumer(deps: M23LateCheckResolvedConsumerDeps) {
  return {
    consumerName: "m23.m18-late-check-resolved",
    consumerModule: "m23" as const,
    eventTypes: [M23_LATE_CHECK_RESOLVED_EVENT] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const visitId = stringField(event.payload, "visitId");
      if (visitId === undefined) {
        throw new Error(
          `m23.m18-late-check-resolved: ${M23_LATE_CHECK_RESOLVED_EVENT} carries no visitId`,
        );
      }

      const encounters = await deps.resolveEncounterForVisit.forVisits(event.organizationId, [visitId]);
      const encounterId = encounters.get(visitId);
      if (encounterId === undefined) {
        // No M8 encounter is attached to this visit — a real, legal state. Nothing to revalidate; a
        // deliberate no-op, not a DLQ.
        return;
      }

      const eventPayload =
        typeof event.payload === "object" && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : {};
      const job: RevalidateConsumerJob = {
        organizationId: event.organizationId,
        eventId: event.id,
        eventName: M23_LATE_CHECK_RESOLVED_EVENT,
        eventPayload: { ...eventPayload, encounterId },
      };
      await deps.enqueue.enqueue(job);
    },
  };
}
