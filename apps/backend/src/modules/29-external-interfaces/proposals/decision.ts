// apps/backend/src/modules/29-external-interfaces/proposals — the proposal decision core (M29-T04 / §4.1.2 /
// T-29.06 §5). PURE. Given the current proposal snapshot + an adjudication command, it validates the review
// guards and returns the DB update patch + the §4.10 outbox descriptor the T08 route applies (via an atomic
// `UPDATE … WHERE proposal_status='pending'` for race-safety) and publishes.
//
// GUARDS this core encodes that the enum column cannot:
//   • decided-is-decided (§2.6) — only a `pending` proposal is adjudicable; anything else throws
//     {@link ProposalAlreadyDecidedError} (the route maps it to 409, and the atomic UPDATE is the real race gate).
//   • reject requires a rationale of ≥ `XI_PROPOSAL_REJECT_RATIONALE_MIN_CHARS` chars (W-XI-04) — else
//     {@link ProposalRejectRationaleRequiredError} (route → 400 `decision_note_required`).
//   • accept applies via the OWNER MODULE (M5 `PatientMutator` / M6 `AdmissionEventApplier`) — the core only
//     emits `m29.hl7_inbound_proposal.accepted`; those consumers already exist and their deny-stubs close on it.
import { XI_PROPOSAL_REJECT_RATIONALE_MIN_CHARS } from "@wardenx/types";
import type {
  Hl7InboundProposalKind,
  Hl7InboundProposalStatus,
  Hl7ProposalOwnerModule,
} from "@wardenx/types";

/** The reviewable fields the decision core reads (a projection of the current `hl7_inbound_proposal` row). */
export interface ProposalSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly sourceMessageId: string;
  readonly resourceKind: Hl7InboundProposalKind;
  readonly ownerModule: Hl7ProposalOwnerModule;
  readonly matchedPatientId: string | null;
  readonly proposalStatus: Hl7InboundProposalStatus;
  readonly proposedPatientCandidate: unknown;
}

export interface AcceptCommand {
  readonly kind: "accept";
  readonly decidedByMembershipId: string;
  readonly decidedAt: Date;
  /** Subset of candidate fields to apply (partial accept, W-XI-03); `undefined` ⇒ full accept. */
  readonly appliedFields?: readonly string[];
  /** The candidate the reviewer picked when the proposal was `matched_ambiguous`. */
  readonly acceptedAggregateId?: string;
  readonly decisionRationale?: string;
}

export interface RejectCommand {
  readonly kind: "reject";
  readonly decidedByMembershipId: string;
  readonly decidedAt: Date;
  readonly decisionRationale: string;
}

export interface DeferCommand {
  readonly kind: "defer";
  readonly decidedByMembershipId: string;
  readonly deferredAt: Date;
}

export type ProposalDecisionCommand = AcceptCommand | RejectCommand | DeferCommand;

/** The `hl7_inbound_proposal` columns a decision sets (applied under `WHERE proposal_status='pending'`). */
export interface ProposalDecisionUpdate {
  readonly proposalStatus: Hl7InboundProposalStatus;
  /** The adjudicating membership, or `null` for the system-driven expire-sweep (NULL audit actor). */
  readonly decidedByMembershipId: string | null;
  readonly decidedAt: Date;
  readonly decisionRationale: string | null;
  readonly acceptedAggregateId?: string | null;
}

/** The `m29.hl7_inbound_proposal.accepted` payload (§4.10) — the shape M5/M6's accept consumers read. */
export interface ProposalAcceptedPayload {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly sourceMessageId: string;
  readonly resourceKind: Hl7InboundProposalKind;
  readonly ownerModule: Hl7ProposalOwnerModule;
  readonly matchedPatientId: string | null;
  readonly acceptedAggregateId: string | null;
  readonly decidedByMembershipId: string;
  readonly decidedAt: string;
  readonly decisionRationale: string | null;
  readonly appliedFields: readonly string[] | null;
  readonly proposedPatientCandidate: unknown;
}

/** The `m29.hl7_inbound_proposal.rejected` payload (§4.10). */
export interface ProposalRejectedPayload {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly sourceMessageId: string;
  readonly ownerModule: Hl7ProposalOwnerModule;
  readonly decidedByMembershipId: string;
  readonly decidedAt: string;
  readonly decisionRationale: string;
}

/** The `m29.hl7_inbound_proposal.expired` payload (§4.10). */
export interface ProposalExpiredPayload {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly expiredAt: string;
}

export type ProposalDecisionResult =
  | {
      readonly kind: "accepted";
      readonly update: ProposalDecisionUpdate;
      readonly event: {
        readonly name: "m29.hl7_inbound_proposal.accepted";
        readonly payload: ProposalAcceptedPayload;
      };
    }
  | {
      readonly kind: "rejected";
      readonly update: ProposalDecisionUpdate;
      readonly event: {
        readonly name: "m29.hl7_inbound_proposal.rejected";
        readonly payload: ProposalRejectedPayload;
      };
    }
  /** Defer punts the proposal to a caseload-RN task (M19 forward-seam, T08); the row stays `pending`, no event. */
  | { readonly kind: "deferred" };

