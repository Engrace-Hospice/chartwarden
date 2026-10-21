// apps/backend/src/modules/05-patient/outbox-consumers/m29-proposal-accepted.ts — the M29
// proposal-accept consumer (M5-T11, spec §4.10). PHASE-1 FORWARD-SEAM / DENY-STUB.
//
// M29 (HL7/ADT interop) is Wave H — there is no `m29.hl7_inbound_proposal.accepted` producer yet, so
// this consumer is DECLARED here (the binding contract M29 will dispatch to) but is NOT live-wired.
// The DECISION logic ships now, pure + tested: a `patient_demographic_update` proposal maps the
// parsed PID candidate to a PatientMutationPatch and applies it via the M5 PatientMutator seam (T08)
// — which STRIPS the forbidden identifiers (W-M5-17: an SSN on PID-19 is dropped, never persisted);
// a `new_patient` proposal routes to the create/match path. Wiring M29 later (W-M5-15 full accept,
// W-M5-16 partial accept, W-M5-18 merge-redirect, W-M5-19 ambiguous SSN-last4) is just binding the
// outbox handler to {@link decideProposalApply} + the PatientMutator.
import type { PatientMutationPatch } from "@chartwarden/types";

/** The parsed PID candidate carried on an accepted M29 proposal (§4.10.1, minimal projection). */
export interface ProposedPatientCandidate {
  readonly names?: ReadonlyArray<{ familyName: string; givenName: string; middleName?: string }>;
  readonly dateOfBirth?: string;
  readonly administrativeSex?: string;
  readonly maritalStatus?: string;
  readonly preferredLanguage?: string;
  readonly addresses?: ReadonlyArray<{
    streetAddress: string;
    city: string;
    state?: string;
    zipOrPostalCode?: string;
  }>;
  readonly phoneHome?: string;
  readonly phoneMobile?: string;
  readonly email?: string;
  readonly externalMrns?: ReadonlyArray<{ assigningAuthority: string; value: string }>;
  /** A chatty partner may send an SSN on PID-19 — it must NEVER be applied (W-M5-17). */
  readonly ssnNumber?: string;
}

/** The `m29.hl7_inbound_proposal.accepted` payload M5 consumes (§4.10.1). */
export interface ProposalAcceptedPayload {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly resourceKind: "patient_demographic_update" | "new_patient";
  readonly ownerModule: "m5" | "m6";
  readonly matchedPatientId: string | null;
  readonly decidedByMembershipId: string;
  /** null = full accept; array = partial accept (only these fields applied). */
  readonly appliedFields: readonly string[] | null;
  readonly proposedPatientCandidate: ProposedPatientCandidate;
}

/** The decision: apply a demographic patch to a matched patient, or create a new chart. */
export type ProposalDecision =
  | {
      readonly action: "apply_demographics";
      readonly patientId: string;
      readonly patch: PatientMutationPatch;
    }
  | { readonly action: "create_patient"; readonly candidate: ProposedPatientCandidate }
  | { readonly action: "skip"; readonly reason: string };

/** Map a candidate's first name to the patch demographic fields (§4.10 / D12 — SSN never mapped). */
function candidateToPatch(
  c: ProposedPatientCandidate,
  appliedFields: readonly string[] | null,
): PatientMutationPatch {
  const name = c.names?.[0];
  const addr = c.addresses?.[0];
  const full: PatientMutationPatch = {
    legalFirstName: name?.givenName,
    legalMiddleName: name?.middleName,
    legalLastName: name?.familyName,
    dateOfBirth: c.dateOfBirth,
    administrativeSex: c.administrativeSex,
    maritalStatus: c.maritalStatus,
    preferredLanguage: c.preferredLanguage,
    address: addr
      ? {
          line1: addr.streetAddress,
          city: addr.city,
          state: addr.state,
          postal: addr.zipOrPostalCode,
        }
      : undefined,
    phoneHome: c.phoneHome,
    phoneMobile: c.phoneMobile,
    email: c.email,
    externalMrnsToAdd: c.externalMrns,
    // ssn intentionally NOT mapped (the mutator would strip it anyway — defense in depth, W-M5-17).
  };
  // Partial accept (§4.10): keep only the caller-selected fields.
  if (appliedFields === null) return full;
  const allow = new Set(appliedFields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) if (allow.has(k) && v !== undefined) out[k] = v;
  return out as PatientMutationPatch;
}

/**
 * Decide how an accepted M29 proposal applies (§4.10, pure). A `patient_demographic_update` with a
 * matched patient → `apply_demographics` (patch via PatientMutator, which strips forbidden ids); a
 * `new_patient` → `create_patient` (the create/match path); an update with no match is skipped (D10:
 * never auto-create from a demographic update).
 */
export function decideProposalApply(payload: ProposalAcceptedPayload): ProposalDecision {
  if (payload.ownerModule !== "m5") return { action: "skip", reason: "not_m5_owned" };
  if (payload.resourceKind === "new_patient") {
    return { action: "create_patient", candidate: payload.proposedPatientCandidate };
  }
  // patient_demographic_update
  if (payload.matchedPatientId === null) {
    return { action: "skip", reason: "demographic_update_no_match" };
  }
  return {
    action: "apply_demographics",
    patientId: payload.matchedPatientId,
    patch: candidateToPatch(payload.proposedPatientCandidate, payload.appliedFields),
  };
}

/** The forward-declared (event → consumer) binding M29 will dispatch to once it lands (Wave H). */
export const M29_PROPOSAL_CONSUMER = {
  eventName: "m29.hl7_inbound_proposal.accepted",
  consumerName: "m5.proposal-applier",
} as const;

/** True in Phase 1 — no M29 producer; the consumer is declared but not live-wired. */
export const M29_PROPOSAL_CONSUMER_DEFERRED = true;
