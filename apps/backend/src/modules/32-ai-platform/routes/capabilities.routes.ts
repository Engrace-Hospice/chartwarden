// apps/backend/src/modules/32-ai-platform/routes/capabilities.routes.ts — §4.1 rows R1-R6: the capability
// registry and its §2.2 lifecycle.
//
// THE REGISTRY IS PLATFORM-SHARED AND ITS READS ARE OPEN TO EVERY CLINICAL ROLE (§6's matrix gives
// `ai.capability.read` a ✓ in all eight columns). That is deliberate and it is the transparency half of
// the governance model: a clinician who is offered an AI-enhanced note may look up what the capability
// is, which lifecycle state it is in and whether her agency opted into it. The WRITES are the AI Safety
// Owner's alone, and two of them (R4's transition, and R7's kill switch in the sibling file) carry
// step-up on top.
//
// NO ROUTE HERE TAKES AN ORG. `ai_capability`, `ai_capability_lifecycle_event` and
// `ai_capability_calibration` are platform-shared (§3.3 grants `wardenx_app` SELECT and routes every write
// through the allowlisted platform credential), so a capability is the same row for every tenant. The
// org-scoped decisions ABOUT a capability — the tenant opt-in, the clinician opt-out, the routing override
// — live in the sibling route files, and keeping them apart is what stops one agency's opt-in from
// reading like a property of the capability itself.
import type { FastifyInstance } from "fastify";

import {
  type AiGovernanceServiceDeps,
  aiPermittedNextStates,
  publishAiCapabilityCalibration,
  readAiCapabilityGovernanceDetail,
  registerAiCapability,
  transitionAiCapability,
} from "../governance/service";
import { writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_SAFETY_OWNER, P, STEP_UP } from "./guards";
import {
  CapabilityIdParams,
  CapabilityListQuery,
  PublishCalibrationBody,
  RegisterCapabilityBody,
  TransitionCapabilityBody,
  parse,
  parseQuery,
} from "./m32-typebox";

export interface CapabilityRouteDeps {
  readonly governance: AiGovernanceServiceDeps;
}

export function registerCapabilityRoutes(app: FastifyInstance, deps: CapabilityRouteDeps): void {
  const { governance } = deps;

  // R1 — register into PROPOSED. The SIGNER role rides the body and is checked against §2.2's own
  //      registration edge inside the service; the ACTING MEMBERSHIP is stamped from the session, so a
  //      caller may say "I am signing as clinical_reviewer" and may not say "somebody else signed".
  app.post(
    "/api/v1/ai/capabilities",
    { preHandler: [P("ai.capability.create"), ABAC_SAFETY_OWNER("ai.capability.create")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(RegisterCapabilityBody, request.body);
      const { actorRole, rationaleText, stageArtifacts, ...capability } = body;
      const row = await registerAiCapability(governance, {
        capability,
        actorMembershipId: actor.membershipId,
        actorRole,
        rationaleText,
        stageArtifacts,
      });
      return reply.code(201).send(row);
    },
  );

  // R2 — the registry list. Filtering happens here rather than in the store because all three §4.1
  //      filters are predicates over a small, platform-shared table that the console reads whole anyway;
  //      pushing them into SQL would add three index decisions for no measurable win.
  app.get(
    "/api/v1/ai/capabilities",
    { preHandler: [P("ai.capability.read"), ABAC_IN_ORG("ai.capability.read")] },
    async (request) => {
      const query = parseQuery(CapabilityListQuery, request.query);
      const rows = await governance.registry.listCapabilities();
      return {
        capabilities: rows.filter(
          (row) =>
            (query.lifecycleState === undefined || row.lifecycleState === query.lifecycleState) &&
            (query.riskTier === undefined || row.riskTier === query.riskTier),
        ),
        // §2.4's `hotPhase1` is an INVENTORY fact (packages/ai-platform/src/inventory), not a column on
        // `ai_capability` — the filter is accepted and reported as unapplied rather than silently
        // ignored, because a console that filtered to "hot" and got everything would misreport the
        // wave's actual scope.
        hotPhase1FilterApplied: false,
      };
    },
  );

  // R3 — full detail: the row, the §2.2 posture it publishes to consumers, its lifecycle ledger, its
  //      calibration trail and the states it can reach next. One read, because a console that had to
  //      make four would show a capability mid-transition as four inconsistent panels.
  app.get(
    "/api/v1/ai/capabilities/:capabilityId",
    { preHandler: [P("ai.capability.read"), ABAC_IN_ORG("ai.capability.read")] },
    async (request) => {
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      return readAiCapabilityGovernanceDetail(governance, capabilityId);
    },
  );

  // R4 — walk a §2.2 edge. STEP-UP (permission-keys.ts): the stage-4 → stage-5 edge is what makes a
  //      capability servable against real charts, and the ledger row it writes is the platform's evidence
  //      of who approved that. The FSM, the signer-role check and D10's evidence check all re-run inside
  //      the service (guards.ts rule 3).
  app.post(
    "/api/v1/ai/capabilities/:capabilityId/transitions",
    {
      preHandler: [
        P("ai.capability.transition"),
        ABAC_SAFETY_OWNER("ai.capability.transition"),
        STEP_UP("ai.capability.transition"),
      ],
    },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      const body = parse(TransitionCapabilityBody, request.body);
      const row = await transitionAiCapability(governance, {
        ...body,
        capabilityId,
        actorMembershipId: actor.membershipId,
      });
      return reply.code(200).send({ capability: row, permittedNextStates: aiPermittedNextStates(row.lifecycleState) });
    },
  );

  // R5 — publish a calibration. Two writes (supersede the incumbent, insert the new `is_current` row) in
  //      ONE store call: `ai_cap_calib_current_per_backend_idx` makes any other ordering a constraint
  //      violation rather than a race.
  app.post(
    "/api/v1/ai/capabilities/:capabilityId/calibration",
    { preHandler: [P("ai.capability.calibrate"), ABAC_SAFETY_OWNER("ai.capability.calibrate")] },
    async (request, reply) => {
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      const body = parse(PublishCalibrationBody, request.body);
      const row = await publishAiCapabilityCalibration(governance, { ...body, capabilityId });
      return reply.code(201).send(row);
    },
  );

  // R6 — the calibration trail. §4.1 puts this behind `ai_safety_owner` rather than the open
  //      `ai.capability.read` cell, and the thresholds are why: a calibration row states the decision
  //      boundary a model is being held to, which is the one piece of the registry an adversary could use
  //      to shape an input that lands just inside it (§8.1's tampering row).
  app.get(
    "/api/v1/ai/capabilities/:capabilityId/calibration/history",
    { preHandler: [P("ai.capability.read"), ABAC_SAFETY_OWNER("ai.capability.read")] },
    async (request) => {
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      return {
        calibrations: await governance.registry.listCalibrationHistory(capabilityId),
      };
    },
  );
}
