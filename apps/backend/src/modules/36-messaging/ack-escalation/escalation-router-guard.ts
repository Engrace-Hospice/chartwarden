// apps/backend/src/modules/36-messaging/ack-escalation/escalation-router-guard.ts - WP 4.4 (ADR-0057, ADR-0070): the org-checking
// wrapper around the raw EscalationRouter seam. A worker reads an organization out of a job or an event payload, so it never hands
// that value to the seam unchecked: the guard refuses a malformed call before it leaves, and refuses an answer that is not the one
// asked for (another tier, another instant, an empty or malformed recipient list) or that comes from a TEST source. The seam stays
// the owner's: M19 still enforces the org and patient checks on its side; this is M36 not trusting what comes back.
import {
  ESCALATION_MAX_TIER,
  type EscalationRouteRequest,
  type EscalationRouter,
} from "@wardenx/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EscalationRouterAnswerError extends Error {
  constructor(reason: string) {
    super(`escalation router answer refused: ${reason}`);
    this.name = "EscalationRouterAnswerError";
  }
}

export interface GuardOptions {
  /** Tests only: accept the `in_memory_fake` source. Production never sets it. */
  readonly allowFakeSource?: boolean;
}

export function guardEscalationRouter(
  router: EscalationRouter,
  options: GuardOptions = {},
): EscalationRouter {
  return {
    async resolveTier(orgId: string, request: EscalationRouteRequest) {
      if (!UUID.test(orgId) || !UUID.test(request.patientId)) {
        throw new EscalationRouterAnswerError("organization and patient must be ids");
      }
      if (
        !Number.isSafeInteger(request.tier) ||
        request.tier < 1 ||
        request.tier > ESCALATION_MAX_TIER
      ) {
        throw new EscalationRouterAnswerError("tier out of range");
      }
      const answer = await router.resolveTier(orgId, request);
      if (answer.tier !== request.tier || answer.asOf !== request.asOf) {
        throw new EscalationRouterAnswerError("the answer is for another tier or instant");
      }
      if (answer.source === "in_memory_fake" && options.allowFakeSource !== true) {
        throw new EscalationRouterAnswerError("a test source cannot route a real request");
      }
      if (answer.kind === "resolved") {
        const ids = answer.userIds as readonly unknown[];
        if (ids.length === 0 || !ids.every((id) => typeof id === "string" && UUID.test(id))) {
          throw new EscalationRouterAnswerError("recipients must be a non-empty list of ids");
        }
      }
      return answer;
    },
  };
}
