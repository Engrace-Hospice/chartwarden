// apps/backend/src/modules/23-billing-medicare/services/clearinghouse-attempt-resolution-service.ts — an operator's
// decision on a clearinghouse attempt the transport can no longer settle itself.
//
// A submission that was reserved but never confirmed (an ambiguous failure, then an outage) is re-sent by the
// transport under the same wire key while the vendor's idempotency window lasts. Past the window a re-send could
// file the claim twice, so the transport refuses and the control number stays held. This is the way out: the
// operator checks the vendor's records and records either "it was filed" (with the vendor's id) or "it was not".
// Only a still-reserved attempt that is past the window can be settled here; anything inside the window belongs to
// the transport. The decision and who made it land in the audit trail (the table's M04 trigger).
import { ConflictError, NotFoundError } from "@wardenx/types";
import {
  type AttemptUsage,
  type SubmissionAttemptStore,
  pastKeyWindow,
  scopeKey,
} from "@wardenx/x12-837-client";

export type ResolveStaleAttemptInput = {
  readonly providerEntityId: string;
  readonly usage: AttemptUsage;
  readonly idempotencyKey: string;
} & (
  | { readonly outcome: "sent"; readonly clearinghouseSubmissionId: string }
  | { readonly outcome: "released" }
);

export interface ResolvedAttempt {
  readonly idempotencyKey: string;
  readonly controlNumber: string;
  readonly status: "sent" | "released";
  readonly clearinghouseSubmissionId: string | null;
}

export interface ClearinghouseAttemptResolutionService {
  resolveStale(
    actor: { readonly organizationId: string; readonly userId: string },
    input: ResolveStaleAttemptInput,
  ): Promise<ResolvedAttempt>;
}

export function buildClearinghouseAttemptResolutionService(
  attempts: SubmissionAttemptStore,
  now: () => Date = () => new Date(),
): ClearinghouseAttemptResolutionService {
  return {
    async resolveStale(actor, input) {
      const scope = scopeKey({
        organizationId: actor.organizationId,
        providerEntityId: input.providerEntityId,
        usage: input.usage,
      });
      const attempt = await attempts.find(actor.organizationId, scope, input.idempotencyKey);
      if (!attempt) throw new NotFoundError("clearinghouse attempt");
      if (attempt.status !== "reserved") {
        throw new ConflictError("the attempt is already settled");
      }
      if (!pastKeyWindow(attempt.firstReservedAt, now())) {
        throw new ConflictError(
          "the attempt is still inside the vendor's idempotency window; the transport will retry it",
        );
      }
      const at = now().toISOString();
      const settled = await attempts.resolve(
        actor.organizationId,
        scope,
        input.idempotencyKey,
        input.outcome === "sent"
          ? {
              kind: "sent",
              clearinghouseSubmissionId: input.clearinghouseSubmissionId,
              receivedAt: at,
            }
          : { kind: "released" },
        actor.userId,
      );
      // Settled by someone else between the read and the write.
      if (!settled || settled.status === "reserved") {
        throw new ConflictError("the attempt was settled by someone else");
      }
      return {
        idempotencyKey: settled.idempotencyKey,
        controlNumber: settled.controlNumber,
        status: settled.status,
        clearinghouseSubmissionId: settled.clearinghouseSubmissionId,
      };
    },
  };
}
