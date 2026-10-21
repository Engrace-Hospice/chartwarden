// @chartwarden/messaging - TEST-ONLY in-memory EscalationRouter (M36 WP 4.3, ADR-0057). It implements the real contract over a fixed
// ladder using the shared shift-window rule, so the shift-boundary and time-zone acceptance is proved against the contract itself.
// Every answer is stamped `in_memory_fake`; production wiring must never import it (a backend test scans for that). It is not an
// M19 roster: M19 stays the only owner of rosters and tiers. It enforces only the org it was built for; the real router must also
// check the request context and that the patient belongs to the org (ADR-0057).
import {
  ESCALATION_MAX_TIER,
  type EscalationRouteAnswer,
  type EscalationRouteRequest,
  type EscalationRouter,
  ChartWardenError,
} from "@chartwarden/types";
import {
  type ShiftSchedule,
  parseStrictInstant,
  scheduleContains,
  validateShiftSchedule,
} from "./shift-window";

export interface FakeRotation extends ShiftSchedule {
  readonly userIds: readonly string[];
  /** Users of this rotation that hold the BACKUP seat; every other user of the rotation is primary. */
  readonly backupUserIds?: readonly string[];
}
export interface FakeTier {
  readonly tier: number;
  readonly rotations: readonly FakeRotation[];
}
export interface FakeLadder {
  readonly role: string;
  /** Contiguous from 1 (1, 2, 3...), each with at least one rotation. */
  readonly tiers: readonly FakeTier[];
}
export interface InMemoryEscalationRouterOptions {
  /** The one org this router serves; a call for any other org is refused. */
  readonly orgId: string;
  readonly ladders: readonly FakeLadder[];
}

const SOURCE = "in_memory_fake" as const;

function bad(code: string, message: string, status = 400): ChartWardenError {
  return new ChartWardenError(code, message, status);
}

function validateLadders(ladders: readonly FakeLadder[]): void {
  for (const ladder of ladders) {
    const numbers = ladder.tiers.map((t) => t.tier);
    if (
      numbers.length === 0 ||
      numbers.some((n, i) => n !== i + 1) ||
      numbers.length > ESCALATION_MAX_TIER
    ) {
      throw bad(
        "ESCALATION_LADDER_INVALID",
        `ladder "${ladder.role}" must have tiers 1..n in order, with no gap`,
      );
    }
    for (const tier of ladder.tiers) {
      if (tier.rotations.length === 0) {
        throw bad(
          "ESCALATION_LADDER_INVALID",
          `tier ${tier.tier} of "${ladder.role}" has no rotation`,
        );
      }
      for (const rotation of tier.rotations) {
        if (rotation.userIds.length === 0) {
          throw bad(
            "ESCALATION_LADDER_INVALID",
            `a rotation in tier ${tier.tier} of "${ladder.role}" has no users`,
          );
        }
        validateShiftSchedule(rotation);
      }
    }
  }
}

function validateRequest(request: EscalationRouteRequest): void {
  if (
    !Number.isSafeInteger(request.tier) ||
    request.tier < 1 ||
    request.tier > ESCALATION_MAX_TIER
  ) {
    throw bad("ESCALATION_REQUEST_INVALID", `tier must be an integer 1..${ESCALATION_MAX_TIER}`);
  }
  if (!request.patientId || !request.requiredRole) {
    throw bad("ESCALATION_REQUEST_INVALID", "patient and role are required");
  }
  try {
    parseStrictInstant(request.asOf);
  } catch {
    throw bad(
      "ESCALATION_REQUEST_INVALID",
      "asOf must be an ISO-8601 date-time with an explicit offset",
    );
  }
}

export function createInMemoryEscalationRouter(
  options: InMemoryEscalationRouterOptions,
): EscalationRouter {
  validateLadders(options.ladders);

  return {
    async resolveTier(
      orgId: string,
      request: EscalationRouteRequest,
    ): Promise<EscalationRouteAnswer> {
      if (orgId !== options.orgId) {
        throw bad(
          "ESCALATION_ORG_MISMATCH",
          "escalation routing refused: org does not match the caller",
          403,
        );
      }
      validateRequest(request);
      const base = { tier: request.tier, asOf: request.asOf, source: SOURCE };
      const ladder = options.ladders.find((l) => l.role === request.requiredRole);
      if (!ladder) return { kind: "unavailable", reason: "no_route_configured", ...base };
      const tier = ladder.tiers.find((t) => t.tier === request.tier);
      if (!tier) return { kind: "unavailable", reason: "tier_not_configured", ...base };

      const nextTier = ladder.tiers.some((t) => t.tier === request.tier + 1)
        ? request.tier + 1
        : null;
      const covering = tier.rotations.filter((r) => scheduleContains(r, request.asOf));
      const [first] = covering;
      if (!first) {
        // validateLadders guarantees a rotation; the tier's first rotation's zone is the tier's configured zone.
        const tierZone = tier.rotations[0]?.timeZone;
        if (tierZone === undefined)
          throw bad("ESCALATION_LADDER_INVALID", "a tier has no rotation");
        return { kind: "coverage_gap", nextTier, timeZone: tierZone, ...base };
      }
      // First occurrence keeps its place; primary on any covering rotation wins over backup.
      const rankOf = new Map<string, "primary" | "backup">();
      for (const rotation of covering) {
        for (const id of rotation.userIds) {
          const rank = rotation.backupUserIds?.includes(id) ? "backup" : "primary";
          if (rankOf.get(id) !== "primary") rankOf.set(id, rank);
        }
      }
      const [head, ...rest] = [...rankOf.keys()];
      if (head === undefined)
        throw bad("ESCALATION_LADDER_INVALID", "a covering rotation has no users");
      return {
        kind: "resolved",
        userIds: [head, ...rest],
        ranks: [...rankOf.values()],
        nextTier,
        timeZone: first.timeZone,
        ...base,
      };
    },
  };
}
