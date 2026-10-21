// apps/backend/src/modules/29-external-interfaces/feed — §2.2 `external_feed` onboarding state machine
// (M29-T03). The §2.2 diagram as a PURE function of (fromStatus, toStatus) → transition. No IO, no DB,
// no clock: `external_feed.status` is the state, the M4 baseline write-audit trigger + the §2.4 outbox are
// the ledger, and the T08 operator routes are what walk the row through these edges.
//
// THREE GUARANTEES THIS FILE ENCODES that a bare enum cannot (mirrors the M28 `fhirClientTransition`
// precedent):
//
//  1. `pending_approval → active` is a DUAL-APPROVAL edge (D18, the M28 D12 pattern reapplied). The FSM
//     permits it, but the SERVICE must additionally verify the Operator (`approved_by_op_id`) and the
//     Compliance Officer (`approved_by_compl_id`) are BOTH non-null AND DISTINCT before writing `active`
//     (§2.2 "a Compliance Officer with a *distinct membership* co-approves"; ABAC
//     `external_feed_compliance_co_approver_distinct`, §4.8). `externalFeedEdgeRequiresComplianceCoApproval`
//     flags the edge so the service cannot forget the second signature silently.
//
//  2. Two edges BIND THE MLLP LISTENER (`pending_approval → active` and the `suspended → active`
//     un-suspend). Both must pass the M40 BAA gate (D16) BEFORE the row flips to `active` — see
//     `feed/baa-gate.ts`. `externalFeedEdgeBindsListener` flags them so the activation service knows to run
//     the gate; a `revoked`/`rejected`/`suspended` edge never binds and skips it.
//
//  3. `revoked` and `rejected` are TERMINAL — no edge leaves them (§2.2 "Revocation is permanent; the row
//     is retained for audit because every inbound message has a `feed_id` FK that must remain resolvable").
//     There is no un-revoke, only a new feed. `suspended`, by contrast, is reversible.
import type {
  ExternalFeedServePosture,
  ExternalFeedStatus,
  Hl7StatusTransition,
} from "@chartwarden/types";

/** The status a freshly-created feed lands in (§2.2 `[entry] --> proposed`, "Operator requests"). */
export const EXTERNAL_FEED_INITIAL_STATUS: ExternalFeedStatus = "proposed";

/**
 * Every legal edge of the §2.2 `external_feed` onboarding FSM.
 *
 * `auditAction` follows the §2.4 side-effects table so the M4 audit row and the outbox event read the same
 * verb (`m29.external_feed.<verb>`). The `proposed → pending_approval` submit edge and the
 * `suspended → active` un-suspend edge have no distinct §2.4 event row, so they reuse the closest verb
 * (`submitted_for_approval` / `activated`) — the audit trail still records the exact (from → to) pair.
 */
export const EXTERNAL_FEED_TRANSITIONS: readonly Hl7StatusTransition<ExternalFeedStatus>[] = [
  {
    fromStatus: null,
    toStatus: "proposed",
    auditAction: "m29.external_feed.proposed",
    label: "Operator requests a feed",
  },
  {
    fromStatus: "proposed",
    toStatus: "pending_approval",
    auditAction: "m29.external_feed.submitted_for_approval",
    label: "Operator submits the feed for compliance co-approval",
  },
  {
    fromStatus: "pending_approval",
    toStatus: "active",
    auditAction: "m29.external_feed.activated",
    label: "Compliance Officer co-approves (distinct membership, D18) + BAA gate passes",
  },
  {
    fromStatus: "pending_approval",
    toStatus: "rejected",
    auditAction: "m29.external_feed.rejected",
    label: "co-approval denied",
  },
  {
    fromStatus: "active",
    toStatus: "suspended",
    auditAction: "m29.external_feed.suspended",
    label: "manual suspend / BAA expired / cert-pin mismatch storm / allowlist breach",
  },
  {
    fromStatus: "suspended",
    toStatus: "active",
    auditAction: "m29.external_feed.activated",
    label: "Operator un-suspends after BAA refresh / cert rotate (BAA gate re-runs)",
  },
  {
    fromStatus: "active",
    toStatus: "revoked",
    auditAction: "m29.external_feed.revoked",
    label: "Operator revokes (permanent)",
  },
  {
    fromStatus: "suspended",
    toStatus: "revoked",
    auditAction: "m29.external_feed.revoked",
    label: "Operator revokes a suspended feed (permanent)",
  },
];

