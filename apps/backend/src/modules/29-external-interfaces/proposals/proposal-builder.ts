import type { NewHl7InboundProposalRow } from "@chartwarden/db/schema";
// apps/backend/src/modules/29-external-interfaces/proposals — cascade-outcome → proposal-creation planning (M29-T04 /
// T-29.06 §2.1/§4). PURE. Translates a {@link MatchOutcome} + the ADT message context + the parsed
// candidate into either:
//   • `create` — the `hl7_inbound_proposal` insert row + the `m29.hl7_inbound_proposal.created` outbox
//     descriptor (propose-then-review for EVERY confident/candidate/ambiguous/new-patient outcome, D5), or
//   • `drop`   — the `m29.hl7_message.routing_dropped` descriptor (A03/A11 no-match: can't act on an
//     unknown patient), or
//   • `skip`   — an unsupported message type (logged, no effect).
//
// Determinism: the caller supplies `proposalId`, `proposedAt`, and `expiresAt` so the result is a pure
// function of its inputs (the T08 worker mints the id/clock and does the atomic insert + publish).
import type {
  Hl7InboundMatchLevel,
  Hl7InboundMatchOutcome,
  Hl7InboundProposalKind,
  Hl7ProposalOwnerModule,
} from "@chartwarden/types";
import type { MatchOutcome } from "../inbound/match-cascade";
import type { CascadeMessageContext } from "../inbound/outcome-router";
import { MESSAGE_TYPE_ROUTING, isSupportedAdt } from "./message-type-routing";

export interface ProposalCreatedPayload {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly sourceMessageId: string;
  readonly resourceKind: Hl7InboundProposalKind;
  readonly ownerModule: Hl7ProposalOwnerModule;
  readonly matchOutcome: Hl7InboundMatchOutcome;
  readonly matchedPatientId: string | null;
  readonly matchLevel: Hl7InboundMatchLevel;
  readonly matchConfidence: number | null;
  readonly matchCandidateIds: readonly string[];
  readonly expiresAt: string;
}

export interface RoutingDroppedPayload extends CascadeMessageContext {
  readonly reason: "cannot_act_on_unknown_patient";
}

export type ProposalPlan =
  | {
      readonly kind: "create";
      readonly proposal: NewHl7InboundProposalRow;
      readonly event: {
        readonly name: "m29.hl7_inbound_proposal.created";
        readonly payload: ProposalCreatedPayload;
      };
    }
  | {
      readonly kind: "drop";
      readonly event: {
        readonly name: "m29.hl7_message.routing_dropped";
        readonly payload: RoutingDroppedPayload;
      };
    }
  | { readonly kind: "skip"; readonly reason: "unsupported_message_type" };

export interface BuildProposalInput {
  readonly outcome: MatchOutcome;
  readonly context: CascadeMessageContext;
  /** The full {@link ProjectedAdt} (or its candidate) stored as `proposed_patient_candidate` (PHI, denylisted). */
  readonly proposedPatientCandidate: unknown;
  readonly proposalId: string;
  readonly proposedAt: Date;
  readonly expiresAt: Date;
}

interface OutcomeFields {
  readonly matchOutcome: Hl7InboundMatchOutcome;
  readonly matchedPatientId: string | null;
  readonly matchConfidence: string | null;
  readonly matchCandidateIds: readonly string[];
  readonly matchLevel: Hl7InboundMatchLevel;
}

function projectOutcomeFields(outcome: MatchOutcome): OutcomeFields {
  switch (outcome.kind) {
    case "confident_match":
      return {
        matchOutcome: "matched_single",
        matchedPatientId: outcome.patientId,
        matchConfidence: null,
        matchCandidateIds: [outcome.patientId],
        matchLevel: outcome.level,
      };
    case "candidate_match":
      return {
        matchOutcome: "matched_single",
        matchedPatientId: outcome.patientId,
        matchConfidence: outcome.confidence.toFixed(3),
        matchCandidateIds: [outcome.patientId],
        matchLevel: outcome.level,
      };
    case "ambiguous":
      return {
        matchOutcome: "matched_ambiguous",
        matchedPatientId: null,
        matchConfidence: null,
        matchCandidateIds: outcome.candidateIds,
        matchLevel: outcome.level,
      };
    case "no_match":
      return {
        matchOutcome: "no_match",
        matchedPatientId: null,
        matchConfidence: null,
        matchCandidateIds: [],
        matchLevel: "NO_MATCH",
      };
  }
}

/** Plan the proposal (or drop) for a resolved cascade outcome. */
export function planProposal(input: BuildProposalInput): ProposalPlan {
  const { context } = input;
  if (!isSupportedAdt(context.messageType)) {
    return { kind: "skip", reason: "unsupported_message_type" };
  }
  const routing = MESSAGE_TYPE_ROUTING[context.messageType];

  // A03/A11 no-match: can't discharge/cancel an unknown patient — drop with audit (§4.6 last row).
  if (input.outcome.kind === "no_match" && routing.noMatchBehavior === "drop_with_audit") {
    return {
      kind: "drop",
      event: {
        name: "m29.hl7_message.routing_dropped",
        payload: { ...context, reason: "cannot_act_on_unknown_patient" },
      },
    };
  }

  const fields = projectOutcomeFields(input.outcome);
  // A new-patient proposal is always M5-owned regardless of the ADT trigger's default owner.
  const isNewPatient = input.outcome.kind === "no_match";
  const resourceKind: Hl7InboundProposalKind = isNewPatient ? "new_patient" : routing.resourceKind;
  const ownerModule: Hl7ProposalOwnerModule = isNewPatient ? "m5" : routing.ownerModule;

  const proposal: NewHl7InboundProposalRow = {
    id: input.proposalId,
    organizationId: context.organizationId,
    sourceMessageId: context.messageId,
    resourceKind,
    proposedPatientCandidate: input.proposedPatientCandidate,
    matchOutcome: fields.matchOutcome,
    matchedPatientId: fields.matchedPatientId,
    matchConfidence: fields.matchConfidence,
    matchCandidateIds: [...fields.matchCandidateIds],
    proposedAt: input.proposedAt,
    ownerModule,
    proposalStatus: "pending",
    expiresAt: input.expiresAt,
  };

  return {
    kind: "create",
    proposal,
    event: {
      name: "m29.hl7_inbound_proposal.created",
      payload: {
        proposalId: input.proposalId,
        organizationId: context.organizationId,
        sourceMessageId: context.messageId,
        resourceKind,
        ownerModule,
        matchOutcome: fields.matchOutcome,
        matchedPatientId: fields.matchedPatientId,
        matchLevel: fields.matchLevel,
        matchConfidence: fields.matchConfidence ? Number.parseFloat(fields.matchConfidence) : null,
        matchCandidateIds: [...fields.matchCandidateIds],
        expiresAt: input.expiresAt.toISOString(),
      },
    },
  };
}
