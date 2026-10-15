// M36 WP 4.3 - the EscalationRouter seam contract (ADR-0057). M36 asks M19 one question: "who is on call for role R at instant T for
// patient P at tier n, and is there a tier n+1?". M19 owns rosters, tiers and time-zone rules and answers from them; M36 owns the
// timers and the request state and never keeps a roster copy. The answer carries user ids only (no names, no PHI) and the IANA
// time zone the schedule was evaluated in, so a reader can see it was not the server's. Leaf types only (ADR-0005): M36 resolves
// the implementation through the M1 seam registry and adds no import edge to M19.

/** Where an answer came from. `deny_stub` is the registered default and `in_memory_fake` is test-only; neither may reach a user. */
export const ESCALATION_ROUTE_SOURCES = ["m19", "deny_stub", "in_memory_fake"] as const;
export type EscalationRouteSource = (typeof ESCALATION_ROUTE_SOURCES)[number];

/**
 * Why no answer could be given at all (distinct from a real coverage gap):
 *  - router_not_bound  no M19 implementation is registered (the deny-stub answers).
 *  - no_route_configured  M19 has no ladder for this role in this org.
 */
export const ESCALATION_UNAVAILABLE_REASONS = ["router_not_bound", "no_route_configured"] as const;
export type EscalationUnavailableReason = (typeof ESCALATION_UNAVAILABLE_REASONS)[number];

export interface EscalationRouteRequest {
  readonly patientId: string;
  /** The role the request needs (platform role key); M19 maps it to its ladder. */
  readonly requiredRole: string;
  /** The tier being asked about, 1-based. Tier 1 is the first responder tier. */
  readonly tier: number;
  /** The instant the roster is read at, ISO-8601 with an offset or Z. Same instant, same answer (a replayed timer is idempotent). */
  readonly asOf: string;
}

interface EscalationAnswerBase {
  readonly tier: number;
  /** The instant the answer was evaluated at (echoes the request). */
  readonly asOf: string;
  readonly source: EscalationRouteSource;
}

export interface EscalationResolved extends EscalationAnswerBase {
  readonly kind: "resolved";
  /** Users accountable at this tier at `asOf`. Never empty. Ids only. */
  readonly userIds: readonly string[];
  /** The next tier number, or null when this is the last tier. */
  readonly nextTier: number | null;
  /** The schedule's IANA zone the shift windows were evaluated in. Never the server's. */
  readonly timeZone: string;
}

/** A real answer: the ladder has this tier but nobody covers it at `asOf`. Not "nobody needed". */
export interface EscalationCoverageGap extends EscalationAnswerBase {
  readonly kind: "coverage_gap";
  readonly nextTier: number | null;
  readonly timeZone: string;
}

/** No answer could be produced. A caller MUST treat this as "cannot route" and surface it, never as "no one needed". */
export interface EscalationUnavailable extends EscalationAnswerBase {
  readonly kind: "unavailable";
  readonly reason: EscalationUnavailableReason;
}

export type EscalationRouteAnswer =
  | EscalationResolved
  | EscalationCoverageGap
  | EscalationUnavailable;

/**
 * The seam. `orgId` is positional and first, and is an assertion of the caller's own org, never a selector (M19 convention): an
 * implementation refuses a call whose org differs from the request context. A store failure THROWS; it is never mapped to
 * `coverage_gap` or `unavailable`.
 */
export interface EscalationRouter {
  resolveTier(orgId: string, request: EscalationRouteRequest): Promise<EscalationRouteAnswer>;
}
