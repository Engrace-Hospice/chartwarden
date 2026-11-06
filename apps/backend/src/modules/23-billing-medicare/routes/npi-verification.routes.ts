// apps/backend/src/modules/23-billing-medicare/routes/npi-verification.routes.ts — platform-verified NPI ownership
// (ADR-0053 amendment precondition 2). The Claim.MD sweep routes an enrollment report only to a provider entity whose
// current NPI is verified here. Every route gates on the platform administrator's key
// (`billing.rule_config.platform_admin`) AND a platform-ops role (`platform_billing_scope`), so a tenant custom role that
// somehow carries the key still cannot verify its own NPI. Writes add a fresh step-up, the AI-actor block and
// `Idempotency-Key`; the operator is the session's membership. Data runs on the platform runner only. No PHI.
import { requireAbac } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, rejectAiActor, writeActorOf } from "./actor";
import { parse } from "./billing-typebox";
import { requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP } from "./guards";
import type { NpiVerificationService } from "./npi-verification-service";
import { NpiVerificationParamsSchema, VerifyNpiBodySchema } from "./npi-verification-typebox";

const KEY = "billing.rule_config.platform_admin";
const PLATFORM_OPS = requireAbac(KEY, "platform_billing_scope", {
  getTarget: () => ({}),
  notFoundOnDeny: false,
}) as PreHandler;
const READ = [P(KEY), PLATFORM_OPS];
const WRITE = [...READ, STEP_UP(KEY), rejectAiActor(), requireIdempotencyKey()];

export function registerNpiVerificationRoutes(
  app: FastifyInstance,
  deps: { readonly npiVerificationService: NpiVerificationService },
): void {
  const service = deps.npiVerificationService;

  app.get("/api/v1/admin/billing/npi-verifications", { preHandler: READ }, async () =>
    service.list(),
  );

  app.post(
    "/api/v1/admin/billing/npi-verifications/:providerEntityId/verify",
    { preHandler: WRITE },
    async (request) => {
      const actor = writeActorOf(request);
      const { providerEntityId } = parse(NpiVerificationParamsSchema, request.params);
      return service.verify(actor, providerEntityId, parse(VerifyNpiBodySchema, request.body));
    },
  );

  app.post(
    "/api/v1/admin/billing/npi-verifications/:providerEntityId/revoke",
    { preHandler: WRITE },
    async (request) => {
      const actor = writeActorOf(request);
      const { providerEntityId } = parse(NpiVerificationParamsSchema, request.params);
      return service.revoke(actor, providerEntityId);
    },
  );
}
