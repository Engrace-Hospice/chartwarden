// apps/backend/src/modules/36-messaging/ack-escalation/escalation-router-guard.ts - WP 4.4 (ADR-0057, ADR-0070): the org-checking
// wrapper around the raw EscalationRouter seam. A worker reads an organization out of a job or an event payload, so it never hands
// that value to the seam unchecked: the guard refuses a malformed call before it leaves, and refuses an answer that is not the one
// asked for (another tier, another instant, an empty or malformed recipient list) or that comes from a TEST source. The seam stays
// the owner's: M19 still enforces the org and patient checks on its side; this is M36 not trusting what comes back.
import {
  ESCALATION_MAX_TIER,
  ESCALATION_RANKS,
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

/** `nextTier` is null (no further tier) or a whole number above the tier asked about, up to the ceiling. */
const validNextTier = (next: unknown, tier: number): boolean =>
  next === null ||
  (typeof next === "number" &&
    Number.isSafeInteger(next) &&
    next > tier &&
    next <= ESCALATION_MAX_TIER);

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
        // Ranks are optional, but a present list must pair one closed word with each recipient: a skewed list would mislabel a person.
        const ranks = answer.ranks as readonly unknown[] | undefined;
        if (
          ranks !== undefined &&
          (!Array.isArray(ranks) ||
            ranks.length !== ids.length ||
            !ranks.every((r) => (ESCALATION_RANKS as readonly unknown[]).includes(r)))
        ) {
          throw new EscalationRouterAnswerError(
            "ranks must pair one known rank with each recipient",
          );
        }
      }
      if (answer.kind !== "unavailable" && !validNextTier(answer.nextTier, request.tier)) {
        // A buggy router must not turn into a retry loop that dead-letters: it is "cannot route", recorded and visible.
        return {
          kind: "unavailable",
          reason: "no_route_configured",
          tier: answer.tier,
          asOf: answer.asOf,
          source: answer.source,
        };
      }
      return answer;
    },
  };
}
