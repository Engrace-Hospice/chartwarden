// apps/backend/src/modules/18-evv/outbox-consumers/m17-visit-cancelled.ts — the D14 `m17.visit.cancelled`
// binding (F-141/F-152/#248's follow-up build).
//
// M18's own D14 consumed-events list names exactly `m17.visit.published` (already bound,
// `m17-visit-published.ts`) and `m17.visit.cancelled` (this file). `M18_DR_INT_INVENTORY.md`'s
// integration table states the mechanism directly: "`m17.visit.cancelled` (cancel pending aggregator
// submissions)". `domain/missing-resolution.ts`'s own §2.2.4 graph names the SECOND half — the
// `void_for_cancelled_visit` close ("the M17 visit is in a cancelled state (the `m17.visit.cancelled`
// consumer drives this)") — so a cancelled visit both (a) cancels any non-terminal aggregator submission
// for it (D7 — `isAggregatorSubmissionCancellable`) and (b) voids any still-`open` missing-resolution row
// for it (§2.2.4 — an unresolved missing-checkout/checkin can no longer block billing for a visit that
// never happened). Both are independent per-visit facts; a visit may have zero, one, or both.
//
// ACTOR ATTRIBUTION: `m18.evv.aggregator_cancelled`'s catalogued payload requires `cancelledByMembershipId`
// as a non-empty string (`Type.Object({ ..., cancelledByMembershipId: id })`, `events-by-m18.ts`) — a
// nullable DB column cannot satisfy that on the wire. Mirrors M17's own `M17_SYSTEM_USER_ID` sentinel
// precedent (`consumers/admission-lifecycle.ts`, `outbox-consumers/m20-safety-visit-cancellation.ts`) with
// an M18-scoped constant, since `evv_aggregator_submission.cancelled_by_membership_id` and
// `evv_missing_resolution.resolved_by_membership_id` are both plain app-validated uuid columns with no FK.
// The missing-resolution close, by contrast, is genuinely system-driven per the machine's own contract
// (`void_for_cancelled_visit` requires `isSystemActor: true` and never stamps a resolver — "the
// cancellation reason lives on the M17 visit") — `resolved_by_membership_id` stays NULL there, matching
// every other system close (`closed_system_checkout_received`).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { EvvAggregatorSubmissionStatus, EvvMissingResolutionStatus } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import {
  isAggregatorSubmissionCancellable,
  transitionAggregatorSubmission,
} from "../domain/aggregator-submission";
import { transitionMissingResolution } from "../domain/missing-resolution";

const AGG = schema.evvAggregatorSubmission;
const MR = schema.evvMissingResolution;

/** Not a real membership row — mirrors M17's own established system-actor sentinel convention. */
const M18_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000018";

const CANCELLABLE_STATUSES: readonly EvvAggregatorSubmissionStatus[] = [
  "pending",
  "queued",
  "submitting",
  "submitted",
];

export const M18_VISIT_CANCELLED_CONSUMER = {
  eventName: "m17.visit.cancelled",
  consumerName: "m18.m17-visit-cancelled",
} as const;

export interface M18VisitCancelledOutboxPort {
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

export interface VisitCancelledConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m18.*` against the boot catalog. */
  readonly outbox: M18VisitCancelledOutboxPort;
}

function factsOf(payload: unknown): { visitId: string; reason: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const visitId = p.visitId;
  if (typeof visitId !== "string" || visitId.length === 0) {
    throw new Error(`${M18_VISIT_CANCELLED_CONSUMER.consumerName}: payload has no visitId`);
  }
  const reason = typeof p.reason === "string" ? p.reason : "";
  return { visitId, reason };
}

/**
 * M18's live `m17.visit.cancelled` binding. Idempotent by construction on both halves:
 * `isAggregatorSubmissionCancellable` only matches non-terminal statuses, so a redelivery finds nothing
 * left to cancel; the missing-resolution `openIdempotency` uniqueness + the `open`-only read means a
 * redelivery finds no open row left to void.
 */
export function buildM18VisitCancelledConsumer(deps: VisitCancelledConsumerDeps) {
  return {
    consumerName: M18_VISIT_CANCELLED_CONSUMER.consumerName,
    consumerModule: "m18" as const,
    eventTypes: [M18_VISIT_CANCELLED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;
      const cancellationReason =
        facts.reason.length > 0
          ? `System: source visit cancelled (${facts.reason})`
          : "System: source visit cancelled (m17.visit.cancelled)";

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        // (a) cancel every non-terminal aggregator submission for the visit (D7).
        const submissions = await tx
          .select({ id: AGG.id, status: AGG.status, stateCode: AGG.stateCode, version: AGG.version })
          .from(AGG)
          .where(
            and(
              eq(AGG.organizationId, organizationId),
              eq(AGG.visitId, facts.visitId),
              inArray(AGG.status, [...CANCELLABLE_STATUSES]),
            ),
          );
        for (const s of submissions) {
          if (!isAggregatorSubmissionCancellable(s.status as EvvAggregatorSubmissionStatus)) continue;
          const transition = transitionAggregatorSubmission(s.status as EvvAggregatorSubmissionStatus, {
            type: "cancel",
          });
          const [updated] = await tx
            .update(AGG)
            .set({
              status: transition.status,
              cancelledByMembershipId: M18_SYSTEM_USER_ID,
              cancelledAt: new Date(),
              cancellationReason,
              version: s.version + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(AGG.id, s.id), eq(AGG.version, s.version)))
            .returning({ id: AGG.id });
          if (!updated) continue; // lost a version race — the next tick (or none, if terminal) sees it
          await deps.outbox.publish(tx, {
            eventName: "m18.evv.aggregator_cancelled",
            organizationId,
            aggregateKind: "evv_aggregator_submission",
            aggregateId: s.id,
            payload: {
              submissionId: s.id,
              visitId: facts.visitId,
              stateCode: s.stateCode,
              cancelledByMembershipId: M18_SYSTEM_USER_ID,
              reason: cancellationReason,
            },
          });
        }

        // (b) void every still-open missing-resolution row for the visit (§2.2.4).
        const openRows = await tx
          .select({ id: MR.id, status: MR.status, version: MR.version })
          .from(MR)
          .where(
            and(
              eq(MR.organizationId, organizationId),
              eq(MR.visitId, facts.visitId),
              eq(MR.status, "open"),
            ),
          );
        for (const r of openRows) {
          const transition = transitionMissingResolution(r.status as EvvMissingResolutionStatus, {
            type: "void_for_cancelled_visit",
            visitCancelled: true,
            isSystemActor: true,
          });
          const [updated] = await tx
            .update(MR)
            .set({
              status: transition.status,
              version: r.version + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(MR.id, r.id), eq(MR.version, r.version)))
            .returning({ id: MR.id });
          if (!updated) continue; // lost a version race — the row is already terminal either way
          await deps.outbox.publish(tx, {
            eventName: "m18.evv.late_check_resolved",
            organizationId,
            aggregateKind: "evv_missing_resolution",
            aggregateId: r.id,
            payload: {
              missingResolutionId: r.id,
              visitId: facts.visitId,
              resolvedByMembershipId: null,
              status: transition.status,
              resolutionReason: "",
            },
          });
        }
      });
    },
  };
}
