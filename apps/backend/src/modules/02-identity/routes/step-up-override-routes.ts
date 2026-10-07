// apps/backend/src/modules/02-identity/routes/step-up-override-routes.ts — GAP-115 (M2 spec §4.1 `GET/POST
// /api/v1/orgs/:id/step-up-overrides[...]`; §3.7, §4.3.2, D9, W-M2-10).
//
//   GET    /api/v1/orgs/:id/step-up-overrides                 the tenant's overrides
//   POST   /api/v1/orgs/:id/step-up-overrides                 set / replace one operation's override
//   DELETE /api/v1/orgs/:id/step-up-overrides/:operationKey   remove it (the platform floor applies again)
//
// Gated on `step_up_override.manage` (org_admin via the full catalog, compliance_officer by default grant) and
// the §7.12 org binding. The two WRITES additionally require a fresh step-up (`requireStepUp`) — changing a
// security control is exactly what the control exists to protect. TIGHTEN-ONLY: the request is validated
// against the platform floor (422 with the reason) and `trg_tenant_step_up_tighten_only` refuses it at rest.
// Audited at `compliance` retention and published as `m2.session.step_up_policy_override.configured`.
import { requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import {
  auditStepUpOverrideConfigured,
  auditStepUpOverrideRemoved,
} from "../audit/org-admin-audit";
import { type StepUpOverrideAdminStore, validateOverrideInput } from "../step-up-override-admin";
import {
  type AdminRouteDeps,
  assertOrgMatch,
  auditContextFor,
  notFound,
  publishM2,
  resolveActor,
} from "./admin-route-kit";

export interface StepUpOverrideRouteDeps extends AdminRouteDeps {
  readonly overrides: StepUpOverrideAdminStore;
}

/** The step-up operation key the two writes gate on (a tenant may tighten it like any other). */
export const STEP_UP_OVERRIDE_OPERATION = "step_up_override.manage";

export function registerStepUpOverrideRoutes(
  app: FastifyInstance,
  deps: StepUpOverrideRouteDeps,
): void {
  app.get("/api/v1/orgs/:id/step-up-overrides", async (request) => {
    await requirePermission("step_up_override.manage")(request);
    const { id: orgId } = request.params as { id: string };
    assertOrgMatch(request, orgId);
    return { overrides: await deps.overrides.list(orgId) };
  });

  app.post("/api/v1/orgs/:id/step-up-overrides", async (request, reply) => {
    await requirePermission("step_up_override.manage")(request);
    await requireStepUp(STEP_UP_OVERRIDE_OPERATION)(request);
    const { id: orgId } = request.params as { id: string };
    assertOrgMatch(request, orgId);
    const actor = await resolveActor(deps, request);
    const input = validateOverrideInput(request.body);
    if (!actor.membershipId) throw notFound("an org-bound membership for the acting administrator");

    const record = await deps.overrides.upsert(orgId, {
      ...input,
      configuredByMembershipId: actor.membershipId,
    });
    await auditStepUpOverrideConfigured(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      operationKey: record.operationKey,
      qualifyingFactors: record.qualifyingFactors,
      maxAgeSec: record.maxAgeSec,
      configuredByMembershipId: actor.membershipId,
    });
    await publishM2(deps, {
      eventName: "m2.session.step_up_policy_override.configured",
      payload: {
        organizationId: orgId,
        operationKey: record.operationKey,
        qualifyingFactors: [...record.qualifyingFactors],
        maxAgeSec: record.maxAgeSec,
        configuredByMembershipId: actor.membershipId,
      },
      organizationId: orgId,
      aggregateKind: "step_up_policy_override",
      aggregateId: `${orgId}:${record.operationKey}`,
    });
    return reply.code(200).send(record);
  });

  app.delete("/api/v1/orgs/:id/step-up-overrides/:operationKey", async (request, reply) => {
    await requirePermission("step_up_override.manage")(request);
    await requireStepUp(STEP_UP_OVERRIDE_OPERATION)(request);
    const { id: orgId, operationKey } = request.params as { id: string; operationKey: string };
    assertOrgMatch(request, orgId);
    const actor = await resolveActor(deps, request);
    if (!(await deps.overrides.remove(orgId, operationKey))) throw notFound("step-up override");
    await auditStepUpOverrideRemoved(deps.audit, auditContextFor(request, actor), {
      organizationId: orgId,
      operationKey,
    });
    return reply.code(200).send({ removed: true });
  });
}
