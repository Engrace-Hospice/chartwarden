// apps/backend/src/modules/24-billing-medicaid/routes/claims.routes.ts — M24 (§4.1) the claim lifecycle +
// validation + AR surface (routes 1–17, 35, 36). Reads gate on the §4.7 key; mutations compose the §4.8 ABAC
// predicate over the route's `:id` (mapped onto the claim target), the §D12 step-up on submit/replace/void,
// the §8.6 `actor_kind='ai_*'` reject, and the §F08 Idempotency-Key. Org/actor binding is server-side.
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { ABAC_CLAIM, ABAC_RESULT, ABAC_BODY_PE, P, STEP_UP } from "./guards";
import {
  ApplyOverrideBody,
  AssembleClaimBody,
  ClaimListQuery,
  ProviderEntityQuery,
  ReplaceClaimBody,
  SubmitClaimBody,
  UpdateDraftClaimBody,
  VoidClaimBody,
  ValidationWorklistQuery,
  parse,
  parseQuery,
} from "./m24-typebox";
import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

export interface ClaimsRouteDeps {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
}

const AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
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
      const body = parse(AssembleClaimBody, request.body);
      const claim = await writeService.assembleClaim(writeActorOf(request), body);
      return reply.code(201).send(claim);
    },
  );

  // 2 — list
  app.get("/api/v1/medicaid-claims", { preHandler: [P("medicaid.claim.read")], config: { auditRead: { resourceKind: "medicaid_claim", list: true } } }, async (request, reply) => {
    const q = parseQuery(ClaimListQuery, request.query);
    return reply.send(
      await readService.listClaims(
        actorOf(request),
        {
          state: q.state,
          kind: q.kind,
          mcoId: q.mcoId,
          serviceState: q.serviceState,
          patientId: q.patientId,
          providerEntityId: q.providerEntityId,
        },
        q.cursor,
        clampLimit(q.limit === undefined ? undefined : String(q.limit)),
      ),
    );
  });

  // 3 — read one
  app.get(
    "/api/v1/medicaid-claims/:id",
    { preHandler: [P("medicaid.claim.read"), ABAC_CLAIM("medicaid.claim.read", "medicaid_claim_in_billing_manager_caseload")], config: { auditRead: { resourceKind: "medicaid_claim", resourceIdParam: "id" } } },
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
      const body = parse(UpdateDraftClaimBody, request.body);
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
      const body = parse(SubmitClaimBody, request.body);
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
      const body = parse(ReplaceClaimBody, request.body);
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
      const body = parse(VoidClaimBody, request.body);
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
    { preHandler: [P("medicaid.claim.read"), ABAC_CLAIM("medicaid.claim.read", "medicaid_claim_in_billing_manager_caseload")], config: { auditRead: { resourceKind: "medicaid_claim_line", resourceIdParam: "id", list: true } } },
    async (request, reply) => reply.send(await readService.listClaimLines(actorOf(request), pParam(request, "id"))),
  );

  // 12 — submissions
  app.get(
    "/api/v1/medicaid-claims/:id/submissions",
    { preHandler: [P("medicaid.claim.read"), ABAC_CLAIM("medicaid.claim.read", "medicaid_claim_in_billing_manager_caseload")], config: { auditRead: { resourceKind: "medicaid_claim_submission", resourceIdParam: "id", list: true } } },
    async (request, reply) => reply.send(await readService.listSubmissions(actorOf(request), pParam(request, "id"))),
  );

  // 13 — acknowledgments
  app.get(
    "/api/v1/medicaid-claims/:id/acknowledgments",
    { preHandler: [P("medicaid.claim.read"), ABAC_CLAIM("medicaid.claim.read", "medicaid_claim_in_billing_manager_caseload")], config: { auditRead: { resourceKind: "medicaid_claim_acknowledgment", resourceIdParam: "id", list: true } } },
    async (request, reply) => reply.send(await readService.listAcknowledgments(actorOf(request), pParam(request, "id"))),
  );

  // 14 — validation run (RBAC; the run→claim caseload narrowing binds with the M5 CaseloadProvider seam)
  app.get("/api/v1/medicaid-validation-runs/:id", { preHandler: [P("medicaid.validation.read_run")], config: { auditRead: { resourceKind: "medicaid_validation_run", resourceIdParam: "id" } } }, async (request, reply) => {
    const run = await readService.getValidationRun(actorOf(request), pParam(request, "id"));
    if (!run) throw new NotFoundError("validation run not found");
    return reply.send(run);
  });

  // 15 — validation runs for claim
  app.get(
    "/api/v1/medicaid-claims/:id/validation-runs",
    { preHandler: [P("medicaid.validation.read_run"), ABAC_CLAIM("medicaid.validation.read_run", "medicaid_claim_in_billing_manager_caseload")], config: { auditRead: { resourceKind: "medicaid_validation_run", resourceIdParam: "id", list: true } } },
    async (request, reply) => reply.send(await readService.listValidationRuns(actorOf(request), pParam(request, "id"))),
  );

  // 16 — apply override (step-up)
  app.post(
    "/api/v1/medicaid-validation-results/:id/override",
    { preHandler: [P("medicaid.validation.override"), ABAC_RESULT("medicaid.validation.override", "medicaid_override_role_eligible"), STEP_UP("medicaid.validation.override"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(ApplyOverrideBody, request.body);
      return reply.code(201).send(await writeService.applyOverride(writeActorOf(request), pParam(request, "id"), body));
    },
  );

  // 17 — overrides audit
  app.get("/api/v1/medicaid-validation-overrides", { preHandler: [P("medicaid.validation.read_override")], config: { auditRead: { none: "override AUDIT of rule suppressions — actor + rule key, no patient data" } } }, async (request, reply) =>
    reply.send(await readService.listOverrides(actorOf(request))),
  );

  // 35 — AR aging dashboard
  app.get("/api/v1/medicaid-ar-dashboard", { preHandler: [P("medicaid.claim.read_ar_dashboard")], config: { auditRead: { none: "Medicaid AR aging + open-claim counts — aggregate, no patient identity" } } }, async (request, reply) =>
    reply.send(await readService.arDashboard(actorOf(request), parseQuery(ProviderEntityQuery, request.query).providerEntityId)),
  );

  // 36 — AR metrics (M33-feeding)
  app.get("/api/v1/medicaid-ar-dashboard/metrics", { preHandler: [P("medicaid.claim.read_metrics")], config: { auditRead: { none: "Medicaid billing metrics — aggregate, no patient identity" } } }, async (request, reply) =>
    reply.send(await readService.arMetrics(actorOf(request), parseQuery(ProviderEntityQuery, request.query).providerEntityId)),
  );

  // 39 — org-wide validation worklist (§5.1 #5): blocked claims grouped by the rule holding them. One
  // server-side join replaces what the web surface used to approximate by fanning out per claim.
  app.get("/api/v1/medicaid-validation-worklist", { preHandler: [P("medicaid.validation.read_run")], config: { auditRead: { resourceKind: "medicaid_claim", list: true } } }, async (request, reply) => {
    const q = parseQuery(ValidationWorklistQuery, request.query);
    return reply.send(await readService.validationWorklist(actorOf(request), q.limit ?? 500));
  });
}
