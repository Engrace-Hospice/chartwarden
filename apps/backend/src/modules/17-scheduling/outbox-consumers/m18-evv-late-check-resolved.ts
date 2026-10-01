// apps/backend/src/modules/17-scheduling/outbox-consumers/m18-evv-late-check-resolved.ts — F-196 (#248).
//
// `m18.evv.late_check_resolved` was declared as an M17 consumer since the catalog existed but never bound.
// The fact is real and already fires in production: M23 has a live, bound consumer for this exact event
// (`23-billing-medicare/outbox-consumers/m18-late-check-resolved.ts`, F-162). M17's own `evv_bracket_state`
// is already push-maintained by its two sibling EVV consumers (`m18-evv-check-in.ts`,
// `m18-evv-at-patient-address.ts`), so a push consumer is this module's established, correct mechanism —
// not a seam-vs-push mismatch.
//
// This is a SAME-ROW INFORMATIONAL STAMP, not a lifecycle transition: a late-check resolution fires once
// the visit is already `completed` — it never moves `status` — so it does NOT append to
// `visit_state_history` (that table's `to_state` is a real `visit_status` transition ledger, the
// `m18-evv-at-patient-address.ts` en_route → in_visit shape; writing a same-state row here would misuse
// it). Idempotent by construction: the UPDATE's WHERE clause pins
// `evv_missing_resolution_resolved_at IS NULL`, so a redelivery after the first stamp matches zero rows and
// is a silent no-op, mirroring the `transfer_event.document_id`/`m6-backref` NULL-guard shape (F-192).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const V = schema.visit;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M17_EVV_LATE_CHECK_RESOLVED_CONSUMER = {
  eventName: "m18.evv.late_check_resolved",
  consumerName: "m17.m18-evv-late-check-resolved",
} as const;

export interface EvvLateCheckResolvedDeps {
  readonly db: DbClient;
}

function factsOf(payload: unknown): {
  visitId: string;
  status: string;
  resolutionReason: string;
  resolvedByMembershipId: string | null;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const readStr = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `${M17_EVV_LATE_CHECK_RESOLVED_CONSUMER.consumerName}: payload has no ${key}`,
      );
    }
    return value;
  };
  const resolvedByMembershipId =
    typeof p.resolvedByMembershipId === "string" && p.resolvedByMembershipId.length > 0
      ? p.resolvedByMembershipId
      : null;
  return {
    visitId: readStr("visitId"),
    status: readStr("status"),
    resolutionReason: readStr("resolutionReason"),
    resolvedByMembershipId,
  };
}

/**
 * M17's live `m18.evv.late_check_resolved` binding (F-196, #248). Stamps `visit.evv_missing_resolution_*`
 * once, on the first delivery only — a redelivery after the stamp already landed is a silent no-op (the
 * WHERE clause's `IS NULL` guard), never a second audit write of the same resolution.
 */
export function buildM17EvvLateCheckResolvedConsumer(deps: EvvLateCheckResolvedDeps) {
  return {
    consumerName: M17_EVV_LATE_CHECK_RESOLVED_CONSUMER.consumerName,
    consumerModule: "m17" as const,
    eventTypes: [M17_EVV_LATE_CHECK_RESOLVED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const [visit] = await tx
            .select({
              id: V.id,
              version: V.version,
              evvMissingResolutionResolvedAt: V.evvMissingResolutionResolvedAt,
            })
            .from(V)
            .where(eq(V.id, facts.visitId))
            .limit(1);
          if (!visit) return; // cross-tenant / already-erased — never a write
          if (visit.evvMissingResolutionResolvedAt !== null) return; // already stamped — idempotent no-op

          await tx
            .update(V)
            .set({
              evvMissingResolutionResolvedAt: new Date(),
              evvMissingResolutionStatus: facts.status,
              evvMissingResolutionByMembershipId: facts.resolvedByMembershipId,
              evvMissingResolutionReason: facts.resolutionReason,
              version: visit.version + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(V.id, facts.visitId), isNull(V.evvMissingResolutionResolvedAt)));
        },
      );
    },
  };
}
