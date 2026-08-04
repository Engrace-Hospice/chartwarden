// apps/backend/src/modules/29-external-interfaces/proposals — the `hl7_inbound_proposal` review FSM (M29-T04
// / §2.2). PURE, mirroring the `external_feed` lifecycle precedent: the enum column is the state, the M4
// baseline write-audit trigger + the §4.10 outbox are the ledger, and the T08 review routes walk a row
// through these edges. `pending` is the ONLY reviewable state; `accepted` / `rejected` / `expired` are all
// terminal (decided-is-decided, §2.6) — there is no re-open, only a fresh inbound message + proposal.
import type {
  Hl7InboundMatchOutcome,
  Hl7InboundProposalStatus,
  Hl7ProposalReviewPosture,
  Hl7StatusTransition,
} from "@wardenx/types";

/** The status a freshly-created proposal lands in (§2.2 — an inbound message resolves to `pending` review). */
export const HL7_INBOUND_PROPOSAL_INITIAL_STATUS: Hl7InboundProposalStatus = "pending";

/** The terminal proposal states — no edge leaves them. */
export const HL7_INBOUND_PROPOSAL_TERMINAL_STATUSES: readonly Hl7InboundProposalStatus[] = [
  "accepted",
  "rejected",
  "expired",
];

/** Every legal edge of the §2.2 proposal review FSM; `auditAction` reads the same `m29.*` verb as the outbox. */
export const HL7_INBOUND_PROPOSAL_TRANSITIONS: readonly Hl7StatusTransition<Hl7InboundProposalStatus>[] =
  [
    {
      fromStatus: null,
      toStatus: "pending",
      auditAction: "m29.hl7_inbound_proposal.created",
      label: "Cascade resolves an inbound ADT to a review proposal",
    },
    {
      fromStatus: "pending",
      toStatus: "accepted",
      auditAction: "m29.hl7_inbound_proposal.accepted",
      label: "Reviewer accepts → apply via the owner module (M5/M6)",
    },
    {
      fromStatus: "pending",
      toStatus: "rejected",
      auditAction: "m29.hl7_inbound_proposal.rejected",
      label: "Reviewer rejects with a required rationale (W-XI-04)",
    },
    {
      fromStatus: "pending",
      toStatus: "expired",
      auditAction: "m29.hl7_inbound_proposal.expired",
      label: "Review SLA lapsed — the expire-sweep flips it (§2.2)",
    },
  ];

/** Resolve the transition for a `(from → to)` edge, or `undefined` when the edge is illegal. */
export function hl7InboundProposalTransition(
  from: Hl7InboundProposalStatus | null,
  to: Hl7InboundProposalStatus,
): Hl7StatusTransition<Hl7InboundProposalStatus> | undefined {
  return HL7_INBOUND_PROPOSAL_TRANSITIONS.find((t) => t.fromStatus === from && t.toStatus === to);
}

/** True when `(from → to)` is a legal edge. */
export function canHl7InboundProposalTransition(
  from: Hl7InboundProposalStatus | null,
  to: Hl7InboundProposalStatus,
): boolean {
  return hl7InboundProposalTransition(from, to) !== undefined;
}

/** True when the proposal is still adjudicable (`pending`). Terminal states fail closed. */
export function canDecideProposal(status: Hl7InboundProposalStatus): boolean {
  return status === "pending";
}

/**
 * The operator-facing review posture (§2.2): `pending` is reviewable (ambiguous when the cascade left the
 * reviewer a candidate list to pick from); the rest are decided/expired.
 */
export function hl7ProposalReviewPosture(
  status: Hl7InboundProposalStatus,
  matchOutcome: Hl7InboundMatchOutcome,
): Hl7ProposalReviewPosture {
  switch (status) {
    case "pending":
      return { kind: "reviewable", ambiguous: matchOutcome === "matched_ambiguous" };
    case "accepted":
      return { kind: "decided", terminalStatus: "accepted" };
    case "rejected":
      return { kind: "decided", terminalStatus: "rejected" };
    case "expired":
      return { kind: "expired" };
  }
}
