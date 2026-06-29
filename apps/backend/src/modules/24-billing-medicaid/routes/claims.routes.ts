// apps/backend/src/modules/24-billing-medicaid/routes/claims.routes.ts — M24 (§4.1) the claim lifecycle +
// validation + AR surface (routes 1–17, 35, 36). Reads gate on the §4.7 key; mutations compose the §4.8 ABAC
// predicate over the route's `:id` (mapped onto the claim target), the §D12 step-up on submit/replace/void,
// the §8.6 `actor_kind='ai_*'` reject, and the §F08 Idempotency-Key. Org/actor binding is server-side.
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { ABAC_CLAIM, ABAC_RESULT, ABAC_BODY_PE, P, STEP_UP } from "./guards";
import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

export interface ClaimsRouteDeps {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
}

const AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const qStr = (q: unknown, key: string): string | undefined => {
  const v = (q as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";
const vParam = (request: { headers: Record<string, unknown> }): number | null => ifMatchVersion(request);

export function registerClaimsRoutes(app: FastifyInstance, deps: ClaimsRouteDeps): void {
  const { readService, writeService } = deps;

  // 1 — assemble
  app.post(
    "/api/v1/medicaid-claims",
    { preHandler: [P("medicaid.claim.assemble"), ABAC_BODY_PE("medicaid.claim.assemble", "provider_entity_medicaid_billing_scope"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const claim = await writeService.assembleClaim(writeActorOf(request), request.body as never);
      return reply.code(201).send(claim);
    },
  );

  // 2 — list
  app.get("/api/v1/medicaid-claims", { preHandler: [P("medicaid.claim.read")] }, async (request, reply) => {
    const q = request.query;
    return reply.send(
      await readService.listClaims(
        actorOf(request),
        {
          state: qStr(q, "state"),
          kind: qStr(q, "kind"),
          mcoId: qStr(q, "mcoId"),
          serviceState: qStr(q, "serviceState"),
          patientId: qStr(q, "patientId"),
          providerEntityId: qStr(q, "providerEntityId"),
        },
        qStr(q, "cursor"),
        clampLimit(qStr(q, "limit")),
      ),
    );
  });

  // 3 — read one
  app.get(
    "/api/v1/medicaid-claims/:id",
    { preHandler: [P("medicaid.claim.read"), ABAC_CLAIM("medicaid.claim.read", "medicaid_claim_in_billing_manager_caseload")] },
    async (request, reply) => {
      const claim = await readService.getClaim(actorOf(request), pParam(request, "id"));
      if (!claim) throw new NotFoundError("medicaid claim not found");
      return reply.send(claim);
    },
  );

  // 4 — update draft
  app.patch(
    "/api/v1/medicaid-claims/:id",
    { preHandler: [P("medicaid.claim.update_draft"), ABAC_CLAIM("medicaid.claim.update_draft", "medicaid_claim_in_billing_manager_caseload"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = (request.body ?? {}) as { mcoId?: string | null };
      return reply.send(
        await writeService.updateDraftClaim(writeActorOf(request), pParam(request, "id"), {
          expectedVersion: vParam(request),
          mcoId: body.mcoId,
        }),
      );
    },
  );

  // 5 — delete draft
  app.delete(
    "/api/v1/medicaid-claims/:id",
    { preHandler: [P("medicaid.claim.delete_draft"), ABAC_CLAIM("medicaid.claim.delete_draft", "medicaid_claim_in_billing_manager_caseload"), AI, IDEMPOTENT] },
    async (request, reply) => {
      await writeService.deleteDraftClaim(writeActorOf(request), pParam(request, "id"), vParam(request));
      return reply.code(204).send();
    },
  );

  // 6 — validate
  app.post(
    "/api/v1/medicaid-claims/:id/validate",
    { preHandler: [P("medicaid.validation.run"), ABAC_CLAIM("medicaid.validation.run", "medicaid_claim_in_billing_manager_caseload"), AI, IDEMPOTENT] },
    async (request, reply) => reply.send(await writeService.validateClaim(writeActorOf(request), pParam(request, "id"))),
  );

  // 7 — submit (step-up)
  app.post(
    "/api/v1/medicaid-claims/:id/submit",
    { preHandler: [P("medicaid.claim.submit"), ABAC_CLAIM("medicaid.claim.submit", "medicaid_claim_in_billing_manager_caseload"), STEP_UP("medicaid.claim.submit"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = (request.body ?? {}) as { channelHint?: string };
      return reply.send(
        await writeService.submitClaim(writeActorOf(request), pParam(request, "id"), { expectedVersion: vParam(request), channelHint: body.channelHint }),
      );
    },
  );

  // 8 — replace (TOB 817, step-up)
  app.post(
    "/api/v1/medicaid-claims/:id/replace",
    { preHandler: [P("medicaid.claim.replace"), ABAC_CLAIM("medicaid.claim.replace", "medicaid_claim_in_billing_manager_caseload"), STEP_UP("medicaid.claim.replace"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = (request.body ?? {}) as { reason: string };
      return reply
        .code(201)
        .send(await writeService.replaceClaim(writeActorOf(request), pParam(request, "id"), { expectedVersion: vParam(request), reason: body.reason }));
    },
  );

  // 9 — void (TOB 818, step-up)
  app.post(
    "/api/v1/medicaid-claims/:id/void",
    { preHandler: [P("medicaid.claim.void"), ABAC_CLAIM("medicaid.claim.void", "medicaid_claim_in_billing_manager_caseload"), STEP_UP("medicaid.claim.void"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = (request.body ?? {}) as { reason: string };
      return reply
        .code(201)
        .send(await writeService.voidClaim(writeActorOf(request), pParam(request, "id"), { expectedVersion: vParam(request), reason: body.reason }));
    },
  );

  // 10 — abandon
  app.post(
    "/api/v1/medicaid-claims/:id/abandon",
    { preHandler: [P("medicaid.claim.update_draft"), ABAC_CLAIM("medicaid.claim.update_draft", "medicaid_claim_in_billing_manager_caseload"), AI, IDEMPOTENT] },
    async (request, reply) => reply.send(await writeService.abandonClaim(writeActorOf(request), pParam(request, "id"), vParam(request))),
  );

  // 11 — lines
  app.get(
    "/api/v1/medicaid-claims/:id/lines",
    { preHandler: [P("medicaid.claim.read"), ABAC_CLAIM("medicaid.claim.read", "medicaid_claim_in_billing_manager_caseload")] },
    async (request, reply) => reply.send(await readService.listClaimLines(actorOf(request), pParam(request, "id"))),
  );

  // 12 — submissions
  app.get(
    "/api/v1/medicaid-claims/:id/submissions",
    { preHandler: [P("medicaid.claim.read"), ABAC_CLAIM("medicaid.claim.read", "medicaid_claim_in_billing_manager_caseload")] },
    async (request, reply) => reply.send(await readService.listSubmissions(actorOf(request), pParam(request, "id"))),
  );

  // 13 — acknowledgments
  app.get(
    "/api/v1/medicaid-claims/:id/acknowledgments",
    { preHandler: [P("medicaid.claim.read"), ABAC_CLAIM("medicaid.claim.read", "medicaid_claim_in_billing_manager_caseload")] },
    async (request, reply) => reply.send(await readService.listAcknowledgments(actorOf(request), pParam(request, "id"))),
  );

  // 14 — validation run (RBAC; the run→claim caseload narrowing binds with the M5 CaseloadProvider seam)
  app.get("/api/v1/medicaid-validation-runs/:id", { preHandler: [P("medicaid.validation.read_run")] }, async (request, reply) => {
    const run = await readService.getValidationRun(actorOf(request), pParam(request, "id"));
    if (!run) throw new NotFoundError("validation run not found");
    return reply.send(run);
  });

  // 15 — validation runs for claim
  app.get(
    "/api/v1/medicaid-claims/:id/validation-runs",
    { preHandler: [P("medicaid.validation.read_run"), ABAC_CLAIM("medicaid.validation.read_run", "medicaid_claim_in_billing_manager_caseload")] },
    async (request, reply) => reply.send(await readService.listValidationRuns(actorOf(request), pParam(request, "id"))),
  );

  // 16 — apply override (step-up)
  app.post(
    "/api/v1/medicaid-validation-results/:id/override",
    { preHandler: [P("medicaid.validation.override"), ABAC_RESULT("medicaid.validation.override", "medicaid_override_role_eligible"), STEP_UP("medicaid.validation.override"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = request.body as { reason: string; overrideRoleClaimed: "billing_manager" | "compliance_officer" | "medical_director" | "org_admin" };
      return reply.code(201).send(await writeService.applyOverride(writeActorOf(request), pParam(request, "id"), body));
    },
  );

  // 17 — overrides audit
  app.get("/api/v1/medicaid-validation-overrides", { preHandler: [P("medicaid.validation.read_override")] }, async (request, reply) =>
    reply.send(await readService.listOverrides(actorOf(request))),
  );

  // 35 — AR aging dashboard
  app.get("/api/v1/medicaid-ar-dashboard", { preHandler: [P("medicaid.claim.read_ar_dashboard")] }, async (request, reply) =>
    reply.send(await readService.arDashboard(actorOf(request), qStr(request.query, "providerEntityId"))),
  );

  // 36 — AR metrics (M33-feeding)
  app.get("/api/v1/medicaid-ar-dashboard/metrics", { preHandler: [P("medicaid.claim.read_metrics")] }, async (request, reply) =>
    reply.send(await readService.arMetrics(actorOf(request), qStr(request.query, "providerEntityId"))),
  );
}
