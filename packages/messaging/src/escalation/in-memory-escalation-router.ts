// @wardenx/messaging - TEST-ONLY in-memory EscalationRouter (M36 WP 4.3, ADR-0057). It implements the real contract over a fixed
// ladder using the shared shift-window rule, so the shift-boundary and time-zone acceptance is proved against the contract itself.
// Every answer is stamped `in_memory_fake`; production wiring must never import it
// (a backend test greps for that). It is not an M19 roster: M19 stays the only owner of rosters and tiers.
import {
  type EscalationRouteAnswer,
  type EscalationRouteRequest,
  type EscalationRouter,
  WardenXError,
} from "@wardenx/types";
import { type ShiftSchedule, isKnownTimeZone, scheduleContains } from "./shift-window";

export interface FakeRotation extends ShiftSchedule {
  readonly userIds: readonly string[];
}
export interface FakeTier {
  readonly tier: number;
  readonly rotations: readonly FakeRotation[];
}
export interface FakeLadder {
  readonly role: string;
  readonly tiers: readonly FakeTier[];
}
export interface InMemoryEscalationRouterOptions {
  /** The one org this router serves; a call for any other org is refused. */
  readonly orgId: string;
  readonly ladders: readonly FakeLadder[];
}

const SOURCE = "in_memory_fake" as const;

export function createInMemoryEscalationRouter(
  options: InMemoryEscalationRouterOptions,
): EscalationRouter {
  for (const ladder of options.ladders)
    for (const tier of ladder.tiers)
      for (const rotation of tier.rotations)
        if (!isKnownTimeZone(rotation.timeZone)) {
          throw new WardenXError(
            "ESCALATION_SHIFT_INVALID",
            `unknown time zone "${rotation.timeZone}"`,
            400,
          );
        }

  return {
    async resolveTier(
      orgId: string,
      request: EscalationRouteRequest,
    ): Promise<EscalationRouteAnswer> {
      if (orgId !== options.orgId) {
        throw new WardenXError(
          "ESCALATION_ORG_MISMATCH",
          "escalation routing refused: org does not match the caller",
          403,
        );
      }
      if (
        !Number.isInteger(request.tier) ||
        request.tier < 1 ||
        !request.patientId ||
        !request.requiredRole
      ) {
        throw new WardenXError(
          "ESCALATION_REQUEST_INVALID",
          "tier must be a positive integer and patient and role are required",
          400,
        );
      }
      if (Number.isNaN(Date.parse(request.asOf))) {
        throw new WardenXError(
          "ESCALATION_REQUEST_INVALID",
          "asOf must be an ISO-8601 instant",
          400,
        );
      }
      const base = { tier: request.tier, asOf: request.asOf, source: SOURCE };
      const ladder = options.ladders.find((l) => l.role === request.requiredRole);
      const fallbackZone = ladder?.tiers[0]?.rotations[0]?.timeZone;
      if (!ladder || fallbackZone === undefined)
        return { kind: "unavailable", reason: "no_route_configured", ...base };

      const nextTier = ladder.tiers.some((t) => t.tier === request.tier + 1)
        ? request.tier + 1
        : null;
      const tier = ladder.tiers.find((t) => t.tier === request.tier);
      const timeZone = tier?.rotations[0]?.timeZone ?? fallbackZone;
      const covering = (tier?.rotations ?? []).filter((r) => scheduleContains(r, request.asOf));
      if (covering.length === 0) return { kind: "coverage_gap", nextTier, timeZone, ...base };
      const userIds = [...new Set(covering.flatMap((r) => r.userIds))];
      return {
        kind: "resolved",
        userIds,
        nextTier,
        timeZone: covering[0]?.timeZone ?? timeZone,
        ...base,
      };
    },
  };
}
