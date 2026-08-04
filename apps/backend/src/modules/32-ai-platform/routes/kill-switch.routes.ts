// apps/backend/src/modules/32-ai-platform/routes/kill-switch.routes.ts — §4.1 rows R7-R9: D8's stop
// button.
//
// THREE PROPERTIES THAT ARE THE POINT OF THIS FILE:
//
//   1. THE SCOPE IS A BODY FIELD ON EXACTLY THESE TWO ROUTES, AND IT IS BOUNDED HARD. §3.2.12 makes the
//      table "mixed: org-scoped or platform-scoped" and R7 says "platform-wide if `organization_id`
//      null". `killSwitchScopeOf` (./actor.ts) turns `scope: 'platform'` into NULL and `scope: 'tenant'`
//      into the SESSION's org — a caller can never name a third agency's id. `ABAC_KILL_SWITCH_SCOPE`
//      (./guards.ts) then requires the safety-owner arm for the platform scope specifically, so a tenant
//      admin holding §4.6's key for their own agency cannot stop a capability for every agency.
//   2. DEACTIVATION IS NOT GATED ON THE SWITCH BEING INACTIVE. Obvious once stated, easy to get wrong:
//      `ai_kill_switch_inactive` is registered (../abac-predicates.ts) and DELIBERATELY not bound here.
//      Binding it would make an active kill switch unliftable — the platform's stop button with no
//      release. It belongs on the INVOCATION path, which is where "may this capability run" is asked.
//   3. STEP-UP IS ON BOTH DIRECTIONS. §4.6 gives activate and deactivate ONE key on purpose (a
//      deactivation is the same authority exercised the other way), and the direction that RESUMES a
//      capability somebody paused during a SEV-1 is the one a stolen session would want. Gating only the
//      activation would leave the undo unguarded.
//
// THE DEMOTION IS NOT WALKED HERE. `activateAiKillSwitch` returns a §2.2 demotion PLAN and D16 gives it a
// 60-second budget through the §4.8 follow-up worker. Walking it inline would make a slow governance write
// hold up the stop that is the whole point of a kill switch, and it needs a signer + rationale the route
// has no honest value for.
import type { FastifyInstance } from "fastify";

import {
  type AiSafetyServiceDeps,
  activateAiKillSwitch,
  deactivateAiKillSwitch,
  listActiveAiKillSwitches,
} from "../safety/service";
import { actorOf, killSwitchScopeOf, writeActorOf } from "./actor";
import { ABAC_KILL_SWITCH_SCOPE, ABAC_SAFETY_OWNER_OR_IN_ORG, P, STEP_UP } from "./guards";
import {
  ActivateKillSwitchBody,
  CapabilityIdParams,
  DeactivateKillSwitchBody,
  parse,
} from "./m32-typebox";

export interface KillSwitchRouteDeps {
  readonly safety: AiSafetyServiceDeps;
}

export function registerKillSwitchRoutes(app: FastifyInstance, deps: KillSwitchRouteDeps): void {
  const { safety } = deps;

  // R7 — activate. `activationMessage` is required by §3.2.12 for a human actor, and the four
  //      `automated_*` actor kinds are unspellable in the body (m32-typebox.ts) so a human cannot file a
  //      stop as though a monitor had raised it.
  app.post(
    "/api/v1/ai/capabilities/:capabilityId/kill-switch",
    {
      preHandler: [
        P("ai.kill_switch.activate"),
        ABAC_KILL_SWITCH_SCOPE("ai.kill_switch.activate"),
        STEP_UP("ai.kill_switch.activate"),
      ],
    },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      const body = parse(ActivateKillSwitchBody, request.body);
      const outcome = await activateAiKillSwitch(safety, {
        organizationId: killSwitchScopeOf(actor, body.scope),
        capabilityId,
        reason: body.reason,
        actorKind: body.actorKind,
        actorMembershipId: actor.membershipId,
        activationMessage: body.activationMessage,
      });
      // The DEMOTION PLAN rides the response rather than being executed (see the header). A console that
      // showed "stopped" without saying "and this capability will be demoted to DEPRECATED" would leave
      // the operator to discover the lifecycle change from the ledger.
      return reply.code(201).send(outcome);
    },
  );

  // R8 — lift it. `resolutionNarrative` is not optional: §3.2.12 requires it, and a switch lifted with no
  //      account of why is a post-mortem with a hole in it. The activation half of the row is left ALONE
  //      by the deactivation patch — who stopped it and why is exactly what a review reads.
  app.delete(
    "/api/v1/ai/capabilities/:capabilityId/kill-switch",
    {
      preHandler: [
        P("ai.kill_switch.activate"),
        ABAC_KILL_SWITCH_SCOPE("ai.kill_switch.activate"),
        STEP_UP("ai.kill_switch.activate"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { capabilityId } = parse(CapabilityIdParams, request.params);
      const body = parse(DeactivateKillSwitchBody, request.body);
      return deactivateAiKillSwitch(safety, {
        organizationId: killSwitchScopeOf(actor, body.scope),
        capabilityId,
        actorKind: body.actorKind,
        actorMembershipId: actor.membershipId,
        resolutionNarrative: body.resolutionNarrative,
      });
    },
  );

  // R9 — the §5.1.3 dashboard. `listActive` answers the DISJUNCTION (this org's rows ∪ the platform
  //      rows), which is the same disjunction the gate applies — a dashboard that showed only the
  //      tenant's own rows would tell an agency a capability was running while a platform switch had it
  //      stopped.
  app.get(
    "/api/v1/ai/kill-switches",
    { preHandler: [P("ai.kill_switch.read"), ABAC_SAFETY_OWNER_OR_IN_ORG("ai.kill_switch.read")] },
    async (request) => {
      const actor = actorOf(request);
      return { killSwitches: await listActiveAiKillSwitches(safety, actor.organizationId) };
    },
  );
}
