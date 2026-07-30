// apps/backend/src/modules/24-billing-medicaid/routes/eligibility.routes.ts — M24 (§4.1) the state-Medicaid
// eligibility surface (routes 22–23). The force-refresh route composes the §4.8
// `provider_entity_medicaid_billing_scope` ABAC over the body PE, the §8.6 AI reject + §F08 Idempotency-Key.
// The 270/271 adapter + the M5 MedicaidIdUnlockReader are deferred — the write service degrades (§4.4/§8.7).
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC_BODY_PE, P } from "./guards";
import { EligibilityListQuery, RefreshEligibilityBody, parse, parseQuery } from "./m24-typebox";
import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

export interface EligibilityRouteDeps {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
}

const AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

export function registerEligibilityRoutes(app: FastifyInstance, deps: EligibilityRouteDeps): void {
  const { readService, writeService } = deps;

  // 22 — force a fresh state-eligibility round-trip
  app.post(
    "/api/v1/medicaid-eligibility-checks",
    { preHandler: [P("medicaid.eligibility.check"), ABAC_BODY_PE("medicaid.eligibility.check", "provider_entity_medicaid_billing_scope"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(RefreshEligibilityBody, request.body);
      return reply.code(202).send(await writeService.refreshEligibility(writeActorOf(request), body));
    },
  );

  // 23 — per-patient eligibility history
  app.get("/api/v1/medicaid-eligibility-checks", { preHandler: [P("medicaid.eligibility.read")] }, async (request, reply) =>
    reply.send(await readService.listEligibilityChecks(actorOf(request), parseQuery(EligibilityListQuery, request.query))),
  );
}