/** A decision was attempted on a non-`pending` proposal (decided-is-decided, §2.6) — route maps to 409. */
export class ProposalAlreadyDecidedError extends Error {
  constructor() {
    super("proposal_already_decided");
    this.name = "ProposalAlreadyDecidedError";
  }
}

/** A reject was attempted without a ≥40-char rationale (W-XI-04) — route maps to 400 `decision_note_required`. */
export class ProposalRejectRationaleRequiredError extends Error {
  constructor(readonly minChars: number) {
    super("decision_note_required");
    this.name = "ProposalRejectRationaleRequiredError";
  }
}

/** Adjudicate a proposal. Throws the typed guards above; otherwise returns the update + outbox descriptor. */
export function decideProposal(
  snapshot: ProposalSnapshot,
  command: ProposalDecisionCommand,
): ProposalDecisionResult {
  if (snapshot.proposalStatus !== "pending") {
    throw new ProposalAlreadyDecidedError();
  }

  switch (command.kind) {
    case "accept": {
      const acceptedAggregateId = command.acceptedAggregateId ?? null;
      const decisionRationale = command.decisionRationale?.trim()
        ? command.decisionRationale.trim()
        : null;
      return {
        kind: "accepted",
        update: {
          proposalStatus: "accepted",
          decidedByMembershipId: command.decidedByMembershipId,
          decidedAt: command.decidedAt,
          decisionRationale,
          acceptedAggregateId,
        },
        event: {
          name: "m29.hl7_inbound_proposal.accepted",
          payload: {
            proposalId: snapshot.id,
            organizationId: snapshot.organizationId,
            sourceMessageId: snapshot.sourceMessageId,
            resourceKind: snapshot.resourceKind,
            ownerModule: snapshot.ownerModule,
            matchedPatientId: acceptedAggregateId ?? snapshot.matchedPatientId,
            acceptedAggregateId,
            decidedByMembershipId: command.decidedByMembershipId,
            decidedAt: command.decidedAt.toISOString(),
            decisionRationale,
            appliedFields: command.appliedFields ? [...command.appliedFields] : null,
            proposedPatientCandidate: snapshot.proposedPatientCandidate,
          },
        },
      };
    }

    case "reject": {
      const rationale = command.decisionRationale?.trim() ?? "";
      if (rationale.length < XI_PROPOSAL_REJECT_RATIONALE_MIN_CHARS) {
        throw new ProposalRejectRationaleRequiredError(XI_PROPOSAL_REJECT_RATIONALE_MIN_CHARS);
      }
      return {
        kind: "rejected",
        update: {
          proposalStatus: "rejected",
          decidedByMembershipId: command.decidedByMembershipId,
          decidedAt: command.decidedAt,
          decisionRationale: rationale,
        },
        event: {
          name: "m29.hl7_inbound_proposal.rejected",
          payload: {
            proposalId: snapshot.id,
            organizationId: snapshot.organizationId,
            sourceMessageId: snapshot.sourceMessageId,
            ownerModule: snapshot.ownerModule,
            decidedByMembershipId: command.decidedByMembershipId,
            decidedAt: command.decidedAt.toISOString(),
            decisionRationale: rationale,
          },
        },
      };
    }

    case "defer":
      // No status change — the reviewer punts to a caseload RN as an M19 task (wired at the T08 route).
      return { kind: "deferred" };
  }
}

/**
 * The system-driven `pending → expired` transition for one row (§2.2). Non-`pending` rows are unaffected
 * (returns `null` — the real race gate is the caller's atomic `WHERE proposal_status='pending'` UPDATE,
 * this is belt-and-suspenders on a stale read).
 *
 * `reason` defaults to the §2.2 72h SLA sweep's own rationale; F-165 (#248) widened this with an optional
 * override so a DIFFERENT system-driven expiry — the `m5.patient.deceased` freeze consumer
 * (`outbox-consumers/m5-patient-deceased.ts`) — can record ITS OWN reason in `decision_rationale` rather
 * than mislabeling a death-triggered freeze as an SLA timeout. Both still transition through the exact
 * same enum edge and emit the exact same `m29.hl7_inbound_proposal.expired` event — `expired` is the
 * correct terminal state for "this proposal no longer needs review" either way (§2.6 decided-is-decided;
 * there is no dedicated "frozen" status and inventing one is a schema change this narrow fix does not
 * need).
 */
export function expireProposal(
  snapshot: Pick<ProposalSnapshot, "id" | "organizationId" | "proposalStatus">,
  now: Date,
  reason: string = "auto_expired_pending_ttl_exceeded",
): {
  readonly update: ProposalDecisionUpdate;
  readonly event: {
    readonly name: "m29.hl7_inbound_proposal.expired";
    readonly payload: ProposalExpiredPayload;
  };
} | null {
  if (snapshot.proposalStatus !== "pending") return null;
  return {
    update: {
      proposalStatus: "expired",
      decidedByMembershipId: null,
      decidedAt: now,
      decisionRationale: reason,
    },
    event: {
      name: "m29.hl7_inbound_proposal.expired",
      payload: {
        proposalId: snapshot.id,
        organizationId: snapshot.organizationId,
        expiredAt: now.toISOString(),
      },
    },
  };
}