/** The terminal statuses — no edge leaves them (§2.2). The row is retained so every message's FK resolves. */
export const EXTERNAL_FEED_TERMINAL_STATUSES: readonly ExternalFeedStatus[] = [
  "revoked",
  "rejected",
];

/** The (from → to) edge whose write demands the D18 distinct-compliance-co-approver evidence. */
const COMPLIANCE_CO_APPROVAL_EDGE: {
  readonly from: ExternalFeedStatus;
  readonly to: ExternalFeedStatus;
} = { from: "pending_approval", to: "active" };

/** The edges that BIND the MLLP listener on entry to `active` — both must pass the D16 BAA gate first. */
const LISTENER_BINDING_EDGES: readonly {
  readonly from: ExternalFeedStatus;
  readonly to: ExternalFeedStatus;
}[] = [
  { from: "pending_approval", to: "active" },
  { from: "suspended", to: "active" },
];

/** Resolve the transition for a (from, to) pair, or `null` if the FSM forbids it. */
export function externalFeedTransition(
  from: ExternalFeedStatus | null,
  to: ExternalFeedStatus,
): Hl7StatusTransition<ExternalFeedStatus> | null {
  return EXTERNAL_FEED_TRANSITIONS.find((t) => t.fromStatus === from && t.toStatus === to) ?? null;
}

/** True when the FSM permits the transition. Fails CLOSED: an unknown pair is not a transition. */
export function canExternalFeedTransition(
  from: ExternalFeedStatus | null,
  to: ExternalFeedStatus,
): boolean {
  return externalFeedTransition(from, to) !== null;
}

/** True when the edge is the D18 compliance co-approval promotion — the service must verify both distinct
 *  approver memberships (Operator + Compliance Officer) before it writes `active`. */
export function externalFeedEdgeRequiresComplianceCoApproval(
  from: ExternalFeedStatus | null,
  to: ExternalFeedStatus,
): boolean {
  return from === COMPLIANCE_CO_APPROVAL_EDGE.from && to === COMPLIANCE_CO_APPROVAL_EDGE.to;
}

/**
 * §2.2 / D18 — the distinct-co-approver predicate the service checks BEFORE writing `active`. Both actors
 * must be present AND distinct; a single membership signing both the operator and compliance roles would
 * defeat the survey-defense purpose of the second signature (the M28 D12 pattern reapplied).
 */
export function externalFeedCoApprovalSatisfied(
  operatorMembershipId: string | null | undefined,
  complianceMembershipId: string | null | undefined,
): boolean {
  return (
    !!operatorMembershipId &&
    !!complianceMembershipId &&
    operatorMembershipId !== complianceMembershipId
  );
}

/** GAP-153 / D20 — what a revoke call does given the STORED first approver (never a body-supplied one). */
export type FeedRevokeStep = "request" | "complete" | "self_approval";

/**
 * Dual-approval revoke: with no first approver on file this call IS the first approval (`request`); a second,
 * DISTINCT membership completes the revoke (`complete`); the same membership approving twice is refused.
 */
export function decideFeedRevokeStep(
  storedRequesterMembershipId: string | null | undefined,
  actorMembershipId: string,
): FeedRevokeStep {
  if (!storedRequesterMembershipId) return "request";
  return storedRequesterMembershipId === actorMembershipId ? "self_approval" : "complete";
}

/** True when the edge binds the MLLP listener on entry to `active` — the activation service must run the
 *  M40 BAA gate (`feed/baa-gate.ts`) BEFORE writing the new status (D16). */
export function externalFeedEdgeBindsListener(
  from: ExternalFeedStatus | null,
  to: ExternalFeedStatus,
): boolean {
  return LISTENER_BINDING_EDGES.some((e) => e.from === from && e.to === to);
}

/**
 * The feed's onboarding-lifecycle serve posture (§2.2). LIFECYCLE leg only — `serving` means the registry
 * PERMITS binding; the per-feed sender allowlist (§4.11.2), the M40 BAA gate (D16), the channel cert pin
 * (§8.7) and the rate limit are further request-time gates the listener applies on top.
 */
export function externalFeedServePosture(status: ExternalFeedStatus): ExternalFeedServePosture {
  switch (status) {
    case "active":
      return { kind: "serving" };
    case "proposed":
    case "pending_approval":
      return { kind: "awaiting_approval", status };
    case "suspended":
      return { kind: "suspended" };
    case "revoked":
    case "rejected":
      return { kind: "terminated", terminalStatus: status };
  }
}
