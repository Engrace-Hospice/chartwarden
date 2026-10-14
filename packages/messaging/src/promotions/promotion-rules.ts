// M36 WP 3.7 - the pure chart-promotion rules (ADR-0063). No I/O: the service and the stores call these, so the request
// decision (insert / replay / supersede), the outcome table and the caller's actions have one definition.
import {
  CHART_PROMOTION_TARGETS,
  type ChartPromotionAction,
  type ChartPromotionOutcome,
  type ChartPromotionReasonCode,
  type ChartPromotionRole,
  type ChartPromotionStatus,
  type ChartPromotionTargetModule,
  isChartPromotionTarget,
} from "@wardenx/types";

export { CHART_PROMOTION_TARGETS, isChartPromotionTarget };

/** Newest proposals shown to a reviewer per call; a reviewer works a short list, not an archive. */
export const CHART_PROMOTION_PENDING_MAX = 20;

/** The slice of a stored request the decisions need. */
export interface PromotionFacts {
  readonly status: ChartPromotionStatus;
  readonly sourceBodySha256: string;
  readonly requestedAt: Date;
}

export type PromotionRequestDecision =
  | { readonly kind: "insert" }
  /** The same body is already proposed (or already accepted): return that row, write and publish nothing. */
  | { readonly kind: "replay"; readonly index: number }
  /** The message was edited after it was proposed: the old proposal is superseded and a new one inserted. */
  | { readonly kind: "supersede"; readonly index: number };

/**
 * What a request for (message, target) does given the existing rows for that key and the body hash now.
 * Proposed + same hash replays; proposed + other hash supersedes; otherwise the latest accepted request for the same hash
 * replays (the message is already in the chart); otherwise a new request. Rejected, withdrawn and superseded never block.
 */
export function decidePromotionRequest(
  existing: readonly PromotionFacts[],
  incomingSha: string,
): PromotionRequestDecision {
  const proposed = existing.findIndex((r) => r.status === "proposed");
  if (proposed >= 0) {
    return existing[proposed]?.sourceBodySha256 === incomingSha
      ? { kind: "replay", index: proposed }
      : { kind: "supersede", index: proposed };
  }
  let latest = -1;
  existing.forEach((r, i) => {
    if (r.status !== "accepted" || r.sourceBodySha256 !== incomingSha) return;
    const best = existing[latest];
    if (!best || r.requestedAt.getTime() >= best.requestedAt.getTime()) latest = i;
  });
  return latest >= 0 ? { kind: "replay", index: latest } : { kind: "insert" };
}

export interface PromotionOutcomeInput {
  /** The module whose `mN.chart_promotion.decided` event this is. */
  readonly ownerModule: string;
  readonly outcome: ChartPromotionOutcome;
  readonly resultRef: string | null;
  readonly reasonCode: ChartPromotionReasonCode | null;
}

export interface PromotionOutcomeRow {
  readonly status: ChartPromotionStatus;
  readonly targetModule: ChartPromotionTargetModule | string;
  readonly resultRef: string | null;
}

export type PromotionOutcomeDecision =
  /** Move the row to accepted (from proposed, withdrawn or superseded) with this result. */
  | { readonly kind: "accept"; readonly resultRef: string }
  | { readonly kind: "reject"; readonly reasonCode: ChartPromotionReasonCode }
  | { readonly kind: "noop" }
  /** An event from a module that does not own the target, or a malformed one: believed by nobody. */
  | { readonly kind: "ignore" }
  /** An accepted row already has a different result: log ids only, change nothing. */
  | { readonly kind: "conflict" };

/** The reason codes a reviewer may give when declining; anything else is recorded as `other`. */
const REJECT_REASONS: readonly ChartPromotionReasonCode[] = [
  "not_clinically_relevant",
  "already_documented",
  "duplicate",
  "wrong_patient",
  "other",
];

/**
 * How the owning module's decision applies to a request. Only the module that owns the target is believed. Accepted may
 * still land on a withdrawn or superseded request (a signed record exists, so the truth beats the earlier intent); a
 * rejection of a request that is no longer proposed changes nothing.
 */
export function applyPromotionOutcome(
  row: PromotionOutcomeRow,
  event: PromotionOutcomeInput,
): PromotionOutcomeDecision {
  if (event.ownerModule !== row.targetModule) return { kind: "ignore" };
  if (event.outcome === "accepted") {
    if (!event.resultRef) return { kind: "ignore" };
    if (row.status === "accepted") {
      return row.resultRef === event.resultRef ? { kind: "noop" } : { kind: "conflict" };
    }
    if (row.status === "rejected") return { kind: "noop" };
    return { kind: "accept", resultRef: event.resultRef };
  }
  if (row.status !== "proposed") return { kind: "noop" };
  const wanted = event.reasonCode;
  return {
    kind: "reject",
    reasonCode: wanted && REJECT_REASONS.includes(wanted) ? wanted : "other",
  };
}

/** Only the person who proposed it may take a proposal back, and only while it is still proposed. */
export function allowedPromotionActions(
  row: { readonly status: ChartPromotionStatus },
  role: ChartPromotionRole,
): readonly ChartPromotionAction[] {
  return row.status === "proposed" && role === "requester" ? ["withdraw"] : [];
}

export function promotionActorRole(
  row: { readonly requestedByUserId: string },
  userId: string,
): ChartPromotionRole {
  return row.requestedByUserId === userId ? "requester" : "other";
}

/** The status active (still awaiting a reviewer) vs closed, for the requester's list. */
export function isActivePromotionStatus(status: ChartPromotionStatus): boolean {
  return status === "proposed";
}
