// @chartwarden/fhir — §2.2 `fhir_client` onboarding state machine (M28-T01).
//
// The §2.2 diagram as a PURE function of (fromStatus, toStatus) → transition. No IO, no DB, no clock:
// `fhir_client.status` is the state, the M4 write-audit trigger + the outbox are the ledger, and
// M28-T03's `client-onboarding.ts` / `client-revocation.ts` are what walk the row through these edges.
//
// TWO GUARANTEES THIS FILE ENCODES that a bare enum cannot:
//
//  1. `pending_approval → active` is a DUAL-APPROVAL edge (D12). The FSM permits it, but the SERVICE must
//     additionally verify `approved_by_admin_membership_id` and `approved_by_compliance_membership_id`
//     are BOTH non-null AND DISTINCT before writing `active` — the row's status "cannot flip without both
//     being non-null" (§2.2). `fhirClientTransition` returns the edge; `requiresDualApproval` flags which
//     edge carries the extra obligation, so the service cannot forget it silently.
//
//  2. `revoked` and `rejected` are TERMINAL. No edge leaves them. A revocation cascade (revoke sessions,
//     cancel in-flight bulk exports — §2.4) runs on ENTRY to `revoked`; there is no un-revoke, only a new
//     client. `suspended`, by contrast, is reversible (`suspended → active` on manual unsuspend).

import type {
  FhirClientServePosture,
  FhirClientStatus,
  FhirStatusTransition,
} from "@chartwarden/types";

/** The status a freshly-proposed client lands in (§2.2 `[*] --> proposed` / "Org Admin requests"). */
export const FHIR_CLIENT_INITIAL_STATUS: FhirClientStatus = "pending_approval";

/**
 * Every legal edge of the §2.2 onboarding FSM.
 *
 * `auditAction` is the `audit_event.action` the transition emits (§2.2 "Transitions emit
 * `audit_event.action` per the table"); the strings follow the §2.4 outbox naming so the audit row and
 * the outbox event read the same verb.
 */
export const FHIR_CLIENT_TRANSITIONS: readonly FhirStatusTransition<FhirClientStatus>[] = [
  {
    fromStatus: null,
    toStatus: "pending_approval",
    auditAction: "m28.fhir.client.proposed",
    label: "Org Admin requests a client",
  },
  {
    fromStatus: "pending_approval",
    toStatus: "active",
    auditAction: "m28.fhir.client.activated",
    label: "Compliance Officer co-approves (dual approval, D12)",
  },
  {
    fromStatus: "pending_approval",
    toStatus: "rejected",
    auditAction: "m28.fhir.client.rejected",
    label: "approval denied",
  },
  {
    fromStatus: "active",
    toStatus: "suspended",
    auditAction: "m28.fhir.client.suspended",
    label: "manual or rate-violation suspension",
  },
  {
    fromStatus: "suspended",
    toStatus: "active",
    auditAction: "m28.fhir.client.activated",
    label: "manual unsuspend",
  },
  {
    fromStatus: "suspended",
    toStatus: "revoked",
    auditAction: "m28.fhir.client.revoked",
    label: "revoked from suspension",
  },
  {
    fromStatus: "active",
    toStatus: "revoked",
    auditAction: "m28.fhir.client.revoked",
    label: "Org Admin or platform-ops revokes",
  },
];

/** The (from → to) pair whose write demands the D12 dual-approval evidence on top of the FSM edge. */
const DUAL_APPROVAL_EDGE: { readonly from: FhirClientStatus; readonly to: FhirClientStatus } = {
  from: "pending_approval",
  to: "active",
};

/** The statuses whose entry runs the §2.4 revocation cascade (revoke sessions, cancel bulk exports). */
export const FHIR_CLIENT_CASCADE_ON_ENTRY: readonly FhirClientStatus[] = ["suspended", "revoked"];

/** The terminal statuses — no edge leaves them (§2.2). */
export const FHIR_CLIENT_TERMINAL_STATUSES: readonly FhirClientStatus[] = ["revoked", "rejected"];

/** Resolve the transition for a (from, to) pair, or `null` if the FSM forbids it. */
export function fhirClientTransition(
  from: FhirClientStatus | null,
  to: FhirClientStatus,
): FhirStatusTransition<FhirClientStatus> | null {
  return FHIR_CLIENT_TRANSITIONS.find((t) => t.fromStatus === from && t.toStatus === to) ?? null;
}

/** True when the FSM permits the transition. Fails CLOSED: an unknown pair is not a transition. */
export function canFhirClientTransition(
  from: FhirClientStatus | null,
  to: FhirClientStatus,
): boolean {
  return fhirClientTransition(from, to) !== null;
}

/** True when the edge is the D12 dual-approval promotion — the service must verify both distinct
 *  approver memberships before it writes the new status. */
export function fhirClientEdgeRequiresDualApproval(
  from: FhirClientStatus | null,
  to: FhirClientStatus,
): boolean {
  return from === DUAL_APPROVAL_EDGE.from && to === DUAL_APPROVAL_EDGE.to;
}

/**
 * §2.2 — the D12 dual-approval predicate the service checks BEFORE writing `active`. The two approvers
 * must both be present AND distinct; the compliance signature is the §164.504 BAA-in-place artifact, so a
 * single membership signing both roles would defeat the survey-defense purpose of the second signature.
 */
export function fhirDualApprovalSatisfied(
  adminMembershipId: string | null | undefined,
  complianceMembershipId: string | null | undefined,
): boolean {
  return (
    !!adminMembershipId && !!complianceMembershipId && adminMembershipId !== complianceMembershipId
  );
}

/** The client's onboarding-lifecycle serve posture (§2.2). LIFECYCLE leg only — the rate limit, IP
 *  allowlist, SUD consent gate and `fhir.write` flag are further request-time gates. */
export function fhirClientServePosture(status: FhirClientStatus): FhirClientServePosture {
  switch (status) {
    case "active":
      return { kind: "serving" };
    case "pending_approval":
      return { kind: "awaiting_approval" };
    case "suspended":
      return { kind: "suspended" };
    case "revoked":
    case "rejected":
      return { kind: "terminated", terminalStatus: status };
  }
}
