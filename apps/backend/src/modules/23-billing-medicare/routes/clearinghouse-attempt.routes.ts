// apps/backend/src/modules/23-billing-medicare/routes/clearinghouse-attempt.routes.ts — the operator's way out of a
// clearinghouse attempt the transport can no longer settle (reserved, past the vendor's idempotency window).
//
// One command: record that the submission WAS filed (with the vendor's id, found in the vendor's own records) or
// that it was NOT. It gates `billing.clearinghouse.resolve_attempt` + `provider_entity_billing_scope` over the
// body's provider entity + the §D14 step-up + the §D13 AI-block + `Idempotency-Key`. The org and the acting user
// are server-side; the decision and who made it are audited by the attempt table's trigger.
import type { FastifyInstance } from "fastify";
import type { ClearinghouseAttemptResolutionService } from "../services/clearinghouse-attempt-resolution-service";
import { rejectAiActor, writeActorOf } from "./actor";
import { parse } from "./billing-typebox";
import { ResolveStaleAttemptBodySchema } from "./clearinghouse-attempt-typebox";
import { requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, STEP_UP, targetProviderFromBody } from "./guards";

export interface ClearinghouseAttemptRouteDeps {
  readonly resolutionService: ClearinghouseAttemptResolutionService;
}

const RESOLVE = P("billing.clearinghouse.resolve_attempt");
const RESOLVE_ABAC = PROVIDER_SCOPE(
  "billing.clearinghouse.resolve_attempt",
  targetProviderFromBody,
);
const RESOLVE_STEPUP = STEP_UP("billing.clearinghouse.resolve_attempt");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

export function registerClearinghouseAttemptRoutes(
  app: FastifyInstance,
  deps: ClearinghouseAttemptRouteDeps,
): void {
  app.post(
    "/api/v1/billing/clearinghouse-attempts/resolve",
    { preHandler: [RESOLVE, RESOLVE_ABAC, RESOLVE_STEPUP, NO_AI, IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const body = parse(ResolveStaleAttemptBodySchema, request.body);
      return deps.resolutionService.resolveStale(
        { organizationId: actor.organizationId, userId: actor.userId },
        body,
      );
    },
  );
}
