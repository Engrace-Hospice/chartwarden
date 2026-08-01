// apps/backend/src/modules/32-ai-platform/routes/consent.routes.ts — §4.1 rows R10-R15: the two consent
// layers.
//
// TWO LAYERS, TWO DATA SUBJECTS, AND THEY MUST NOT BE COLLAPSED. §5.3's tenant opt-in is the AGENCY's
// decision, recorded against an org admin and gated by four acknowledgments W4.1 validates upstream.
// §5.4's clinician opt-out is the INDIVIDUAL's, and the clinician is her own data subject — which is why
// §4.6 files those two keys under `self_service` and why nothing here lets one person set another's.
//
// ── THE OPT-OUT ROUTES ARE `/me`-SHAPED WITHOUT SAYING SO ──────────────────────────────────────────
//
// R13/R14/R15 take no membership id at all. The acting membership is stamped from the session
// (writeActorOf), so `POST /clinician-opt-out` cannot be pointed at a colleague. §4.1's own predicate cell
// for these three is the bare `wardenx.organization.member`, which reads as weak until you notice the
// route has no parameter through which a stronger predicate could even be aimed — the target is the
// session, and the session is not a caller-supplied value.
//
// ── R11 IS A `DELETE` THAT MAY MEAN "PAUSE", AND THE DEFAULT IS THE HARDER ONE ─────────────────────
//
// §5.3 gives a tenant both a PAUSE (keeps the acknowledgment evidence) and a WITHDRAWAL (does not), and
// §10.6 requires the withdrawal to be immediate. R11's own wording is "revokes", so an unqualified DELETE
// WITHDRAWS: a route that silently paused would leave an agency believing it had stopped while the
// evidence — and, on M35's side, the metering — said otherwise. `mode: 'pause'` is the explicit opt-in to
// the softer act.
import type { FastifyInstance } from "fastify";

import {
  type AiGovernanceServiceDeps,
  listAiClinicianOptOuts,
  listAiTenantOptIns,
  pauseAiTenantOptIn,
  recordAiClinicianOptOut,
  recordAiTenantOptIn,
  revertAiClinicianOptOut,
  withdrawAiTenantOptIn,
} from "../governance/service";
import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_TENANT_CONSENT, P } from "./guards";
import {
  CapabilityIdParams,
  RecordClinicianOptOutBody,
  RecordTenantOptInBody,
  RevokeTenantOptInBody,
  parse,
} from "./m32-typebox";

export interface ConsentRouteDeps {
  readonly governance: AiGovernanceServiceDeps;
}

export function registerConsentRoutes(app: FastifyInstance, deps: ConsentRouteDeps): void {
  const { governance } = deps;

  // R10 — record the tenant opt-in. The four §5.3.1 acknowledgments arrive as EVIDENCE (the reference
  //       strings and the attestation text as shown), and W4.1's resolver decides whether they resolve.
  //       With the Phase-1 denying resolver every cloud-reachable opt-in is REFUSED — the fail-closed
  //       direction the M32-T03 header argues for, and the reason a 422 here names a specific gate rather
  //       than a missing field.
  app.post(
    "/api/v1/ai/tenant-opt-in",
    { preHandler: [P("ai.tenant_opt_in"), ABAC_TENANT_CONSENT("ai.tenant_opt_in")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(RecordTenantOptInBody, request.body);
      const row = await recordAiTenantOptIn(governance, {
        organizationId: actor.organizationId,
        capabilityId: body.capabilityId,
        orgAdminMembershipId: actor.membershipId,
        routingMode: body.routingMode,
        pilotEnrollment: body.pilotEnrollment,
        acknowledgments: body.acknowledgments,
        orgRoutingPreference: body.orgRoutingPreference,
      });
      return reply.code(201).send(row);
    },
  );

  // R11 — revoke (default) or pause (explicit). See the header on why the default is the harder act.
  app.delete(
    "/api/v1/ai/tenant-opt-in/:capabilityId",
    { preHandler: [P("ai.tenant_opt_in"), ABAC_TENANT_CONSENT("ai.tenant_opt_in")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      const body = parse(RevokeTenantOptInBody, request.body ?? {});
      const reason = body.reason ?? null;
      if (body.mode === "pause") {
        // A pause NEEDS a reason — it is a state somebody else will have to interpret later, unlike a
        // withdrawal, which is self-explanatory and which §10.6 forbids obstructing.
        return pauseAiTenantOptIn(governance, {
          organizationId: actor.organizationId,
          capabilityId,
          orgAdminMembershipId: actor.membershipId,
          reason: reason ?? "paused by tenant admin",
        });
      }
      return withdrawAiTenantOptIn(governance, {
        organizationId: actor.organizationId,
        capabilityId,
        orgAdminMembershipId: actor.membershipId,
        reason,
      });
    },
  );

  // R12 — the org's opt-in records. Granted to `tenant_admin` and `compliance_officer` (§4.6): the
  //       acknowledgment evidence is what a privacy review reads to answer "who agreed to what, when".
  app.get(
    "/api/v1/ai/tenant-opt-in",
    { preHandler: [P("ai.tenant_opt_in.read"), ABAC_IN_ORG("ai.tenant_opt_in.read")] },
    async (request) => {
      const actor = actorOf(request);
      return { optIns: await listAiTenantOptIns(governance, actor.organizationId) };
    },
  );

  // R13 — the clinician turns a capability off for herself. IDEMPOTENT by rule, not by route: a second
  //       tap returns the live row and writes nothing (`evaluateAiClinicianOptOut`), because a clinician
  //       double-tapping a toggle on a bad connection must not produce two opt-out rows whose revert
  //       order then matters.
  app.post(
    "/api/v1/ai/clinician-opt-out",
    { preHandler: [P("ai.clinician_opt_out"), ABAC_IN_ORG("ai.clinician_opt_out")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(RecordClinicianOptOutBody, request.body);
      const row = await recordAiClinicianOptOut(governance, {
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
        capabilityId: body.capabilityId,
        reason: body.reason ?? null,
      });
      return reply.code(201).send(row);
    },
  );

  // R14 — she turns it back on. The ROW IS KEPT and stamped `reverted_at`: §5.4's history is the record
  //       that she once declined, which is what makes a later "why did this clinician never see the
  //       suggestion" answerable. A delete would erase the only evidence of a coercion question.
  app.delete(
    "/api/v1/ai/clinician-opt-out/:capabilityId",
    { preHandler: [P("ai.clinician_opt_out"), ABAC_IN_ORG("ai.clinician_opt_out")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      return revertAiClinicianOptOut(governance, {
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
        capabilityId,
      });
    },
  );

  // R15 — her own history, reverted rows included (that IS the history). Scoped to the SESSION's
  //       membership inside the service, so this cannot be pointed at a colleague.
  app.get(
    "/api/v1/ai/clinician-opt-out",
    { preHandler: [P("ai.clinician_opt_out.read"), ABAC_IN_ORG("ai.clinician_opt_out.read")] },
    async (request) => {
      const actor = writeActorOf(request);
      return {
        optOuts: await listAiClinicianOptOuts(governance, actor.organizationId, actor.membershipId),
      };
    },
  );
}
