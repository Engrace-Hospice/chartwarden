// apps/backend/src/modules/29-external-interfaces/inbound — cascade-outcome routing (M29-T04 / T-29.05 §6).
// PURE. Two projections of a {@link MatchOutcome}:
//   1. `projectCascadeForMessage` — the columns the parse worker writes back onto `hl7_message_inbound`
//      (§2.2 of T-29.05: matched_patient_id / match_level / match_outcome / match_confidence).
//   2. `routeCascadeOutcome` — the next-stage `m29.hl7_message.cascade_resolved_*` outbox descriptor the
//      T-29.06 proposal creator consumes. Both `confident` and `candidate` produce proposals downstream
//      (propose-then-review, T-29.06 §2.1); the three-way event split is retained for observability.
//
// Descriptors are RETURNED, never published here — the T08 worker/route owns the actual outbox write, so
// this file stays a pure, unit-testable mapping (mirrors the M6 `decideAdmissionEvent` effect-descriptor style).
import type { Hl7InboundMatchLevel, Hl7InboundMatchOutcome } from "@chartwarden/types";
import type { MatchOutcome } from "./match-cascade";

/** The context a cascade result carries forward to the resolved event (message identity + wire metadata). */
export interface CascadeMessageContext {
  readonly messageId: string;
  readonly feedId: string;
  readonly organizationId: string;
  readonly messageControlId: string;
  readonly messageType: string;
}

/** The `hl7_message_inbound` cascade-result columns (numeric confidence stringified for Drizzle). */
export interface CascadeMessageProjection {
  readonly matchedPatientId: string | null;
  readonly matchLevel: Hl7InboundMatchLevel;
  readonly matchOutcome: Hl7InboundMatchOutcome;
  readonly matchConfidence: string | null;
}

export interface CascadeResolvedConfidentPayload extends CascadeMessageContext {
  readonly matchedPatientId: string;
  readonly matchLevel: Hl7InboundMatchLevel;
  readonly mergeRedirectHops: number;
}

export interface CascadeResolvedCandidatePayload extends CascadeMessageContext {
  readonly candidatePatientId: string | null;
  readonly matchLevel: Hl7InboundMatchLevel;
  readonly matchConfidence: number | null;
  readonly candidateIds: readonly string[];
  readonly mergeRedirectHops: number;
}

export type CascadeNoMatchPayload = CascadeMessageContext;

/** The three terminal cascade-resolved outbox descriptors (T-29.05 §2.5). */
export type CascadeResolvedEvent =
  | {
      readonly name: "m29.hl7_message.cascade_resolved_confident";
      readonly payload: CascadeResolvedConfidentPayload;
    }
  | {
      readonly name: "m29.hl7_message.cascade_resolved_candidate";
      readonly payload: CascadeResolvedCandidatePayload;
    }
  | {
      readonly name: "m29.hl7_message.cascade_resolved_no_match";
      readonly payload: CascadeNoMatchPayload;
    };

/** Project the cascade outcome onto the `hl7_message_inbound` result columns. */
export function projectCascadeForMessage(outcome: MatchOutcome): CascadeMessageProjection {
  switch (outcome.kind) {
    case "confident_match":
      return {
        matchedPatientId: outcome.patientId,
        matchLevel: outcome.level,
        matchOutcome: "matched_single",
        matchConfidence: null,
      };
    case "candidate_match":
      return {
        matchedPatientId: outcome.patientId,
        matchLevel: outcome.level,
        matchOutcome: "matched_single",
        matchConfidence: outcome.confidence.toFixed(3),
      };
    case "ambiguous":
      return {
        matchedPatientId: null,
        matchLevel: outcome.level,
        matchOutcome: "matched_ambiguous",
        matchConfidence: null,
      };
    case "no_match":
      return {
        matchedPatientId: null,
        matchLevel: "NO_MATCH",
        matchOutcome: "no_match",
        matchConfidence: null,
      };
  }
}

/** Map the cascade outcome to its `cascade_resolved_*` event descriptor (ambiguous rides the candidate event). */
export function routeCascadeOutcome(
  outcome: MatchOutcome,
  ctx: CascadeMessageContext,
): CascadeResolvedEvent {
  switch (outcome.kind) {
    case "confident_match":
      return {
        name: "m29.hl7_message.cascade_resolved_confident",
        payload: {
          ...ctx,
          matchedPatientId: outcome.patientId,
          matchLevel: outcome.level,
          mergeRedirectHops: outcome.mergeRedirectHops,
        },
      };
    case "candidate_match":
      return {
        name: "m29.hl7_message.cascade_resolved_candidate",
        payload: {
          ...ctx,
          candidatePatientId: outcome.patientId,
          matchLevel: outcome.level,
          matchConfidence: outcome.confidence,
          candidateIds: [outcome.patientId],
          mergeRedirectHops: outcome.mergeRedirectHops,
        },
      };
    case "ambiguous":
      return {
        name: "m29.hl7_message.cascade_resolved_candidate",
        payload: {
          ...ctx,
          candidatePatientId: null,
          matchLevel: outcome.level,
          matchConfidence: null,
          candidateIds: outcome.candidateIds,
          mergeRedirectHops: 0,
        },
      };
    case "no_match":
      return { name: "m29.hl7_message.cascade_resolved_no_match", payload: { ...ctx } };
  }
}
